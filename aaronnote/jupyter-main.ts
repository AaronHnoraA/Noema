import "../src/styles/aaron-ui-tokens.css";
import "../src/styles/aaron-ui-elegant.css";
import "../src/styles/theme-loader.ts";
import { installB3ComponentSystem } from "../src/b3-component-system.ts";
import "./jupyter-page.css";
import { api } from "./api-client.ts";
import { renderJupyterOutputs } from "../src/jupyter-rendermime.ts";
import type { JupyterMarkdownParser, JupyterOutputView, WidgetMountFn } from "../src/jupyter-rendermime.ts";
import type { JupyterWidgetKernelMessage } from "../src/jupyter-widget-runtime.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import { installNoemaThemeRuntime, loadNoemaAppConfig } from "./theme-runtime.ts";

type DocumentRef = {
  scriptFile: string;
  sourceFile: string;
  projectRoot?: string;
  language: string;
  kernel: string;
  session: string;
  kernelSpecName?: string;
  kernelId?: string;
  sessionName?: string;
  sessionId?: string;
  runId?: string;
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
  runSeq?: number;
  runEvents?: Array<Record<string, unknown>>;
  runTerminal?: boolean;
  persistedOutputRetries?: number;
};

declare global {
  interface Window {
    noemaJupyterOpenDocument?: (payload: Partial<DocumentRef> & { cellId?: string; runId?: string }) => void;
    noemaJupyterOpenView?: (view: "outputs" | "variables" | "manage") => void;
  }
}

const removeThemeRuntime = installNoemaThemeRuntime();
const removeB3ComponentSystem = installB3ComponentSystem(document.body);
void loadNoemaAppConfig().catch(() => {});

let currentDocument: TabState | undefined;
let statusTimer = 0;
let refreshTimer = 0;
const outputDisposers = new Set<() => void>();
const cellOutputViews = new Map<string, JupyterOutputView>();
let dialogOutputDispose: (() => void) | null = null;
let researchRunSource: EventSource | null = null;
let researchRunRetry = 0;

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

const noemaMarkdownParser: JupyterMarkdownParser = {
  async render(source: string): Promise<string> {
    return renderMarkdownHTML(source);
  },
};

const app = document.createElement("main");
app.className = "noema-jupyter-page noema-jupyter-output-surface";
app.innerHTML = `
  <header class="noema-jupyter-header">
    <div class="noema-jupyter-brand">
      <span class="noema-jupyter-logo">N</span>
      <strong data-surface-title>Jupyter Output</strong>
    </div>
    <div class="noema-jupyter-kernel" data-kernel-status></div>
    <button type="button" class="noema-jupyter-open-source" data-action="open-source">Open Source in Emacs</button>
  </header>
  <div class="noema-jupyter-shell">
    <section class="noema-jupyter-workspace" data-workspace></section>
  </div>
  <div class="noema-jupyter-status" role="status" data-status></div>
  <div class="noema-jupyter-context-menu" role="menu" data-context-menu hidden></div>
  <dialog class="noema-jupyter-dialog" data-dialog>
    <header><strong data-dialog-title></strong><button type="button" data-dialog-close>×</button></header>
    <div class="noema-jupyter-dialog-body" data-dialog-body></div>
  </dialog>
`;
document.body.append(app);

const workspaceEl = app.querySelector<HTMLElement>("[data-workspace]")!;
const statusEl = app.querySelector<HTMLElement>("[data-status]")!;
const kernelStatusEl = app.querySelector<HTMLElement>("[data-kernel-status]")!;
const surfaceTitleEl = app.querySelector<HTMLElement>("[data-surface-title]")!;
const dialogEl = app.querySelector<HTMLDialogElement>("[data-dialog]")!;
const dialogTitleEl = app.querySelector<HTMLElement>("[data-dialog-title]")!;
const dialogBodyEl = app.querySelector<HTMLElement>("[data-dialog-body]")!;
const contextMenuEl = app.querySelector<HTMLElement>("[data-context-menu]")!;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function setStatus(message: string, error = false): void {
  statusEl.textContent = message;
  statusEl.dataset.error = error ? "true" : "false";
  statusEl.classList.add("is-visible");
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => statusEl.classList.remove("is-visible"), 4500);
}

function documentParams(tab: TabState, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...tab.ref, ...extra };
}

function isResearchDocument(value: DocumentRef | string | undefined): boolean {
  const file = typeof value === "string" ? value : value?.scriptFile;
  return /\.noema$/i.test(text(file));
}

function activeTab(): TabState | undefined {
  return currentDocument;
}

function activeCell(tab = activeTab()): CellSnapshot | undefined {
  if (!tab?.snapshot) return undefined;
  return tab.snapshot.cells.find((cell) => cell.id === tab.activeCellId) || tab.snapshot.cells[0];
}

function persistedOutputRunId(cell: CellSnapshot | undefined): string {
  for (const output of cell?.outputs || []) {
    if (!output || typeof output !== "object") continue;
    const data = (output as { data?: unknown }).data;
    if (!data || typeof data !== "object") continue;
    const run = (data as Record<string, unknown>)["application/vnd.noema.run+json"];
    if (run && typeof run === "object") return text((run as Record<string, unknown>).run_id);
  }
  return "";
}

function disposeOutputs(): void {
  for (const dispose of outputDisposers) {
    try { dispose(); } catch {}
  }
  outputDisposers.clear();
  cellOutputViews.clear();
}

function cellOutputKey(tab: TabState, cell: CellSnapshot): string {
  return `${tab.ref.scriptFile}\0${cell.id}`;
}

function registerCellOutputView(tab: TabState, cell: CellSnapshot, view: JupyterOutputView): void {
  cellOutputViews.set(cellOutputKey(tab, cell), view);
  outputDisposers.add(view);
}

function cellCard(cell: CellSnapshot): HTMLElement | null {
  return workspaceEl.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cell.id)}"]`);
}

function ensureCellOutputView(tab: TabState, cell: CellSnapshot): JupyterOutputView | null {
  const key = cellOutputKey(tab, cell);
  const existing = cellOutputViews.get(key);
  if (existing) return existing;
  const output = cellCard(cell)?.querySelector<HTMLElement>(".noema-jupyter-output");
  if (!output) return null;
  output.hidden = false;
  output.replaceChildren();
  const view = renderJupyterOutputs(output, [], outputRenderOptions(cell));
  registerCellOutputView(tab, cell, view);
  installAutomaticOutputFold(tab, cell, output);
  return view;
}

function isWidgetOutput(output: unknown): boolean {
  const data = output && typeof output === "object" ? (output as { data?: unknown }).data : null;
  return Boolean(
    data && typeof data === "object"
    && "application/vnd.jupyter.widget-view+json" in data
  );
}

function updateCellChrome(cell: CellSnapshot): void {
  const card = cellCard(cell);
  if (!card) return;
  card.dataset.status = cell.status || "idle";
  const prompt = card.querySelector<HTMLElement>(".noema-jupyter-prompt");
  if (prompt) prompt.textContent = isResearchDocument(activeTab()?.ref)
    ? "Work"
    : cell.executionCount == null ? "[ ]" : `[${cell.executionCount}]`;
  const status = card.querySelector<HTMLElement>(".noema-jupyter-badges span:first-child");
  if (status) status.textContent = cell.status || "idle";
}

function selectCell(tab: TabState, cellId: string, focus = false): void {
  tab.activeCellId = cellId;
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
    const liveCell = activeCell(tab);
    const liveOutputs = liveCell?.outputs;
    const liveStatus = liveCell?.status;
    const raw = await api.jupyterCell.scriptSnapshot(documentParams(tab));
    const snapshot = raw as unknown as DocumentSnapshot;
    tab.snapshot = snapshot;
    tab.ref = { ...tab.ref, ...snapshot.document };
    if (!snapshot.cells.some((cell) => cell.id === tab.activeCellId)) {
      tab.activeCellId = snapshot.cells[0]?.id || "";
    }
    if (isResearchDocument(tab.ref) && tab.ref.runId) {
      const cell = activeCell(tab);
      if (tab.runTerminal && persistedOutputRunId(cell) !== tab.ref.runId) {
        // The terminal Run event is durable before the notebook output write.
        // Preserve the completed live view while polling the canonical file.
        if (cell && liveOutputs) {
          cell.outputs = liveOutputs;
          cell.status = liveStatus || cell.status;
        }
        if ((tab.persistedOutputRetries || 0) < 20) {
          tab.persistedOutputRetries = (tab.persistedOutputRetries || 0) + 1;
          window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => void loadTab(tab, false), 250);
        } else {
          setStatus("Run completed, but its persisted work output is not available yet.", true);
        }
      } else {
        tab.persistedOutputRetries = 0;
        startResearchRunStream(tab);
      }
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

function normalizeRef(payload: Partial<DocumentRef>): DocumentRef | null {
  const scriptFile = text(payload.scriptFile);
  if (!scriptFile) return null;
  const research = isResearchDocument(scriptFile);
  return {
    scriptFile,
    sourceFile: text(payload.sourceFile),
    projectRoot: text(payload.projectRoot),
    language: research ? "" : text(payload.language) || "python",
    kernel: research ? "" : text(payload.kernel) || "python3",
    session: research ? "" : text(payload.session) || "default",
    kernelSpecName: research ? "" : text(payload.kernelSpecName || payload.kernel) || "python3",
    kernelId: text(payload.kernelId),
    sessionName: research ? "" : text(payload.sessionName || payload.session) || "default",
    sessionId: text(payload.sessionId),
    runId: text(payload.runId),
  };
}

function openDocument(payload: Partial<DocumentRef> & { cellId?: string }): void {
  const ref = normalizeRef(payload);
  if (!ref) return;
  let tab = currentDocument?.ref.scriptFile === ref.scriptFile ? currentDocument : undefined;
  if (!tab) {
    // The output page is a projection of the Emacs-selected document, not a
    // browser-owned multi-document workspace.
    stopResearchRunStream();
    tab = { ref, activeCellId: text(payload.cellId), loading: false, error: "", runSeq: 0, runEvents: [] };
  } else {
    if (ref.runId && ref.runId !== tab.ref.runId) {
      stopResearchRunStream();
      tab.runSeq = 0;
      tab.runEvents = [];
      tab.runTerminal = false;
      tab.persistedOutputRetries = 0;
    }
    tab.ref = { ...tab.ref, ...ref };
    if (payload.cellId) tab.activeCellId = text(payload.cellId);
  }
  currentDocument = tab;
  render();
  void loadTab(tab);
}

function stopResearchRunStream(): void {
  window.clearTimeout(researchRunRetry);
  researchRunRetry = 0;
  researchRunSource?.close();
  researchRunSource = null;
}

function eventType(event: Record<string, unknown>): string {
  return text(event.type);
}

function eventPayload(event: Record<string, unknown>): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
}

function applyResearchRunSnapshot(tab: TabState, snapshot: Record<string, unknown>): void {
  if (tab !== currentDocument) return;
  const run = snapshot.run && typeof snapshot.run === "object" ? snapshot.run as Record<string, unknown> : {};
  const incoming = Array.isArray(snapshot.events) ? snapshot.events.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
  const seen = new Set((tab.runEvents || []).map((item) => Number(item.seq) || 0));
  tab.runEvents = [...(tab.runEvents || []), ...incoming.filter((item) => !seen.has(Number(item.seq) || 0))];
  tab.runSeq = Math.max(Number(snapshot.seq) || 0, tab.runSeq || 0);
  const cell = activeCell(tab);
  if (!cell) return;
  const content = (tab.runEvents || [])
    .filter((item) => eventType(item) === "run.content.segment")
    .map((item) => text(eventPayload(item).text)).join("");
  const activity = (tab.runEvents || []).filter((item) => (
    eventType(item) === "run.action.updated" || eventType(item).includes("permission")
  ));
  const outputs: unknown[] = [];
  if (content) outputs.push({
    output_type: "display_data",
    data: { "text/markdown": content, "text/plain": content },
    metadata: {},
  });
  if (activity.length || !content) outputs.push({
    output_type: "display_data",
    data: { "application/vnd.noema.run+json": { ...snapshot, events: tab.runEvents } },
    metadata: {},
  });
  cell.outputs = outputs;
  cell.status = text(run.status) || "running";
  const view = ensureCellOutputView(tab, cell);
  view?.clear();
  outputs.forEach((output, index) => view?.setOutput(index, output));
  updateCellChrome(cell);
  const terminal = ["completed", "cancelled", "failed", "interrupted"].includes(cell.status);
  tab.runTerminal = terminal;
  if (terminal) {
    stopResearchRunStream();
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void loadTab(tab, false), 90);
  }
}

function startResearchRunStream(tab: TabState): void {
  if (tab !== currentDocument || !tab.ref.runId || tab.runTerminal || researchRunSource) return;
  const params = new URLSearchParams({
    root: tab.ref.projectRoot || "",
    run: tab.ref.runId,
    after: String(tab.runSeq || 0),
  });
  const source = new EventSource(`/api/noema/research/run/stream?${params}`);
  researchRunSource = source;
  source.addEventListener("snapshot", (event) => {
    try { applyResearchRunSnapshot(tab, JSON.parse((event as MessageEvent<string>).data)); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Invalid Run stream snapshot", true); }
  });
  source.addEventListener("error", () => {
    source.close();
    if (researchRunSource === source) researchRunSource = null;
    if (tab === currentDocument && !tab.runTerminal) {
      window.clearTimeout(researchRunRetry);
      researchRunRetry = window.setTimeout(() => startResearchRunStream(tab), 500);
    }
  });
}

window.noemaJupyterOpenDocument = openDocument;
window.noemaJupyterOpenView = () => {
  // Kept as a wire-compatible hook.  The only supported projection is rich
  // output; variables, sessions and kernel management belong to Emacs.
  render();
};

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

function openDialog(title: string): void {
  dialogTitleEl.textContent = title;
  if (!dialogEl.open) dialogEl.showModal();
}

async function openSource(cell = activeCell()): Promise<void> {
  const tab = activeTab();
  if (!tab || !cell) return;
  await api.emacs.selectJupyterCell({ scriptFile: tab.ref.scriptFile, cellId: cell.id });
}

function activateCell(tab: TabState, cellId: string): void {
  tab.activeCellId = cellId;
  for (const item of workspaceEl.querySelectorAll<HTMLElement>(".noema-jupyter-cell")) {
    item.dataset.active = item.dataset.cellId === cellId ? "true" : "false";
  }
}

async function saveOutputUi(tab: TabState, cell: CellSnapshot): Promise<void> {
  if (isResearchDocument(tab.ref)) return;
  try {
    await api.jupyterCell.saveScriptCellOutputUi(documentParams(tab, {
      cellId: cell.id,
      outputFolded: cell.outputUi?.outputFolded === true,
      outputExpanded: cell.outputUi?.outputExpanded === true,
    }));
  } catch {}
}

function outputRenderOptions(cell: CellSnapshot) {
  return {
    widgetRuntime: cell.widgetRuntime,
    widgetMessages: cell.widgetMessages,
    widgetOutputs: cell.widgetOutputs,
    mountWidget,
    markdownParser: noemaMarkdownParser,
  };
}

function installAutomaticOutputFold(tab: TabState, cell: CellSnapshot, output: HTMLElement): void {
  if (output.hidden || cell.outputUi?.outputExpanded === true) return;
  let observer: ResizeObserver | null = null;
  const collapseIfLong = () => {
    if (!output.isConnected || output.hidden || output.classList.contains("is-auto-collapsed")) return;
    if (output.scrollHeight <= 360) return;
    output.classList.add("is-auto-collapsed");
    const expand = button("Show full output", "Expand long output", async () => {
      output.classList.remove("is-auto-collapsed");
      expand.remove();
      observer?.disconnect();
      cell.outputUi = { ...cell.outputUi, outputExpanded: true, outputFolded: false };
      await saveOutputUi(tab, cell);
    }, "noema-jupyter-output-expander");
    output.append(expand);
    observer?.disconnect();
  };
  observer = new ResizeObserver(collapseIfLong);
  observer.observe(output);
  outputDisposers.add(() => observer?.disconnect());
  requestAnimationFrame(collapseIfLong);
}

function popoutCellOutput(cell: CellSnapshot): void {
  dialogOutputDispose?.();
  dialogOutputDispose = null;
  dialogBodyEl.replaceChildren();
  dialogBodyEl.classList.add("noema-jupyter-popout-output");
  openDialog(`Output · ${cell.id}`);
  if (cell.outputs.length === 0) {
    dialogBodyEl.textContent = "No output";
    return;
  }
  dialogOutputDispose = renderJupyterOutputs(dialogBodyEl, cell.outputs, outputRenderOptions(cell));
}

function closeCellMenu(): void {
  contextMenuEl.hidden = true;
  contextMenuEl.replaceChildren();
}

function openCellMenu(tab: TabState, cell: CellSnapshot, x: number, y: number): void {
  activateCell(tab, cell.id);
  const menuItem = (
    label: string,
    title: string,
    run: () => void | Promise<void>,
    danger = false,
  ): HTMLButtonElement => {
    const result = button(label, title, () => {
      closeCellMenu();
      return run();
    }, danger ? "is-danger" : "");
    result.setAttribute("role", "menuitem");
    return result;
  };
  contextMenuEl.replaceChildren(
    menuItem("Open Source in Emacs", "Jump to source", () => openSource(cell)),
    menuItem("Pop Out Output", "Open full output in a resizable dialog", () => popoutCellOutput(cell)),
    menuItem(cell.outputUi?.outputFolded ? "Show Output" : "Fold Output", "Toggle output visibility", async () => {
      cell.outputUi = { ...cell.outputUi, outputFolded: !cell.outputUi?.outputFolded };
      await saveOutputUi(tab, cell);
      renderWorkspace();
    }),
    ...(cell.outputUi?.outputExpanded ? [
      menuItem("Use Compact Output", "Limit long output to its own scroll area", async () => {
        cell.outputUi = { ...cell.outputUi, outputExpanded: false, outputFolded: false };
        await saveOutputUi(tab, cell);
        renderWorkspace();
      }),
    ] : []),
  );
  contextMenuEl.hidden = false;
  const width = contextMenuEl.offsetWidth;
  const height = contextMenuEl.offsetHeight;
  contextMenuEl.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  contextMenuEl.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  contextMenuEl.querySelector<HTMLButtonElement>("button")?.focus();
}

function appendStdinForm(output: HTMLElement, cell: CellSnapshot): void {
  output.querySelector(".noema-jupyter-stdin")?.remove();
  if (!cell.stdin) return;
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
    stdin.remove();
  });
  stdin.append(label, input, submit, cancel);
  stdin.addEventListener("submit", (event) => {
    event.preventDefault();
    const runId = cell.stdin?.runId || "";
    void api.jupyterCell.inputReply({ runId, value: input.value }).finally(() => {
      delete cell.stdin;
      stdin.remove();
    });
  });
  output.append(stdin);
  requestAnimationFrame(() => input.focus());
}

function renderCell(tab: TabState, cell: CellSnapshot): HTMLElement {
  const card = document.createElement("article");
  card.className = "noema-jupyter-cell";
  card.dataset.cellId = cell.id;
  card.dataset.active = cell.id === tab.activeCellId ? "true" : "false";
  card.dataset.status = cell.status || "idle";
  card.tabIndex = 0;
  card.addEventListener("focus", () => {
    if (tab.activeCellId !== cell.id) activateCell(tab, cell.id);
  });
  card.addEventListener("click", (event) => {
    activateCell(tab, cell.id);
    const target = event.target as Element | null;
    // Do not steal DOM focus from live ipywidgets, stdin, links, or rendered
    // HTML controls.  The card becomes active, while the interactive output
    // keeps owning keyboard/pointer input.
    if (!target?.closest("button, input, select, textarea, a, [contenteditable='true'], .jupyter-widgets")) {
      card.focus({ preventScroll: true });
    }
  });
  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openCellMenu(tab, cell, event.clientX, event.clientY);
  });

  const head = document.createElement("header");
  head.className = "noema-jupyter-cell-header";
  const prompt = document.createElement("span");
  prompt.className = "noema-jupyter-prompt";
  prompt.textContent = isResearchDocument(tab.ref)
    ? "Work"
    : cell.executionCount == null ? "[ ]" : `[${cell.executionCount}]`;
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
  actions.append(button("•••", "Cell actions", () => {
    const rect = actions.getBoundingClientRect();
    openCellMenu(tab, cell, rect.right, rect.bottom + 4);
  }, "noema-jupyter-more-button"));
  head.append(prompt, identity, badges, actions);

  const output = document.createElement("div");
  output.className = "noema-jupyter-output";
  if (cell.outputUi?.outputFolded) output.hidden = true;
  if (Array.isArray(cell.outputs) && cell.outputs.length > 0) {
    registerCellOutputView(tab, cell, renderJupyterOutputs(output, cell.outputs, outputRenderOptions(cell)));
    installAutomaticOutputFold(tab, cell, output);
  } else {
    const empty = document.createElement("div");
    empty.className = "noema-jupyter-output-empty";
    empty.textContent = cell.status === "error" ? "Execution failed" : "No output";
    output.append(empty);
  }
  appendStdinForm(output, cell);
  card.append(head, output);
  return card;
}

function renderWorkspace(): void {
  disposeOutputs();
  const tab = activeTab();
  const research = isResearchDocument(tab?.ref);
  surfaceTitleEl.textContent = research ? "Work Output" : "Jupyter Output";
  kernelStatusEl.hidden = research;
  kernelStatusEl.textContent = research ? "" : tab?.snapshot
    ? `${tab.ref.kernel} · ${tab.ref.session} · ${tab.snapshot.kernelStatus}`
    : "No kernel";
  if (!tab) {
    workspaceEl.innerHTML = `<div class="noema-jupyter-empty"><strong>No output selected</strong><span>Open a work block in Emacs and run it with C-c C-c.</span></div>`;
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
    workspaceEl.innerHTML = `<div class="noema-jupyter-empty"><strong>No output yet</strong><span>Run a work block from Emacs.</span></div>`;
    return;
  }
  workspaceEl.replaceChildren(...cells.map((cell) => renderCell(tab, cell)));
}

function render(): void {
  renderWorkspace();
}

app.querySelector("[data-action='open-source']")?.addEventListener("click", () => void openSource());
function closeDialog(): void {
  dialogOutputDispose?.();
  dialogOutputDispose = null;
  dialogBodyEl.classList.remove("noema-jupyter-popout-output");
  dialogEl.close();
}

app.querySelector("[data-dialog-close]")?.addEventListener("click", closeDialog);
dialogEl.addEventListener("click", (event) => {
  if (event.target === dialogEl) closeDialog();
});
window.addEventListener("pointerdown", (event) => {
  if (!contextMenuEl.hidden && !(event.target as Element | null)?.closest("[data-context-menu]")) {
    closeCellMenu();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !contextMenuEl.hidden) {
    event.preventDefault();
    closeCellMenu();
    return;
  }
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
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const next = tab.snapshot?.cells[cell.index + (event.key === "ArrowUp" ? -1 : 1)];
    if (next) selectCell(tab, next.id, true);
    return;
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
  const tab = currentDocument;
  if (tab && tab.ref.scriptFile !== text(detail?.scriptFile)
      && tab.ref.sourceFile !== text(detail?.file)) return;
  if (!tab) return;
  const cell = tab.snapshot?.cells.find((item) => item.id === text(detail.cellId));
  if (cell) {
    const outputView = cellOutputViews.get(cellOutputKey(tab, cell));
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
      if (patch.kind === "clear") {
        cell.outputs = [];
        outputView?.clear();
      }
      else if (patch.kind === "set" && Number.isInteger(patch.index)) {
        const outputs = [...cell.outputs];
        outputs[Number(patch.index)] = patch.output;
        cell.outputs = outputs;
        // Widget display_data arrives before its complete comm transcript and
        // live runtime stamp.  Mounting that partial output starts a control
        // comm while the Cell is still busy, then every later stream/status
        // event used to tear it down and start another one.  Keep the Cell's
        // OutputArea stable and mount the widget once from the authoritative
        // end-of-execution snapshot. Ordinary stream/rich outputs still update
        // in place through JupyterLab's OutputAreaModel.
        if (!isWidgetOutput(patch.output)) {
          ensureCellOutputView(tab, cell)?.setOutput(Number(patch.index), patch.output);
        }
      } else if (patch.kind === "executionCount") {
        cell.executionCount = patch.value ?? cell.executionCount;
      } else if (patch.kind === "status") {
        cell.status = text(patch.state) || cell.status;
      }
    }
    updateCellChrome(cell);
    const output = cellCard(cell)?.querySelector<HTMLElement>(".noema-jupyter-output");
    if (output && detail.phase === "stdin") appendStdinForm(output, cell);
    if (output && detail.phase === "end") output.querySelector(".noema-jupyter-stdin")?.remove();
  }
  if (detail.phase === "end") {
    window.clearTimeout(refreshTimer);
    // Refresh outputs after execution without revealing any Cell.  Cross-view
    // navigation is reserved for the explicit Cmd/M-Enter open command.
    refreshTimer = window.setTimeout(() => void loadTab(tab, false), 90);
  }
});

window.addEventListener("aaronnote:jupyter-session", (event) => {
  const snapshot = (event as CustomEvent<DocumentSnapshot>).detail;
  const scriptFile = text(snapshot?.document?.scriptFile);
  const tab = currentDocument?.ref.scriptFile === scriptFile ? currentDocument : undefined;
  if (!tab || !snapshot?.document) return;
  window.clearTimeout(refreshTimer);
  refreshTimer = 0;
  tab.snapshot = snapshot;
  tab.ref = { ...tab.ref, ...snapshot.document };
  if (!snapshot.cells.some((cell) => cell.id === tab.activeCellId)) {
    tab.activeCellId = snapshot.cells[0]?.id || "";
  }
  render();
});

window.addEventListener("aaronnote:connection", (event) => {
  const detail = (event as CustomEvent<{ status?: string }>).detail;
  if (detail?.status !== "connected") return;
  // Reconcile once after an actual socket connection/reconnection.  Normal
  // synchronization is carried by jupyter-cell/jupyter-session events.
  const tab = currentDocument;
  if (tab) void loadTab(tab, false);
});

const query = new URLSearchParams(location.search);
const initial = normalizeRef({
  scriptFile: query.get("scriptFile") || "",
  sourceFile: query.get("sourceFile") || "",
  projectRoot: query.get("projectRoot") || "",
  language: query.get("language") || "python",
  kernel: query.get("kernel") || "python3",
  session: query.get("session") || "default",
  runId: query.get("runId") || "",
});
if (initial) {
  openDocument({ ...initial, cellId: query.get("cellId") || "" });
} else {
  render();
  const tab = activeTab();
  if (tab) void loadTab(tab, false);
	else {
	  const notebookId = text(query.get("notebookId"));
	  const cellId = text(query.get("cellId"));
	  if (notebookId && cellId) {
		setStatus("Resolving research cell…");
		void api.research.resolveCell({ notebookId, cellId }).then((resolved) => {
		  const scriptFile = text(resolved.file);
		  if (!scriptFile) throw new Error("Research cell resolver returned no notebook file");
		  openDocument({ scriptFile, sourceFile: scriptFile, cellId });
		  setStatus("Research cell opened");
		}).catch((error) => {
		  setStatus(error instanceof Error ? error.message : "Research cell link failed", true);
		});
	  }
	}
}
window.addEventListener("beforeunload", () => {
  stopResearchRunStream();
  dialogOutputDispose?.();
  disposeOutputs();
  removeB3ComponentSystem();
  removeThemeRuntime();
}, { once: true });
