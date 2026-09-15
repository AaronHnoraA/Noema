import "../src/styles/aaron-ui-tokens.css";
import "../src/styles/aaron-ui-elegant.css";
import "../src/styles/theme-loader.ts";
import { installB3ComponentSystem } from "../src/b3-component-system.ts";
import "./jupyter-page.css";
import { api } from "./api-client.ts";
import { appendRunEvents, mergeRunRef, runSnapshotMatches } from "./research-run-state.ts";
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
  agent?: string;
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
  outputUi?: { outputFolded?: boolean; outputExpanded?: boolean; liveOutput?: boolean };
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
  runCellId?: string;
  loading: boolean;
  error: string;
  runSeq?: number;
  runEvents?: Array<Record<string, unknown>>;
  runTerminal?: boolean;
  persistedOutputRetries?: number;
  writebackPending?: boolean;
  runSnapshot?: Record<string, unknown>;
  runStartedAt?: number;
  runStreamDetail?: "status" | "full";
  loadGeneration?: number;
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

function runCell(tab: TabState): CellSnapshot | undefined {
  if (tab.runCellId) return tab.snapshot?.cells.find((cell) => cell.id === tab.runCellId);
  return activeCell(tab);
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
  const generation = tab.loadGeneration = (tab.loadGeneration || 0) + 1;
  const requestedRun = tab.ref.runId;
  const current = () => tab === currentDocument && tab.loadGeneration === generation && tab.ref.runId === requestedRun;
  tab.loading = true;
  tab.error = "";
  renderWorkspace();
  try {
    const liveCell = isResearchDocument(tab.ref) ? runCell(tab) : activeCell(tab);
    const liveOutputs = liveCell?.outputs;
    const liveStatus = liveCell?.status;
    const raw = await api.jupyterCell.scriptSnapshot(documentParams(tab));
    if (!current()) return;
    const snapshot = raw as unknown as DocumentSnapshot;
    tab.snapshot = snapshot;
    tab.ref = mergeRunRef(tab.ref, snapshot.document);
    if (!snapshot.cells.some((cell) => cell.id === tab.activeCellId)) {
      tab.activeCellId = snapshot.cells[0]?.id || "";
    }
    if (isResearchDocument(tab.ref) && tab.ref.runId) {
      const cell = runCell(tab);
      if (tab.runTerminal && persistedOutputRunId(cell) !== tab.ref.runId) {
        // The terminal Run event is durable before the notebook output write.
        // Preserve the completed live view while polling the canonical file.
        if (cell && liveOutputs) {
          cell.outputs = liveOutputs;
          cell.status = liveStatus || cell.status;
        }
        tab.writebackPending = true;
        const attempt = tab.persistedOutputRetries || 0;
        const retryDelays = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 300_000];
        tab.persistedOutputRetries = attempt + 1;
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(
          () => void loadTab(tab, false),
          retryDelays[Math.min(attempt, retryDelays.length - 1)],
        );
      } else {
        tab.persistedOutputRetries = 0;
        tab.writebackPending = false;
        if (tab.runTerminal) {
          // The canonical .noema output now owns the completed view. Drop the
          // provisional Run projection so rendering matches an ordinary Jupyter
          // cell after execution finishes.
          tab.runSnapshot = undefined;
          tab.runEvents = [];
        } else {
          startResearchRunStream(tab);
        }
      }
    }
  } catch (error) {
    if (current()) tab.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (!current()) return;
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
    sessionName: research ? text(payload.sessionName) : text(payload.sessionName || payload.session) || "default",
    sessionId: text(payload.sessionId),
    runId: text(payload.runId),
    agent: text(payload.agent),
  };
}

function openDocument(payload: Partial<DocumentRef> & { cellId?: string }): void {
  const ref = normalizeRef(payload);
  if (!ref) return;
  window.clearTimeout(refreshTimer);
  let tab = currentDocument?.ref.scriptFile === ref.scriptFile ? currentDocument : undefined;
  if (!tab) {
    // The output page is a projection of the Emacs-selected document, not a
    // browser-owned multi-document workspace.
    stopResearchRunStream();
    tab = {
      ref,
      activeCellId: text(payload.cellId),
      runCellId: text(payload.cellId),
      loading: false,
      error: "",
      runSeq: 0,
      runEvents: [],
    };
  } else {
    if (ref.runId && ref.runId !== tab.ref.runId) {
      stopResearchRunStream();
      tab.runSeq = 0;
      tab.runEvents = [];
      tab.runTerminal = false;
      tab.persistedOutputRetries = 0;
      tab.writebackPending = false;
      tab.runSnapshot = undefined;
      tab.runStartedAt = undefined;
      tab.runStreamDetail = undefined;
      tab.runCellId = text(payload.cellId) || tab.activeCellId;
    }
    tab.ref = mergeRunRef(tab.ref, ref);
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

function terminalRunStatus(status: string): boolean {
  return ["completed", "cancelled", "failed", "interrupted"].includes(status);
}

function runValue(tab: TabState, key: string): string {
  const run = tab.runSnapshot?.run;
  const value = run && typeof run === "object" ? (run as Record<string, unknown>)[key] : undefined;
  return text(value);
}

function renderResearchRunStatus(tab: TabState, cell: CellSnapshot, target?: HTMLElement): void {
  const output = target || cellCard(cell)?.querySelector<HTMLElement>(".noema-jupyter-output");
  if (!output || !tab.runSnapshot || cell.outputUi?.liveOutput === true) return;
  output.hidden = false;
  const status = runValue(tab, "status") || cell.status || "running";
  const started = Date.parse(runValue(tab, "startedAt")) || tab.runStartedAt || Date.now();
  tab.runStartedAt ||= started;
  const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const panel = document.createElement("section");
  panel.className = "noema-research-run-status";
  const line = document.createElement("div");
  line.className = "noema-research-run-summary";
  const spinner = document.createElement("span");
  spinner.className = "noema-research-run-spinner";
  spinner.textContent = terminalRunStatus(status) ? "●" : "◌";
  const summary = document.createElement("strong");
  summary.textContent = terminalRunStatus(status)
    ? `${status}${tab.writebackPending ? " · saving output…" : ""}`
    : `${status} · ${elapsed}s`;
  line.append(spinner, summary);
  const meta = document.createElement("div");
  meta.className = "noema-research-run-meta";
  meta.textContent = [
    tab.ref.agent || runValue(tab, "agent"),
    tab.ref.sessionName || runValue(tab, "sessionName"),
    tab.ref.sessionId || runValue(tab, "sessionId"),
  ].filter(Boolean).join(" · ");
  const actions = document.createElement("div");
  actions.className = "noema-research-run-actions";
  actions.append(
    button("Open Agent", "Open this Session's interactive agent buffer", () => api.emacs.openResearchSession({
      root: tab.ref.projectRoot || "",
      runId: tab.ref.runId || runValue(tab, "id"),
      sessionId: tab.ref.sessionId || runValue(tab, "sessionId"),
      name: tab.ref.sessionName || runValue(tab, "sessionName"),
    })),
    button("Open Source", "Jump to this work cell in Emacs", () => openSource(cell)),
  );
  if (!terminalRunStatus(status)) {
    actions.append(button("Cancel Run", "Cancel this exact durable Run", async () => {
      const requestedRun = tab.ref.runId;
      const result = await api.research.cancelRun({
        root: tab.ref.projectRoot || "",
        runId: tab.ref.runId || runValue(tab, "id"),
      });
      if (tab !== currentDocument || tab.ref.runId !== requestedRun) return;
      const run = result.run as Record<string, unknown> | undefined;
      if (run && terminalRunStatus(text(run.status))) {
        applyResearchRunSnapshot(tab, { run, events: [], seq: tab.runSeq || 0 });
        setStatus(`Run ${text(run.status)}`);
      } else {
        setStatus(result.delivered === false ? "Cancel could not reach the worker; recheck completion" : "Cancelling… checking worker completion", result.delivered === false);
        window.setTimeout(() => {
          if (tab === currentDocument && tab.ref.runId === requestedRun && !tab.runTerminal) {
            void checkResearchCompletion(tab, cell).catch((error) => setStatus(String(error), true));
          }
        }, 3500);
      }
    }, "is-danger"));
  }
  panel.append(line, meta, actions);
  output.replaceChildren(panel);
}

function applyResearchRunSnapshot(tab: TabState, snapshot: Record<string, unknown>): void {
  if (tab !== currentDocument || !runSnapshotMatches(tab.ref.runId, snapshot)) return;
  tab.runSnapshot = snapshot;
  const run = snapshot.run && typeof snapshot.run === "object" ? snapshot.run as Record<string, unknown> : {};
  const incoming = Array.isArray(snapshot.events) ? snapshot.events.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
  if (runCell(tab)?.outputUi?.liveOutput === true) {
    tab.runEvents = appendRunEvents(tab.runEvents || [], incoming);
  }
  tab.runSeq = Math.max(Number(snapshot.seq) || 0, tab.runSeq || 0);
  const cell = runCell(tab);
  if (!cell) return;
  cell.status = text(run.status) || "running";
  updateCellChrome(cell);
  if (cell.outputUi?.liveOutput === true) {
    const content = (tab.runEvents || [])
      .filter((item) => eventType(item) === "run.content.segment")
      .map((item) => typeof eventPayload(item).text === "string" ? eventPayload(item).text : "").join("");
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
    const view = ensureCellOutputView(tab, cell);
    view?.clear();
    outputs.forEach((output, index) => view?.setOutput(index, output));
  } else {
    renderResearchRunStatus(tab, cell);
  }
  const terminal = terminalRunStatus(cell.status) && snapshot.hasMore !== true;
  tab.runTerminal = terminal;
  if (terminal) {
    stopResearchRunStream();
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void loadTab(tab, false), 90);
  }
}

function startResearchRunStream(tab: TabState): void {
  if (tab !== currentDocument || !tab.ref.runId || tab.runTerminal || researchRunSource) return;
  const detail = runCell(tab)?.outputUi?.liveOutput === true ? "full" : "status";
  tab.runStreamDetail = detail;
  const params = new URLSearchParams({
    root: tab.ref.projectRoot || "",
    run: tab.ref.runId,
    after: String(tab.runSeq || 0),
    detail,
  });
  const source = new EventSource(`/api/noema/research/run/stream?${params}`);
  researchRunSource = source;
  source.addEventListener("snapshot", (event) => {
    if (researchRunSource !== source) return;
    try { applyResearchRunSnapshot(tab, JSON.parse((event as MessageEvent<string>).data)); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Invalid Run stream snapshot", true); }
  });
  source.addEventListener("error", () => {
    source.close();
    if (researchRunSource !== source) return;
    researchRunSource = null;
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
  try {
    await api.jupyterCell.saveScriptCellOutputUi(documentParams(tab, {
      cellId: cell.id,
      outputFolded: cell.outputUi?.outputFolded === true,
      outputExpanded: cell.outputUi?.outputExpanded === true,
      liveOutput: cell.outputUi?.liveOutput === true,
    }));
  } catch {}
}

async function toggleResearchLiveOutput(tab: TabState, cell: CellSnapshot): Promise<void> {
  cell.outputUi = { ...cell.outputUi, liveOutput: cell.outputUi?.liveOutput !== true };
  await saveOutputUi(tab, cell);
  if (tab.ref.runId && !tab.runTerminal && cell.id === tab.runCellId) {
    stopResearchRunStream();
    tab.runSeq = 0;
    tab.runEvents = [];
    tab.runSnapshot = undefined;
    startResearchRunStream(tab);
  }
  renderWorkspace();
  setStatus(cell.outputUi.liveOutput
    ? "Live output remembered for this cell"
    : "Live output disabled; showing lightweight Run status");
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

async function checkResearchCompletion(tab: TabState, cell: CellSnapshot): Promise<void> {
  const expectedRunId = tab.ref.runId;
  setStatus("Checking protocol completion and saved output…");
  const result = await api.research.checkRunCompletion({
    root: tab.ref.projectRoot || "", file: tab.ref.scriptFile, cellId: cell.id,
    runId: cell.id === (tab.runCellId || tab.activeCellId) ? tab.ref.runId : undefined,
  });
  if (tab !== currentDocument || tab.ref.runId !== expectedRunId) return;
  const run = result.run as Record<string, unknown> | undefined;
  if (run && text(run.id)) {
    if (text(run.id) !== tab.ref.runId) {
      openDocument({ ...tab.ref, cellId: cell.id, runId: text(run.id), sessionId: text(run.sessionId) });
    }
    applyResearchRunSnapshot(tab, { run, events: [], seq: tab.runSeq || 0 });
  }
  const writeback = result.result as { error?: string; skipped?: string } | undefined;
  if (writeback?.error) setStatus(`Run ended; output save failed: ${writeback.error}`, true);
  else if (writeback?.skipped) setStatus("Run ended; newer Run output preserved");
  else if (result.detection === "terminal") setStatus(`Run ${text(run?.status)} · output reconciled`);
  else if (result.detection === "no-run") setStatus("This work cell has no Run to check");
  else if (result.detection === "worker-unavailable") setStatus("Worker unavailable; cannot confirm completion. Expired leases are marked interrupted, never completed.", true);
  else setStatus("Completion check sent to worker; waiting for protocol confirmation");
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
    ...(isResearchDocument(tab.ref) ? [
      menuItem("Recheck Completion", "重新检测结束：核对 ACP 完成回执、Run 状态和输出回写，不重新执行任务", () => checkResearchCompletion(tab, cell)),
      menuItem(
        cell.outputUi?.liveOutput ? "Stop Remembering Live Output" : "Remember This Cell · Live Output",
        "Persist whether this work cell streams provisional output",
        () => toggleResearchLiveOutput(tab, cell),
      ),
    ] : []),
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
  if (isResearchDocument(tab.ref) && tab.runSnapshot && cell.id === (tab.runCellId || tab.activeCellId)) {
    renderResearchRunStatus(tab, cell, output);
  }
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
  tab.loadGeneration = (tab.loadGeneration || 0) + 1;
  tab.loading = false;
  window.clearTimeout(refreshTimer);
  refreshTimer = 0;
  tab.snapshot = snapshot;
  tab.ref = mergeRunRef(tab.ref, snapshot.document);
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
  if (tab) {
    void loadTab(tab, false);
  } else {
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
// Elapsed time is a local display concern; unchanged server snapshots need
// neither network traffic nor a replacement output panel.
const runClock = window.setInterval(() => {
  const tab = currentDocument;
  if (!tab?.runSnapshot || tab.runTerminal || !tab.runStartedAt) return;
  const cell = runCell(tab);
  if (!cell || cell.outputUi?.liveOutput === true) return;
  const summary = cellCard(cell)?.querySelector(".noema-research-run-summary strong");
  if (summary) summary.textContent = `${runValue(tab, "status") || cell.status} · ${Math.max(0, Math.floor((Date.now() - tab.runStartedAt) / 1000))}s`;
}, 1000);

window.addEventListener("beforeunload", () => {
  window.clearInterval(runClock);
  stopResearchRunStream();
  dialogOutputDispose?.();
  disposeOutputs();
  removeB3ComponentSystem();
  removeThemeRuntime();
}, { once: true });
