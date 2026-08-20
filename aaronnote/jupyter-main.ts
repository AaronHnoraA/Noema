import "../src/styles/aaron-ui-tokens.css";
import "../src/styles/aaron-ui-elegant.css";
import "../src/styles/theme-loader.ts";
import "./jupyter-page.css";
import { api } from "./api-client.ts";
import { renderJupyterOutputs } from "../src/jupyter-rendermime.ts";
import type { WidgetMountFn } from "../src/jupyter-rendermime.ts";
import type { JupyterWidgetKernelMessage } from "../src/jupyter-widget-runtime.ts";
import { renderJupyterVariablesTable } from "../src/jupyter-variables-view.ts";
import { installNoemaThemeRuntime, loadNoemaAppConfig } from "./theme-runtime.ts";

type DocumentRef = {
  scriptFile: string;
  sourceFile: string;
  language: string;
  kernel: string;
  session: string;
  kernelSpecName?: string;
  kernelId?: string;
  sessionName?: string;
  sessionId?: string;
};

type ManagerKernel = {
  id?: string;
  kernelId?: string;
  kernelSpecName?: string;
  language?: string;
  targetId?: string;
  status?: string;
  running?: number;
  generation?: number;
  sessionIds?: string[];
};

type ManagerSession = {
  id?: string;
  sessionId?: string;
  scriptFile?: string;
  sourceFile?: string;
  sessionName?: string;
  language?: string;
  kernelSpecName?: string;
  kernelId?: string;
  running?: number;
};

type ManagerTask = {
  id?: string;
  taskId?: string;
  kernelId?: string;
  sessionId?: string;
  scriptFile?: string;
  cellId?: string;
  status?: string;
  error?: string;
};

type ManagerSnapshot = {
  server?: { status?: string; owned?: boolean };
  servers?: Array<{ id?: string; displayName?: string; kind?: string; target?: string }>;
  kernels?: ManagerKernel[];
  sessions?: ManagerSession[];
  tasks?: ManagerTask[];
};

type CellSnapshot = {
  id: string;
  index: number;
  line: number;
  revision: string;
  code: string;
  stale: boolean;
  status: string;
  executionCount: number | null;
  outputs: unknown[];
  widgetMessages?: unknown[];
  widgetOutputs?: Record<string, unknown[]>;
  widgetRuntime?: { id: string; name: string; generation?: number };
  outputUi?: { outputFolded?: boolean; outputExpanded?: boolean };
  stdin?: { runId: string; prompt: string; password: boolean };
};

type DocumentSnapshot = {
  ok?: boolean;
  documentRevision: string;
  document: DocumentRef;
  kernelStatus: string;
  cells: CellSnapshot[];
};

type TabState = {
  ref: DocumentRef;
  snapshot?: DocumentSnapshot;
  activeCellId: string;
  loading: boolean;
  error: string;
};

declare global {
  interface Window {
    noemaJupyterOpenDocument?: (payload: Partial<DocumentRef> & { cellId?: string }) => void;
    noemaJupyterOpenView?: (view: "outputs" | "variables" | "manage") => void;
  }
}

const removeThemeRuntime = installNoemaThemeRuntime();
void loadNoemaAppConfig().catch(() => {});

const STORAGE_KEY = "noema:jupyter:tabs:v1";
const tabs = new Map<string, TabState>();
let activeScript = "";
let statusTimer = 0;
let refreshTimer = 0;
let managerTimer = 0;
let lastDKeyAt = 0;
let manager: ManagerSnapshot = {};
let activeView: "outputs" | "variables" | "manage" = "outputs";
const outputDisposers = new Set<() => void>();

const mountWidget: WidgetMountFn = (host, modelId, runtime, messages, widgetOutputs) => {
  (window as Window & { __jupyter_widgets_assets_path__?: string }).__jupyter_widgets_assets_path__ ??=
    new URL("./", window.location.href).toString();
  return import("../src/jupyter-widget-runtime.ts")
    .then(({ mountJupyterWidget }) => mountJupyterWidget(
      host,
      modelId,
      runtime,
      messages as JupyterWidgetKernelMessage[],
      widgetOutputs,
    ));
};

const app = document.createElement("main");
app.className = "noema-jupyter-page";
app.innerHTML = `
  <header class="noema-jupyter-header">
    <div class="noema-jupyter-brand">
      <span class="noema-jupyter-logo">N</span>
      <div><strong>Jupyter</strong><small>Emacs-owned workspace</small></div>
    </div>
    <div class="noema-jupyter-kernel" data-kernel-status></div>
    <label class="noema-jupyter-kernel-select">Kernel
      <select data-kernel-select aria-label="Kernel"></select>
    </label>
    <div class="noema-jupyter-global-actions">
      <button type="button" data-action="run-all">Run All</button>
      <button type="button" data-action="restart-run-all">Restart & Run All</button>
      <button type="button" data-action="interrupt">Interrupt</button>
      <button type="button" data-action="restart">Restart</button>
      <button type="button" data-action="shutdown">Shut Down</button>
      <button type="button" data-action="clear-all">Clear Outputs</button>
      <button type="button" data-action="variables">Variables</button>
      <button type="button" data-action="tasks">Kernel Tasks</button>
      <button type="button" data-action="board">Jupyter Board</button>
    </div>
  </header>
  <nav class="noema-jupyter-tabs" aria-label="Jupyter documents" data-tabs></nav>
  <div class="noema-jupyter-shell">
    <aside class="noema-jupyter-manager" data-manager></aside>
    <section class="noema-jupyter-workspace" data-workspace></section>
    <aside class="noema-jupyter-inspector" data-inspector></aside>
  </div>
  <section class="noema-jupyter-tasks" data-task-panel></section>
  <div class="noema-jupyter-status" role="status" data-status></div>
  <dialog class="noema-jupyter-dialog" data-dialog>
    <header><strong data-dialog-title></strong><button type="button" data-dialog-close>×</button></header>
    <div class="noema-jupyter-dialog-body" data-dialog-body></div>
  </dialog>
`;
document.body.append(app);

const tabsEl = app.querySelector<HTMLElement>("[data-tabs]")!;
const workspaceEl = app.querySelector<HTMLElement>("[data-workspace]")!;
const managerEl = app.querySelector<HTMLElement>("[data-manager]")!;
const inspectorEl = app.querySelector<HTMLElement>("[data-inspector]")!;
const taskPanelEl = app.querySelector<HTMLElement>("[data-task-panel]")!;
const statusEl = app.querySelector<HTMLElement>("[data-status]")!;
const kernelStatusEl = app.querySelector<HTMLElement>("[data-kernel-status]")!;
const kernelSelectEl = app.querySelector<HTMLSelectElement>("[data-kernel-select]")!;
const dialogEl = app.querySelector<HTMLDialogElement>("[data-dialog]")!;
const dialogTitleEl = app.querySelector<HTMLElement>("[data-dialog-title]")!;
const dialogBodyEl = app.querySelector<HTMLElement>("[data-dialog-body]")!;
const kernelOptions = new Map<string, Array<{ name: string; displayName?: string; language?: string }>>();

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function keyFor(ref: Pick<DocumentRef, "scriptFile">): string {
  return text(ref.scriptFile);
}

function tabLabel(ref: DocumentRef): string {
  const name = ref.sourceFile || ref.scriptFile;
  const base = name.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "Jupyter";
  return `${base} · ${ref.language || "code"}/${ref.session || "default"}`;
}

function setStatus(message: string, error = false): void {
  statusEl.textContent = message;
  statusEl.dataset.error = error ? "true" : "false";
  statusEl.classList.add("is-visible");
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => statusEl.classList.remove("is-visible"), 4500);
}

function persistTabs(): void {
  const value = Array.from(tabs.values()).map((tab) => ({ ref: tab.ref, activeCellId: tab.activeCellId }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeScript, tabs: value }));
}

function restoredTabs(): Array<{ ref: DocumentRef; activeCellId?: string }> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return Array.isArray(parsed.tabs) ? parsed.tabs : [];
  } catch {
    return [];
  }
}

function documentParams(tab: TabState, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...tab.ref, ...extra };
}

function activeTab(): TabState | undefined {
  return tabs.get(activeScript);
}

function activeCell(tab = activeTab()): CellSnapshot | undefined {
  if (!tab?.snapshot) return undefined;
  return tab.snapshot.cells.find((cell) => cell.id === tab.activeCellId) || tab.snapshot.cells[0];
}

function disposeOutputs(): void {
  for (const dispose of outputDisposers) {
    try { dispose(); } catch {}
  }
  outputDisposers.clear();
}

function selectCell(tab: TabState, cellId: string, focus = false): void {
  tab.activeCellId = cellId;
  persistTabs();
  renderWorkspace();
  const card = workspaceEl.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cellId)}"]`);
  card?.scrollIntoView({ block: "center", behavior: "smooth" });
  if (focus) card?.focus();
}

async function loadTab(tab: TabState, reveal = true): Promise<void> {
  tab.loading = true;
  tab.error = "";
  renderWorkspace();
  try {
    const raw = await api.jupyterCell.scriptSnapshot({ scriptFile: tab.ref.scriptFile });
    const snapshot = raw as unknown as DocumentSnapshot;
    tab.snapshot = snapshot;
    tab.ref = { ...tab.ref, ...snapshot.document };
    if (!kernelOptions.has(tab.ref.scriptFile)) void loadKernelOptions(tab);
    if (!snapshot.cells.some((cell) => cell.id === tab.activeCellId)) {
      tab.activeCellId = snapshot.cells[0]?.id || "";
    }
  } catch (error) {
    tab.error = error instanceof Error ? error.message : String(error);
  } finally {
    tab.loading = false;
    render();
    if (reveal && tab.activeCellId) {
      requestAnimationFrame(() => {
        workspaceEl.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(tab.activeCellId)}"]`)
          ?.scrollIntoView({ block: "center" });
      });
    }
  }
}

async function loadManager(renderAfter = true): Promise<void> {
  try {
    manager = await api.jupyterCell.managerSnapshot() as ManagerSnapshot;
  } catch (error) {
    manager = {};
    if (renderAfter) setStatus(error instanceof Error ? error.message : "Jupyter manager unavailable", true);
  }
  if (renderAfter) {
    renderManager();
    renderWorkspace();
    renderTasks();
    if (activeView === "manage") renderInspector();
  }
}

async function loadKernelOptions(tab: TabState): Promise<void> {
  try {
    const result = await api.jupyterCell.kernels({ file: tab.ref.sourceFile || tab.ref.scriptFile });
    const values = [...(result.kernels || []), ...(result.attachable || [])];
    kernelOptions.set(tab.ref.scriptFile, values);
    if (tab === activeTab()) renderWorkspace();
  } catch {
    kernelOptions.set(tab.ref.scriptFile, []);
  }
}

async function switchKernel(name: string): Promise<void> {
  const tab = activeTab();
  if (!tab?.snapshot || !name) return;
  kernelSelectEl.disabled = true;
  const [kind, value = ""] = name.split(":", 2);
  setStatus(kind === "none" ? "Detaching session…" : "Selecting kernel…");
  try {
    await api.jupyterCell.sessionSelect({
      scriptFile: tab.ref.scriptFile,
      kind,
      ...(kind === "start" ? { kernelSpecName: value } : {}),
      ...(kind === "connect" ? { kernelId: value } : {}),
    });
    await loadManager(false);
    await loadTab(tab, true);
    setStatus(kind === "none" ? "Session has no kernel" : "Kernel selected");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Kernel switch failed", true);
    renderWorkspace();
  }
}

function normalizeRef(payload: Partial<DocumentRef>): DocumentRef | null {
  const scriptFile = text(payload.scriptFile);
  if (!scriptFile) return null;
  return {
    scriptFile,
    sourceFile: text(payload.sourceFile),
    language: text(payload.language) || "python",
    kernel: text(payload.kernel) || "python3",
    session: text(payload.session) || "default",
    kernelSpecName: text(payload.kernelSpecName || payload.kernel) || "python3",
    kernelId: text(payload.kernelId),
    sessionName: text(payload.sessionName || payload.session) || "default",
    sessionId: text(payload.sessionId),
  };
}

function openDocument(payload: Partial<DocumentRef> & { cellId?: string }): void {
  const ref = normalizeRef(payload);
  if (!ref) return;
  const key = keyFor(ref);
  let tab = tabs.get(key);
  if (!tab) {
    tab = { ref, activeCellId: text(payload.cellId), loading: false, error: "" };
    tabs.set(key, tab);
  } else {
    tab.ref = { ...tab.ref, ...ref };
    if (payload.cellId) tab.activeCellId = text(payload.cellId);
  }
  activeScript = key;
  persistTabs();
  render();
  void loadTab(tab);
}

window.noemaJupyterOpenDocument = openDocument;
window.noemaJupyterOpenView = (view) => {
  activeView = view;
  if (view === "variables") void showVariables();
  else {
    render();
    if (view === "manage") void loadManager(true);
  }
};

function renderTabs(): void {
  tabsEl.replaceChildren(...Array.from(tabs.entries()).map(([key, tab]) => {
    const item = document.createElement("div");
    item.className = "noema-jupyter-tab";
    item.dataset.active = key === activeScript ? "true" : "false";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "noema-jupyter-tab-select";
    select.textContent = tabLabel(tab.ref);
    select.title = tab.ref.scriptFile;
    select.addEventListener("click", () => {
      activeScript = key;
      persistTabs();
      render();
      if (!tab.snapshot) void loadTab(tab);
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "noema-jupyter-tab-close";
    close.textContent = "×";
    close.title = "Close view (kernel keeps running)";
    close.addEventListener("click", () => {
      tabs.delete(key);
      if (activeScript === key) activeScript = tabs.keys().next().value || "";
      persistTabs();
      render();
    });
    item.append(select, close);
    return item;
  }));
}

function button(label: string, title: string, run: () => void | Promise<void>, className = ""): HTMLButtonElement {
  const result = document.createElement("button");
  result.type = "button";
  result.textContent = label;
  result.title = title;
  if (className) result.className = className;
  result.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void run();
  });
  return result;
}

async function execute(mode: "current" | "selected" | "above" | "below" | "all", ids?: string[]): Promise<void> {
  const tab = activeTab();
  const cell = activeCell(tab);
  if (!tab || (!cell && mode !== "all")) return;
  setStatus(mode === "current" ? `Running ${cell?.id}…` : `Running ${mode}…`);
  try {
    if (mode === "selected" && ids?.length) {
      for (const cellId of ids) {
        await api.jupyterCell.scriptAction({
          scriptFile: tab.ref.scriptFile,
          cellId,
          action: "run-current",
        });
      }
    } else {
      await api.jupyterCell.scriptAction({
        scriptFile: tab.ref.scriptFile,
        cellId: cell?.id || "",
        action: `run-${mode}`,
      });
    }
    await loadManager(false);
    await loadTab(tab, true);
    setStatus("Execution complete");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Execution failed", true);
    await loadTab(tab, true);
  }
}

async function mutate(op: string): Promise<void> {
  const tab = activeTab();
  const cell = activeCell(tab);
  if (!tab || !cell) return;
  try {
    const result = await api.jupyterCell.scriptAction({
      scriptFile: tab.ref.scriptFile,
      cellId: cell.id,
      action: op,
    });
    tab.activeCellId = text(result.activeCellId) || cell.id;
    await loadTab(tab, true);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Cell mutation failed", true);
  }
}

async function clearOutput(all = false): Promise<void> {
  const tab = activeTab();
  const cell = activeCell(tab);
  if (!tab || (!cell && !all)) return;
  try {
    await api.jupyterCell.scriptAction({
      scriptFile: tab.ref.scriptFile,
      cellId: all ? "" : cell!.id,
      action: all ? "clear-all-outputs" : "clear-output",
    });
    await loadTab(tab, false);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Clear output failed", true);
  }
}

async function kernelAction(action: "interrupt" | "restart" | "shutdown"): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  try {
    const kernelId = text(tab.ref.kernelId);
    if (kernelId) await api.jupyterCell.kernelControl({ kernelId, action });
    else await api.jupyterCell.scriptAction({ scriptFile: tab.ref.scriptFile, action });
    await loadManager(false);
    setStatus(action === "shutdown" ? "Kernel shut down" : `Kernel ${action} requested`);
    await loadTab(tab, false);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : `Kernel ${action} failed`, true);
  }
}

function openDialog(title: string): void {
  dialogTitleEl.textContent = title;
  if (!dialogEl.open) dialogEl.showModal();
}

async function showVariables(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  activeView = "variables";
  inspectorEl.innerHTML = `<div class="noema-jupyter-panel-empty">Loading variables…</div>`;
  renderManager();
  try {
    const result = await api.jupyterCell.variables(documentParams(tab));
    renderJupyterVariablesTable(
      inspectorEl,
      Array.isArray(result.variables) ? result.variables : [],
      result.supported === false ? "Start this Python kernel by running a Cell first." : undefined,
    );
  } catch (error) {
    inspectorEl.textContent = error instanceof Error ? error.message : "Variable inspection failed";
  }
}

async function showTasks(): Promise<void> {
  activeView = "manage";
  await loadManager(true);
}

async function openSource(cell = activeCell()): Promise<void> {
  const tab = activeTab();
  if (!tab || !cell) return;
  await api.emacs.open({ file: tab.ref.scriptFile, line: cell.line || 1, col: 0 });
}

function renderCell(tab: TabState, cell: CellSnapshot): HTMLElement {
  const card = document.createElement("article");
  card.className = "noema-jupyter-cell";
  card.dataset.cellId = cell.id;
  card.dataset.active = cell.id === tab.activeCellId ? "true" : "false";
  card.tabIndex = 0;
  card.addEventListener("focus", () => {
    if (tab.activeCellId !== cell.id) {
      tab.activeCellId = cell.id;
      persistTabs();
      for (const item of workspaceEl.querySelectorAll<HTMLElement>(".noema-jupyter-cell")) {
        item.dataset.active = item === card ? "true" : "false";
      }
    }
  });
  card.addEventListener("click", () => card.focus());

  const head = document.createElement("header");
  head.className = "noema-jupyter-cell-header";
  const prompt = document.createElement("span");
  prompt.className = "noema-jupyter-prompt";
  prompt.textContent = cell.executionCount == null ? "[ ]" : `[${cell.executionCount}]`;
  const identity = document.createElement("span");
  identity.className = "noema-jupyter-cell-id";
  identity.textContent = cell.id;
  const badges = document.createElement("span");
  badges.className = "noema-jupyter-badges";
  badges.append(
    Object.assign(document.createElement("span"), { textContent: cell.status || "idle" }),
    ...(cell.stale ? [Object.assign(document.createElement("span"), { textContent: "stale" })] : []),
  );
  const actions = document.createElement("div");
  actions.className = "noema-jupyter-cell-actions";
  actions.append(
    button("Run", "Run only this Cell (Ctrl+Enter)", () => { tab.activeCellId = cell.id; return execute("current"); }),
    button("Next", "Run and select next (Shift+Enter)", async () => {
      tab.activeCellId = cell.id;
      await execute("current");
      const next = tab.snapshot?.cells[cell.index + 1];
      if (next) selectCell(tab, next.id, true);
    }),
    button("Above", "Run this Cell and all above", () => { tab.activeCellId = cell.id; return execute("above"); }),
    button("Below", "Run this Cell and all below", () => { tab.activeCellId = cell.id; return execute("below"); }),
    button("Clear", "Clear this output", () => { tab.activeCellId = cell.id; return clearOutput(false); }),
    button("Source", "Open source in Emacs (Cmd+Enter)", () => openSource(cell)),
    button("＋", "Insert Cell below", () => { tab.activeCellId = cell.id; return mutate("insertBelow"); }),
    button("Duplicate", "Duplicate Cell", () => { tab.activeCellId = cell.id; return mutate("duplicate"); }),
    button("↑", "Move Cell up", () => { tab.activeCellId = cell.id; return mutate("moveUp"); }),
    button("↓", "Move Cell down", () => { tab.activeCellId = cell.id; return mutate("moveDown"); }),
    button("Delete", "Delete Cell", async () => {
      tab.activeCellId = cell.id;
      if (cell.outputs.length > 0 && !window.confirm(`Delete Cell ${cell.id} and its output?`)) return;
      await mutate("delete");
    }, "is-danger"),
  );
  head.append(prompt, identity, badges, actions);

  const output = document.createElement("div");
  output.className = "noema-jupyter-output";
  if (cell.outputUi?.outputFolded) output.hidden = true;
  if (Array.isArray(cell.outputs) && cell.outputs.length > 0) {
    outputDisposers.add(renderJupyterOutputs(output, cell.outputs, {
      widgetRuntime: cell.widgetRuntime,
      widgetMessages: cell.widgetMessages,
      widgetOutputs: cell.widgetOutputs,
      mountWidget,
    }));
  } else {
    const empty = document.createElement("div");
    empty.className = "noema-jupyter-output-empty";
    empty.textContent = cell.status === "error" ? "Execution failed" : "No output";
    output.append(empty);
  }
  if (cell.stdin) {
    output.hidden = false;
    const stdin = document.createElement("form");
    stdin.className = "noema-jupyter-stdin";
    const label = document.createElement("label");
    label.textContent = cell.stdin.prompt || (cell.stdin.password ? "Password:" : "Input:");
    const input = document.createElement("input");
    input.type = cell.stdin.password ? "password" : "text";
    input.autocomplete = "off";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Send";
    const cancel = button("Cancel", "Cancel input", async () => {
      await api.jupyterCell.inputReply({ runId: cell.stdin!.runId, cancel: true });
      delete cell.stdin;
      renderWorkspace();
    });
    stdin.append(label, input, submit, cancel);
    stdin.addEventListener("submit", (event) => {
      event.preventDefault();
      const runId = cell.stdin?.runId || "";
      void api.jupyterCell.inputReply({ runId, value: input.value }).finally(() => {
        delete cell.stdin;
        renderWorkspace();
      });
    });
    output.append(stdin);
  }
  const foot = document.createElement("footer");
  foot.className = "noema-jupyter-cell-footer";
  foot.append(button(output.hidden ? "Show output" : "Fold output", "Toggle output visibility", async () => {
    output.hidden = !output.hidden;
    cell.outputUi = {
      ...cell.outputUi,
      outputFolded: output.hidden,
    };
    try {
      await api.jupyterCell.saveScriptCellOutputUi(documentParams(tab, {
        cellId: cell.id,
        outputFolded: output.hidden,
        outputExpanded: cell.outputUi?.outputExpanded === true,
      }));
    } catch {}
    renderWorkspace();
  }));
  card.append(head, output, foot);
  return card;
}

function panelSection(title: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "noema-jupyter-manager-section";
  const heading = document.createElement("h2");
  heading.textContent = title;
  section.append(heading);
  return section;
}

function renderManager(): void {
  const nav = document.createElement("nav");
  nav.className = "noema-jupyter-view-nav";
  for (const [view, label] of [["outputs", "Outputs"], ["variables", "Variables"], ["manage", "Manage"]] as const) {
    const item = button(label, `Open ${label}`, () => {
      activeView = view;
      if (view === "variables") return showVariables();
      render();
    });
    item.dataset.active = activeView === view ? "true" : "false";
    nav.append(item);
  }

  const server = panelSection("Server");
  const serverRow = document.createElement("div");
  serverRow.className = "noema-jupyter-manager-row";
  serverRow.append(
    Object.assign(document.createElement("strong"), { textContent: "Emacs Jupyter" }),
    Object.assign(document.createElement("span"), { textContent: text(manager.server?.status) || "connecting" }),
  );
  server.append(serverRow);
  for (const remote of manager.servers || []) {
    const row = document.createElement("div");
    row.className = "noema-jupyter-manager-row";
    row.append(
      Object.assign(document.createElement("strong"), { textContent: text(remote.displayName || remote.id) }),
      Object.assign(document.createElement("span"), { textContent: `${text(remote.kind)} · ${text(remote.target)}` }),
    );
    server.append(row);
  }

  const running = panelSection(`Running Kernels (${manager.kernels?.length || 0})`);
  for (const kernel of manager.kernels || []) {
    const row = document.createElement("div");
    row.className = "noema-jupyter-manager-card";
    const name = document.createElement("strong");
    name.textContent = text(kernel.kernelSpecName) || "kernel";
    const detail = document.createElement("small");
    detail.textContent = `${text(kernel.status) || "unknown"} · ${kernel.sessionIds?.length || 0} session · ${kernel.running || 0} task`;
    const actions = document.createElement("div");
    const id = text(kernel.kernelId || kernel.id);
    actions.append(
      button("Attach", "Attach the active script session", () => switchKernel(`connect:${id}`)),
      button("Stop", "Shut down this global kernel", async () => {
        if (!id) return;
        await api.jupyterCell.kernelControl({ kernelId: id, action: "shutdown" });
        await loadManager(true);
        const tab = activeTab();
        if (tab) await loadTab(tab, false);
      }),
    );
    row.append(name, detail, actions);
    running.append(row);
  }
  if (!manager.kernels?.length) running.append(Object.assign(document.createElement("small"), { textContent: "No running kernels" }));

  const specs = panelSection("Kernel Specs");
  const tab = activeTab();
  for (const spec of tab ? kernelOptions.get(tab.ref.scriptFile) || [] : []) {
    const row = button(spec.displayName || spec.name, `Start ${spec.name}`, () => switchKernel(`start:${spec.name}`));
    row.className = "noema-jupyter-spec-button";
    specs.append(row);
  }
  if (!tab) specs.append(Object.assign(document.createElement("small"), { textContent: "Open a script to list compatible specs" }));
  managerEl.replaceChildren(nav, server, running, specs);
}

function renderInspector(): void {
  const tab = activeTab();
  const cell = activeCell(tab);
  const heading = document.createElement("h2");
  if (activeView === "manage") {
    heading.textContent = "Sessions";
    const list = document.createElement("div");
    list.className = "noema-jupyter-session-list";
    for (const session of manager.sessions || []) {
      const row = document.createElement("div");
      row.className = "noema-jupyter-manager-card";
      row.append(
        Object.assign(document.createElement("strong"), { textContent: (text(session.scriptFile).split(/[\\/]/).pop() || "session") }),
        Object.assign(document.createElement("small"), {
          textContent: `${text(session.language)} · ${text(session.sessionName)} · ${text(session.kernelId) || "No Kernel"}`,
        }),
      );
      list.append(row);
    }
    if (!manager.sessions?.length) list.textContent = "No document sessions";
    inspectorEl.replaceChildren(heading, list);
    return;
  }
  if (activeView === "variables") {
    heading.textContent = "Variables";
    const refresh = button("Refresh", "Refresh the live variable explorer", () => showVariables());
    const hint = document.createElement("p");
    hint.className = "noema-jupyter-panel-empty";
    hint.textContent = tab ? "Refresh variables from the active kernel." : "Open a script first.";
    inspectorEl.replaceChildren(heading, refresh, hint);
    return;
  }
  heading.textContent = "Cell Inspector";
  if (!cell || !tab) {
    inspectorEl.replaceChildren(heading, Object.assign(document.createElement("p"), { textContent: "No active Cell" }));
    return;
  }
  const details = document.createElement("dl");
  for (const [label, value] of [
    ["Cell", cell.id], ["Status", cell.status], ["Execution", cell.executionCount ?? "—"],
    ["Language", tab.ref.language], ["Session", tab.ref.sessionName || tab.ref.session],
  ]) {
    details.append(
      Object.assign(document.createElement("dt"), { textContent: String(label) }),
      Object.assign(document.createElement("dd"), { textContent: String(value) }),
    );
  }
  const actions = document.createElement("div");
  actions.className = "noema-jupyter-inspector-actions";
  actions.append(
    button("Run Cell", "Run the selected Cell", () => execute("current")),
    button("Open in Emacs", "Jump to source", () => openSource(cell)),
    button("Insert Below", "Insert a Cell below", () => mutate("insertBelow")),
    button("Delete", "Delete selected Cell", () => mutate("delete"), "is-danger"),
  );
  inspectorEl.replaceChildren(heading, details, actions);
}

function renderTasks(): void {
  const heading = document.createElement("strong");
  heading.textContent = `Tasks (${manager.tasks?.filter((task) => task.status === "running").length || 0} running)`;
  const list = document.createElement("div");
  list.className = "noema-jupyter-task-list";
  for (const task of (manager.tasks || []).slice(0, 12)) {
    const item = document.createElement("span");
    item.textContent = `${text(task.cellId) || "task"} · ${text(task.status)}${task.error ? ` · ${task.error}` : ""}`;
    list.append(item);
  }
  if (!manager.tasks?.length) list.append(Object.assign(document.createElement("span"), { textContent: "No tasks" }));
  taskPanelEl.replaceChildren(heading, list);
  taskPanelEl.dataset.expanded = activeView === "manage" ? "true" : "false";
}

function renderWorkspace(): void {
  disposeOutputs();
  const tab = activeTab();
  kernelStatusEl.textContent = tab?.snapshot
    ? `${tab.ref.kernel} · ${tab.ref.session} · ${tab.snapshot.kernelStatus}`
    : "No kernel";
  const noKernel = document.createElement("option");
  noKernel.value = "none:";
  noKernel.textContent = "No Kernel";
  const specs = document.createElement("optgroup");
  specs.label = "Start New Kernel";
  for (const item of tab ? kernelOptions.get(tab.ref.scriptFile) || [] : []) {
    specs.append(Object.assign(document.createElement("option"), {
      value: `start:${item.name}`,
      textContent: item.displayName || item.name,
    }));
  }
  const running = document.createElement("optgroup");
  running.label = "Connect to Running Kernel";
  for (const item of manager.kernels || []) {
    if (tab && text(item.language) && text(item.language).toLowerCase() !== tab.ref.language.toLowerCase()) continue;
    const id = text(item.kernelId || item.id);
    running.append(Object.assign(document.createElement("option"), {
      value: `connect:${id}`,
      textContent: `${text(item.kernelSpecName)} · ${text(item.status)} · ${id.slice(-6)}`,
    }));
  }
  kernelSelectEl.replaceChildren(noKernel, specs, running);
  kernelSelectEl.value = tab?.ref.kernelId
    ? `connect:${tab.ref.kernelId}`
    : (tab?.ref.kernelSpecName || tab?.ref.kernel)
      ? `start:${tab?.ref.kernelSpecName || tab?.ref.kernel}`
      : "none:";
  kernelSelectEl.disabled = !tab?.snapshot;
  if (!tab) {
    workspaceEl.innerHTML = `<div class="noema-jupyter-empty"><strong>No Jupyter document</strong><span>Open a .cell script in Emacs and press C-c i p.</span></div>`;
    return;
  }
  if (tab.loading && !tab.snapshot) {
    workspaceEl.innerHTML = `<div class="noema-jupyter-empty"><strong>Loading outputs…</strong></div>`;
    return;
  }
  if (tab.error) {
    workspaceEl.innerHTML = `<div class="noema-jupyter-empty is-error"><strong>Unable to load document</strong><span></span></div>`;
    workspaceEl.querySelector("span")!.textContent = tab.error;
    return;
  }
  const cells = tab.snapshot?.cells || [];
  if (cells.length === 0) {
    workspaceEl.innerHTML = `<div class="noema-jupyter-empty"><strong>No Cells</strong><span>Add a Cell from Emacs.</span></div>`;
    return;
  }
  workspaceEl.replaceChildren(...cells.map((cell) => renderCell(tab, cell)));
}

kernelSelectEl.addEventListener("change", () => void switchKernel(kernelSelectEl.value));

function render(): void {
  renderTabs();
  renderManager();
  renderWorkspace();
  renderInspector();
  renderTasks();
}

app.querySelector("[data-action='run-all']")?.addEventListener("click", () => void execute("all"));
app.querySelector("[data-action='restart-run-all']")?.addEventListener("click", async () => {
  await kernelAction("restart");
  await execute("all");
});
app.querySelector("[data-action='interrupt']")?.addEventListener("click", () => void kernelAction("interrupt"));
app.querySelector("[data-action='restart']")?.addEventListener("click", () => void kernelAction("restart"));
app.querySelector("[data-action='shutdown']")?.addEventListener("click", () => void kernelAction("shutdown"));
app.querySelector("[data-action='clear-all']")?.addEventListener("click", () => void clearOutput(true));
app.querySelector("[data-action='variables']")?.addEventListener("click", () => void showVariables());
app.querySelector("[data-action='tasks']")?.addEventListener("click", () => void showTasks());
app.querySelector("[data-action='board']")?.addEventListener("click", () => {
  activeView = "manage";
  void loadManager(true);
});
app.querySelector("[data-dialog-close]")?.addEventListener("click", () => dialogEl.close());
dialogEl.addEventListener("click", (event) => {
  if (event.target === dialogEl) dialogEl.close();
});

window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
  const tab = activeTab();
  const cell = activeCell(tab);
  if (!tab || !cell) return;
  if (event.metaKey && event.key === "Enter") {
    event.preventDefault();
    void openSource(cell);
    return;
  }
  if (event.ctrlKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    event.preventDefault();
    void mutate(event.key === "ArrowUp" ? "moveUp" : "moveDown");
    return;
  }
  if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    void execute("current");
    return;
  }
  if (event.shiftKey && event.key === "Enter") {
    event.preventDefault();
    void execute("current").then(() => {
      const next = tab.snapshot?.cells[cell.index + 1];
      if (next) selectCell(tab, next.id, true);
    });
    return;
  }
  if (event.altKey && event.key === "Enter") {
    event.preventDefault();
    void execute("current").then(() => mutate("insertBelow"));
    return;
  }
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const next = tab.snapshot?.cells[cell.index + (event.key === "ArrowUp" ? -1 : 1)];
    if (next) selectCell(tab, next.id, true);
    return;
  }
  if (event.key.toLowerCase() === "a") {
    event.preventDefault();
    void mutate("insertAbove");
    return;
  }
  if (event.key.toLowerCase() === "b") {
    event.preventDefault();
    void mutate("insertBelow");
    return;
  }
  if (event.key.toLowerCase() === "d") {
    const now = performance.now();
    if (now - lastDKeyAt < 650) {
      event.preventDefault();
      lastDKeyAt = 0;
      if (cell.outputs.length === 0 || window.confirm(`Delete Cell ${cell.id}?`)) void mutate("delete");
    } else {
      lastDKeyAt = now;
    }
  }
});

window.addEventListener("aaronnote:jupyter-cell", (event) => {
  const detail = (event as CustomEvent<{
    scriptFile?: string;
    file?: string;
    cellId?: string;
    runId?: string;
    phase?: string;
    status?: string;
    prompt?: string;
    password?: boolean;
    executionCount?: number | null;
    events?: Array<{ kind?: string; index?: number; output?: unknown; state?: string; value?: number | null }>;
  }>).detail;
  const tab = tabs.get(text(detail?.scriptFile)) || Array.from(tabs.values()).find((item) => item.ref.sourceFile === text(detail?.file));
  if (!tab) return;
  if (detail.cellId) tab.activeCellId = text(detail.cellId);
  const cell = tab.snapshot?.cells.find((item) => item.id === text(detail.cellId));
  if (cell) {
    if (detail.phase === "start") cell.status = "busy";
    if (detail.phase === "stdin") {
      cell.stdin = {
        runId: text(detail.runId),
        prompt: text(detail.prompt),
        password: detail.password === true,
      };
    }
    if (detail.phase === "end") {
      cell.status = text(detail.status) || "idle";
      cell.executionCount = detail.executionCount ?? cell.executionCount;
      delete cell.stdin;
    }
    for (const patch of detail.events || []) {
      if (patch.kind === "clear") cell.outputs = [];
      else if (patch.kind === "set" && Number.isInteger(patch.index)) {
        const outputs = [...cell.outputs];
        outputs[Number(patch.index)] = patch.output;
        cell.outputs = outputs;
      } else if (patch.kind === "executionCount") {
        cell.executionCount = patch.value ?? cell.executionCount;
      } else if (patch.kind === "status") {
        cell.status = text(patch.state) || cell.status;
      }
    }
    renderWorkspace();
    requestAnimationFrame(() => {
      workspaceEl.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cell.id)}"]`)
        ?.scrollIntoView({ block: "center" });
    });
  }
  if (detail.phase === "end") {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void loadTab(tab, true), 90);
  }
});

const query = new URLSearchParams(location.search);
const initialView = query.get("view");
if (initialView === "variables" || initialView === "manage" || initialView === "outputs") activeView = initialView;
for (const saved of restoredTabs()) {
  const ref = normalizeRef(saved.ref);
  if (!ref) continue;
  tabs.set(keyFor(ref), { ref, activeCellId: text(saved.activeCellId), loading: false, error: "" });
}
const initial = normalizeRef({
  scriptFile: query.get("scriptFile") || "",
  sourceFile: query.get("sourceFile") || "",
  language: query.get("language") || "python",
  kernel: query.get("kernel") || "python3",
  session: query.get("session") || "default",
});
if (initial) {
  openDocument({ ...initial, cellId: query.get("cellId") || "" });
} else {
  activeScript = tabs.keys().next().value || "";
  render();
  const tab = activeTab();
  if (tab) void loadTab(tab, false);
}
void loadManager(true);
managerTimer = window.setInterval(() => void loadManager(true), 2500);

window.addEventListener("beforeunload", () => {
  window.clearInterval(managerTimer);
  persistTabs();
  disposeOutputs();
  removeThemeRuntime();
}, { once: true });
