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
import { installHostClipboard } from "./host-clipboard.ts";
import { hostCommandTargetsClient } from "./host-command-target.ts";
import { writeSystemClipboard } from "../src/system-clipboard.ts";
import { installHostKeyboardBridge, pageClientFromLocation } from "./host-keyboard.ts";
import { releaseHostInputFocus } from "./host-input-focus.ts";
import { outputDialogEnterCloses, outputShortcut } from "./jupyter-output-keys.ts";
import { jupyterKernelLabel } from "./jupyter-kernel-view.ts";
import type { JupyterKernelView } from "./jupyter-kernel-view.ts";

// Emacs host keys, host-owned keys and focus handoff: the rule every Noema
// page shares (see host-keyboard.ts).
installHostKeyboardBridge({ client: () => pageClientFromLocation() });

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
  kernelStateLost?: boolean;
  kernelError?: string;
  cells: CellSnapshot[];
};

type TabState = {
  ref: DocumentRef;
  snapshot?: DocumentSnapshot;
  activeCellId: string;
  loading: boolean;
  error: string;
  kernelView?: JupyterKernelView;
  lastSnapshotRetryAt?: number;
  loadGeneration?: number;
};

declare global {
  interface Window {
    noemaJupyterOpenDocument?: (payload: Partial<DocumentRef> & { cellId?: string }) => void;
    noemaJupyterOpenView?: (view: "outputs" | "variables" | "manage") => void;
  }
}

const removeThemeRuntime = installNoemaThemeRuntime();
installHostClipboard();
const pageClient = new URLSearchParams(window.location.search).get("client") || "";
const removeB3ComponentSystem = installB3ComponentSystem(document.body);
void loadNoemaAppConfig().catch(() => {});

let currentDocument: TabState | undefined;
let statusTimer = 0;
let refreshTimer = 0;
let kernelStatusTimer = 0;
let kernelStatusInFlight = false;
const outputDisposers = new Set<() => void>();
const cellOutputViews = new Map<string, JupyterOutputView>();
const outputFoldObservers = new WeakMap<HTMLElement, ResizeObserver>();
const outputFoldDisposalRegistered = new WeakSet<HTMLElement>();
let dialogOutputDispose: (() => void) | null = null;
let dialogReturnFocus: HTMLElement | null = null;

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
    <div class="noema-jupyter-kernel" data-kernel-status role="status" aria-live="polite"></div>
    <button type="button" class="noema-jupyter-shortcuts" data-action="shortcuts" title="Output keyboard shortcuts" aria-label="Output keyboard shortcuts">?</button>
    <button type="button" class="noema-jupyter-open-source" data-action="open-source" title="⌘Enter · Open source in Emacs">Open Source in Emacs</button>
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



function activeTab(): TabState | undefined {
  return currentDocument;
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
  activateCell(tab, cellId);
  const card = workspaceEl.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cellId)}"]`);
  card?.scrollIntoView({ block: "center", behavior: "smooth" });
  if (focus) card?.focus({ preventScroll: true });
}

async function loadTab(tab: TabState, reveal = true): Promise<void> {
  const generation = tab.loadGeneration = (tab.loadGeneration || 0) + 1;
  const current = () => tab === currentDocument && tab.loadGeneration === generation;
  const previousError = tab.error;
  tab.loading = true;
  tab.error = "";
  if (!tab.snapshot) renderWorkspace();
  try {
    const raw = await api.jupyterCell.scriptSnapshot(documentParams(tab));
    if (!current()) return;
    const snapshot = raw as unknown as DocumentSnapshot;
    tab.snapshot = snapshot;
    tab.kernelView = { id: snapshot.document.kernelId, status: snapshot.kernelStatus, stateLost: snapshot.kernelStateLost, lastError: snapshot.kernelError };
    tab.lastSnapshotRetryAt = 0;
    tab.ref = { ...tab.ref, ...snapshot.document };
    if (!snapshot.cells.some((cell) => cell.id === tab.activeCellId)) {
      tab.activeCellId = snapshot.cells[0]?.id || "";
    }
  } catch (error) {
    if (current()) {
      tab.error = error instanceof Error ? error.message : String(error);
      if (!tab.snapshot) tab.kernelView = { status: "unavailable", lastError: tab.error };
    }
  } finally {
    if (!current()) return;
    tab.loading = false;
    if (tab.error && tab.snapshot) {
      // Preserve mounted OutputAreas and widget comms after a Remote failure.
      renderKernelBadge();
      if (tab.error !== previousError) setStatus(`Output refresh unavailable: ${tab.error}`, true);
      return;
    }
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
  if (!scriptFile || /\.noema(?:\.ipynb)?$/i.test(scriptFile)) return null;
  return {
    scriptFile,
    sourceFile: text(payload.sourceFile),
    projectRoot: text(payload.projectRoot),
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
  window.clearTimeout(refreshTimer);
  let tab = currentDocument?.ref.scriptFile === ref.scriptFile ? currentDocument : undefined;
  if (!tab) {
    tab = { ref, activeCellId: text(payload.cellId), loading: false, error: "" };
  } else {
    if (tab.ref.kernel !== ref.kernel || tab.ref.session !== ref.session) {
      tab.snapshot = undefined;
      tab.kernelView = undefined;
      tab.error = "";
    }
    tab.ref = { ...tab.ref, ...ref };
    if (payload.cellId) tab.activeCellId = text(payload.cellId);
  }
  currentDocument = tab;
  ensureKernelStatusPolling();
  render();
  void loadTab(tab);
}

async function pollKernelStatus(): Promise<void> {
  const tab = currentDocument;
  if (kernelStatusInFlight || document.hidden || !tab?.snapshot || tab.loading
      || tab.snapshot.kernelStatus === "no-kernel") return;
  const { scriptFile, sourceFile, projectRoot, kernel, session } = tab.ref;
  kernelStatusInFlight = true;
  try {
    const result = await api.jupyterCell.kernelStatus({
      file: sourceFile || scriptFile, scriptFile, projectRoot, kernel, session,
    });
    if (tab !== currentDocument || tab.ref.kernel !== kernel || tab.ref.session !== session) return;
    const previous = tab.kernelView?.status || tab.snapshot.kernelStatus;
    const previousId = tab.kernelView?.id ?? tab.snapshot.document.kernelId;
    const status = text(result.status) || "unknown";
    tab.kernelView = {
      id: text(result.id),
      status,
      stateLost: result.stateLost === true,
      lastError: text(result.lastError),
    };
    renderKernelBadge();
    // Only a recovered or newly started runtime needs a full output refresh.
    // Ordinary status checks leave mounted OutputAreas and widget comms alone.
    if ((previousId !== tab.kernelView.id && Boolean(tab.kernelView.id))
        || (["disconnected", "dead", "unavailable", "not-started"].includes(previous)
          && !["disconnected", "dead", "unavailable", "not-started"].includes(status))
        || (tab.error && Date.now() - (tab.lastSnapshotRetryAt || 0) >= 15_000)) {
      tab.lastSnapshotRetryAt = Date.now();
      void loadTab(tab, false);
    }
  } catch (error) {
    if (tab !== currentDocument) return;
    tab.kernelView = {
      status: "unavailable",
      stateLost: tab.kernelView?.stateLost,
      lastError: error instanceof Error ? error.message : String(error),
    };
    renderKernelBadge();
  } finally {
    kernelStatusInFlight = false;
  }
}

function ensureKernelStatusPolling(): void {
  if (kernelStatusTimer) return;
  kernelStatusTimer = window.setInterval(() => void pollKernelStatus(), 5_000);
}

















window.noemaJupyterOpenDocument = openDocument;
window.noemaJupyterOpenView = () => {
  // Kept as a wire-compatible hook.  The only supported projection is rich
  // output; variables, sessions and kernel management belong to Emacs.
  render();
};
if (window.portalBridge) {
  window.portalBridge.receive = async (message) => {
    if (message.type === "jupyter-open" && message.payload) {
      const payload = message.payload as Partial<DocumentRef> & { cellId?: string };
      openDocument(payload);
      if ("view" in payload) window.noemaJupyterOpenView?.("outputs");
    } else if (message.type === "core-ready") {
      await api.connection.reconnect("focus");
    }
  };
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

function openDialog(title: string): void {
  dialogTitleEl.textContent = title;
  if (!dialogEl.open) dialogEl.showModal();
}

async function openSource(cell = activeCell()): Promise<void> {
  const tab = activeTab();
  if (!tab || !cell) return;
  try {
    await api.emacs.selectJupyterCell({ scriptFile: tab.ref.scriptFile, cellId: cell.id });
    releaseHostInputFocus();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not open source in Emacs", true);
  }
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
  if (cell.outputUi?.outputExpanded === true || outputFoldObservers.has(output)
      || output.classList.contains("is-auto-collapsed")) return;
  const collapseIfLong = () => {
    if (!output.isConnected || output.hidden || cell.outputUi?.outputExpanded === true
        || output.classList.contains("is-auto-collapsed")) return;
    if (output.scrollHeight <= 360) return;
    output.classList.add("is-auto-collapsed");
    const expand = button("Show full output", "Expand long output (Space)",
      () => setCellOutputExpanded(tab, cell, true), "noema-jupyter-output-expander");
    output.append(expand);
    stopAutomaticOutputFold(output);
  };
  const observer = new ResizeObserver(collapseIfLong);
  outputFoldObservers.set(output, observer);
  observer.observe(output);
  if (!outputFoldDisposalRegistered.has(output)) {
    outputFoldDisposalRegistered.add(output);
    outputDisposers.add(() => stopAutomaticOutputFold(output));
  }
  requestAnimationFrame(collapseIfLong);
}

function stopAutomaticOutputFold(output: HTMLElement): void {
  outputFoldObservers.get(output)?.disconnect();
  outputFoldObservers.delete(output);
}

async function setCellOutputExpanded(tab: TabState, cell: CellSnapshot, expanded: boolean): Promise<void> {
  const output = cellCard(cell)?.querySelector<HTMLElement>(".noema-jupyter-output");
  if (!output) return;
  cell.outputUi = { ...cell.outputUi, outputExpanded: expanded, outputFolded: false };
  output.hidden = false;
  stopAutomaticOutputFold(output);
  output.classList.remove("is-auto-collapsed");
  output.querySelector(".noema-jupyter-output-expander")?.remove();
  if (!expanded) installAutomaticOutputFold(tab, cell, output);
  await saveOutputUi(tab, cell);
}

function popoutCellOutput(cell: CellSnapshot): void {
  const focused = document.activeElement;
  dialogReturnFocus = focused instanceof HTMLElement && workspaceEl.contains(focused)
    ? focused : cellCard(cell);
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

async function toggleCellOutput(tab: TabState, cell: CellSnapshot): Promise<void> {
  const output = cellCard(cell)?.querySelector<HTMLElement>(".noema-jupyter-output");
  if (!output) return;
  const folded = !cell.outputUi?.outputFolded;
  cell.outputUi = { ...cell.outputUi, outputFolded: folded };
  output.hidden = folded;
  await saveOutputUi(tab, cell);
}

function closeCellMenu(): void {
  contextMenuEl.hidden = true;
  contextMenuEl.replaceChildren();
}



/** The page's current non-empty text selection, if any. */
function pageSelectionText(): string {
  const selection = window.getSelection();
  return selection && !selection.isCollapsed ? selection.toString() : "";
}

/** Plain text of CELL's rendered output, as a reader would copy it. */
function cellOutputText(cell: CellSnapshot | undefined): string {
  const output = cell ? cellCard(cell)?.querySelector<HTMLElement>(".noema-jupyter-output") : null;
  return (output?.innerText || output?.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Copy the page selection, or the active cell's whole output when nothing is
 * selected.  Emacs routes Cmd-C here: on the macOS xwidget port WebKit never
 * receives a key Emacs owns, so the page must perform the copy itself.
 */
async function copyOutput(cell = activeCell()): Promise<void> {
  const selected = pageSelectionText();
  const text = selected || cellOutputText(cell);
  if (!text) {
    setStatus("Nothing to copy");
    return;
  }
  const copied = await writeSystemClipboard(text);
  setStatus(copied ? (selected ? "Selection copied" : "Output copied") : "Copy failed", !copied);
}

/** Select the active cell's output text, so the next copy takes all of it. */
function selectActiveOutput(): void {
  const cell = activeCell();
  const output = cell ? cellCard(cell)?.querySelector<HTMLElement>(".noema-jupyter-output") : null;
  const selection = window.getSelection();
  if (!output || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(output);
  selection.removeAllRanges();
  selection.addRange(range);
}

window.addEventListener("noema:command", (event) => {
  const detail = (event as CustomEvent<{ command?: string }>).detail;
  if (!detail || !hostCommandTargetsClient(detail, pageClient)) return;
  switch (String(detail.command || "").toLowerCase()) {
    case "copy":
    case "cut":
      void copyOutput();
      break;
    case "select-all":
      selectActiveOutput();
      break;
    case "focus": {
      if (dialogEl.open) break;
      const cell = activeCell();
      if (cell) cellCard(cell)?.focus({ preventScroll: true });
      break;
    }
    default:
      break;
  }
});

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
  const selected = pageSelectionText();
  contextMenuEl.replaceChildren(
    ...(selected ? [menuItem("Copy", "Copy the selected text", () => copyOutput(cell))] : []),
    menuItem("Copy Output", "Copy this cell's whole output as plain text", async () => {
      const text = cellOutputText(cell);
      const copied = text ? await writeSystemClipboard(text) : false;
      setStatus(copied ? "Output copied" : text ? "Copy failed" : "No output to copy", !copied && Boolean(text));
    }),
    menuItem("Open Source in Emacs", "Jump to source", () => openSource(cell)),
    menuItem("Pop Out Output", "Open full output in a larger window", () => popoutCellOutput(cell)),
    menuItem(cell.outputUi?.outputFolded ? "Show Output" : "Fold Output", "Toggle output visibility (Tab)", () => toggleCellOutput(tab, cell)),
    menuItem(cell.outputUi?.outputExpanded ? "Use Compact Output" : "Show Full Output",
      "Toggle full and compact output (Space)",
      () => setCellOutputExpanded(tab, cell, cell.outputUi?.outputExpanded !== true)),
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
    // A click that ends a text drag must leave that selection for copying.
    if (!pageSelectionText()
        && !target?.closest("button, input, select, textarea, a, [contenteditable='true'], .jupyter-widgets")) {
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

function renderKernelBadge(): void {
  const tab = activeTab();
  const view = tab?.kernelView || (tab?.snapshot
    ? { id: tab.snapshot.document.kernelId, status: tab.snapshot.kernelStatus, stateLost: tab.snapshot.kernelStateLost, lastError: tab.snapshot.kernelError }
    : undefined);
  const label = tab && view ? jupyterKernelLabel(tab.ref.kernel, tab.ref.session, view) : "No kernel";
  if (kernelStatusEl.textContent !== label) kernelStatusEl.textContent = label;
  kernelStatusEl.dataset.status = view?.status || "";
  kernelStatusEl.title = view?.lastError || "";
}

function renderWorkspace(): void {
  disposeOutputs();
  const tab = activeTab();
  surfaceTitleEl.textContent = "Jupyter Output";
  renderKernelBadge();
  if (!tab) {
    workspaceEl.innerHTML = `<div class="noema-jupyter-empty"><strong>No output selected</strong><span>Run a Jupyter cell in Emacs.</span></div>`;
    return;
  }
  if (tab.loading && !tab.snapshot) {
    workspaceEl.innerHTML = `<div class="noema-jupyter-empty"><strong>Loading outputs…</strong></div>`;
    return;
  }
  if (tab.error && !tab.snapshot) {
    workspaceEl.innerHTML = `<div class="noema-jupyter-empty is-error"><strong>Unable to load document</strong><span></span></div>`;
    workspaceEl.querySelector("span")!.textContent = tab.error;
    return;
  }
  const cells = tab.snapshot?.cells || [];
  if (cells.length === 0) {
    workspaceEl.innerHTML = `<div class="noema-jupyter-empty"><strong>No output yet</strong><span>Run a Jupyter cell from Emacs.</span></div>`;
    return;
  }
  workspaceEl.replaceChildren(...cells.map((cell) => renderCell(tab, cell)));
}

function render(): void {
  renderWorkspace();
}

function showOutputShortcuts(): void {
  setStatus("↑/↓ choose output · Tab fold/show · Space full/compact · Enter popout/close · ⌘Enter source · Esc close");
}

app.querySelector("[data-action='open-source']")?.addEventListener("click", () => void openSource());
app.querySelector("[data-action='shortcuts']")?.addEventListener("click", showOutputShortcuts);
function closeDialog(): void {
  const returnFocus = dialogReturnFocus;
  dialogReturnFocus = null;
  dialogOutputDispose?.();
  dialogOutputDispose = null;
  dialogBodyEl.classList.remove("noema-jupyter-popout-output");
  dialogEl.close();
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

app.querySelector("[data-dialog-close]")?.addEventListener("click", closeDialog);
dialogEl.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});
dialogEl.addEventListener("click", (event) => {
  if (event.target === dialogEl) closeDialog();
});
window.addEventListener("pointerdown", (event) => {
  if (!contextMenuEl.hidden && !(event.target as Element | null)?.closest("[data-context-menu]")) {
    closeCellMenu();
  }
});

window.addEventListener("keydown", (event) => {
  if (dialogEl.open) {
    if (event.key === "Escape" || outputDialogEnterCloses(event, dialogBodyEl)) {
      event.preventDefault();
      closeDialog();
    }
    return;
  }
  if (event.key === "Escape" && !contextMenuEl.hidden) {
    event.preventDefault();
    closeCellMenu();
    return;
  }
  if (!contextMenuEl.hidden) return;
  const shortcut = outputShortcut(event);
  if (!shortcut) return;
  const tab = activeTab();
  const cell = activeCell(tab);
  if (!tab || !cell) return;
  event.preventDefault();
  switch (shortcut) {
    case "previous":
    case "next": {
      const cells = tab.snapshot?.cells || [];
      const index = cells.findIndex((item) => item.id === cell.id);
      const next = cells[index + (shortcut === "previous" ? -1 : 1)];
      if (next) selectCell(tab, next.id, true);
      break;
    }
    case "fold": void toggleCellOutput(tab, cell); break;
    case "expand": void setCellOutputExpanded(tab, cell, cell.outputUi?.outputExpanded !== true); break;
    case "source": void openSource(cell); break;
    case "popout": popoutCellOutput(cell); break;
    case "help": showOutputShortcuts(); break;
  }
});

window.addEventListener("noema:jupyter-cell", (event) => {
  const detail = (event as CustomEvent<{
    scriptFile?: string;
    file?: string;
    cellId?: string;
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

window.addEventListener("noema:jupyter-session", (event) => {
  const snapshot = (event as CustomEvent<DocumentSnapshot>).detail;
  const scriptFile = text(snapshot?.document?.scriptFile);
  const tab = currentDocument?.ref.scriptFile === scriptFile ? currentDocument : undefined;
  if (!tab || !snapshot?.document) return;
  tab.loadGeneration = (tab.loadGeneration || 0) + 1;
  tab.loading = false;
  tab.error = "";
  tab.lastSnapshotRetryAt = 0;
  window.clearTimeout(refreshTimer);
  refreshTimer = 0;
  tab.snapshot = snapshot;
  tab.kernelView = { id: snapshot.document.kernelId, status: snapshot.kernelStatus, stateLost: snapshot.kernelStateLost, lastError: snapshot.kernelError };
  tab.ref = { ...tab.ref, ...snapshot.document };
  if (!snapshot.cells.some((cell) => cell.id === tab.activeCellId)) {
    tab.activeCellId = snapshot.cells[0]?.id || "";
  }
  render();
});

window.addEventListener("noema:connection", (event) => {
  const detail = (event as CustomEvent<{ status?: string }>).detail;
  if (detail?.status !== "connected") return;
  // Reconcile once after an actual socket connection/reconnection.  Normal
  // synchronization is carried by jupyter-cell/jupyter-session events.
  const tab = currentDocument;
  if (tab) void loadTab(tab, false);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void pollKernelStatus();
});

const query = new URLSearchParams(location.search);
const initial = normalizeRef({
  scriptFile: query.get("scriptFile") || "",
  sourceFile: query.get("sourceFile") || "",
  projectRoot: query.get("projectRoot") || "",
  language: query.get("language") || "python",
  kernel: query.get("kernel") || "python3",
  session: query.get("session") || "default",
});
if (initial) {
  openDocument({ ...initial, cellId: query.get("cellId") || "" });
} else {
  render();
  const tab = activeTab();
  if (tab) {
    void loadTab(tab, false);
  }
}
window.addEventListener("beforeunload", () => {
  window.clearInterval(kernelStatusTimer);
  dialogOutputDispose?.();
  disposeOutputs();
  removeB3ComponentSystem();
  removeThemeRuntime();
}, { once: true });
