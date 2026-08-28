import "./desktop-bridge.ts";
import "../src/styles/widgets.css";
import "../src/styles/typography.css";
import { installB3ComponentSystem } from "../src/b3-component-system.ts";
import "./style.css";
import "../src/styles/aaron-ui-tokens.css";
import "../src/styles/aaron-ui-elegant.css";
import "../src/styles/theme-loader.ts";

import {
  createEditor,
  type EditorClipboardPayload,
  type EditorCommand,
  type QuickInsertItem,
  type StoredPasteAsset,
} from "../src/lib.ts";
import { setupCopilot } from "../plugins/noema-copilot/renderer.ts";
import { indentMarkdownBlock } from "../src/cm6/commands/index.ts";
import {
  runEditorDelete,
  runEditorEnter,
  runEditorMovement,
  runEditorTab,
  runEditorTextInput,
  type EditorMovementKey,
} from "../src/cm6/input-commands.ts";
import { markdownHrefAt } from "../src/cm6/editor-cm6.ts";
import {
  blockMathAtomicFullRebuildCount,
  blockMathFullRebuildCount,
  finishInlineMathEditing,
  formulaRangeAtWidgetPosition,
  formulaSourceRangeAtPosition,
  revealFormulaSource,
} from "../src/cm6/extensions/visual/widgets/math.ts";
import { getBlockMathRanges, rangeAtPosition, rangeOverlapsAny } from "../src/cm6/math-ranges.ts";
import {
  mountVisualTexDisplayEditor,
  mountVisualTexPreview,
  normalizeVisualTexLatex,
  setVisualTexDisplayLayout,
  visualTexDisplayLayout,
  visualTexOuterDisplayLayout,
  type VisualTexInlineEditor,
  type VisualTexPreview,
  type VisualTexCompletionTemplate,
  type VisualTexDisplayLayout,
} from "../src/cm6/extensions/visual/widgets/visualtex-inline.ts";
import { jumpStructuralDelimiter, jumpTexUnit } from "../src/cm6/structural-jump.ts";
import { equationTagsFromText, getEquationTagHits } from "../src/equation-tags.ts";
import { INLINE_MATH_RE } from "../src/inline-math.ts";
import { formatMathRenderError } from "../src/math-render.ts";
import { mathPreviewFitScale } from "./math-preview-fit.ts";
import { getKatexMacros, setKatexMacros } from "../src/katex-macros.ts";
import { renderJupyterVariablesTable } from "../src/jupyter-variables-view.ts";
import { formatCitationLabel, renderPublishedNoteHTML } from "../src/render-html.ts";
import { createSelfContainedNoteHTML } from "../src/self-contained-html.ts";
import { hrefProtocol, safeHref } from "../src/url-safety.ts";
import {
  api,
  type TodoItem,
  type JupyterKernelSpec,
  type JupyterKernelTask,
  type JupyterTasksResult,
  type LatexExportAgentStatus,
  type LatexTemplate,
  type CoreTask,
  type BibliographyCitation,
  type BibliographyDiagnostic,
  type BibliographyDocument,
  type BibliographyReference,
  type LanguageToolSettings,
  type WikiIndex,
} from "./api-client.ts";
import { Epoch } from "../src/async-epoch.ts";
import { CoalescedTimer } from "../src/coalesced-timer.ts";
import { findSlashHint, resolveHintMenuItems } from "../src/hint-core.ts";
import { matchHotKey } from "../src/hotkey.ts";
import { primaryModifierDown } from "../src/platform-compat.ts";
import type { HeadingNumberFormat } from "../src/heading-number.ts";
import { createMenuController, type NoemaMenuItem } from "../src/menu-system.ts";
import { createTransientSurfaceRegistry } from "../src/transient-surfaces.ts";
import { blobToBase64 } from "../src/paste.ts";
import { collectFindMatches, createFindPattern, type FindMatch } from "./find.ts";
import { AssistScheduler, type AssistUpdateFlags, type AssistUpdateOptions } from "./assist-scheduler.ts";
import {
  ProseCheckLifecycle,
  type ProseCheckContext,
  type ProseCheckOutcome,
  type ProseCheckState,
} from "./prose-check-lifecycle.ts";
import { createFloatingTocPanel, inlineTagAnchorsFromText, markdownHeadingsFromText } from "./floating-toc.ts";
import { createSlideDeckController, type SlideDeckController } from "./slide-deck.ts";
import { normalizeDateValue } from "../src/planning-values.ts";
import { AARONNOTE_AUTHORING_SNIPPETS } from "../src/authoring-syntax.ts";
import { patchPlanningNodeRaw, scanPlanningNodes } from "../shared/planning-dsl.mjs";
import { latexMarkNames, latexMarkSnippetDefinitions } from "../shared/latex-marks.mjs";
import { desktopDropDisposition, desktopPlatformLabels } from "../shared/desktop-shell.mjs";
import {
  buildLatexExportScopes,
  latexExportScopesContent,
  toggleLatexExportScopeSelection,
  type LatexExportScope,
} from "./latex-export-scope.ts";
import { resolveAnchorHeading } from "../src/heading-slug.ts";
import { createLocalGraphPanel } from "./local-graph.ts";
import { openLanguageToolSettingsTool } from "./languagetool-tool.ts";
import { openAssetMaintenance } from "./asset-maintenance.ts";
import { setFindHighlightRanges } from "../src/cm6/find-highlight.ts";
import {
  refreshViewportDecorationsNow,
  setViewportDecorationRefreshPaused,
} from "../src/cm6/viewport-refresh.ts";
import { setMeasuredWidgetObservationPaused } from "../src/cm6/extensions/visual/widgets/measured-observer.ts";
import {
  createFocusQuiescenceController,
  editorTextFromKeydown,
  replayEditorKeydown,
} from "../src/cm6/focus-quiescence.ts";
import { createRendererActivityGate, type RendererActivityState } from "../src/renderer-activity.ts";
import { imageAnimationActivityParticipant } from "../src/image-animation.ts";
import {
  cancelPointerSelection,
  isPointerSelecting,
  pointerSelectionEffect,
} from "../src/cm6/extensions/visual/selection.ts";
import {
  allProseDiagnostics,
  proseDiagnosticsAt,
  setProseDiagnostics,
  type ProseDiagnostic,
} from "../src/cm6/prose-diagnostics.ts";
import {
  canonicalRoamNoteId,
  escapeMarkdownLinkText,
  markdownRoamIdLink,
  resolveRoamNoteSearch,
  roamHrefForNote,
  roamNoteSearchValue,
} from "./roam-idlink.ts";
import {
  expandSnippetBody,
  mathLiveSnippetTemplate,
  matchingSnippetsAtTokenBoundary,
  matchingSnippetsForPrefix,
  SnippetSession,
  SnippetUsageStore,
  snippetDetail,
  snippetLabel,
  snippetPopupKeyAction,
  snippetScore,
} from "./snippets.ts";
import { MathSnippetIndex } from "./math-snippet-index.ts";
import { collectTagSuggestions, createTagPicker } from "./tag-picker.ts";
import {
  metadataTagsFromMarkdown,
  planMarkdownMetadataChanges,
  planMarkdownTagChanges,
  type TagChangeSet,
} from "./note-tag-transaction.ts";
import {
  citeKeyCompletionContext,
  citeKeyRenderPrefix,
  citeNamespaceCompletionPrefix,
  citeNamespaceRenderPrefix,
} from "./bibliography-completion.ts";
import {
  alignBibliographyCitationRanges,
  bibliographyChangesRequireResolution,
  bibliographyResolutionState,
  mapBibliographyRangesThroughChanges,
  mapBibliographyWatchRangesThroughChanges,
  type BibliographyCommandRange,
  type BibliographyTextChange,
  type BibliographyWatchRange,
} from "./bibliography-state.ts";
import type { CursorPosition, NoteSummary, SnippetSummary } from "./types.ts";
import { createVimLite, type VimLiteKey, type VimLiteMode } from "./vim-lite.ts";
import { ceilCommandGeneratedId, ceilLanguageForKernel } from "../src/cm6/extensions/visual/widgets/ceil-shared.ts";
import {
  getOrgEnvBlockIdentities,
  orgEnvBlockIdentityAtPosition,
  orgEnvBlockIdentityPosition,
} from "../src/cm6/extensions/visual/widgets/block-extras.ts";
import type {
  AttributeViewCellPatchDetail,
  AttributeViewOpenRowDetail,
  AttributeViewRequestDetail,
} from "../src/cm6/extensions/visual/widgets/attribute-view.ts";
import type {
  EmbedQueryOpenDetail,
  EmbedQueryRequestDetail,
} from "../src/cm6/extensions/visual/widgets/embed-query.ts";
import {
  markdownBlockSourceOffset,
  markdownLineStartOffset,
} from "./markdown-box-lab-navigation.ts";
import {
  handleXwidgetControlBeforeInput,
  handleXwidgetControlKeydown,
  handleXwidgetEmacsKeydown,
  handleXwidgetHistoryKeydown,
  handleXwidgetMathBeforeInput,
  handleXwidgetMathKeydown,
  handleXwidgetSpecialBeforeInput,
  handleXwidgetSpecialKeydown,
  handleXwidgetVimBeforeInput,
  handleXwidgetVimKeydown,
} from "./xwidget-key-guard.ts";
import { focusQuiescenceEnabled, serverMode, sourceEditorName, standaloneMode } from "./host-mode.ts";
import { installHostClipboard } from "./host-clipboard.ts";
import { unionSelectionRect } from "./selection-geometry.ts";
import { writeSystemClipboard } from "../src/system-clipboard.ts";
import { copiedText } from "../src/cm6/copied-text.ts";
import { createZoomController } from "./features/zoom/controller.ts";
import {
  createWritingStatsController,
  type WritingStatsController,
} from "./features/writing-stats/controller.ts";
import { installActiveCoreReconnect } from "./active-core-reconnect.ts";
import { noteAutoSaveEnabled } from "./save-policy.ts";
import { SaveDrain } from "./save-drain.ts";
import { EditorSaveChangeTracker, type EditorSaveChangeToken } from "./editor-save-changes.ts";
import {
  installNoemaThemeRuntime,
  loadNoemaAppConfig,
} from "./theme-runtime.ts";
import { wikiCompletionSnippets, wikiLinkCompletionContext } from "./wiki-completion.ts";
import { createLinkPreviewController } from "./link-preview.ts";
import { createKnowledgeSearch } from "./knowledge-search.ts";
import {
  currentNoteFromIndex,
  openedNoteNeedsIndexReload,
  payloadUpdatesNoteIndex,
} from "./note-index.ts";
import {
  createDesktopKnowledgeDock,
  type DesktopKnowledgeDock,
} from "./desktop-knowledge-dock.ts";
import { refreshAgendaView } from "./agenda-view.ts";

const removeNoemaThemeRuntime = installNoemaThemeRuntime();
const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing #app");
const removeB3ComponentSystem = installB3ComponentSystem(document.body);
window.addEventListener("beforeunload", removeB3ComponentSystem, { once: true });
const initialParams = new URLSearchParams(window.location.search);
const serverReaderMode = serverMode();
if (serverReaderMode && initialParams.has("host")) {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("host");
  window.history.replaceState(window.history.state, "", cleanUrl);
  initialParams.delete("host");
}
type ServerReaderSettings = {
  showSource: boolean;
  showGraph: boolean;
  showSearch: boolean;
  showToc: boolean;
  showStatus: boolean;
  selectionToolbar: boolean;
  customContextMenu: boolean;
  editingAids: boolean;
};
const serverReaderDefaults: ServerReaderSettings = {
  showSource: false,
  showGraph: true,
  showSearch: true,
  showToc: true,
  showStatus: false,
  selectionToolbar: false,
  customContextMenu: false,
  editingAids: false,
};
const injectedServerReader = (window as Window & { __noemaServerReader?: Partial<ServerReaderSettings> }).__noemaServerReader;
const serverReader = { ...serverReaderDefaults, ...(injectedServerReader || {}) };
const passiveServerReader = serverReaderMode && !serverReader.editingAids;
const initialReadOnly = serverReaderMode || initialParams.get("readonly") === "1" || initialParams.get("readonly") === "true";
const desktopMode = standaloneMode() && Boolean(window.noemaDesktop);
let activeObsidianTaskID = "";
const jupyterExecutionAvailable = !serverReaderMode;
const desktopPlatform = window.noemaDesktop?.platform || (/Mac/.test(navigator.platform) ? "darwin" : "");
const platformLabels = desktopPlatformLabels(desktopPlatform);
document.body.dataset.hostMode = serverReaderMode ? "server" : desktopMode ? "desktop" : "emacs";
// Must run before the first copy: it decides whether a copy can reach the OS.
installHostClipboard();
if (desktopMode) document.body.dataset.desktopPlatform = desktopPlatform;
if (serverReaderMode) {
  document.body.dataset.serverReaderEditingAids = String(serverReader.editingAids);
}

root.innerHTML = `
  <header class="noema-desktop-titlebar" data-desktop-titlebar data-desktop-drag-region ${desktopMode ? "" : "hidden"}>
    <nav class="noema-desktop-titlebar-controls" aria-label="Note navigation">
      <button type="button" data-desktop-command="back" title="Back" aria-label="Back">←</button>
      <button type="button" data-desktop-command="forward" title="Forward" aria-label="Forward">→</button>
      <button type="button" data-desktop-command="refresh" title="Refresh" aria-label="Refresh">↻</button>
      <button type="button" data-desktop-menu="actions" title="Editor actions" aria-label="Editor actions">✎</button>
      <button type="button" data-desktop-menu="window" title="Window actions" aria-label="Window actions">▦</button>
    </nav>
    <strong class="noema-desktop-titlebar-name" data-desktop-title>Noema</strong>
  </header>
  <header class="noema-server-header" data-server-header ${serverReaderMode ? "" : "hidden"}>
    <div class="noema-server-leading">
      <a href="/wiki" class="noema-server-brand" aria-label="Open Noema Public Wiki">
        <img class="noema-server-brand-icon" src="./Noema.svg" alt="">
        <span><b>Noema</b><small>Public Wiki</small></span>
      </a>
      <nav aria-label="Reader history">
        <button type="button" data-server-command="back" title="Back" aria-label="Back">←</button>
        <button type="button" data-server-command="forward" title="Forward" aria-label="Forward">→</button>
      </nav>
    </div>
    <strong class="noema-server-page"><span data-server-title>Noema</span></strong>
    <div class="noema-server-actions">
      <label class="noema-server-search" ${serverReader.showSearch ? "" : "hidden"}>
        <span aria-hidden="true">⌕</span><input type="search" data-server-search placeholder="Search Wiki" aria-label="Search Noema Wiki" autocomplete="off">
      </label>
      <button type="button" data-server-command="toggle-toc" title="Page outline" aria-label="Page outline" ${serverReader.showToc ? "" : "hidden"}>Contents</button>
      <button type="button" data-server-command="toggle-graph" title="Local graph" aria-label="Local graph" ${serverReader.showGraph ? "" : "hidden"}>Graph</button>
      <button type="button" data-server-command="refresh" title="Refresh" aria-label="Refresh">↻</button>
      <button type="button" data-server-command="toggle-source" aria-label="Toggle source" ${serverReader.showSource ? "" : "hidden"}>Source</button>
    </div>
  </header>
  <main class="aaronnote-focused-shell">
    <aside class="aaronnote-status-hud" aria-live="polite" ${serverReaderMode && !serverReader.showStatus ? "hidden" : ""}>
      <span class="aaronnote-status-pill aaronnote-status-pill-left" data-mode-toggle
            role="button" tabindex="0" title="Toggle tools" aria-label="Toggle tools"
            aria-expanded="false">
        <span data-vim-mode>INSERT</span>
        <span data-readonly hidden>READ ONLY</span>
      </span>
      <span class="aaronnote-status-pill aaronnote-status-pill-right" data-stats-toggle
            role="button" tabindex="0" title="Toggle page outline" aria-label="Toggle page outline"
            aria-expanded="false">
        <span data-writing-stats aria-live="polite"></span>
      </span>
    </aside>
    <section class="aaronnote-focused-editor" data-editor></section>
  </main>
  <div class="noema-desktop-drop-overlay" data-desktop-drop-overlay hidden>
    <span data-desktop-drop-label>Drop to insert</span>
  </div>
  <div class="noema-global-search" data-global-search hidden>
    <label><span aria-hidden="true">⌕</span><input type="search" data-global-search-input placeholder="Search notes, tags, namespaces…" aria-label="Search knowledge" autocomplete="off"></label>
  </div>
`;

const host = root.querySelector<HTMLElement>("[data-editor]")!;
const fileLabel = document.createElement("strong");
const desktopTitleName = root.querySelector<HTMLElement>("[data-desktop-title]")!;
const serverTitleName = root.querySelector<HTMLElement>("[data-server-title]")!;
const desktopDropOverlay = root.querySelector<HTMLElement>("[data-desktop-drop-overlay]")!;
const desktopDropLabel = root.querySelector<HTMLElement>("[data-desktop-drop-label]")!;
const modeLabel = root.querySelector<HTMLElement>("[data-vim-mode]")!;
const readOnlyLabel = root.querySelector<HTMLElement>("[data-readonly]")!;
const statusLabel = document.createElement("span");
const writingStatsLabel = root.querySelector<HTMLElement>("[data-writing-stats]")!;
const statsToggle = root.querySelector<HTMLElement>("[data-stats-toggle]")!;
const modeToggle = root.querySelector<HTMLElement>("[data-mode-toggle]")!;
const shellControl = (label: string): HTMLButtonElement => {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  return button;
};
const jupyterButton = shellControl("Code cells");
const tocButton = shellControl("Page");
const agendaButton = shellControl("Agenda");
const graphButton = shellControl("Graph");
const toolsButton = shellControl("Tools");
const sourceButton = shellControl("Source");
const saveButton = shellControl("Save");

const prosePopover = document.createElement("div");
prosePopover.className = "aaronnote-prose-popover";
prosePopover.hidden = true;
document.body.appendChild(prosePopover);

const graphPanelRoot = document.createElement("aside");
graphPanelRoot.className = "aaronnote-local-graph-panel noema-knowledge-dock is-collapsed";
graphPanelRoot.setAttribute("aria-label", "Knowledge");
graphPanelRoot.innerHTML = `
  <header class="noema-knowledge-dock-header">
    <strong>Knowledge</strong>
    <nav class="noema-knowledge-dock-tabs" role="tablist" aria-label="Knowledge views" ${serverReaderMode ? "hidden" : ""}>
      <button type="button" role="tab" data-knowledge-view="backlinks">Backlinks</button>
      <button type="button" role="tab" data-knowledge-view="mentions">Mentions</button>
      <button type="button" role="tab" data-knowledge-view="graph">Graph</button>
      <button type="button" role="tab" data-knowledge-view="search">Search</button>
      <button type="button" role="tab" data-knowledge-view="tags">Tags</button>
    </nav>
    <button type="button" data-graph-close>Close</button>
  </header>
  <section class="noema-knowledge-dock-pane noema-knowledge-backlinks" data-knowledge-pane="backlinks" hidden>
    <div class="noema-knowledge-dock-status" data-knowledge-backlink-status></div>
    <div class="noema-knowledge-backlink-list" data-knowledge-backlink-list></div>
  </section>
  <section class="noema-knowledge-dock-pane noema-knowledge-mentions" data-knowledge-pane="mentions" hidden>
    <div class="noema-knowledge-dock-status" data-knowledge-mention-status></div>
    <div class="noema-knowledge-backlink-list" data-knowledge-mention-list></div>
  </section>
  <section class="noema-knowledge-dock-pane noema-knowledge-graph" data-knowledge-pane="graph">
    <div class="aaronnote-local-graph-controls">
      <div class="aaronnote-graph-mode" role="group" aria-label="Graph scope">
        <button type="button" data-graph-mode="local" class="is-active">Local</button>
        <button type="button" data-graph-mode="workspace">Workspace</button>
      </div>
      <input type="search" data-graph-search placeholder="Search graph" aria-label="Search graph" />
      <select data-graph-group aria-label="Filter graph group"><option value="">All groups</option></select>
      <label>Depth <input type="range" data-graph-depth min="1" max="3" value="1" /></label>
      <span data-graph-depth-label>1</span>
      <label><input type="checkbox" data-graph-refs checked /> Refs</label>
      <label><input type="checkbox" data-graph-backlinks checked /> Back</label>
      <label><input type="checkbox" data-graph-tags checked /> Tags</label>
    </div>
    <div class="aaronnote-local-graph-canvas" data-graph-canvas></div>
    <div class="aaronnote-local-graph-status" data-graph-status></div>
    <div class="aaronnote-graph-detail" data-graph-detail hidden></div>
  </section>
  <section class="noema-knowledge-dock-pane noema-knowledge-search" data-knowledge-pane="search" hidden>
    <div class="noema-knowledge-dock-search-anchor" data-knowledge-search-anchor>
      <label><span aria-hidden="true">⌕</span><input type="search" data-knowledge-search placeholder="Search notes, tags, namespaces…" aria-label="Search knowledge" autocomplete="off" /></label>
    </div>
    <p class="noema-knowledge-search-hint">Open a result here, or hold the primary modifier to open it in a new Noema window.</p>
  </section>
  <section class="noema-knowledge-dock-pane noema-knowledge-tags" data-knowledge-pane="tags" hidden>
    <div class="noema-knowledge-dock-status" data-knowledge-tag-status></div>
    <div class="noema-knowledge-tag-list" data-knowledge-tag-list></div>
  </section>
`;
document.body.appendChild(graphPanelRoot);
const graphDepthInput = graphPanelRoot.querySelector<HTMLInputElement>("[data-graph-depth]")!;
const graphDepthLabel = graphPanelRoot.querySelector<HTMLElement>("[data-graph-depth-label]")!;
const graphRefsInput = graphPanelRoot.querySelector<HTMLInputElement>("[data-graph-refs]")!;
const graphBacklinksInput = graphPanelRoot.querySelector<HTMLInputElement>("[data-graph-backlinks]")!;
const graphTagsInput = graphPanelRoot.querySelector<HTMLInputElement>("[data-graph-tags]")!;
const graphCanvas = graphPanelRoot.querySelector<HTMLElement>("[data-graph-canvas]")!;
const graphStatus = graphPanelRoot.querySelector<HTMLElement>("[data-graph-status]")!;
const graphSearch = graphPanelRoot.querySelector<HTMLInputElement>("[data-graph-search]")!;
const graphGroup = graphPanelRoot.querySelector<HTMLSelectElement>("[data-graph-group]")!;
const graphDetail = graphPanelRoot.querySelector<HTMLElement>("[data-graph-detail]")!;
const graphModeButtons = Array.from(graphPanelRoot.querySelectorAll<HTMLButtonElement>("[data-graph-mode]"));
const graphClose = graphPanelRoot.querySelector<HTMLButtonElement>("[data-graph-close]")!;
const knowledgeTabButtons = Array.from(graphPanelRoot.querySelectorAll<HTMLButtonElement>("[data-knowledge-view]"));
const knowledgeBacklinksPane = graphPanelRoot.querySelector<HTMLElement>("[data-knowledge-pane='backlinks']")!;
const knowledgeMentionsPane = graphPanelRoot.querySelector<HTMLElement>("[data-knowledge-pane='mentions']")!;
const knowledgeGraphPane = graphPanelRoot.querySelector<HTMLElement>("[data-knowledge-pane='graph']")!;
const knowledgeSearchPane = graphPanelRoot.querySelector<HTMLElement>("[data-knowledge-pane='search']")!;
const knowledgeTagsPane = graphPanelRoot.querySelector<HTMLElement>("[data-knowledge-pane='tags']")!;
const knowledgeBacklinkList = graphPanelRoot.querySelector<HTMLElement>("[data-knowledge-backlink-list]")!;
const knowledgeBacklinkStatus = graphPanelRoot.querySelector<HTMLElement>("[data-knowledge-backlink-status]")!;
const knowledgeMentionList = graphPanelRoot.querySelector<HTMLElement>("[data-knowledge-mention-list]")!;
const knowledgeMentionStatus = graphPanelRoot.querySelector<HTMLElement>("[data-knowledge-mention-status]")!;
const knowledgeSearchAnchor = graphPanelRoot.querySelector<HTMLElement>("[data-knowledge-search-anchor]")!;
const knowledgeSearchInput = graphPanelRoot.querySelector<HTMLInputElement>("[data-knowledge-search]")!;
const knowledgeTagList = graphPanelRoot.querySelector<HTMLElement>("[data-knowledge-tag-list]")!;
const knowledgeTagStatus = graphPanelRoot.querySelector<HTMLElement>("[data-knowledge-tag-status]")!;

const toc = document.createElement("aside");
toc.className = "aaronnote-floating-toc is-collapsed";
toc.innerHTML = `<nav data-toc-list aria-label="Page outline"></nav>`;
document.body.appendChild(toc);
const tocList = toc.querySelector<HTMLElement>("[data-toc-list]")!;

const toolsPanel = document.createElement("div");
toolsPanel.className = "aaronnote-tools-panel";
toolsPanel.hidden = true;
toolsPanel.innerHTML = `
  <div class="aaronnote-tools-head">
    <strong>Tools</strong>
    <button type="button" data-tools-close>Close</button>
  </div>
  <div class="aaronnote-tools-list" data-tools-list></div>
`;
document.body.appendChild(toolsPanel);
const toolsList = toolsPanel.querySelector<HTMLElement>("[data-tools-list]")!;
const toolsClose = toolsPanel.querySelector<HTMLButtonElement>("[data-tools-close]")!;

const jupyterPanel = document.createElement("aside");
jupyterPanel.className = "aaronnote-jupyter-panel";
jupyterPanel.hidden = true;
jupyterPanel.innerHTML = `
  <header>
    <strong>Jupyter</strong>
    <button type="button" data-jupyter-close aria-label="Close">Close</button>
  </header>
  <div class="aaronnote-jupyter-toolbar">
    <button type="button" data-jupyter-action="run-all" title="Run all" aria-label="Run all">&#xf04b;</button>
    <button type="button" data-jupyter-action="run-above" title="Run cells above cursor" aria-label="Run cells above cursor">&#xf062;</button>
    <button type="button" data-jupyter-action="run-below" title="Run cells below cursor" aria-label="Run cells below cursor">&#xf063;</button>
    <button type="button" data-jupyter-action="run-section" title="Run current section" aria-label="Run current section">&#xf0e8;</button>
    <button type="button" data-jupyter-action="restart-run-all" title="Restart and run all" aria-label="Restart and run all">&#xf021;</button>
    <button type="button" data-jupyter-action="interrupt" title="Interrupt kernel" aria-label="Interrupt kernel">&#xf04d;</button>
    <button type="button" data-jupyter-action="clear-all" title="Clear all outputs" aria-label="Clear all outputs">&#xf1f8;</button>
    <button type="button" data-jupyter-action="variables" title="Variables" aria-label="Variables">&#xf0ce;</button>
    <button type="button" data-jupyter-action="toggle-kernel-tool" title="Switch kernel" aria-label="Switch kernel">&#xf085;</button>
    <button type="button" data-jupyter-action="tasks" title="Kernel task manager" aria-label="Kernel task manager">&#xf0ae;</button>
    <button type="button" data-jupyter-action="cleanup" title="Cleanup idle kernels" aria-label="Cleanup idle kernels">&#xf12d;</button>
    <button type="button" data-jupyter-action="refresh" title="Refresh" aria-label="Refresh">&#xf2f1;</button>
  </div>
  <div class="aaronnote-jupyter-kernel-tool" data-jupyter-kernel-tool hidden>
    <label>Lang <select data-jupyter-kernel-language></select></label>
    <label>Session <select data-jupyter-kernel-session></select></label>
    <label>Old <select data-jupyter-kernel-old></select></label>
    <label>New <select data-jupyter-kernel-new></select></label>
    <div class="aaronnote-jupyter-kernel-cells" data-jupyter-kernel-cells></div>
    <button type="button" data-jupyter-action="switch-kernel">Switch</button>
  </div>
  <div class="aaronnote-jupyter-summary" data-jupyter-summary>No cells</div>
  <div class="aaronnote-jupyter-list" data-jupyter-list></div>
  <div class="aaronnote-jupyter-vars" data-jupyter-vars hidden></div>
  <div class="aaronnote-jupyter-runtime" data-jupyter-runtime hidden></div>
`;
document.body.appendChild(jupyterPanel);
const jupyterClose = jupyterPanel.querySelector<HTMLButtonElement>("[data-jupyter-close]")!;
const jupyterSummary = jupyterPanel.querySelector<HTMLElement>("[data-jupyter-summary]")!;
const jupyterList = jupyterPanel.querySelector<HTMLElement>("[data-jupyter-list]")!;
const jupyterVars = jupyterPanel.querySelector<HTMLElement>("[data-jupyter-vars]")!;
const jupyterRuntime = jupyterPanel.querySelector<HTMLElement>("[data-jupyter-runtime]")!;
const jupyterKernelTool = jupyterPanel.querySelector<HTMLElement>("[data-jupyter-kernel-tool]")!;
const jupyterKernelLanguage = jupyterPanel.querySelector<HTMLSelectElement>("[data-jupyter-kernel-language]")!;
const jupyterKernelSession = jupyterPanel.querySelector<HTMLSelectElement>("[data-jupyter-kernel-session]")!;
const jupyterKernelOld = jupyterPanel.querySelector<HTMLSelectElement>("[data-jupyter-kernel-old]")!;
const jupyterKernelNew = jupyterPanel.querySelector<HTMLSelectElement>("[data-jupyter-kernel-new]")!;
const jupyterKernelCells = jupyterPanel.querySelector<HTMLElement>("[data-jupyter-kernel-cells]")!;

const roamToolsPanel = document.createElement("section");
roamToolsPanel.className = "aaronnote-roam-tools";
roamToolsPanel.hidden = true;
roamToolsPanel.innerHTML = `
  <header>
    <strong data-roam-tools-title>Roam tools</strong>
    <button type="button" data-roam-tools-close>Close</button>
  </header>
  <div class="aaronnote-roam-tools-list" data-roam-tools-list></div>
`;
document.body.appendChild(roamToolsPanel);
const roamToolsTitle = roamToolsPanel.querySelector<HTMLElement>("[data-roam-tools-title]")!;
const roamToolsList = roamToolsPanel.querySelector<HTMLElement>("[data-roam-tools-list]")!;
const roamToolsClose = roamToolsPanel.querySelector<HTMLButtonElement>("[data-roam-tools-close]")!;

const modal = document.createElement("div");
modal.className = "aaronnote-modal";
modal.hidden = true;
document.body.appendChild(modal);

const taskManagerModal = document.createElement("div");
taskManagerModal.className = "aaronnote-task-manager-backdrop";
taskManagerModal.hidden = true;
taskManagerModal.innerHTML = `
  <section class="aaronnote-task-manager" role="dialog" aria-modal="true" aria-labelledby="aaronnote-task-manager-title">
    <header class="aaronnote-task-manager-head">
      <div>
        <strong id="aaronnote-task-manager-title">Task Manager</strong>
        <span data-task-manager-summary>Core task pool</span>
      </div>
      <div class="aaronnote-task-manager-head-actions">
        <button type="button" data-task-manager-refresh>Refresh</button>
        <button type="button" data-task-manager-dismiss aria-label="Close task manager">Close</button>
      </div>
    </header>
    <nav class="aaronnote-task-manager-tabs" role="tablist">
      <button type="button" role="tab" data-task-tab="active" aria-selected="true">Active tasks</button>
      <button type="button" role="tab" data-task-tab="latex" aria-selected="false">LaTeX exports</button>
    </nav>
    <div class="aaronnote-task-manager-status" data-task-manager-status>Open or refresh to read Core state.</div>
    <div class="aaronnote-task-manager-list" data-task-manager-list></div>
  </section>
`;
document.body.appendChild(taskManagerModal);
const taskManagerPanel = taskManagerModal.querySelector<HTMLElement>(".aaronnote-task-manager")!;
const taskManagerList = taskManagerModal.querySelector<HTMLElement>("[data-task-manager-list]")!;
const taskManagerStatus = taskManagerModal.querySelector<HTMLElement>("[data-task-manager-status]")!;
const taskManagerSummary = taskManagerModal.querySelector<HTMLElement>("[data-task-manager-summary]")!;
const taskManagerRefresh = taskManagerModal.querySelector<HTMLButtonElement>("[data-task-manager-refresh]")!;
const taskManagerDismiss = taskManagerModal.querySelector<HTMLButtonElement>("[data-task-manager-dismiss]")!;
const taskManagerTabs = [...taskManagerModal.querySelectorAll<HTMLButtonElement>("[data-task-tab]")];
let taskManagerTab: "active" | "latex" = "active";
let taskManagerSnapshot: CoreTask[] = [];
let taskManagerLoading = false;
let taskManagerPollTimer: number | null = null;

function taskTime(value: unknown): string {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function taskMetadataLine(task: CoreTask): string {
  const metadata = task.metadata || {};
  return [metadata.file, metadata.outputPath, metadata.engine].map((value) => String(value || "").trim()).filter(Boolean).join(" · ");
}

function taskResultLine(task: CoreTask): string {
  const result = task.result || {};
  const agent = result.agent && typeof result.agent === "object" ? result.agent as Record<string, unknown> : null;
  const elapsed = Number(agent?.elapsedMs || 0);
  const agentText = agent
    ? `${String(agent.backend || "agent")} polish${elapsed > 0 ? ` ${(elapsed / 1000).toFixed(1)}s` : ""} · ${Number(agent.applied || 0)} applied / ${Number(agent.kept || 0)} kept`
    : "";
  return [result.title, result.pdfFile || result.file, agentText].map((value) => String(value || "").trim()).filter(Boolean).join(" · ");
}

function visibleTaskWarnings(task: CoreTask): string[] {
  const warnings = Array.isArray(task.result?.warnings) ? task.result.warnings.map(String) : [];
  // Older retained export tasks may contain the removed Markdown-vs-LaTeX
  // word-bag heuristic.  It was never a hard gate and is no longer emitted by
  // Core; do not present that obsolete cached diagnostic as a current failure.
  return warnings.filter((warning) => !/^fidelity:\s*~\d+/i.test(warning));
}

function visibleTaskSnapshot(): CoreTask[] {
  return taskManagerSnapshot.filter((task) => taskManagerTab === "latex"
    ? task.kind === "latex-export"
    : ["queued", "running", "canceling"].includes(task.status));
}

function renderTaskManager(): void {
  for (const tab of taskManagerTabs) {
    const selected = tab.dataset.taskTab === taskManagerTab;
    tab.setAttribute("aria-selected", String(selected));
    tab.classList.toggle("is-active", selected);
  }
  const tasks = visibleTaskSnapshot();
  const active = taskManagerSnapshot.filter((task) => ["queued", "running", "canceling"].includes(task.status)).length;
  taskManagerSummary.textContent = `${active} active · ${taskManagerSnapshot.length} retained`;
  taskManagerList.replaceChildren();
  if (tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-task-empty";
    empty.textContent = taskManagerTab === "active" ? "No active tasks." : "No LaTeX export tasks in the current Core session.";
    taskManagerList.appendChild(empty);
    return;
  }
  for (const task of tasks) {
    const card = document.createElement("article");
    card.className = `aaronnote-task-card is-${task.status}`;
    const head = document.createElement("div");
    head.className = "aaronnote-task-card-head";
    const identity = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = task.title || task.kind;
    const kind = document.createElement("span");
    kind.textContent = task.kind;
    identity.append(title, kind);
    const badge = document.createElement("span");
    badge.className = "aaronnote-task-status-badge";
    badge.textContent = task.status;
    head.append(identity, badge);

    const description = document.createElement("p");
    description.textContent = task.description || "Core task";
    const phase = document.createElement("div");
    phase.className = "aaronnote-task-phase";
    phase.textContent = `${task.phase || task.status}${task.message && task.message !== task.phase ? ` — ${task.message}` : ""}`;
    const meta = document.createElement("div");
    meta.className = "aaronnote-task-meta";
    meta.textContent = [
      taskMetadataLine(task),
      task.startedAt ? `Started ${taskTime(task.startedAt)}` : `Created ${taskTime(task.createdAt)}`,
      task.finishedAt ? `Finished ${taskTime(task.finishedAt)}` : "",
    ].filter(Boolean).join(" · ");
    card.append(head, description, phase, meta);

    const resultText = taskResultLine(task);
    if (resultText) {
      const result = document.createElement("div");
      result.className = "aaronnote-task-result";
      result.textContent = resultText;
      card.appendChild(result);
    }
    const warnings = visibleTaskWarnings(task);
    if (warnings.length > 0 || task.error) {
      const notice = document.createElement("div");
      notice.className = task.error ? "aaronnote-task-error" : "aaronnote-task-warning";
      notice.textContent = task.error || warnings.map(String).join("; ");
      card.appendChild(notice);
    }
    if (task.progress?.length) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `Progress (${task.progress.length})`;
      const log = document.createElement("ol");
      for (const entry of task.progress) {
        const item = document.createElement("li");
        item.textContent = `${taskTime(entry.at)}  ${String(entry.text || "")}`.trim();
        log.appendChild(item);
      }
      details.append(summary, log);
      card.appendChild(details);
    }
    const agent = task.result?.agent && typeof task.result.agent === "object"
      ? task.result.agent as Record<string, unknown>
      : null;
    const decisions = agent && Array.isArray(agent.decisions)
      ? agent.decisions as Array<Record<string, unknown>>
      : [];
    const agentSummary = String(agent?.summary || "").trim();
    if (agentSummary || decisions.length > 0) {
      const details = document.createElement("details");
      details.className = "aaronnote-task-agent-audit";
      const summary = document.createElement("summary");
      summary.textContent = `Agent audit (${decisions.length} decisions)`;
      details.appendChild(summary);
      if (agentSummary) {
        const report = document.createElement("p");
        report.textContent = agentSummary;
        details.appendChild(report);
      }
      if (decisions.length > 0) {
        const list = document.createElement("ul");
        for (const decision of decisions) {
          const item = document.createElement("li");
          const id = String(decision.id || decision.kind || "review");
          const action = String(decision.action || "reviewed");
          const reason = String(decision.reason || "No reason returned");
          item.textContent = `${id}: ${action} — ${reason}`;
          list.appendChild(item);
        }
        details.appendChild(list);
      }
      card.appendChild(details);
    }
    const actions = document.createElement("div");
    actions.className = "aaronnote-task-actions";
    if (task.cancellable) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        try { await api.tasks.cancel(task.id); } catch (error) { taskManagerStatus.textContent = error instanceof Error ? error.message : String(error); }
        await refreshTaskManager();
      });
      actions.appendChild(cancel);
    }
    if (task.retryable) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = task.status === "completed" ? "Run again" : "Rerun";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        try {
          await api.tasks.retry(task.id);
          taskManagerStatus.textContent = "LaTeX export queued again with the same inputs.";
        } catch (error) {
          taskManagerStatus.textContent = error instanceof Error ? error.message : String(error);
        }
        await refreshTaskManager();
      });
      actions.appendChild(retry);
    }
    if (task.closeable) {
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close task";
      close.addEventListener("click", async () => {
        close.disabled = true;
        try { await api.tasks.close(task.id); } catch (error) { taskManagerStatus.textContent = error instanceof Error ? error.message : String(error); }
        await refreshTaskManager();
      });
      actions.appendChild(close);
    }
    if (actions.childElementCount > 0) card.appendChild(actions);
    taskManagerList.appendChild(card);
  }
}

async function refreshTaskManager(silent = false): Promise<void> {
  if (taskManagerLoading) return;
  taskManagerLoading = true;
  taskManagerRefresh.disabled = true;
  if (!silent) taskManagerStatus.textContent = "Reading Core task snapshot…";
  try {
    const result = await api.tasks.list();
    taskManagerSnapshot = result.tasks || [];
    const active = taskManagerSnapshot.some((task) => ["queued", "running", "canceling"].includes(task.status));
    taskManagerStatus.textContent = `${active ? "Live task state" : "Snapshot refreshed"} ${new Date().toLocaleTimeString()}.`;
    renderTaskManager();
  } catch (error) {
    taskManagerStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    taskManagerLoading = false;
    taskManagerRefresh.disabled = false;
  }
}

function closeTaskManager(): void {
  taskManagerModal.hidden = true;
  if (taskManagerPollTimer != null) window.clearInterval(taskManagerPollTimer);
  taskManagerPollTimer = null;
}

function openTaskManager(): void {
  taskManagerModal.hidden = false;
  void refreshTaskManager();
  if (taskManagerPollTimer == null) {
    taskManagerPollTimer = window.setInterval(() => {
      if (!taskManagerModal.hidden) void refreshTaskManager(true);
    }, 1500);
  }
  window.setTimeout(() => taskManagerRefresh.focus(), 0);
}

taskManagerRefresh.addEventListener("click", () => void refreshTaskManager());
taskManagerDismiss.addEventListener("click", closeTaskManager);
taskManagerTabs.forEach((tab) => tab.addEventListener("click", () => {
  taskManagerTab = tab.dataset.taskTab === "latex" ? "latex" : "active";
  renderTaskManager();
}));
taskManagerModal.addEventListener("mousedown", (event) => { if (event.target === taskManagerModal) closeTaskManager(); });
taskManagerPanel.addEventListener("mousedown", (event) => event.stopPropagation());
window.addEventListener("keydown", (event) => {
  if (!taskManagerModal.hidden && event.key === "Escape") { event.preventDefault(); closeTaskManager(); }
});
window.aaronnoteOpenTaskManager = openTaskManager;
const snippetPopup = document.createElement("div");
snippetPopup.className = "aaronnote-snippet-popup";
snippetPopup.hidden = true;
snippetPopup.setAttribute("role", "listbox");
document.body.appendChild(snippetPopup);

const mathPreview = document.createElement("div");
mathPreview.className = "aaronnote-math-preview";
mathPreview.hidden = true;
const mathPreviewVisualHost = document.createElement("div");
mathPreviewVisualHost.className = "aaronnote-math-preview-visual";
const mathPreviewFallback = document.createElement("pre");
mathPreviewFallback.className = "aaronnote-math-preview-fallback";
mathPreviewFallback.hidden = true;
mathPreview.append(mathPreviewVisualHost, mathPreviewFallback);
document.body.appendChild(mathPreview);

const selectionTool = document.createElement("div");
selectionTool.className = "aaronnote-selection-tool";
selectionTool.innerHTML = `
  <button type="button" data-selection-command="bold" title="Bold">B</button>
  <button type="button" data-selection-command="italic" title="Italic">I</button>
  <button type="button" data-selection-command="highlight" title="Highlight">==</button>
  <button type="button" data-selection-command="strike" title="Strikethrough">~~</button>
  <button type="button" data-selection-command="code" title="Inline code">&lt;&gt;</button>
  <button type="button" data-selection-command="superscript" title="Superscript">x²</button>
  <button type="button" data-selection-command="subscript" title="Subscript">x₂</button>
  <button type="button" data-selection-command="insert-footnote" title="Insert footnote">Fn</button>
  <button type="button" data-selection-command="revision-form" title="Suggest revision">Rev</button>
  <button type="button" data-selection-command="link" title="Link">@</button>
  <span aria-hidden="true"></span>
  <button type="button" data-selection-command="copy" title="Copy">Copy</button>
  <button type="button" data-selection-command="more" title="More actions">...</button>
  <div class="aaronnote-selection-more" data-selection-more hidden>
    <button type="button" data-selection-command="insert-roam-idlink">Insert roam idlink...</button>
  </div>
  <form class="aaronnote-revision-form" data-revision-form hidden>
    <input name="advice" placeholder="Replacement" aria-label="Revision replacement" required />
    <input name="reason" placeholder="Reason (optional)" aria-label="Revision reason" />
    <select name="style" aria-label="Revision colour">
      <option value="indigo">Indigo</option><option value="teal">Teal</option>
      <option value="red">Red</option><option value="green">Green</option><option value="yellow">Yellow</option>
    </select>
    <button type="submit">Insert</button>
  </form>
`;
selectionTool.hidden = true;
document.body.appendChild(selectionTool);
const selectionMore = selectionTool.querySelector<HTMLElement>("[data-selection-more]")!;
const selectionRoamIdlink = selectionTool.querySelector<HTMLButtonElement>("[data-selection-command='insert-roam-idlink']")!;
const selectionRevisionForm = selectionTool.querySelector<HTMLFormElement>("[data-revision-form]")!;

const contextMenu = document.createElement("div");
contextMenu.className = "aaronnote-context-menu";
contextMenu.hidden = true;
contextMenu.setAttribute("role", "menu");
document.body.appendChild(contextMenu);
const contextMenuController = createMenuController(contextMenu, {
  topBoundary: () => desktopMode ? 54 : 6,
  onError: (error) => setStatus(error instanceof Error ? error.message : "Context action failed"),
  onClose: () => contextMenu.classList.remove("is-bibliography", "is-math"),
});
const transientSurfaces = createTransientSurfaceRegistry();
transientSurfaces.register({
  id: "context-menu",
  priority: 100,
  visible: () => contextMenuController.visible,
  close: () => hideContextMenu(),
});
transientSurfaces.register({
  id: "snippet-popup",
  priority: 80,
  visible: () => !snippetPopup.hidden || Boolean(snippetPopupChooseHandler),
  close: () => hideSnippetPopup(),
});
transientSurfaces.register({
  id: "math-preview",
  priority: 70,
  visible: () => !mathPreview.hidden || Boolean(mathPreviewSession),
  close: () => hideMathPreview(),
});
transientSurfaces.register({
  id: "prose-popover",
  priority: 60,
  visible: () => !prosePopover.hidden,
  close: () => hideProsePopover(),
});

const liveTexStudio = document.createElement("div");
liveTexStudio.className = "aaronnote-livetex-backdrop";
liveTexStudio.hidden = true;
liveTexStudio.innerHTML = `
  <section class="aaronnote-livetex-studio cm-editor" role="dialog" aria-modal="true" aria-labelledby="aaronnote-livetex-title">
    <header class="aaronnote-livetex-head">
      <div class="aaronnote-livetex-brand">
        <span aria-hidden="true">TeX</span>
        <strong id="aaronnote-livetex-title">LiveTeX</strong>
      </div>
      <div class="aaronnote-livetex-document-title">
        <span>当前公式</span>
        <button type="button" data-livetex-apply title="Apply formula" aria-label="Apply formula">✓</button>
      </div>
      <div class="aaronnote-livetex-head-actions">
        <button type="button" data-livetex-close aria-label="Close LiveTeX">×</button>
      </div>
    </header>
    <nav class="aaronnote-livetex-toolbar" aria-label="Visual formula tools">
      <div class="aaronnote-livetex-mode">
        <span aria-hidden="true">{ }</span>
        <strong>可视化编辑</strong>
      </div>
      <i aria-hidden="true"></i>
      <div class="aaronnote-livetex-view-actions" role="group" aria-label="Formula alignment">
        <button type="button" data-livetex-align="left" title="Align left">≡</button>
        <button type="button" data-livetex-align="center" title="Align center">≡</button>
        <button type="button" data-livetex-align="right" title="Align right">≡</button>
      </div>
      <i aria-hidden="true"></i>
      <div class="aaronnote-livetex-editor-tools" data-livetex-editor-tools></div>
      <div class="aaronnote-livetex-zoom" role="group" aria-label="Formula zoom">
        <button type="button" data-livetex-zoom="out" title="Zoom out">−</button>
        <output data-livetex-zoom-label>100%</output>
        <button type="button" data-livetex-zoom="in" title="Zoom in">+</button>
      </div>
    </nav>
    <main class="aaronnote-livetex-stage" data-livetex-stage data-align="center">
      <div class="aaronnote-livetex-editor" data-livetex-editor data-aaronnote-vim="native" data-cm-visual-math="active"></div>
    </main>
  </section>
`;
document.body.appendChild(liveTexStudio);
const liveTexStudioPanel = liveTexStudio.querySelector<HTMLElement>(".aaronnote-livetex-studio")!;
const liveTexStage = liveTexStudio.querySelector<HTMLElement>("[data-livetex-stage]")!;
const liveTexEditorHost = liveTexStudio.querySelector<HTMLElement>("[data-livetex-editor]")!;
const liveTexEditorTools = liveTexStudio.querySelector<HTMLElement>("[data-livetex-editor-tools]")!;
const liveTexZoomLabel = liveTexStudio.querySelector<HTMLOutputElement>("[data-livetex-zoom-label]")!;
let liveTexEditor: VisualTexInlineEditor | null = null;
let liveTexTarget: ContextMathTarget | null = null;
let liveTexDraft = "";
let liveTexZoom = 1;

const bibliographyPanel = document.createElement("section");
bibliographyPanel.className = "aaronnote-bib-panel";
bibliographyPanel.hidden = true;

const findPanel = document.createElement("div");
findPanel.className = "aaronnote-find-panel";
findPanel.hidden = true;
findPanel.innerHTML = `
  <input type="search" data-find-query autocomplete="off" spellcheck="false" />
  <span data-find-count>0/0</span>
  <button type="button" data-find-prev title="Previous">↑</button>
  <button type="button" data-find-next title="Next">↓</button>
  <button type="button" data-find-close title="Close">×</button>
`;
document.body.appendChild(findPanel);
const findInput = findPanel.querySelector<HTMLInputElement>("[data-find-query]")!;
const findCount = findPanel.querySelector<HTMLElement>("[data-find-count]")!;
const findPrevButton = findPanel.querySelector<HTMLButtonElement>("[data-find-prev]")!;
const findNextButton = findPanel.querySelector<HTMLButtonElement>("[data-find-next]")!;
const findCloseButton = findPanel.querySelector<HTMLButtonElement>("[data-find-close]")!;

let currentFile = "";
let currentTitle = "";
let currentClient = "";
let currentKind = "";
let currentStandalone = false;
let currentIncrementalSave = false;
let currentRemote = false;
let currentReadOnly = initialReadOnly;
let currentMtimeMs = 0;
let currentVersion = "";
let revision = 0;
let savedRevision = 0;
const editorSaveChanges = new EditorSaveChangeTracker();
let forceFullEditorSave = false;
// Unlike the document-local revision, this must never reset when a note is
// reopened. The host uses it to reject genuinely out-of-order writes from the
// same browser client.
let saveSequence = 0;
let desktopSaveInFlight = false;
let desktopSaveConflict = false;
let applyingContent = false;
let saveTimer = 0;
let saveIdleHandle = 0;
let proseAutoSuspendedUntil = 0;
let languageToolSettings: LanguageToolSettings = {
  automaticEnabled: true,
  serverUrl: "http://10.243.90.222:8765",
  language: "en-US",
  level: "picky",
  performanceProfile: "balanced",
  manualLocalFallback: true,
  remoteTimeoutMs: 5_000,
  retryCooldownMs: 30_000,
};
let languageToolDefaults = { ...languageToolSettings };
let languageToolHealth = "Not tested";
let languageToolRevision = "";
let languageToolLoadSequence = 0;
let activeProseDiagnostic: ProseDiagnostic | null = null;
let cursorPositionsLoaded = false;
let cursorPositionsLoadPromise: Promise<CursorPosition[]> | null = null;
let cursorPositions: CursorPosition[] = [];
let lastSavedCursorPositionKey = "";
let lastTrackedCursorPositionKey = "";
let cursorPositionFlushTail: Promise<void> = Promise.resolve();
let clientCloseNotified = false;
let pendingExternalSave: { file: string; mtimeMs: number } | null = null;
let pendingExternalSaveRefreshInFlight = false;
let navigationBackStack: CursorPosition[] = [];
let navigationForwardStack: CursorPosition[] = [];
let restoringNavigationBack = false;
let restoringNavigationForward = false;
let snippets: SnippetSummary[] = [];
let notes: NoteSummary[] = [];
let notesIndexLoaded = false;
let pathSuggestions: string[] = [];
let currentRelationshipSource = "";
let desktopKnowledgeDock: DesktopKnowledgeDock | null = null;
// Tracks the index version from the last notesIndexPayload response so we can
// detect when the server's watcher has bumped the index due to external changes.
let lastNotesIndexVersion = 0;
// True when a notes-index-changed event arrived while the page was hidden;
// triggers reloadNotes on the next visibility-restore.
let pendingNotesRefresh = false;
let wikiIndexCache: WikiIndex | null = null;
let wikiIndexPromise: Promise<WikiIndex> | null = null;
const notesRefreshTimer = new CoalescedTimer(500);
let initialNotesIdleHandle = 0;
// Ephemeral request-level cache for completions — NOT a roam business cache.
// Holds results only for the duration of the current completion session (same
// context key). Discarded as soon as the context key changes.
const completionEpoch = new Epoch();
const completionTimer = new CoalescedTimer(60);
let completionContextKey = "";
let completionPendingItems: SnippetSummary[] | null = null;
let pendingOpenHash = "";
let pendingOpenDomTarget = "";
let pendingTodoTarget: TodoTarget | null = null;
let snippetPopupItems: SnippetSummary[] = [];
let snippetPopupIndex = 0;
let snippetDeleteBefore = 0;
let snippetSuppressedPrefix = "";
let snippetCompletionArmed = false;
let snippetRenderKey = "";
let snippetPopupMatchKey = "";
let snippetPopupChooseHandler: ((snippet: SnippetSummary) => boolean) | null = null;
const snippetUsage = new SnippetUsageStore();

const QUICK_INSERT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  footnote: ["脚注", "jiaozhu", "jiaoz", "引用"],
  revision: ["修订", "xiuding", "建议", "jianyi"],
  metadata: ["属性", "shuxing", "元数据", "yuanshuju"],
  "heading-1": ["一级标题", "标题", "yijibiaoti", "biaoti", "bt"],
  "heading-2": ["二级标题", "标题", "erjibiaoti", "biaoti", "bt"],
  "heading-3": ["三级标题", "标题", "sanjibiaoti", "biaoti", "bt"],
  "bullet-list": ["无序列表", "wuxuliebiao", "liebia", "liebiao"],
  "ordered-list": ["有序列表", "youxuliebiao", "编号", "bianhao"],
  "task-list": ["任务列表", "renwuliebiao", "待办", "daiban"],
  blockquote: ["引用块", "yinyong", "引用"],
  "code-block": ["代码块", "daimakuai", "daima"],
  "jupyter-cell": ["计算单元", "jisuan", "代码单元", "daimadanyuan"],
  table: ["表格", "biaoge", "bg"],
  "table-insert-row": ["插入行", "charuhang", "表格"],
  "table-insert-column": ["插入列", "charulie", "表格"],
  "table-delete-row": ["删除行", "shanchuhang", "表格"],
  "table-delete-column": ["删除列", "shanchulie", "表格"],
  "table-align-left": ["左对齐", "zuoduiqi", "表格"],
  "table-align-center": ["居中", "juzhong", "表格"],
  "table-align-right": ["右对齐", "youduiqi", "表格"],
  "table-format": ["格式化表格", "geshihua", "表格"],
  "math-block": ["公式", "gongshi", "数学", "shuxue"],
  toc: ["目录", "mulu", "大纲", "dagang"],
  "org-env-proof": ["证明", "zhengming"],
  "org-env-theorem": ["定理", "dingli"],
  "org-env-note": ["注记", "笔记块", "zhuji", "biji"],
  image: ["图片", "tupian", "图像", "tuxiang"],
};

type SlashMenuPreferences = {
  enabled: boolean;
  order: string[];
  hidden: Set<string>;
};

function readStringArrayStorage(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function loadSlashMenuPreferences(): SlashMenuPreferences {
  let enabled = true;
  try {
    enabled = localStorage.getItem("noema.quickInsert.enabled") !== "false";
  } catch {
    // Storage can be unavailable in a locked-down browser; defaults remain safe.
  }
  return {
    enabled,
    order: readStringArrayStorage("noema.quickInsert.order"),
    hidden: new Set(readStringArrayStorage("noema.quickInsert.hidden")),
  };
}

let slashMenuPreferences = loadSlashMenuPreferences();
window.addEventListener("storage", (event) => {
  if (event.key?.startsWith("noema.quickInsert.")) slashMenuPreferences = loadSlashMenuPreferences();
});

const HEADING_NUMBER_FORMATS = new Set<HeadingNumberFormat>([
  "decimal-hierarchical",
  "upper-alpha-hierarchical",
  "lower-alpha-hierarchical",
  "upper-roman-hierarchical",
  "lower-roman-hierarchical",
  "upper-greek-hierarchical",
  "lower-greek-hierarchical",
  "decimal-parenthesized",
  "chinese-document",
]);

function loadHeadingNumberingPreference(): { enabled: boolean; format: HeadingNumberFormat } {
  try {
    const format = localStorage.getItem("noema.headingNumbering.format") as HeadingNumberFormat | null;
    return {
      enabled: localStorage.getItem("noema.headingNumbering.enabled") === "true",
      format: format && HEADING_NUMBER_FORMATS.has(format) ? format : "decimal-hierarchical",
    };
  } catch {
    return { enabled: false, format: "decimal-hierarchical" };
  }
}

let headingNumberingPreference = loadHeadingNumberingPreference();

function loadWikiCompletionIndex(force = false): Promise<WikiIndex> {
  if (!force && wikiIndexCache) return Promise.resolve(wikiIndexCache);
  if (!force && wikiIndexPromise) return wikiIndexPromise;
  const request = force ? api.wiki.refresh() : api.wiki.bootstrap();
  wikiIndexPromise = request.then((value) => {
    wikiIndexCache = value;
    return value;
  }).finally(() => {
    wikiIndexPromise = null;
  });
  return wikiIndexPromise;
}

function openWikiPageCreation(title: string): void {
  const url = new URL("/wiki", location.origin);
  url.searchParams.set("new", "1");
  url.searchParams.set("title", title);
  if (currentFile) url.searchParams.set("source", currentFile);
  window.open(url, "_blank", "noopener");
}

const BUILTIN_SNIPPET_SOURCE = "aaronnote:builtin";
const LATEX_MARK_SNIPPETS: SnippetSummary[] = latexMarkSnippetDefinitions().map((snippet) => ({
  ...snippet,
  mode: "markdown-mode",
  group: "Noema LaTeX marks",
  kind: "",
  source: BUILTIN_SNIPPET_SOURCE,
}));
const BUILTIN_SNIPPETS: SnippetSummary[] = [{
  key: ":",
  name: "Display math",
  mode: "markdown-mode",
  group: "Noema builtin",
  kind: "",
  body: "\\[\n$1\n\\]\n$0",
  source: BUILTIN_SNIPPET_SOURCE,
}, {
  key: "cite",
  name: "Citation",
  mode: "markdown-mode",
  group: "Noema builtin",
  kind: "",
  body: "@@cite(${1:namespace}) [${2:key}]$0",
  source: BUILTIN_SNIPPET_SOURCE,
}, {
  key: "latexmk",
  name: "LaTeX mark",
  mode: "markdown-mode",
  group: "Noema builtin",
  kind: "",
  body: `@@latexmk(\${1|${latexMarkNames().join(",")}|})$0`,
  source: BUILTIN_SNIPPET_SOURCE,
}, ...AARONNOTE_AUTHORING_SNIPPETS.map((snippet) => ({
  ...snippet,
  mode: "markdown-mode",
  group: snippet.context === "org-meta" ? "Noema metadata" : "Noema authoring",
  kind: "",
  source: BUILTIN_SNIPPET_SOURCE,
})), ...LATEX_MARK_SNIPPETS];
let paused = false;
let rendererActivityState: RendererActivityState = "active";
const pauseReasons = new Set<string>();
type MathPreviewSession = {
  /** Formula identity, stable while its body is being edited. */
  formula: string;
  tex: string;
  to: number;
  contentFrom: number;
  display: boolean;
  doc: object;
  geometryEpoch: number;
  anchorRect: { left: number; top: number; bottom: number } | null;
  bottomRect: { bottom: number } | null;
};
let mathPreviewSession: MathPreviewSession | null = null;
let mathPreviewPendingErrorKey = "";
let mathPreviewErrorTimer = 0;
let mathPreviewWidth = 0;
let liveTexPreview: VisualTexPreview | null = null;
let mathPreviewGeometryEpoch = 0;
const clientId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const changeHandlers = new Set<() => void>();
const selectionChangeHandlers = new Set<() => void>();
const vimModeChangeHandlers = new Set<() => void>();
const copilotActiveChangeHandlers = new Set<() => void>();
const copilotFileChangeHandlers = new Set<() => void>();
const MATH_PREVIEW_ERROR_MAX_LENGTH = 180;
const NAVIGATION_BACK_STACK_MAX = 80;
const PROSE_SCOPE_PADDING = 32 * 1024;
const PROSE_SCOPE_MAX_CHARS = 180_000;
const LANGUAGETOOL_LOCAL_DEADLINE_ALLOWANCE_MS = 17_000;
const PROSE_PROFILES = {
  responsive: { idleMs: 1_000, scrollMs: 500, padding: 4 * 1024, maxChars: 32 * 1024 },
  balanced: { idleMs: 1_800, scrollMs: 700, padding: 4 * 1024, maxChars: 32 * 1024 },
  quiet: { idleMs: 3_000, scrollMs: 1_200, padding: 2 * 1024, maxChars: 16 * 1024 },
} as const;
const LARGE_DOCUMENT_CHARS = 512 * 1024;
const editorCommands = new Set<EditorCommand>([
  "bold",
  "italic",
  "highlight",
  "strike",
  "code",
  "link",
  "superscript",
  "subscript",
  "insert-footnote",
  "insert-revision",
  "edit-properties",
  "move-block-up",
  "move-block-down",
  "blockquote",
  "bullet-list",
  "ordered-list",
  "task-list",
  "code-block",
  "paragraph-menu",
  "insert-table",
  "insert-math-block",
  "insert-toc",
  "insert-org-env",
  "image-edit",
  "table-insert-row",
  "table-insert-column",
  "table-delete-row",
  "table-delete-column",
  "heading-1",
  "heading-2",
  "heading-3",
  "heading-4",
  "heading-5",
  "heading-6",
  "fold-heading",
  "unfold-heading",
  "toggle-fold",
  "fold-all-headings",
  "unfold-all-headings",
  "copy-code",
]);

window.AaronnoteCurrentFile = () => currentFile;
window.AaronnoteBlockTarget = (blockId: string) => noteAnchorHref(currentNote(), encodeURIComponent(blockId));

type ApplyOpenedNoteOptions = {
  revealCursor?: boolean;
  focusEditor?: boolean;
  updateStatus?: boolean;
  resetVim?: boolean;
  reloadNotes?: boolean;
  preserveView?: boolean;
};

async function uploadPasteBlobAsset(
  blob: Blob,
  meta: { file?: string; name?: string; type?: string },
): Promise<StoredPasteAsset> {
  return api.assets.upload({
    file: meta.file || currentFile,
    name: meta.name,
    type: meta.type || blob.type,
    data: await blobToBase64(blob),
  });
}

async function storePasteAssetFromPath(
  path: string,
  meta: { file?: string; name?: string; type?: string },
): Promise<StoredPasteAsset> {
  return api.assets.storeFromPath({
    file: meta.file || currentFile,
    path,
    name: meta.name,
    type: meta.type,
  });
}

async function readSystemClipboardForPaste(): Promise<EditorClipboardPayload | null> {
  try {
    if (desktopMode && window.noemaDesktop?.readClipboard) {
      const clipboard = await window.noemaDesktop.readClipboard();
      if (clipboard.kind === "image") {
        const asset = await api.assets.upload({
          file: currentFile,
          name: "clipboard.png",
          type: clipboard.type,
          data: clipboard.data,
        });
        return { kind: "asset", asset };
      }
      if (clipboard.kind === "text") return clipboard;
      return { kind: "empty" };
    }
    const payload = await api.clipboard.read({ file: currentFile }) as EditorClipboardPayload;
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

async function openSystemTarget(target: string, base = ""): Promise<void> {
  const result = await api.emacs.systemOpen(target, base || undefined);
  if (!desktopMode || !window.noemaDesktop || !result?.target) return;
  const protocol = hrefProtocol(result.target);
  const opened = protocol
    ? await window.noemaDesktop.openExternal(result.target)
    : await window.noemaDesktop.openPath(result.target);
  if (!opened.ok) throw new Error(opened.message || `Unable to open ${result.target}`);
}

function primaryShortcut(key: string): string {
  return `${platformLabels.primaryModifier}-${key}`;
}

function roamFeaturesEnabled(): boolean {
  return !currentStandalone;
}

let lastEmacsStatus = "";
let lastEmacsStatusAt = 0;
let pendingEmacsStatusTimer: number | null = null;
let pendingEmacsStatus: { message: string; severity: "info" | "warning" | "error" } | null = null;

function statusSeverity(message: string): "warning" | "error" | null {
  if (/\b(?:error|failed?|conflict|not found|unavailable)\b/i.test(message)) return "error";
  if (/\b(?:warning|warn|changed in another pane)\b/i.test(message)) return "warning";
  return null;
}

function routineStatus(message: string): boolean {
  return /^(?:opening(?:\.\.\.)?|saved|edited|ready)$/i.test(message.trim());
}

function sendImportantStatus(message: string, severity: "info" | "warning" | "error"): void {
  const send = (next: { message: string; severity: "info" | "warning" | "error" }) => {
    lastEmacsStatus = next.message;
    lastEmacsStatusAt = performance.now();
    void api.emacs.uiState({ client: currentClient, status: next.message, severity: next.severity });
  };
  if (severity === "error" || performance.now() - lastEmacsStatusAt >= 450) {
    if (pendingEmacsStatusTimer !== null) window.clearTimeout(pendingEmacsStatusTimer);
    pendingEmacsStatusTimer = null;
    pendingEmacsStatus = null;
    send({ message, severity });
    return;
  }
  pendingEmacsStatus = { message, severity };
  if (pendingEmacsStatusTimer !== null) return;
  pendingEmacsStatusTimer = window.setTimeout(() => {
    pendingEmacsStatusTimer = null;
    const next = pendingEmacsStatus;
    pendingEmacsStatus = null;
    if (next && next.message !== lastEmacsStatus) send(next);
  }, Math.max(0, 450 - (performance.now() - lastEmacsStatusAt)));
}

function setStatus(message: string): void {
  statusLabel.textContent = message;
  delete statusLabel.dataset.proseOwner;
  const severity = statusSeverity(message);
  if (!routineStatus(message) && message !== lastEmacsStatus) {
    sendImportantStatus(message, severity || "info");
  }
}

let coreWasDisconnected = api.connection.status() === "disconnected";
const coreReconnectController = api.connection.supported()
  ? installActiveCoreReconnect({
      connection: api.connection,
      onStatus(status) {
        if (status === "disconnected") {
          coreWasDisconnected = true;
          // Do not mirror this message through the unavailable core.
          statusLabel.textContent = "Core disconnected — focus, click, or type to reconnect";
          return;
        }
        if (status === "connecting") {
          if (coreWasDisconnected) statusLabel.textContent = "Reconnecting to core…";
          return;
        }
        if (coreWasDisconnected) {
          coreWasDisconnected = false;
          setStatus("Core reconnected");
          // SSE has no replay. A pane that was suspended while another split
          // saved may have missed note-saved entirely, so reconcile once from
          // the authoritative file after reconnect. The same-document CM6
          // path preserves its logical cursor and viewport.
          void reconcileCurrentFileAfterCoreReconnect();
        }
      },
    })
  : null;

function setOwnedProseStatus(requestId: number, message: string): void {
  setStatus(message);
  statusLabel.dataset.proseOwner = String(requestId);
}

function applyReadOnlyUi(): void {
  root.classList.toggle("is-readonly", currentReadOnly);
  root.dataset.readonly = currentReadOnly ? "true" : "false";
  document.body.dataset.readonly = currentReadOnly ? "true" : "false";
  readOnlyLabel.hidden = !currentReadOnly;
  saveButton.hidden = currentReadOnly;
  saveButton.disabled = currentReadOnly;
  if (currentReadOnly) {
    sourceButton.title = "Toggle source view (read-only)";
  } else {
    sourceButton.removeAttribute("title");
  }
}

function rejectReadOnlyAction(action = "Read-only pane"): boolean {
  if (!currentReadOnly) return false;
  setStatus(action);
  return true;
}

function snippetIdentity(snippet: SnippetSummary): string {
  return `${snippet.kind || ""}\0${snippet.mode || ""}\0${snippet.key || ""}`;
}

function withBuiltinSnippets(items: readonly SnippetSummary[] = []): SnippetSummary[] {
  const builtins = new Map(BUILTIN_SNIPPETS.map((snippet) => [snippetIdentity(snippet), snippet]));
  return [
    ...items.filter((snippet) => !builtins.has(snippetIdentity(snippet))),
    ...BUILTIN_SNIPPETS,
  ];
}
snippets = withBuiltinSnippets(snippets);

function updateTitle(): void {
  const name = currentFile.split(/[\\/]/).at(-1) || "Noema";
  const displayName = serverReaderMode && currentTitle ? currentTitle : name;
  fileLabel.textContent = name;
  desktopTitleName.textContent = name;
  desktopTitleName.title = currentFile || name;
  serverTitleName.textContent = displayName;
  serverTitleName.title = currentFile || displayName;
  document.title = currentReadOnly
    ? serverReaderMode ? `${displayName} · Noema Wiki` : `${name} (read-only)`
    : revision === savedRevision ? name : `* ${name}`;
  const windowState = {
    kind: "note" as const,
    file: currentFile,
    title: name,
    dirty: !currentReadOnly && revision !== savedRevision,
    saveInFlight: desktopSaveInFlight,
    conflict: desktopSaveConflict,
    busy: false,
  };
  window.noemaDesktop?.updateWindowState(windowState);
}

function renderModeToggleLabel(mode: VimLiteMode): void {
  if (slideDeck?.isRevealView()) {
    const target = slideDeck.getTheme() === "dark" ? "light" : "dark";
    modeLabel.textContent = target.toUpperCase();
    modeToggle.title = `Switch slides to ${target} theme`;
    modeToggle.setAttribute("aria-label", `Switch slides to ${target} theme`);
    modeToggle.setAttribute("aria-expanded", "false");
    modeToggle.classList.remove("is-active");
  } else {
    modeLabel.textContent = mode.toUpperCase();
    modeToggle.title = "Toggle tools";
    modeToggle.setAttribute("aria-label", "Toggle tools");
  }
}

function updateModeLabel(mode: VimLiteMode): void {
  renderModeToggleLabel(mode);
  modeLabel.dataset.mode = mode;
  root.dataset.vimMode = mode;
  host.dataset.vimMode = mode;
  document.body.dataset.vimMode = mode;
  if (mode === "normal") noteCursorPositionEvent();
  vimModeChangeHandlers.forEach((handler) => handler());
  scheduleAssistUpdate({ mathPreview: true, cursor: true });
}

function subscribe<K extends keyof DocumentEventMap>(
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  document.addEventListener(type, handler, options);
  return () => document.removeEventListener(type, handler, options);
}

let visualMathEditorActive = false;
let visualMathReturnMode: VimLiteMode | null = null;
let slideDeck: SlideDeckController | null = null;
let writingStatsController: WritingStatsController | null = null;
let reconcileVimSelection: (() => void) | undefined;

const editor = createEditor(host, {
  initialContent: "",
  readOnly: initialReadOnly,
  passiveReader: passiveServerReader,
  headingNumbering: headingNumberingPreference,
  getCurrentFile: () => currentFile,
  pasteAssets: {
    uploadBlobAsset: uploadPasteBlobAsset,
    storeAssetFromPath: storePasteAssetFromPath,
  },
  readSystemClipboardFallback: readSystemClipboardForPaste,
  onChange: () => {
    if (!applyingContent) revision += 1;
    updateTitle();
    changeHandlers.forEach((handler) => handler());
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true, toc: true });
    if (bibliographyResolutionDirty) scheduleBibliographyRefresh();
    if (!currentReadOnly) scheduleSave();
    scheduleWritingStats(true);
    if (!applyingContent && !currentReadOnly) {
      proseLifecycle.invalidate("document-edited");
      scheduleAutomaticProseCheck();
    }
    slideDeck?.refresh();
  },
  onSelectionChange: () => {
    reconcileVimSelection?.();
    selectionChangeHandlers.forEach((handler) => handler());
    scheduleWritingStats(writingStatsController?.isDocumentChanged() ?? true);
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
  },
  onBlur: () => {
    // Focus changes are not mode commands.  Desktop controls and Emacs buffer
    // switches must preserve Insert/Normal/Visual and the live selection.
    void flushCursorPosition();
  },
});
editor.onViewUpdate((update) => {
  if (update.docChanged) editorSaveChanges.record(update.changes);
});
editor.onDocumentReset(() => {
  editorSaveChanges.reset();
  forceFullEditorSave = false;
});

type DesktopEditorPerfResult = {
  iterations: number;
  insertMs: number;
  deleteMs: number;
  insertP95Ms: number;
  deleteP95Ms: number;
  maxInsertMs: number;
  maxDeleteMs: number;
  formulaDragSteps: number;
  formulaDragDispatchP95Ms: number;
  formulaDragDispatchMaxMs: number;
  formulaDragFrameP95Ms: number;
  formulaDragFrameMaxMs: number;
  formulaScrollSteps: number;
  formulaScrollFrameP95Ms: number;
  formulaScrollFrameMaxMs: number;
  formulaScrollTargetErrorMaxPx: number;
  formulaScrollBacktracks: number;
  formulaScrollMathRebuilds: number;
  formulaScrollAtomicRebuilds: number;
  sourceScrollFrameP95Ms: number;
  sourceScrollFrameMaxMs: number;
  sourceScrollTargetErrorMaxPx: number;
  formulaPreviewVisibleBeforeScroll: boolean;
  formulaPreviewClosedOnScroll: boolean;
  initialVisualNodeCount: number;
  settledVisualNodeCount: number;
  roundTripVisualNodeCount: number;
  initialVisualMatchesSettled: boolean;
  settledVisualMatchesRoundTrip: boolean;
  visualRoundTripConsistent: boolean;
  initialMathBlockCount: number;
  settledMathBlockCount: number;
  roundTripMathBlockCount: number;
  initialOrgEnvBlockCount: number;
  settledOrgEnvBlockCount: number;
  roundTripOrgEnvBlockCount: number;
  initialViewportFrom: number;
  initialViewportTo: number;
  settledViewportFrom: number;
  settledViewportTo: number;
  roundTripViewportFrom: number;
  roundTripViewportTo: number;
  initialProbeScrollTop: number;
  settledProbeScrollTop: number;
  roundTripProbeScrollTop: number;
  initialFirstMathSourceFrom: number;
  settledFirstMathSourceFrom: number;
  roundTripFirstMathSourceFrom: number;
  longTaskCount: number;
  longTaskMs: number;
  contentRestored: boolean;
};

const desktopPerfSmokeMode = initialParams.get("desktopPerfSmoke");
if (desktopPerfSmokeMode === "1" || desktopPerfSmokeMode === "selection") {
  (
    window as Window & {
      __noemaRunEditorPerfProbe?: () => Promise<DesktopEditorPerfResult>;
    }
  ).__noemaRunEditorPerfProbe = async () => {
    const iterations = desktopPerfSmokeMode === "selection" ? 0 : 500;
    const original = editor.view.state.doc.toString();
    const originalSelection = editor.view.state.selection.main;
    const longTasks: number[] = [];
    const observer =
      typeof PerformanceObserver !== "undefined"
        ? new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) longTasks.push(entry.duration);
          })
        : null;
    try {
      observer?.observe({ entryTypes: ["longtask"] });
    } catch {
      // Long Tasks is not available in every Chromium execution mode.
    }

    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const percentile95 = (samples: number[]) => {
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] || 0;
    };
    const visualSelectors = [
      ".cm-front-matter-block",
      ".cm-org-env-block",
      ".cm-math-block",
      ".cm-math-inline",
      ".cm-horizontal-rule",
      ".cm-table-block",
      ".cm-code-fold-button",
      ".syntax-hidden",
      ".syntax-hint",
    ];
    const visualSignature = (): Record<string, number> => (
      Object.fromEntries(visualSelectors.map((selector) => [
        selector,
        editor.view.dom.querySelectorAll(selector).length,
      ]))
    );
    const visualSourceSignature = (): Array<{ selector: string; from: number; to: number }> => {
      const signature: Array<{ selector: string; from: number; to: number }> = [];
      for (const selector of visualSelectors) {
        for (const node of editor.view.dom.querySelectorAll<HTMLElement>(selector)) {
          const datasetFrom = node.dataset.cmSourceFrom;
          const datasetTo = node.dataset.cmSourceTo;
          let from = datasetFrom == null ? Number.NaN : Number(datasetFrom);
          let to = datasetTo == null ? Number.NaN : Number(datasetTo);
          if (!Number.isFinite(from)) {
            try { from = editor.view.posAtDOM(node, 0); } catch { continue; }
          }
          if (!Number.isFinite(to)) to = from;
          signature.push({ selector, from, to });
        }
      }
      return signature.sort((left, right) => (
        left.from - right.from || left.to - right.to || left.selector.localeCompare(right.selector)
      ));
    };
    const firstVisibleMathSourceFrom = (): number => {
      const value = Number(editor.view.dom.querySelector<HTMLElement>(
        ".cm-math-block[data-cm-source-from]",
      )?.dataset.cmSourceFrom);
      return Number.isFinite(value) ? value : -1;
    };
    const initialProbeSelection = editor.view.state.selection.main;
    const initialProbeScrollTop = host.scrollTop;
    await frame();
    await frame();
    const initialVisualSignature = visualSignature();
    const initialVisualSources = visualSourceSignature();
    const initialViewport = { ...editor.view.viewport };
    const initialScrollTop = host.scrollTop;
    const initialFirstMathSourceFrom = firstVisibleMathSourceFrom();
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    await frame();
    await frame();
    const settledVisualSignature = visualSignature();
    const settledVisualSources = visualSourceSignature();
    const settledViewport = { ...editor.view.viewport };
    const settledProbeScrollTop = host.scrollTop;
    const settledFirstMathSourceFrom = firstVisibleMathSourceFrom();
    editor.toggleSource();
    await frame();
    await frame();
    editor.toggleSource();
    host.scrollTop = initialProbeScrollTop;
    await frame();
    await frame();
    await frame();
    await frame();
    const roundTripVisualSignature = visualSignature();
    const roundTripVisualSources = visualSourceSignature();
    const roundTripViewport = { ...editor.view.viewport };
    const roundTripProbeScrollTop = host.scrollTop;
    const roundTripFirstMathSourceFrom = firstVisibleMathSourceFrom();
    const initialVisualNodeCount = Object.values(initialVisualSignature)
      .reduce((sum, count) => sum + count, 0);
    const settledVisualNodeCount = Object.values(settledVisualSignature)
      .reduce((sum, count) => sum + count, 0);
    const roundTripVisualNodeCount = Object.values(roundTripVisualSignature)
      .reduce((sum, count) => sum + count, 0);
    // CM6 intentionally mounts an overscan margin outside the screen. A mode
    // reconfiguration may widen that margin while the actual scroll position
    // and visible source stay unchanged, so raw DOM counts are diagnostics,
    // not a correctness predicate. Compare only the source interval covered
    // by both snapshots.
    const commonVisualFrom = Math.max(
      initialViewport.from,
      settledViewport.from,
      roundTripViewport.from,
    );
    const commonVisualTo = Math.min(
      initialViewport.to,
      settledViewport.to,
      roundTripViewport.to,
    );
    const comparableVisualSignature = (
      signature: Array<{ selector: string; from: number; to: number }>,
    ): string => signature
      .filter((entry) => entry.to >= commonVisualFrom && entry.from <= commonVisualTo)
      .map((entry) => `${entry.selector}:${entry.from}:${entry.to}`)
      .join("|");
    const sameVisualSignature = (
      left: Array<{ selector: string; from: number; to: number }>,
      right: Array<{ selector: string; from: number; to: number }>,
    ) => comparableVisualSignature(left) === comparableVisualSignature(right);
    const initialVisualMatchesSettled = sameVisualSignature(
      initialVisualSources,
      settledVisualSources,
    );
    const settledVisualMatchesRoundTrip = sameVisualSignature(
      settledVisualSources,
      roundTripVisualSources,
    );
    const visualRoundTripConsistent = sameVisualSignature(
      initialVisualSources,
      roundTripVisualSources,
    );
    editor.view.dispatch({
      selection: {
        anchor: initialProbeSelection.anchor,
        head: initialProbeSelection.head,
      },
    });
    if (iterations > 0) {
      const selection = editor.view.state.doc.length;
      editor.view.dispatch({ selection: { anchor: selection } });
      await frame();

      // Warm the update/decorations path without including first-use module
      // and font work in the measured run.
      for (let i = 0; i < 20; i += 1) editor.insertText("x");
      for (let i = 0; i < 20; i += 1) editor.insertText("", 1);
      await frame();
    }

    const insertSamples: number[] = [];
    const insertStart = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      const started = performance.now();
      editor.insertText("x");
      insertSamples.push(performance.now() - started);
    }
    await frame();
    const insertMs = performance.now() - insertStart;

    const deleteSamples: number[] = [];
    const deleteStart = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      const started = performance.now();
      editor.insertText("", 1);
      deleteSamples.push(performance.now() - started);
    }
    await frame();
    const deleteMs = performance.now() - deleteStart;

    // Measure the interaction that is most sensitive to WebKit layout: a
    // pointer selection crossing a rendered display formula in a large note.
    // The dispatch samples expose synchronous CM6/plugin work; the frame
    // samples also include drawSelection, widget layout and layer painting.
    const formulaOpen = original.indexOf("\\[");
    const formulaClose = formulaOpen >= 0 ? original.indexOf("\\]", formulaOpen + 2) : -1;
    const formulaDragDispatchSamples: number[] = [];
    const formulaDragFrameSamples: number[] = [];
    let formulaDragSteps = 0;
    if (formulaOpen >= 0 && formulaClose > formulaOpen) {
      const anchor = Math.max(0, original.lastIndexOf("\n", Math.max(0, formulaOpen - 600)) + 1);
      const end = Math.min(original.length, formulaClose + 2 + 600);
      const heads = Array.from(
        { length: 36 },
        (_, index) => anchor + Math.floor(((end - anchor) * (index + 1)) / 36),
      );
      editor.view.dispatch({
        selection: { anchor },
        effects: pointerSelectionEffect.of(true),
        scrollIntoView: true,
      });
      rendererActivity.notifyActivity();
      await frame();
      await frame();
      for (const head of heads) {
        const started = performance.now();
        editor.view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
        formulaDragDispatchSamples.push(performance.now() - started);
        await frame();
        formulaDragFrameSamples.push(performance.now() - started);
      }
      formulaDragSteps = heads.length;
      editor.view.dispatch({ effects: pointerSelectionEffect.of(false) });
    }

    // Put the caret inside a real inline formula so the first scroll frame
    // exercises the fixed formula preview. Scrolling intentionally closes the
    // preview; all subsequent frames must remain free of popup geometry reads.
    const inlineFormulaOpen = original.indexOf("\\(");
    if (inlineFormulaOpen >= 0) {
      editor.setMarkdownSelection(inlineFormulaOpen + 2, undefined, { scrollIntoView: true });
      scheduleAssistUpdate({ mathPreview: true, cursor: true });
      await frame();
      await frame();
    }
    if (mathPreview.hidden && formulaOpen >= 0 && formulaClose > formulaOpen) {
      // Visual mode normally opens MathLive inline. For this smoke-only path,
      // mount the same resident preview with real document TeX so the first
      // scroll frame still proves that the heavier floating surface is closed.
      ensureLiveTexPreview().update({
        latex: original.slice(formulaOpen + 2, formulaClose).trim(),
        display: true,
        selection: { anchor: 0, head: 0 },
        placeholders: [],
      });
      mathPreview.classList.add("is-display");
      mathPreview.hidden = false;
      await frame();
    }
    const formulaPreviewVisibleBeforeScroll = !mathPreview.hidden;
    const formulaScrollFrameSamples: number[] = [];
    const formulaScrollErrors: number[] = [];
    const formulaScrollSteps = 72;
    // 240 px/frame covers a fast trackpad gesture without turning the probe
    // into repeated PageDown-sized teleports through unmounted content.
    const formulaScrollDelta = 240;
    const formulaScrollStart = host.scrollTop;
    const formulaScrollMaximum = Math.max(0, host.scrollHeight - host.clientHeight);
    const formulaRebuildsBeforeScroll = blockMathFullRebuildCount();
    const formulaAtomicRebuildsBeforeScroll = blockMathAtomicFullRebuildCount();
    let formulaScrollBacktracks = 0;
    let previousScrollTop = formulaScrollStart;
    rendererActivity.notifyActivity();
    host.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: formulaScrollDelta,
    }));
    for (let index = 1; index <= formulaScrollSteps; index += 1) {
      const target = Math.min(
        formulaScrollMaximum,
        formulaScrollStart + index * formulaScrollDelta,
      );
      const started = performance.now();
      host.scrollTop = target;
      host.dispatchEvent(new Event("scroll"));
      await frame();
      const actual = host.scrollTop;
      formulaScrollFrameSamples.push(performance.now() - started);
      formulaScrollErrors.push(Math.abs(actual - target));
      if (actual + 0.5 < previousScrollTop) formulaScrollBacktracks += 1;
      previousScrollTop = actual;
    }
    const formulaPreviewClosedOnScroll = formulaPreviewVisibleBeforeScroll && mathPreview.hidden;
    const formulaScrollMathRebuilds = blockMathFullRebuildCount() - formulaRebuildsBeforeScroll;
    const formulaScrollAtomicRebuilds = blockMathAtomicFullRebuildCount()
      - formulaAtomicRebuildsBeforeScroll;

    // Same outer-scroll path with visual extensions disabled. This separates
    // browser/CM6 baseline cost from viewport widget construction.
    host.scrollTop = formulaScrollStart;
    editor.toggleSource();
    await frame();
    await frame();
    const sourceScrollFrameSamples: number[] = [];
    const sourceScrollErrors: number[] = [];
    host.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: formulaScrollDelta,
    }));
    for (let index = 1; index <= formulaScrollSteps; index += 1) {
      const target = Math.min(
        formulaScrollMaximum,
        formulaScrollStart + index * formulaScrollDelta,
      );
      const started = performance.now();
      host.scrollTop = target;
      host.dispatchEvent(new Event("scroll"));
      await frame();
      sourceScrollFrameSamples.push(performance.now() - started);
      sourceScrollErrors.push(Math.abs(host.scrollTop - target));
    }
    editor.toggleSource();
    await frame();
    await frame();

    const restoredSelection = {
      anchor: Math.min(originalSelection.anchor, original.length),
      head: Math.min(originalSelection.head, original.length),
    };
    const currentContent = editor.view.state.doc.toString();
    editor.view.dispatch(currentContent === original
      ? { selection: restoredSelection }
      : {
          changes: { from: 0, to: editor.view.state.doc.length, insert: original },
          selection: restoredSelection,
        });
    host.scrollTop = initialProbeScrollTop;
    await frame();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    observer?.disconnect();

    return {
      iterations,
      insertMs,
      deleteMs,
      insertP95Ms: percentile95(insertSamples),
      deleteP95Ms: percentile95(deleteSamples),
      maxInsertMs: Math.max(0, ...insertSamples),
      maxDeleteMs: Math.max(0, ...deleteSamples),
      formulaDragSteps,
      formulaDragDispatchP95Ms: percentile95(formulaDragDispatchSamples),
      formulaDragDispatchMaxMs: Math.max(0, ...formulaDragDispatchSamples),
      formulaDragFrameP95Ms: percentile95(formulaDragFrameSamples),
      formulaDragFrameMaxMs: Math.max(0, ...formulaDragFrameSamples),
      formulaScrollSteps,
      formulaScrollFrameP95Ms: percentile95(formulaScrollFrameSamples),
      formulaScrollFrameMaxMs: Math.max(0, ...formulaScrollFrameSamples),
      formulaScrollTargetErrorMaxPx: Math.max(0, ...formulaScrollErrors),
      formulaScrollBacktracks,
      formulaScrollMathRebuilds,
      formulaScrollAtomicRebuilds,
      sourceScrollFrameP95Ms: percentile95(sourceScrollFrameSamples),
      sourceScrollFrameMaxMs: Math.max(0, ...sourceScrollFrameSamples),
      sourceScrollTargetErrorMaxPx: Math.max(0, ...sourceScrollErrors),
      formulaPreviewVisibleBeforeScroll,
      formulaPreviewClosedOnScroll,
      initialVisualNodeCount,
      settledVisualNodeCount,
      roundTripVisualNodeCount,
      initialVisualMatchesSettled,
      settledVisualMatchesRoundTrip,
      visualRoundTripConsistent,
      initialMathBlockCount: initialVisualSignature[".cm-math-block"] ?? 0,
      settledMathBlockCount: settledVisualSignature[".cm-math-block"] ?? 0,
      roundTripMathBlockCount: roundTripVisualSignature[".cm-math-block"] ?? 0,
      initialOrgEnvBlockCount: initialVisualSignature[".cm-org-env-block"] ?? 0,
      settledOrgEnvBlockCount: settledVisualSignature[".cm-org-env-block"] ?? 0,
      roundTripOrgEnvBlockCount: roundTripVisualSignature[".cm-org-env-block"] ?? 0,
      initialViewportFrom: initialViewport.from,
      initialViewportTo: initialViewport.to,
      settledViewportFrom: settledViewport.from,
      settledViewportTo: settledViewport.to,
      roundTripViewportFrom: roundTripViewport.from,
      roundTripViewportTo: roundTripViewport.to,
      initialProbeScrollTop: initialScrollTop,
      settledProbeScrollTop,
      roundTripProbeScrollTop,
      initialFirstMathSourceFrom,
      settledFirstMathSourceFrom,
      roundTripFirstMathSourceFrom,
      longTaskCount: longTasks.length,
      longTaskMs: longTasks.reduce((sum, duration) => sum + duration, 0),
      contentRestored: editor.view.state.doc.toString() === original,
    };
  };
}

document.body.dataset.headingNumbers = headingNumberingPreference.enabled ? "true" : "false";

function applyHeadingNumberingPreference(
  next: { enabled: boolean; format?: HeadingNumberFormat },
  persist = true,
): void {
  headingNumberingPreference = {
    enabled: next.enabled,
    format: next.format ?? headingNumberingPreference.format,
  };
  editor.setHeadingNumbering(headingNumberingPreference);
  document.body.dataset.headingNumbers = headingNumberingPreference.enabled ? "true" : "false";
  if (persist) {
    try {
      localStorage.setItem("noema.headingNumbering.enabled", String(headingNumberingPreference.enabled));
      localStorage.setItem("noema.headingNumbering.format", headingNumberingPreference.format);
    } catch {
      // The live editor state remains authoritative when storage is unavailable.
    }
  }
}

function toggleHeadingNumbering(): void {
  applyHeadingNumberingPreference({ enabled: !headingNumberingPreference.enabled });
  setStatus(`Heading numbers ${headingNumberingPreference.enabled ? "shown" : "hidden"}`);
}

window.addEventListener("storage", (event) => {
  if (event.key?.startsWith("noema.headingNumbering.")) {
    applyHeadingNumberingPreference(loadHeadingNumberingPreference(), false);
  }
});
host.appendChild(bibliographyPanel);

const linkPreview = createLinkPreviewController({
  resolveTarget(href) {
    const raw = cleanHref(href);
    const wikiTarget = raw.match(/^roam:\/\/wiki\/(.+)$/i)?.[1];
    const target = resolveHrefTarget(raw);
    const note = target.note ?? (wikiTarget ? resolveNoteRef(decodeURIComponent(wikiTarget)) : undefined);
    return {
      href: raw,
      note,
      hash: target.hash,
      domTarget: target.domTarget,
      external: !note && !/^roam:\/\//i.test(raw),
    };
  },
  openNoteContent: (file) => api.notes.open(file),
  openNote: (note, options = {}) => openNote(note, options),
  openExternalUrl,
  isSafeHref: safeHref,
  noteTitle: (note) => note.title || note.path || note.file || "Untitled",
  resolveAssetUrl(src, file) {
    const raw = String(src || "").trim();
    if (!raw || /^(?:data:|https?:|blob:|#)/i.test(raw)) return raw;
    const url = new URL("/note-asset", location.origin);
    url.searchParams.set("src", raw);
    if (file) url.searchParams.set("base", file);
    return url.toString();
  },
  beforeShow: () => {
    hideContextMenu();
    selectionTool.hidden = true;
  },
  setStatus,
});
slideDeck = createSlideDeckController({ root, host, editor, getCurrentFile: () => currentFile });
writingStatsController = createWritingStatsController(editor, writingStatsLabel);

let hoveredInternalHref = "";
let linkHoverTimer = 0;
editor.view.dom.addEventListener("pointermove", (event) => {
  const link = (event.target as Element | null)?.closest(".cm-internal-link-text, .cm-roam-link-text");
  if (!link || !editor.view.dom.contains(link)) {
    window.clearTimeout(linkHoverTimer);
    linkHoverTimer = 0;
    hoveredInternalHref = "";
    linkPreview.dismissTransient();
    return;
  }
  const pos = editor.view.posAtCoords({ x: event.clientX, y: event.clientY });
  const href = typeof pos === "number" ? markdownHrefAt(editor.view.state, pos) || "" : "";
  if (!href || href === hoveredInternalHref) return;
  window.clearTimeout(linkHoverTimer);
  hoveredInternalHref = href;
  const { clientX, clientY } = event;
  linkHoverTimer = window.setTimeout(() => {
    linkHoverTimer = 0;
    if (hoveredInternalHref === href) linkPreview.show(href, clientX, clientY);
  }, 420);
});
editor.view.dom.addEventListener("pointerleave", () => {
  window.clearTimeout(linkHoverTimer);
  linkHoverTimer = 0;
  hoveredInternalHref = "";
  window.setTimeout(() => linkPreview.dismissTransient(), 120);
});

let bibliographyModel: BibliographyDocument = { ok: true, entries: [], references: [], citations: [], namespaces: [] };
let bibliographyModelKey = "";
let bibliographyModelCommands: BibliographyCommandRange[] = [];
let bibliographyWatchRanges: BibliographyWatchRange[] = [];
let bibliographyResolutionDirty = false;
let bibliographyRenderVersion = 0;
let bibliographyRequestSeq = 0;
let bibliographyHighlightTimer = 0;
const bibliographyTimer = new CoalescedTimer(180);

function syncBibliographyRanges(changes: readonly BibliographyTextChange[]): void {
  // This callback runs inside the CodeMirror view update, before decorations
  // and the public onChange callback. Keep positions synchronous for a stable
  // label, but only mark semantic edits for the trailing full-document scan.
  if (bibliographyChangesRequireResolution(changes, bibliographyWatchRanges)) {
    bibliographyResolutionDirty = true;
  }
  mapBibliographyRangesThroughChanges(
    bibliographyModel,
    bibliographyModelCommands,
    changes,
  );
  mapBibliographyWatchRangesThroughChanges(bibliographyWatchRanges, changes);
}

function citationAtRange(from: number, to: number): BibliographyCitation | undefined {
  return (bibliographyModel.citations ?? []).find((cite) => cite.from === from && cite.to === to);
}

function referenceById(id: string): BibliographyReference | undefined {
  return (bibliographyModel.references ?? []).find((ref) => ref.id === id);
}

function bibliographyDiagnosticText(diagnostic: BibliographyDiagnostic): string {
  if (typeof diagnostic === "string") return diagnostic.trim();
  return String(diagnostic.message || diagnostic.detail || diagnostic.code || "Bibliography issue").trim();
}

function bibliographyDiagnosticTexts(diagnostics: readonly BibliographyDiagnostic[] | undefined): string[] {
  return (diagnostics ?? []).map(bibliographyDiagnosticText).filter(Boolean);
}

function citationDiagnosticTexts(cite: BibliographyCitation | undefined): string[] {
  return [...new Set([
    ...bibliographyDiagnosticTexts(cite?.diagnostics),
    ...(cite?.items ?? []).flatMap((item) => bibliographyDiagnosticTexts(item.diagnostics)),
  ])];
}

function renderBibliographyPanel(): void {
  const refs = bibliographyModel.references ?? [];
  const diagnostics = bibliographyModel.diagnostics ?? [];
  bibliographyPanel.hidden = refs.length === 0 && diagnostics.length === 0;
  bibliographyPanel.replaceChildren();
  if (diagnostics.length > 0) {
    const notice = document.createElement("section");
    notice.className = "aaronnote-bib-diagnostics";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-label", "Bibliography issues");
    const heading = document.createElement("h2");
    heading.textContent = "Bibliography issues";
    const issues = document.createElement("ul");
    for (const diagnostic of diagnostics) {
      const item = document.createElement("li");
      item.textContent = bibliographyDiagnosticText(diagnostic);
      if (typeof diagnostic !== "string" && diagnostic.severity) item.dataset.severity = diagnostic.severity;
      issues.appendChild(item);
    }
    notice.append(heading, issues);
    bibliographyPanel.appendChild(notice);
  }
  if (refs.length === 0) return;
  const title = document.createElement("h2");
  title.textContent = "References";
  bibliographyPanel.appendChild(title);
  const list = document.createElement("ol");
  list.className = "aaronnote-bib-list";
  for (const ref of refs) {
    const item = document.createElement("li");
    item.className = "aaronnote-bib-item";
    item.id = `aaronnote-bib-ref-${ref.number}`;
    item.dataset.bibId = ref.id || "";
    const text = document.createElement("span");
    text.className = "aaronnote-bib-text";
    text.textContent = ref.text || "";
    item.appendChild(text);
    for (const link of ref.links ?? []) {
      if (!link.href) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "aaronnote-bib-link";
      button.textContent = link.label || "link";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void openSystemTarget(link.href!, currentFile).catch((err) => setStatus(err instanceof Error ? err.message : "Open link failed"));
      });
      item.appendChild(button);
    }
    item.addEventListener("contextmenu", (event) => {
      if (serverReaderMode && !serverReader.customContextMenu) return;
      event.preventDefault();
      event.stopPropagation();
      showReferenceContextMenu(ref, event.clientX, event.clientY);
    });
    list.appendChild(item);
  }
  bibliographyPanel.appendChild(list);
}

function refreshBibliographyDecorations(): void {
  bibliographyRenderVersion += 1;
  refreshViewportDecorationsNow(editor.view);
  renderBibliographyPanel();
}

async function refreshBibliography(force = false): Promise<void> {
  bibliographyResolutionDirty = false;
  const content = editor.getMarkdown();
  const state = bibliographyResolutionState(content);
  const key = `${currentFile}\n${state.key}`;
  if (!state.hasCitationSyntax) {
    bibliographyRequestSeq += 1;
    const changed = bibliographyModelKey !== key
      || (bibliographyModel.citations?.length ?? 0) > 0
      || (bibliographyModel.references?.length ?? 0) > 0
      || (bibliographyModel.diagnostics?.length ?? 0) > 0;
    bibliographyModel = { ok: true, entries: [], references: [], citations: [], namespaces: [] };
    bibliographyModelKey = key;
    bibliographyModelCommands = [];
    bibliographyWatchRanges = state.watchRanges;
    if (changed) refreshBibliographyDecorations();
    return;
  }
  if (!force && key === bibliographyModelKey) {
    const changed = alignBibliographyCitationRanges(bibliographyModel, bibliographyModelCommands, state.commands);
    bibliographyModelCommands = state.commands;
    bibliographyWatchRanges = state.watchRanges;
    if (changed) refreshBibliographyDecorations();
    return;
  }
  const requestSeq = ++bibliographyRequestSeq;
  try {
    const nextModel = await api.bibliography.document({ file: currentFile, content });
    const currentContent = editor.getMarkdown();
    const currentState = bibliographyResolutionState(currentContent);
    const currentKey = `${currentFile}\n${currentState.key}`;
    if (requestSeq !== bibliographyRequestSeq || key !== currentKey) return;
    alignBibliographyCitationRanges(nextModel, state.commands, currentState.commands);
    bibliographyModel = nextModel;
    bibliographyModelKey = key;
    bibliographyModelCommands = currentState.commands;
    bibliographyWatchRanges = currentState.watchRanges;
    const diagnostics = bibliographyDiagnosticTexts(nextModel.diagnostics);
    if (diagnostics.length > 0) {
      const more = diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : "";
      setStatus(`Bibliography: ${diagnostics[0]}${more}`);
    }
  } catch (error) {
    if (requestSeq !== bibliographyRequestSeq) return;
    const currentContent = editor.getMarkdown();
    const currentState = bibliographyResolutionState(currentContent);
    const currentKey = `${currentFile}\n${currentState.key}`;
    if (key !== currentKey) return;
    bibliographyModel = { ok: false, entries: [], references: [], citations: [], namespaces: [], message: error instanceof Error ? error.message : "Bibliography failed" };
    // Cache failures by resolution input as well. Unrelated typing must not
    // hammer a failing bibliography endpoint; a citation/meta edit, explicit
    // refresh, or bibliography-index event will retry it.
    bibliographyModelKey = key;
    bibliographyModelCommands = currentState.commands;
    bibliographyWatchRanges = currentState.watchRanges;
    setStatus(bibliographyModel.message || "Bibliography failed");
  }
  refreshBibliographyDecorations();
}

function scheduleBibliographyRefresh(force = false): void {
  bibliographyTimer.schedule(() => void refreshBibliography(force));
}

function citeLocator(cite: BibliographyCitation | undefined): string {
  const args = cite?.args ?? {};
  return String(args.locator || args.page || args.pages || "").trim();
}

function citePrefix(cite: BibliographyCitation | undefined): string {
  return String(cite?.args?.prefix || "").trim();
}

function citeSuffix(cite: BibliographyCitation | undefined): string {
  return String(cite?.args?.suffix || "").trim();
}

function citationKeys(cite: BibliographyCitation | undefined): string[] {
  if (cite?.keys?.length) return cite.keys;
  return (cite?.items ?? []).map((item) => String(item.key || "").trim()).filter(Boolean);
}

function citationItemIds(cite: BibliographyCitation | undefined): string[] {
  if (cite?.itemIds?.length) return cite.itemIds;
  return (cite?.items ?? []).map((item) => String(item.itemId || item.id || "").trim()).filter(Boolean);
}

function citationLabel(from: number, to: number): { label: string; title?: string; error?: boolean } | null {
  const cite = citationAtRange(from, to);
  if (!cite) return { label: "[?]", title: "Resolving citation", error: true };
  const diagnostics = citationDiagnosticTexts(cite);
  const numbers = [...new Set((cite.numbers ?? cite.items?.map((item) => item.number) ?? [])
    .filter((number): number is number => typeof number === "number" && Number.isFinite(number)))];
  if (diagnostics.length > 0 || numbers.length === 0) {
    return {
      label: "[?]",
      title: diagnostics.join("; ") || "Citation did not resolve any references",
      error: true,
    };
  }
  const locator = citeLocator(cite);
  const label = `[${numbers.join(", ")}${locator ? `, ${locator}` : ""}]`;
  const prefix = citePrefix(cite);
  const suffix = citeSuffix(cite);
  return { label: formatCitationLabel(label, prefix, suffix), title: citationKeys(cite).join("; ") };
}

function highlightReference(ref: BibliographyReference | undefined): void {
  if (!ref?.number) return;
  window.clearTimeout(bibliographyHighlightTimer);
  bibliographyPanel.hidden = false;
  bibliographyPanel.querySelectorAll(".is-highlight").forEach((el) => el.classList.remove("is-highlight"));
  const item = bibliographyPanel.querySelector<HTMLElement>(`#aaronnote-bib-ref-${ref.number}`);
  if (!item) {
    setStatus(`Reference [${ref.number}] is not rendered`);
    return;
  }
  item.scrollIntoView({ block: "center", behavior: "auto" });
  item.classList.add("is-highlight");
  setStatus(`Reference [${ref.number}] · ${ref.entry?.key || ""}`);
  bibliographyHighlightTimer = window.setTimeout(() => item.classList.remove("is-highlight"), 1600);
}

function zoteroHrefForEntry(entry: BibliographyReference["entry"] | undefined): string {
  const fields = entry?.fields ?? {};
  const keys = ["zotero", "zoteroselect", "zotero_select", "zotero-link", "zotero_link"];
  for (const key of keys) {
    const value = String(fields[key] || "").trim();
    if (/^zotero:\/\//i.test(value)) return value;
  }
  return "";
}

function zoteroHrefForReference(ref: BibliographyReference | undefined): string {
  const direct = zoteroHrefForEntry(ref?.entry);
  if (direct) return direct;
  return ref?.links?.find((link) => /^zotero:\/\//i.test(String(link.href || "")))?.href || "";
}

async function openReferenceInZotero(ref: BibliographyReference | undefined): Promise<void> {
  const entry = ref?.entry;
  if (!entry) {
    setStatus("No reference to open in Zotero");
    return;
  }
  const fields = entry.fields ?? {};
  await api.emacs.zotero({
    uri: zoteroHrefForReference(ref),
    key: entry.key || "",
    doi: fields.doi || fields.DOI || "",
    title: fields.title || "",
    bibFile: entry.file || "",
    namespace: entry.namespace || "",
    currentFile,
    client: currentClient,
  });
  setStatus(`Sent ${entry.key || "reference"} to Emacs Zotero`);
}

function citationPrimaryReference(cite: BibliographyCitation | undefined): BibliographyReference | undefined {
  const id = citationItemIds(cite)[0];
  return id ? referenceById(id) : undefined;
}

function openCitationFromWidget(from: number, to: number, _rect: DOMRect, jump: boolean): void {
  const ref = citationPrimaryReference(citationAtRange(from, to));
  if (jump) highlightReference(ref);
}

function editCitationArgs(from: number, to: number): void {
  if (currentReadOnly) return;
  const source = editor.getMarkdown().slice(from, to);
  const argsPattern = /[ \t]*\{([^{}\n]*)\}[ \t]*$/;
  const argsMatch = source.match(argsPattern);
  const current = argsMatch?.[1] ?? "";
  const next = window.prompt("Edit @@cite args", current);
  if (next == null) return;
  const clean = next.trim();
  const replacement = argsMatch
    ? source.replace(argsPattern, clean ? ` {${clean}}` : "")
    : `${source}${clean ? ` {${clean}}` : ""}`;
  editor.replaceMarkdownRange(from, to, replacement, "end");
  scheduleBibliographyRefresh(true);
}

async function openBibEntryInEmacs(entry: BibliographyReference["entry"] | undefined): Promise<void> {
  if (!entry?.file) {
    setStatus("No BibTeX file for reference");
    return;
  }
  await api.emacs.open({ file: entry.file });
  setStatus(`Opened ${entry.path || entry.file} in ${sourceEditorName()}`);
}

async function openCitationBibInEmacs(from: number, to: number): Promise<void> {
  const cite = citationAtRange(from, to);
  const id = citationItemIds(cite)[0];
  const entry = id ? referenceById(id)?.entry : undefined;
  await openBibEntryInEmacs(entry);
}

function citationReferences(cite: BibliographyCitation | undefined): BibliographyReference[] {
  const refs: BibliographyReference[] = [];
  const seen = new Set<string>();
  for (const id of citationItemIds(cite)) {
    if (!id || seen.has(id)) continue;
    const ref = referenceById(id);
    if (!ref) continue;
    seen.add(id);
    refs.push(ref);
  }
  return refs;
}

function bibliographyContextPreview(refs: readonly BibliographyReference[]): HTMLElement {
  const preview = document.createElement("section");
  preview.className = "aaronnote-bib-context-preview";
  preview.setAttribute("aria-label", "Reference preview");
  for (const ref of refs) {
    const article = document.createElement("article");
    const title = document.createElement("strong");
    title.textContent = `[${ref.number || "?"}] ${ref.entry?.key || ""}`;
    const text = document.createElement("p");
    const repeatedNumber = ref.number ? new RegExp(`^\\[${ref.number}\\]\\s*`) : null;
    text.textContent = repeatedNumber ? String(ref.text || "").replace(repeatedNumber, "") : ref.text || "";
    article.append(title, text);
    preview.appendChild(article);
  }
  if (refs.length === 0) {
    const diagnostic = document.createElement("p");
    diagnostic.textContent = "Reference is unresolved.";
    preview.appendChild(diagnostic);
  }
  return preview;
}

function bibliographyLinkActions(refs: readonly BibliographyReference[]): AaronContextMenuItem[] {
  const items: AaronContextMenuItem[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    for (const link of ref.links ?? []) {
      const href = String(link.href || "").trim();
      if (!href || /^zotero:\/\//i.test(href) || seen.has(href)) continue;
      seen.add(href);
      const number = refs.length > 1 ? ` [${ref.number || "?"}]` : "";
      items.push({
        label: `Open ${link.label || "link"}${number}`,
        detail: href,
        run: () => openSystemTarget(href, currentFile),
      });
    }
  }
  return items;
}

function showBibliographyContextMenu(
  refs: readonly BibliographyReference[],
  items: readonly AaronContextMenuItem[],
  x: number,
  y: number,
): void {
  contextMenu.classList.add("is-bibliography");
  contextMenuController.open([
    {
      id: "bibliography-preview",
      label: "",
      type: "custom",
      bind: (row) => row.appendChild(bibliographyContextPreview(refs)),
    },
    ...(items.length > 0 ? [{ separator: true, label: "" } as AaronContextMenuItem] : []),
    ...items,
  ], { left: x, top: y });
}

function showCitationContextMenu(from: number, to: number, x: number, y: number): void {
  const cite = citationAtRange(from, to);
  const refs = citationReferences(cite);
  const keys = citationKeys(cite);
  const items: AaronContextMenuItem[] = serverReaderMode ? [
    ...refs.map((ref) => ({
      label: refs.length > 1 ? `Jump to Reference [${ref.number || "?"}]` : "Jump to Reference",
      detail: ref.entry?.key || "",
      run: () => highlightReference(ref),
    })),
    { label: "Copy Citation Key", detail: keys.join("; "), disabled: keys.length === 0, run: () => copyText(keys.join("; ")) },
  ] : [
    { label: "Edit Cite Args...", detail: "{prefix/locator/suffix}", disabled: currentReadOnly, run: () => editCitationArgs(from, to) },
    ...refs.map((ref) => ({
      label: refs.length > 1 ? `Jump to Reference [${ref.number || "?"}]` : "Jump to Reference",
      detail: ref.entry?.key || "",
      run: () => highlightReference(ref),
    })),
    ...bibliographyLinkActions(refs),
    ...refs.map((ref) => ({
      label: refs.length > 1 ? `Open [${ref.number || "?"}] in Zotero` : "Open in Zotero",
      detail: ref.entry?.key || ref.entry?.fields?.doi || "Emacs search",
      disabled: !ref.entry,
      run: () => openReferenceInZotero(ref),
    })),
    { label: `Open Bib in ${sourceEditorName()}`, detail: refs[0]?.entry?.path || "", disabled: serverReaderMode || !refs[0]?.entry?.file, run: () => openCitationBibInEmacs(from, to) },
    { label: "Copy Citation Key", detail: keys.join("; "), disabled: keys.length === 0, run: () => copyText(keys.join("; ")) },
  ];
  showBibliographyContextMenu(refs, items, x, y);
}

function showReferenceContextMenu(ref: BibliographyReference, x: number, y: number): void {
  const items: AaronContextMenuItem[] = serverReaderMode ? [
    { label: "Jump to Reference", detail: ref.entry?.key || "", run: () => highlightReference(ref) },
    { label: "Copy Citation Key", detail: ref.entry?.key || "", disabled: !ref.entry?.key, run: () => copyText(ref.entry?.key || "") },
  ] : [
    { label: "Jump to Reference", detail: ref.entry?.key || "", run: () => highlightReference(ref) },
    ...bibliographyLinkActions([ref]),
    { label: "Open in Zotero", detail: ref.entry?.key || ref.entry?.fields?.doi || "Emacs search", disabled: !ref.entry, run: () => openReferenceInZotero(ref) },
    { label: `Open Bib in ${sourceEditorName()}`, detail: ref.entry?.path || "", disabled: serverReaderMode || !ref.entry?.file, run: () => openBibEntryInEmacs(ref.entry) },
    { label: "Copy Citation Key", detail: ref.entry?.key || "", disabled: !ref.entry?.key, run: () => copyText(ref.entry?.key || "") },
  ];
  showBibliographyContextMenu([ref], items, x, y);
}

window.AaronnoteBibliography = {
  citationLabel,
  version: () => bibliographyRenderVersion,
  mapChanges: syncBibliographyRanges,
  openCitation: openCitationFromWidget,
  contextMenu: serverReaderMode && !serverReader.customContextMenu ? undefined : showCitationContextMenu,
};

function revealCursorAfterLayout(): void {
  const reveal = () => editor.revealCursor();
  reveal();
  window.requestAnimationFrame(reveal);
  window.requestAnimationFrame(() => window.requestAnimationFrame(reveal));
  for (const delay of [50, 120, 250, 500, 900]) {
    window.setTimeout(reveal, delay);
  }
}

function scheduleWritingStats(documentChanged: boolean): void {
  writingStatsController?.schedule(documentChanged);
}

const zoomController = createZoomController({
  editor,
  host,
  toolsPanel,
  editorSurfaceVisible,
  primaryModifier: primaryMod,
  scheduleAssistUpdate: () => scheduleAssistUpdate({ mathPreview: true, cursor: true, selectionTool: true }),
  setStatus,
});
const {
  layoutZoomPercent,
  updateLayoutZoomTool,
  stepLayoutZoom,
  resetLayoutZoom,
  runLayoutZoomShortcut,
  runVisualZoomShortcut,
} = zoomController;

let editorPointerFocusTimer = 0;

function activateEditorFromPointer(event: PointerEvent | MouseEvent): void {
  if (passiveServerReader) return;
  const target = event.target;
  if (!(target instanceof Node) || !host.contains(target)) return;
  const element = target instanceof Element ? target : target.parentElement;
  if (element?.closest("input, textarea, select, button, a, [data-aaronnote-vim='native']")) return;
  window.clearTimeout(editorPointerFocusTimer);
  // Let CM6 process the pointer and establish its clicked selection first.
  // Focusing synchronously here reveals the previous cursor before CM6's own
  // mousedown handler runs, causing apparently random jumps after a long scroll.
  // The one-tick fallback remains for xwidget focus hand-off and is deduplicated
  // across the pointerdown + mousedown pair.
  editorPointerFocusTimer = window.setTimeout(() => {
    editorPointerFocusTimer = 0;
    if (editor.view.hasFocus) return;
    editor.view.contentDOM.focus({ preventScroll: true });
  }, 0);
}

host.addEventListener("pointerdown", activateEditorFromPointer, { capture: true });
host.addEventListener("mousedown", activateEditorFromPointer, { capture: true });
document.addEventListener("contextmenu", (event) => {
  if (!(event.target instanceof Node) || !host.contains(event.target)) return;
  if (serverReaderMode && !serverReader.customContextMenu) return;
  const element = event.target instanceof Element ? event.target : event.target.parentElement;
  if (element?.closest(".inline-cite-widget, .aaronnote-bib-item")) return;
  event.preventDefault();
  showContextMenu(event);
}, { capture: true });
document.addEventListener("aaronnote:attachment-context-menu", (event) => {
  const custom = event as CustomEvent<{ href?: string; x?: number; y?: number }>;
  const href = custom.detail?.href;
  if (!href) return;
  event.preventDefault();
  event.stopPropagation();
  showContextMenu(event as unknown as MouseEvent, {
    href,
    cell: null,
    x: Number(custom.detail?.x) || 12,
    y: Number(custom.detail?.y) || 12,
  });
}, { capture: true });
document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (contextMenuController.visible && target instanceof Node && !contextMenuController.contains(target)) {
    transientSurfaces.close(["context-menu"], "outside");
  }
}, { capture: true });
window.addEventListener("resize", () => transientSurfaces.close(["context-menu"], "viewport"));
document.addEventListener("scroll", () => {
  transientSurfaces.close(["context-menu"], "viewport");
}, { capture: true, passive: true });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    transientSurfaces.close(["context-menu"], "escape");
  }
}, { capture: true });
const snippetSession = new SnippetSession(editor);
const mathSnippetIndex = new MathSnippetIndex(editor);
const MATH_EDITOR_LAYOUT_ALIASES: Record<string, string> = {
  alig: "ali",
  align: "ali",
  gather: "gat",
  split: "spl",
  cases: "cas",
};
document.addEventListener("aaronnote:math-completion-request", (event) => {
  const detail = (event as CustomEvent<{
    prefix?: string;
    rect?: { left: number; top: number; bottom: number };
    apply?: (template: string | VisualTexCompletionTemplate, deleteBefore: number) => boolean;
    applyLayout?: (layout: VisualTexDisplayLayout, deleteBefore: number) => boolean;
  }>).detail;
  const prefix = String(detail?.prefix || "");
  if (!detail?.apply || !prefix) {
    if (snippetPopupChooseHandler) hideSnippetPopup();
    return;
  }
  const completion = matchingMathEditorSnippetCompletion(prefix);
  if (completion.matches.length === 0) {
    if (snippetPopupChooseHandler) hideSnippetPopup();
    return;
  }
  showSnippetPopup(
    completion.prefix,
    completion.matches,
    completion.deleteBefore,
    detail.rect ?? null,
    (snippet) => {
      const expanded = expandSnippetBody(snippet);
      const outerLayout = visualTexOuterDisplayLayout(expanded.text);
      if (outerLayout && detail.applyLayout) {
        return detail.applyLayout(outerLayout, completion.deleteBefore);
      }
      return detail.apply!(mathLiveSnippetTemplate(snippet), completion.deleteBefore);
    },
  );
});
document.addEventListener("aaronnote:math-completion-key", (event) => {
  if (!snippetPopupChooseHandler) return;
  const detail = (event as CustomEvent<{
    key?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  }>).detail ?? {};
  if (detail.key === " ") {
    const prefix = snippetPopup.dataset.prefix || "";
    const query = MATH_EDITOR_LAYOUT_ALIASES[prefix.toLowerCase()] ?? prefix;
    const exact = snippetPopupItems.findIndex((snippet) => (
      snippetScore(snippet, query, false) === 0
    ));
    if (exact < 0) return;
    snippetPopupIndex = exact;
    if (!chooseSnippetPopupItem()) return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const handled = applySnippetPopupKeyAction(snippetPopupKeyAction({
    key: detail.key === "\t" ? "Tab" : String(detail.key || ""),
    shiftKey: Boolean(detail.shiftKey),
    commandKey: Boolean(detail.metaKey && !detail.ctrlKey),
    ctrlKey: Boolean(detail.ctrlKey),
    altKey: Boolean(detail.altKey),
    isComposing: false,
    acceptEnter: true,
  }));
  if (!handled) return;
  event.preventDefault();
  event.stopPropagation();
});
document.addEventListener("aaronnote:math-completion-close", () => {
  if (snippetPopupChooseHandler) hideSnippetPopup();
});
host.addEventListener("aaronnote-assist-update", () => scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true, toc: true }));
let pendingMathSnippetHandoff: "forward" | "backward" | null = null;
host.addEventListener("aaronnote:math-snippet-boundary", (event) => {
  const direction = (event as CustomEvent<{ direction?: unknown }>).detail?.direction;
  if ((direction !== "forward" && direction !== "backward")
    || !visualMathEditorActive
    || !snippetSession.isSuspended()
    || !snippetSession.canMove(direction === "backward")) return;
  pendingMathSnippetHandoff = direction;
  event.preventDefault();
  event.stopPropagation();
});
host.addEventListener("aaronnote:inline-math-edit-state", (event) => {
  const active = Boolean((event as CustomEvent<{ active?: boolean }>).detail?.active);
  if (active && !visualMathEditorActive && visualMathReturnMode == null) {
    visualMathReturnMode = vim.mode();
  }
  visualMathEditorActive = active;
  copilotActiveChangeHandlers.forEach((handler) => handler());
  if (!active) {
    const handoff = pendingMathSnippetHandoff;
    pendingMathSnippetHandoff = null;
    const returnMode = visualMathReturnMode;
    visualMathReturnMode = null;
    if (returnMode != null && vim.mode() !== returnMode) vim.setMode(returnMode);
    scheduleAssistUpdate({ mathPreview: true, cursor: true });
    // Inline math dispatches this state event immediately before its CM6
    // commit, while display math dispatches it during that update. Resume in a
    // microtask so both adapters map the final source transaction first.
    queueMicrotask(() => {
      const moved = handoff != null
        && snippetSession.resumeAndMove(handoff === "backward");
      if (!moved) snippetSession.resume();
      if (moved) {
        setStatus("Snippet field");
        scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
      }
    });
    return;
  }
  pendingMathSnippetHandoff = null;
  snippetSession.suspend();
  hideSnippetPopup();
  hideMathPreview();
  selectionTool.hidden = true;
  selectionMore.hidden = true;
});
document.addEventListener("aaronnote:visualtex-save-request", () => {
  void save(false);
});

document.addEventListener("aaronnote:open-block-ref", (event) => {
  const id = String((event as CustomEvent<{ id?: string }>).detail?.id || "").trim();
  if (!id) return;
  event.preventDefault();
  if (!commitActiveLiveTexForBoundary(false)) return;
  setStatus(`Resolving block ${id}…`);
  void api.notes.resolveBlock(id).then(async (location) => {
    const file = String(location.file || "").trim();
    if (!file) throw new Error("Block navigation returned no file");
    const before = trackCursorPosition();
    const changingFile = file !== currentFile;
    if (changingFile) {
      pushNavigationBackLocation(before);
      await openFile(file);
    }
    if (file !== currentFile) throw new Error("Block target could not be opened");
    if (!changingFile) pushNavigationBackLocation(before);
    const markdown = editor.getMarkdown();
    const offset = markdownBlockSourceOffset(markdown, location.id, location.line);
    editor.setMarkdownSelection(offset, offset);
    editor.revealCursor();
    editor.focus();
    noteCursorPositionEvent();
    setStatus(`Opened block ${location.id} at ${location.path}:${location.line}`);
  }).catch((error) => {
    setStatus(`Block navigation failed: ${error instanceof Error ? error.message : String(error)}`);
  });
});

document.addEventListener("aaronnote:attribute-view-request", (event) => {
  const custom = event as CustomEvent<AttributeViewRequestDetail>;
  const respond = custom.detail?.respond;
  if (typeof respond !== "function") return;
  event.preventDefault();
  void api.notes.attributeView({
    title: String(custom.detail?.title || ""),
    source: String(custom.detail?.source || ""),
    file: currentFile,
  }).then((model) => respond(model)).catch((error) => {
    respond(null, error instanceof Error ? error.message : String(error));
  });
});

document.addEventListener("aaronnote:embed-query-request", (event) => {
  const custom = event as CustomEvent<EmbedQueryRequestDetail>;
  const respond = custom.detail?.respond;
  if (typeof respond !== "function") return;
  event.preventDefault();
  void api.notes.embedQuery({
    title: String(custom.detail?.title || ""),
    source: String(custom.detail?.source || ""),
    file: currentFile,
  }).then((model) => respond(model)).catch((error) => {
    respond(null, error instanceof Error ? error.message : String(error));
  });
});

document.addEventListener("aaronnote:embed-query-open", (event) => {
  const item = (event as CustomEvent<EmbedQueryOpenDetail>).detail?.item;
  if (!item?.file) return;
  event.preventDefault();
  void (async () => {
    if (item.file !== currentFile) await openFile(item.file);
    if (item.file !== currentFile) return;
    const markdown = editor.getMarkdown();
    const anchor = item.id ? markdown.indexOf(`{#${item.id}`) : -1;
    const offset = anchor >= 0 ? markdown.lastIndexOf("\n", anchor) + 1 : 0;
    editor.setMarkdownSelection(offset, offset);
    editor.revealCursor();
    editor.focus();
    noteCursorPositionEvent();
  })();
});

document.addEventListener("aaronnote:attribute-view-cell-patch", (event) => {
  const custom = event as CustomEvent<AttributeViewCellPatchDetail>;
  const detail = custom.detail;
  if (!detail?.row || typeof detail.respond !== "function") return;
  event.preventDefault();
  void api.notes.attributeViewCellPatch({
    id: detail.row.id,
    kind: detail.row.kind,
    file: detail.row.file,
    index: detail.row.index,
    key: detail.key,
    value: detail.value,
  }).then(() => detail.respond(true)).catch((error) => {
    detail.respond(false, error instanceof Error ? error.message : String(error));
  });
});

document.addEventListener("aaronnote:attribute-view-open-row", (event) => {
  const row = (event as CustomEvent<AttributeViewOpenRowDetail>).detail?.row;
  if (!row?.file) return;
  event.preventDefault();
  void (async () => {
    if (row.file !== currentFile) await openFile(row.file);
    if (row.file !== currentFile) return;
    const offset = markdownLineStartOffset(editor.getMarkdown(), row.line || 1);
    editor.setMarkdownSelection(offset, offset);
    editor.revealCursor();
    editor.focus();
    noteCursorPositionEvent();
  })();
});
host.addEventListener("aaronnote:inline-math-edit-error", (event) => {
  const message = (event as CustomEvent<{ message?: unknown }>).detail?.message;
  setStatus(typeof message === "string" ? `${message}; 已回退到 TeX 源码编辑` : "Visual formula editor unavailable");
  scheduleAssistUpdate({ mathPreview: true, cursor: true });
});

// IME switching for Vim mode (macOS) — fire-and-forget, never blocks keystrokes.
// Requires macism or im-select installed; feature silently disables when absent.
const imeCoalesceTimer = new CoalescedTimer(80);
let imeEnabled = true;
let imeLastSentMode: "" | "normal" | "insert" = "";
function syncImeForVimMode(mode: import("./vim-lite.ts").VimLiteMode): void {
  if (!imeEnabled) return;
  const effective: "normal" | "insert" = mode === "insert" ? "insert" : "normal";
  imeCoalesceTimer.schedule(() => {
    if (effective === "insert" && !document.hasFocus()) return;
    if (effective === imeLastSentMode) return;
    imeLastSentMode = effective;
    void api.ime.vimMode(effective)
      .then((r) => { if (r?.enabled === false) imeEnabled = false; })
      .catch(() => {});
  });
}

/**
 * Adopt a selection that CodeMirror built on its own into the Vim model.
 *
 * The chord is observed in the capture phase, so CodeMirror has not applied
 * its transaction yet; defer to a task so the adopted range is the final one.
 * Insert mode keeps CodeMirror's native half-open selection, exactly as the
 * pointer path does.
 */
function adoptKeyboardSelectionIntoVim(): void {
  window.setTimeout(() => {
    if (vim.mode() === "insert") return;
    vim.syncSelectionFromEditor();
    scheduleAssistUpdate({ cursor: true, selectionTool: true });
  }, 0);
}

function runVimFind(): boolean {
  openFindPanel();
  return true;
}

const vim = createVimLite(editor, host, {
  onModeChange: (mode) => { updateModeLabel(mode); syncImeForVimMode(mode); },
  onUndo: () => editor.undo(),
  onRedo: () => editor.redo(),
  onIndent: (dir) => indentMarkdownBlock(editor.view, dir),
  onFind: runVimFind,
  // A modal key with no binding used to be swallowed with no trace, which is
  // indistinguishable from the keystroke being dropped. Name it instead.
  onUnhandledKey: (sequence) => setStatus(`Vim: ${sequence} is not bound`),
  onFold: (action) => {
    if (action === "close") return editor.runCommand("fold-heading");
    if (action === "open") return editor.runCommand("unfold-heading");
    if (action === "toggle") return editor.runCommand("toggle-fold");
    if (action === "close-all") return editor.runCommand("fold-all-headings");
    return editor.runCommand("unfold-all-headings");
  },
});
const focusQuiescence = createFocusQuiescenceController({
  // The controller is shared by all renderer hosts. Only the Emacs xwidget
  // adapter opts in so a genuinely hidden buffer can park native focus and
  // replay its first returning key through the shared CM6 pipeline.
  enabled: focusQuiescenceEnabled(),
  view: editor.view,
  editorSurface: host,
  isSurfaceVisible: editorSurfaceVisible,
  isPointerSelecting: () => isPointerSelecting(editor.view.state),
  isInteractionBlocked: () =>
    visualMathEditorActive
    || !modal.hidden
    || !findPanel.hidden
    || !selectionTool.hidden
    || !toolsPanel.hidden
    || !roamToolsPanel.hidden
    || !jupyterPanel.hidden
    || focusedEditableOutsideEditor()
    || eventTargetsNativeWidgetInput(document.activeElement),
  onParkedKeydown: (event) => {
    if (event.defaultPrevented || event.isComposing) return false;

    // Focusing during capture does not retarget the event that is already in
    // flight. Re-dispatch the same key at CM6 so the existing document
    // keydown, xwidget/Vim, shortcut and CM6 keymap pipeline handles every
    // control and modifier chord exactly as it does while focused.
    const text = editorTextFromKeydown(event);
    const modeBeforeReplay = vim.mode();
    const documentBeforeReplay = editor.view.state.doc;
    if (!replayEditorKeydown(editor.view.contentDOM, event)) return false;

    // A synthetic keydown does not ask WebKit to generate a native
    // beforeinput/input event. For an ordinary insert-mode text key, use the
    // same input facet used by host key events only when the replayed shared
    // pipeline did not already change the document (snippet/Vim/shortcut
    // handlers may have consumed the key without inserting text).
    if (modeBeforeReplay === "insert"
        && text !== null
        && editor.view.state.doc === documentBeforeReplay) {
      runEditorTextInput(editor.view, text);
    }
    return true;
  },
});
const assistScheduler = new AssistScheduler(window, editorSurfaceVisible, runAssistUpdate);
updateModeLabel(vim.mode());
let vimSelectionSyncPending = false;
reconcileVimSelection = () => {
  if (vimSelectionSyncPending) return;
  vimSelectionSyncPending = true;
  queueMicrotask(() => {
    vimSelectionSyncPending = false;
    if (vim.mode() === "insert") return;
    // Linewise motion keeps a directional logical head that a forward CM6
    // whole-line range cannot encode.  A collapsed range still means a native
    // cut/paste completed and should leave Visual-line.
    if (vim.mode() === "visual-line"
        && !editor.view.state.selection.main.empty) return;
    vim.syncSelectionFromEditor();
  });
};
// Re-assert IME state when the window regains focus.
window.addEventListener("focus", () => {
  imeLastSentMode = "";
  syncImeForVimMode(vim.mode());
  void refreshPendingExternalSaveOnFocus();
});
host.addEventListener("focusin", () => {
  void refreshPendingExternalSaveOnFocus();
});

const floatingTocPanel = createFloatingTocPanel({
  toc,
  toggleButton: tocButton,
  list: tocList,
  editor,
  getNotes: () => notes,
  getCurrentFile: () => currentFile,
  resolveNoteRef,
  openNote,
  openTag: openTagFilter,
  getActivePosition: serverReaderMode ? () => editor.view.viewport.from : undefined,
});

const serverSearchInput = root.querySelector<HTMLInputElement>("[data-server-search]");
if (serverReaderMode && serverSearchInput) {
  const anchor = serverSearchInput.closest<HTMLElement>(".noema-server-search")!;
  createKnowledgeSearch({
    input: serverSearchInput,
    anchor,
    search: (body) => api.knowledge.search(body),
    context: () => ({ file: currentFile, id: currentNote()?.id || "" }),
    open: (note, options) => openNote(note, options),
    limit: 8,
  });
  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "k") return;
    event.preventDefault();
    event.stopPropagation();
    serverSearchInput.focus();
    serverSearchInput.select();
  }, { capture: true });
}

const globalSearchRoot = root.querySelector<HTMLElement>("[data-global-search]")!;
const globalSearchInput = root.querySelector<HTMLInputElement>("[data-global-search-input]")!;
let pendingKnowledgeInsert: { from: number; to: number; selected: string } | null = null;
const hideKnowledgeSearch = (): void => { globalSearchRoot.hidden = true; globalSearchInput.value = ""; pendingKnowledgeInsert = null; editor.focus(); };
const showKnowledgeSearch = (): void => {
  if (serverReaderMode) { serverSearchInput?.focus(); return; }
  if (desktopKnowledgeDock && !pendingKnowledgeInsert) {
    desktopKnowledgeDock.show("search");
    return;
  }
  globalSearchRoot.hidden = false;
  globalSearchInput.focus();
  globalSearchInput.select();
};
if (!serverReaderMode) {
  createKnowledgeSearch({
    input: globalSearchInput,
    anchor: globalSearchInput.closest<HTMLElement>("label")!,
    search: (body) => api.knowledge.search(body),
    context: () => ({ file: currentFile, id: currentNote()?.id || "" }),
    open: (note, options) => {
      const insertion = pendingKnowledgeInsert;
      pendingKnowledgeInsert = null;
      hideKnowledgeSearch();
      if (!insertion) { openNote(note, options); return; }
      const markdown = markdownRoamIdLink(note, insertion.selected || note.title || canonicalRoamNoteId(note));
      if (!markdown) { setStatus("Selected note has no stable id"); return; }
      editor.replaceMarkdownRange(insertion.from, insertion.to, markdown, "end");
      setStatus("Knowledge link inserted");
      scheduleAssistUpdate({ snippets: true, toc: true });
    },
    limit: 10,
  });
  globalSearchRoot.addEventListener("mousedown", (event) => { if (event.target === globalSearchRoot) hideKnowledgeSearch(); });
  globalSearchInput.addEventListener("keydown", (event) => { if (event.key === "Escape" && !globalSearchInput.value) hideKnowledgeSearch(); });
  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLocaleLowerCase() !== "k") return;
    event.preventDefault();
    event.stopPropagation();
    showKnowledgeSearch();
  }, { capture: true });
}

const localGraphPanel = createLocalGraphPanel({
  root: graphPanelRoot,
  toggleButton: graphButton,
  depthInput: graphDepthInput,
  depthLabel: graphDepthLabel,
  refsInput: graphRefsInput,
  backlinksInput: graphBacklinksInput,
  tagsInput: graphTagsInput,
  canvas: graphCanvas,
  status: graphStatus,
  searchInput: graphSearch,
  groupInput: graphGroup,
  detail: graphDetail,
  modeButtons: graphModeButtons,
  isVisible: () => !knowledgeGraphPane.hidden,
  getWorkspaceGraph: () => api.notes.graph(),
  getIndexVersion: () => lastNotesIndexVersion,
  getNotes: () => notes.filter(note => note.roam !== false),
  getCurrentNote: currentNote,
  getMarkdown: () => editor.getMarkdown(),
  getMarkdownLength: () => editor.getMarkdownLength(),
  resolveNoteRef,
  openNote,
  openTag: openTagFilter,
});

if (!serverReaderMode) {
  createKnowledgeSearch({
    input: knowledgeSearchInput,
    anchor: knowledgeSearchAnchor,
    search: (body) => api.knowledge.search(body),
    context: () => ({ file: currentFile, id: currentNote()?.id || "" }),
    open: (note, options) => openNote(note, options),
    limit: 12,
  });
  desktopKnowledgeDock = createDesktopKnowledgeDock({
    root: graphPanelRoot,
    body: document.body,
    visibilityButton: graphButton,
    tabButtons: knowledgeTabButtons,
    panes: {
      backlinks: knowledgeBacklinksPane,
      mentions: knowledgeMentionsPane,
      graph: knowledgeGraphPane,
      search: knowledgeSearchPane,
      tags: knowledgeTagsPane,
    },
    backlinkList: knowledgeBacklinkList,
    backlinkStatus: knowledgeBacklinkStatus,
    mentionList: knowledgeMentionList,
    mentionStatus: knowledgeMentionStatus,
    tagList: knowledgeTagList,
    tagStatus: knowledgeTagStatus,
    searchInput: knowledgeSearchInput,
    getCurrentNote: currentNote,
    getVirtualMentions: async () => {
      const note = currentNote();
      if (!note) return { mentions: [] };
      const result = await api.knowledge.virtualReferences({ targetId: note.id || note.key, file: note.file, title: note.title });
      return {
        ...result,
        mentions: result.mentions.map((mention) => ({
          ...mention,
          note: mention.note ? resolveNoteRef(mention.note.id || mention.sourceId) : resolveNoteRef(mention.sourceId),
        })),
      };
    },
    resolveNoteRef,
    relationshipSource: () => currentRelationshipSource,
    openNote,
    getTags: () => {
      const liveTags = metadataTagsFromMarkdown(editor.getMarkdown()) ?? currentNote()?.tags ?? [];
      const currentTags = new Set(liveTags.map((tag) => String(tag || "").trim().replace(/^#/, "").toLocaleLowerCase()).filter(Boolean));
      const labels = new Map<string, string>();
      const counts = new Map<string, number>();
      for (const note of notes) {
        const unique = new Set((note.tags ?? [])
          .map((tag) => String(tag || "").trim().replace(/^#/, ""))
          .filter(Boolean));
        for (const tag of unique) {
          const key = tag.toLocaleLowerCase();
          if (!labels.has(key)) labels.set(key, tag);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      for (const tag of liveTags) {
        const clean = String(tag || "").trim().replace(/^#/, "");
        if (!clean) continue;
        const key = clean.toLocaleLowerCase();
        if (!labels.has(key)) labels.set(key, clean);
        if (!counts.has(key)) counts.set(key, 1);
      }
      return [...labels.entries()]
        .map(([key, name]) => ({ name, count: counts.get(key) ?? 0, current: currentTags.has(key) }))
        .sort((a, b) => Number(b.current) - Number(a.current) || b.count - a.count || a.name.localeCompare(b.name));
    },
    openTag: openTagFilter,
    onStateChange: () => {},
    onGraphVisible: () => localGraphPanel.update(true),
    onGraphHidden: () => localGraphPanel.suspend(),
    onCollapse: () => localGraphPanel.collapse(),
  });
}
const graphOverlayTimer = new CoalescedTimer(400);
let graphOverlayIdleHandle = 0;
let graphOverlayActivityState: RendererActivityState = "active";
let graphOverlayUpdatePending = false;
const graphOverlayCanRun = (): boolean =>
  graphOverlayActivityState === "active" || graphOverlayActivityState === "recently-active";

function scheduleGraphOverlayUpdate(delayMs = 400): void {
  graphOverlayUpdatePending = true;
  if (!graphOverlayCanRun()) return;
  graphOverlayTimer.schedule(() => {
    if (!graphOverlayCanRun()) return;
    const scheduling = navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } };
    if (scheduling.scheduling?.isInputPending?.()) {
      scheduleGraphOverlayUpdate();
      return;
    }
    if ("requestIdleCallback" in window) {
      if (graphOverlayIdleHandle) window.cancelIdleCallback(graphOverlayIdleHandle);
      graphOverlayIdleHandle = window.requestIdleCallback(() => {
        graphOverlayIdleHandle = 0;
        if (!graphOverlayCanRun()) return;
        if (scheduling.scheduling?.isInputPending?.()) scheduleGraphOverlayUpdate();
        else {
          graphOverlayUpdatePending = false;
          localGraphPanel.update(true);
        }
      }, { timeout: 1200 });
      return;
    }
    graphOverlayUpdatePending = false;
    localGraphPanel.update(true);
  }, undefined, delayMs);
}

const graphOverlayActivity = {
  setActivity(state: RendererActivityState): void {
    const wasSuspended = graphOverlayActivityState === "quiescent"
      || graphOverlayActivityState === "hidden";
    graphOverlayActivityState = state;
    if (state === "quiescent" || state === "hidden" || state === "destroyed") {
      graphOverlayTimer.cancel();
      if (graphOverlayIdleHandle) window.cancelIdleCallback(graphOverlayIdleHandle);
      graphOverlayIdleHandle = 0;
      return;
    }
    if (wasSuspended && graphOverlayUpdatePending) scheduleGraphOverlayUpdate(0);
  },
};
changeHandlers.add(scheduleGraphOverlayUpdate);

graphClose.addEventListener("click", () => {
  if (desktopKnowledgeDock) desktopKnowledgeDock.collapse();
  else localGraphPanel.collapse();
});

type JupyterPanelCell = {
  id: string;
  from: number;
  to: number;
  line: number;
  language: string;
  kernel: string;
  session: string;
  status: string;
  executionCount?: number | null;
  durationMs?: number;
  outputCount?: number;
};
type JupyterPanelExecutionResult = {
  ok?: boolean;
  cellId?: string;
  kernel?: string;
  session?: string;
  status?: string;
  executionCount?: number | null;
  outputs?: unknown[];
  results?: JupyterPanelExecutionResult[];
  stoppedAt?: string;
  widgetMessages?: Array<Record<string, unknown>>;
  widgetMessagesTruncated?: boolean;
};

const JUPYTER_CELL_RE = /^([ \t]*)@@cell(?:[ \t]*\(([^)\n]*)\))?(?:[ \t]+\[([^\]\n]*)\])?[ \t]*$/i;
const jupyterTaskState = new Map<string, Partial<JupyterPanelCell>>();

function cleanJupyterToken(value: string, fallback: string): string {
  const clean = String(value || "").trim();
  return clean || fallback;
}

type JupyterCellDefaults = {
  language: string;
  kernel: string;
  session: string;
};

const HOST_JUPYTER_DEFAULTS = (window as typeof window & {
  __aaronnoteJupyterDefaults?: Partial<JupyterCellDefaults>;
}).__aaronnoteJupyterDefaults ?? {};

const DEFAULT_JUPYTER_CELL: JupyterCellDefaults = {
  language: cleanJupyterToken(HOST_JUPYTER_DEFAULTS.language, "python"),
  kernel: cleanJupyterToken(HOST_JUPYTER_DEFAULTS.kernel, "python3"),
  session: cleanJupyterToken(HOST_JUPYTER_DEFAULTS.session, "default"),
};

function jupyterLooksLikeKernelToken(value: string): boolean {
  return /python3|sage|julia|ir|bash|zsh|node|javascript|typescript|lean4?/i.test(value);
}

function jupyterDefaultKernelForLanguage(language: string): string {
  if (/^lean4?$/i.test(language)) return "lean4";
  if (/^(?:bash|sh|shell|zsh)$/i.test(language)) return "bash";
  if (/^sage/i.test(language)) return "sagemath";
  if (/^(?:python|py)$/i.test(language)) return "python3";
  return DEFAULT_JUPYTER_CELL.kernel;
}

function parseJupyterCellRuntime(rawArgs: string, defaults: JupyterCellDefaults = DEFAULT_JUPYTER_CELL): JupyterCellDefaults {
  const args = rawArgs.split(",").map((item) => item.trim()).filter(Boolean);
  let requestedLanguage = cleanJupyterToken(args[0] || "", defaults.language);
  let kernel = "";
  let session = defaults.session;
  if (args.length === 1 && jupyterLooksLikeKernelToken(args[0]!)) {
    kernel = args[0]!;
    requestedLanguage = ceilLanguageForKernel(kernel);
  } else if (args.length >= 3 || (args.length === 2 && jupyterLooksLikeKernelToken(args[1]!))) {
    // Legacy language,kernel[,session] input remains readable for migration.
    kernel = args[1] || "";
    session = cleanJupyterToken(args[2] || "", DEFAULT_JUPYTER_CELL.session);
  } else {
    session = cleanJupyterToken(
      args[1] || "",
      args.length === 0 ? defaults.session : DEFAULT_JUPYTER_CELL.session,
    );
  }
  if (!kernel && defaults.kernel) {
    const defaultLanguage = ceilLanguageForKernel(defaults.kernel, defaults.language);
    const requestedLanguageLower = requestedLanguage.toLowerCase();
    if (!args[0] || requestedLanguageLower === defaults.language.toLowerCase() || requestedLanguageLower === defaultLanguage.toLowerCase()) {
      kernel = defaults.kernel;
    }
  }
  if (!kernel) kernel = jupyterDefaultKernelForLanguage(requestedLanguage);
  kernel = cleanJupyterToken(kernel, jupyterDefaultKernelForLanguage(requestedLanguage)).replace(/^\((.*)\)$/, "$1").trim()
    || jupyterDefaultKernelForLanguage(requestedLanguage);
  const language = ceilLanguageForKernel(kernel, requestedLanguage);
  return { language, kernel, session };
}

function jupyterCellKey(cell: Pick<JupyterPanelCell, "id" | "language" | "kernel" | "session">): string {
  return `${cell.language}\0${cell.kernel}\0${cell.session}\0${cell.id}`;
}

function isLeanJupyterCell(cell: Pick<JupyterPanelCell, "language" | "kernel">): boolean {
  return /lean/i.test(cell.language) || /lean/i.test(cell.kernel);
}

function formatRuntimeDuration(ms: unknown): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "0s";
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRest = minutes % 60;
  return minuteRest ? `${hours}h ${minuteRest}m` : `${hours}h`;
}

type JupyterCellBase = Pick<JupyterPanelCell, "id" | "from" | "to" | "line" | "language" | "kernel" | "session" | "status">;

let jupyterScanMarkdown: string | null = null;
let jupyterScanBases: JupyterCellBase[] = [];
let jupyterKernelSpecsCache: JupyterKernelSpec[] | null = null;

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function setSelectOptions(select: HTMLSelectElement, values: string[], selected = "", anyLabel = ""): void {
  const options = anyLabel ? ["", ...uniqueSorted(values)] : uniqueSorted(values);
  const current = selected || select.value;
  select.replaceChildren(...options.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value || anyLabel;
    return option;
  }));
  if (options.includes(current)) select.value = current;
  else if (selected && !options.includes(selected)) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = selected;
    select.append(option);
    select.value = selected;
  } else {
    select.value = options[0] || "";
  }
}

async function loadJupyterKernelSpecs(): Promise<JupyterKernelSpec[]> {
  if (jupyterKernelSpecsCache) return jupyterKernelSpecsCache;
  try {
    const result = await api.jupyterCell.kernels({ file: currentFile });
    jupyterKernelSpecsCache = Array.isArray(result.kernels) ? result.kernels : [];
  } catch {
    jupyterKernelSpecsCache = [];
  }
  return jupyterKernelSpecsCache;
}

function formatJupyterCellHeader(
  leading: string,
  rawId: string,
  runtime: JupyterCellDefaults,
): string {
  const nextArgs = [runtime.language, runtime.session || DEFAULT_JUPYTER_CELL.session];
  return `${leading}@@cell(${nextArgs.join(", ")})${rawId ? ` [${rawId.trim()}]` : ""}`;
}

async function switchJupyterKernelForCells(body: {
  language?: string;
  session?: string;
  kernel?: string;
  oldKernel?: string;
}): Promise<number> {
  if (rejectReadOnlyAction("Read-only pane")) return 0;
  const targetLanguage = String(body.language || "").trim().toLowerCase();
  const targetSession = String(body.session || "").trim() || "default";
  const targetKernel = String(body.kernel || "").trim();
  const oldKernel = String(body.oldKernel || "").trim();
  if (!targetLanguage || !targetKernel) {
    setStatus("Language and kernel are required");
    return 0;
  }

  const cells = scanJupyterCells().filter((cell) => (
    cell.language.toLowerCase() === targetLanguage
    && cell.session === targetSession
    && (!oldKernel || cell.kernel === oldKernel)
  ));
  const anchor = cells[0];
  if (anchor) {
    const opened = await ensureJupyterScript(anchor);
    const scriptFile = String(opened.file || opened.scriptFile || "");
    if (!scriptFile) throw new Error("Jupyter script controller is unavailable");
    await api.jupyterCell.sessionSelect({
      scriptFile,
      kind: "start",
      kernelSpecName: targetKernel,
    });
  }
  setStatus(cells.length
    ? `Selected ${targetKernel} for ${targetLanguage}/${targetSession}`
    : `No matching ${targetLanguage}/${targetSession} cells`);
  return cells.length;
}

function exitJupyterCellFromLean(cell: JupyterPanelCell): boolean {
  if (rejectReadOnlyAction("Read-only pane")) return false;
  if (!isLeanJupyterCell(cell)) {
    setStatus("Current cell is not Lean");
    return false;
  }
  const line = editor.getMarkdown().slice(cell.from, cell.to);
  const match = JUPYTER_CELL_RE.exec(line);
  if (!match) {
    setStatus("Jupyter cell header not found");
    return false;
  }
  const leading = match[1] ?? "";
  const rawId = match[3] ?? "";
  const next = formatJupyterCellHeader(leading, rawId, {
    language: DEFAULT_JUPYTER_CELL.language,
    kernel: DEFAULT_JUPYTER_CELL.kernel,
    session: cell.session || DEFAULT_JUPYTER_CELL.session,
  });
  if (line === next) {
    setStatus(`Cell ${cell.id} already uses python3`);
    return false;
  }
  editor.replaceMarkdownRange(cell.from, cell.to, next);
  jupyterTaskState.delete(jupyterCellKey(cell));
  jupyterScanMarkdown = null;
  renderJupyterPanel();
  setStatus(`Switched ${cell.id} from Lean to python3`);
  return true;
}

function setJupyterKernelToolFromCell(cell: JupyterPanelCell | null, specs: JupyterKernelSpec[] = jupyterKernelSpecsCache || []): void {
  const cells = scanJupyterCells().filter((item) => !isLeanJupyterCell(item));
  const selected = cell && !isLeanJupyterCell(cell) ? cell : null;
  const fallback = cells[0] ?? null;
  const language = selected?.language || jupyterKernelLanguage.value || fallback?.language || "python";
  const sessionsForLanguage = cells.filter((item) => item.language === language).map((item) => item.session);
  const session = selected?.session
    || (sessionsForLanguage.includes(jupyterKernelSession.value) ? jupyterKernelSession.value : "")
    || sessionsForLanguage[0]
    || fallback?.session
    || "default";
  const kernelsForSelection = cells
    .filter((item) => item.language === language && item.session === session)
    .map((item) => item.kernel);
  const oldKernel = selected?.kernel
    || (kernelsForSelection.includes(jupyterKernelOld.value) ? jupyterKernelOld.value : "")
    || kernelsForSelection[0]
    || fallback?.kernel
    || "";
  const specKernels = specs
    .filter((spec) => !spec.language || spec.language === language || language === "python")
    .map((spec) => spec.name);

  setSelectOptions(jupyterKernelLanguage, [...cells.map((item) => item.language), language], language);
  setSelectOptions(jupyterKernelSession, [...sessionsForLanguage, session], session);
  setSelectOptions(jupyterKernelOld, [...kernelsForSelection, oldKernel], oldKernel, "Any");
  setSelectOptions(jupyterKernelNew, [...specKernels, ...kernelsForSelection, oldKernel], oldKernel || specKernels[0] || "python3");
  renderJupyterKernelMatchPreview();
}

function renderJupyterKernelMatchPreview(): void {
  const language = jupyterKernelLanguage.value;
  const session = jupyterKernelSession.value || "default";
  const oldKernel = jupyterKernelOld.value;
  const matches = scanJupyterCells().filter((cell) => (
    !isLeanJupyterCell(cell)
    && cell.language === language
    && cell.session === session
    && (!oldKernel || cell.kernel === oldKernel)
  ));
  if (matches.length === 0) {
    jupyterKernelCells.textContent = "No matching blocks";
    return;
  }
  const head = document.createElement("div");
  head.className = "aaronnote-jupyter-kernel-cells-head";
  head.textContent = `${matches.length} matching block${matches.length === 1 ? "" : "s"}`;
  const list = document.createElement("div");
  list.className = "aaronnote-jupyter-kernel-cells-list";
  for (const cell of matches) {
    const row = document.createElement("div");
    row.className = "aaronnote-jupyter-kernel-cell";
    row.textContent = `:${cell.line}  ${cell.language} / ${cell.kernel} / ${cell.session}  ${cell.id}`;
    list.append(row);
  }
  jupyterKernelCells.replaceChildren(head, list);
}

function switchJupyterKernelFromTool(): void {
  void switchJupyterKernelForCells({
    language: jupyterKernelLanguage.value,
    session: jupyterKernelSession.value,
    kernel: jupyterKernelNew.value,
    oldKernel: jupyterKernelOld.value,
  });
}

async function openJupyterKernelTool(cell: JupyterPanelCell | null = selectedJupyterCell()): Promise<void> {
  jupyterKernelTool.hidden = false;
  setJupyterKernelToolFromCell(cell);
  setJupyterKernelToolFromCell(cell, await loadJupyterKernelSpecs());
}

function toggleJupyterKernelTool(): void {
  if (jupyterKernelTool.hidden) {
    void openJupyterKernelTool();
  } else {
    jupyterKernelTool.hidden = true;
  }
}

function selectJupyterCellFromHost(body: {
  file?: string;
  cellId?: string;
  id?: string;
}): JupyterPanelCell | null {
  const cellId = String(body.cellId || body.id || "").trim();
  if (!cellId) return null;
  const cell = scanJupyterCells().find((item) => item.id === cellId) ?? null;
  if (!cell) {
    setStatus(`Jupyter cell not found: ${cellId}`);
    return null;
  }
  editor.view.dispatch({ selection: { anchor: cell.from }, scrollIntoView: true });
  setJupyterKernelToolFromCell(cell);
  if (!jupyterPanel.hidden) renderJupyterPanel();
  return cell;
}

async function runJupyterCellFromHost(body: {
  file?: string;
  cellId?: string;
  id?: string;
}): Promise<void> {
  const cellId = String(body.cellId || body.id || "").trim();
  if (cellId && await window.AaronnoteRunCeilCell?.(cellId)) return;
  const cell = selectJupyterCellFromHost(body);
  if (!cell) return;
  await runJupyterCell(cell);
}

function scanJupyterCellBases(): JupyterCellBase[] {
  const markdown = editor.getMarkdown();
  // getMarkdown() is memoized by immutable-Text identity, so an unchanged doc
  // returns the same string reference; skip re-scanning the whole file. A single
  // context-menu open otherwise triggers this whole-document scan 2-3 times.
  if (markdown === jupyterScanMarkdown) return jupyterScanBases;
  const bases: JupyterCellBase[] = [];
  let pos = 0;
  let lineNumber = 1;
  let lastCellDefaults = DEFAULT_JUPYTER_CELL;
  while (pos <= markdown.length) {
    const lineEndIndex = markdown.indexOf("\n", pos);
    const lineEnd = lineEndIndex < 0 ? markdown.length : lineEndIndex;
    const line = markdown.slice(pos, lineEnd);
    const match = JUPYTER_CELL_RE.exec(line);
    if (match) {
      const leading = match[1] ?? "";
      const rawArgs = match[2] ?? "";
      const rawId = match[3] ?? "";
      const runtime = parseJupyterCellRuntime(rawArgs, lastCellDefaults);
      lastCellDefaults = runtime;
      // Same generator the widget uses (offset after leading whitespace) so a
      // panel run and the widget agree on an unlabeled cell's hidden-script id.
      const id = cleanJupyterToken(rawId, ceilCommandGeneratedId(currentFile, pos + leading.length, rawArgs, rawId));
      bases.push({ id, from: pos, to: lineEnd, line: lineNumber, ...runtime, status: "idle" });
    }
    if (lineEndIndex < 0) break;
    pos = lineEnd + 1;
    lineNumber += 1;
  }
  jupyterScanMarkdown = markdown;
  jupyterScanBases = bases;
  return bases;
}

function scanJupyterCells(): JupyterPanelCell[] {
  return scanJupyterCellBases().map((base) => ({ ...base, ...(jupyterTaskState.get(jupyterCellKey(base)) || {}) }));
}

function jupyterCellsForContext(target: JupyterPanelCell, cells = scanJupyterCells()): Array<Record<string, string>> {
  return cells
    .filter((cell) => cell.language === target.language && cell.session === target.session)
    .map((cell) => ({ cellId: cell.id, id: cell.id, kernel: cell.kernel, session: cell.session, language: cell.language, code: "" }));
}

function renderJupyterPanel(): JupyterPanelCell[] {
  const cells = scanJupyterCells();
  const running = cells.filter((cell) => cell.status === "running" || cell.status === "pending").length;
  jupyterSummary.textContent = `${cells.length} cell${cells.length === 1 ? "" : "s"}${running ? `, ${running} running` : ""}`;
  jupyterList.replaceChildren();
  if (document.activeElement !== jupyterKernelLanguage
    && document.activeElement !== jupyterKernelSession
    && document.activeElement !== jupyterKernelOld
    && document.activeElement !== jupyterKernelNew) {
    setJupyterKernelToolFromCell(selectedJupyterCell(cells));
  }
  if (cells.length === 0) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-jupyter-empty";
    empty.textContent = "No @@cell entries";
    jupyterList.append(empty);
    return cells;
  }
  for (const cell of cells) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "aaronnote-jupyter-task";
    row.dataset.status = cell.status;
    row.innerHTML = `
      <span data-jupyter-task-main></span>
      <span data-jupyter-task-meta></span>
      <span data-jupyter-task-status></span>
    `;
    row.querySelector<HTMLElement>("[data-jupyter-task-main]")!.textContent = `${cell.id}`;
    row.querySelector<HTMLElement>("[data-jupyter-task-meta]")!.textContent = isLeanJupyterCell(cell)
      ? `${cell.language} / ${cell.session} :${cell.line}`
      : `${cell.language} / ${cell.kernel} / ${cell.session} :${cell.line}`;
    row.querySelector<HTMLElement>("[data-jupyter-task-status]")!.textContent = [
      cell.status,
      !isLeanJupyterCell(cell) && cell.executionCount != null ? `In [${cell.executionCount}]` : "",
      cell.durationMs != null ? `${Math.round(cell.durationMs)}ms` : "",
      !isLeanJupyterCell(cell) && cell.outputCount != null ? `${cell.outputCount} out` : "",
    ].filter(Boolean).join(" · ");
    row.addEventListener("click", () => {
      editor.view.dispatch({ selection: { anchor: cell.from }, scrollIntoView: true });
      editor.focus();
      setJupyterKernelToolFromCell(cell);
    });
    jupyterList.append(row);
  }
  return cells;
}

function selectedJupyterCell(cells = scanJupyterCells()): JupyterPanelCell | null {
  const position = editor.view.state.selection.main.from;
  let best: JupyterPanelCell | null = null;
  for (const cell of cells) {
    if (cell.from <= position) best = cell;
    if (cell.from > position) break;
  }
  return best ?? cells[0] ?? null;
}

function filterJupyterCells(mode: string, cells = scanJupyterCells()): JupyterPanelCell[] {
  if (mode === "all") return cells;
  const position = editor.view.state.selection.main.from;
  if (mode === "above") return cells.filter((cell) => cell.from <= position);
  if (mode === "below") return cells.filter((cell) => cell.from >= position);
  if (mode === "section") {
    const markdown = editor.getMarkdown();
    const headings = markdownHeadingsFromText(editor.view.state.doc);
    const currentHeading = headings
      .filter((heading) => heading.pos <= position)
      .sort((a, b) => b.pos - a.pos)[0];
    if (!currentHeading) return cells;
    const next = headings.find((heading) => heading.pos > currentHeading.pos && heading.level <= currentHeading.level);
    const end = next?.pos ?? markdown.length;
    return cells.filter((cell) => cell.from >= currentHeading.pos && cell.from < end);
  }
  return [];
}

async function ensureJupyterScript(cell: JupyterPanelCell, allCells = scanJupyterCells()): Promise<Record<string, unknown>> {
  return await api.jupyterCell.openScript({
    file: currentFile,
    cellId: cell.id,
    kernel: cell.kernel,
    session: cell.session,
    language: cell.language,
    storage: "ipynb",
    open: false,
    cells: jupyterCellsForContext(cell, allCells),
  });
}

async function runJupyterCell(cell: JupyterPanelCell, allCells = scanJupyterCells()): Promise<boolean> {
  if (!jupyterExecutionAvailable) {
    setStatus("Jupyter execution is unavailable in reader mode");
    return false;
  }
  const key = jupyterCellKey(cell);
  jupyterTaskState.set(key, { status: "running" });
  renderJupyterPanel();
  const started = performance.now();
  try {
    await ensureJupyterScript(cell, allCells);
    const result = await api.jupyterCell.executeScriptCell({
      file: currentFile,
      cellId: cell.id,
      kernel: cell.kernel,
      session: cell.session,
      language: cell.language,
      mode: "current",
      selectedCellIds: [cell.id],
      cells: jupyterCellsForContext(cell, allCells),
    }) as JupyterPanelExecutionResult;
    const published = new Set<string>();
    if (Array.isArray(result.results)) {
      for (const item of result.results) {
        const itemId = String(item?.cellId || "");
        const itemCell = allCells.find((candidate) => candidate.id === itemId && candidate.language === cell.language && candidate.session === cell.session);
        if (!itemId || !itemCell || published.has(itemId)) continue;
        window.AaronnotePublishJupyterCellResult?.({
          file: currentFile,
          cellId: itemId,
          kernel: itemCell.kernel,
          session: itemCell.session,
          result: item,
        });
        jupyterTaskState.set(jupyterCellKey(itemCell), {
          status: isLeanJupyterCell(itemCell) ? "synced" : item.status === "error" ? "error" : "ok",
          executionCount: isLeanJupyterCell(itemCell) ? null : item.executionCount,
          durationMs: performance.now() - started,
          outputCount: isLeanJupyterCell(itemCell) ? undefined : item.outputs?.length ?? 0,
        });
        published.add(itemId);
      }
    }
    if (!published.has(cell.id)) {
      window.AaronnotePublishJupyterCellResult?.({
        file: currentFile,
        cellId: cell.id,
        kernel: cell.kernel,
        session: cell.session,
        result,
      });
    }
    jupyterTaskState.set(key, {
      status: isLeanJupyterCell(cell) ? "synced" : result.status === "error" ? "error" : "ok",
      executionCount: isLeanJupyterCell(cell) ? null : result.executionCount,
      durationMs: performance.now() - started,
      outputCount: isLeanJupyterCell(cell) ? undefined : result.outputs?.length ?? 0,
    });
    return result.status !== "error";
  } catch (error) {
    jupyterTaskState.set(key, {
      status: "error",
      durationMs: performance.now() - started,
    });
    setStatus(error instanceof Error ? error.message : "Jupyter run failed");
    return false;
  } finally {
    renderJupyterPanel();
  }
}

async function runJupyterCells(mode: "all" | "above" | "below" | "section"): Promise<void> {
  if (!jupyterExecutionAvailable) {
    setStatus("Jupyter execution is unavailable in reader mode");
    return;
  }
  if (!currentFile) {
    setStatus("Save note first");
    return;
  }
  const allCells = scanJupyterCells();
  const cells = filterJupyterCells(mode, allCells);
  if (cells.length === 0) {
    setStatus("No Jupyter cells");
    return;
  }
  setStatus(`Running ${cells.length} Jupyter cell${cells.length === 1 ? "" : "s"}`);
  const groups = new Map<string, JupyterPanelCell[]>();
  for (const cell of cells) {
    const groupKey = `${cell.language}\0${cell.kernel}\0${cell.session}`;
    groups.set(groupKey, [...(groups.get(groupKey) || []), cell]);
  }
  for (const groupCells of groups.values()) {
    const anchor = groupCells[0];
    if (!anchor) continue;
    const started = performance.now();
    for (const cell of groupCells) jupyterTaskState.set(jupyterCellKey(cell), { status: "running" });
    renderJupyterPanel();
    await ensureJupyterScript(anchor, allCells);
    const result = await api.jupyterCell.executeScriptCell({
      file: currentFile,
      cellId: anchor.id,
      kernel: anchor.kernel,
      session: anchor.session,
      language: anchor.language,
      mode: "selected",
      selectedCellIds: groupCells.map((cell) => cell.id),
      cells: jupyterCellsForContext(anchor, allCells),
    }) as JupyterPanelExecutionResult;
    const results = Array.isArray(result.results) && result.results.length > 0 ? result.results : [result];
    for (const item of results) {
      const itemId = String(item?.cellId || "");
      const itemCell = groupCells.find((candidate) => candidate.id === itemId)
        ?? allCells.find((candidate) => candidate.id === itemId && candidate.language === anchor.language && candidate.session === anchor.session);
      if (!itemId || !itemCell) continue;
      window.AaronnotePublishJupyterCellResult?.({
        file: currentFile,
        cellId: itemId,
        kernel: itemCell.kernel,
        session: itemCell.session,
        result: item,
      });
      jupyterTaskState.set(jupyterCellKey(itemCell), {
        status: isLeanJupyterCell(itemCell) ? "synced" : item.status === "error" ? "error" : "ok",
        executionCount: isLeanJupyterCell(itemCell) ? null : item.executionCount,
        durationMs: performance.now() - started,
        outputCount: isLeanJupyterCell(itemCell) ? undefined : item.outputs?.length ?? 0,
      });
    }
    if (result.status === "error") {
      setStatus(`Jupyter run stopped at ${result.stoppedAt || result.cellId || anchor.id} (error)`);
      renderJupyterPanel();
      return;
    }
  }
  setStatus("Jupyter run complete");
  renderJupyterPanel();
}

async function restartAndRunAllJupyterCells(): Promise<void> {
  const cells = scanJupyterCells();
  const cell = selectedJupyterCell(cells.filter((item) => !isLeanJupyterCell(item)));
  if (!cell) return;
  await api.jupyterCell.restart({ file: currentFile, kernel: cell.kernel, session: cell.session });
  await runJupyterCells("all");
}

async function interruptSelectedJupyterKernel(): Promise<void> {
  const cell = selectedJupyterCell();
  if (!cell) return;
  if (isLeanJupyterCell(cell)) {
    setStatus("Lean cells sync files; no kernel interrupt");
    return;
  }
  await api.jupyterCell.interrupt({ file: currentFile, kernel: cell.kernel, session: cell.session });
  setStatus(`Interrupted ${cell.kernel}/${cell.session}`);
}

async function clearAllJupyterOutputs(): Promise<void> {
  const cells = scanJupyterCells();
  const seen = new Set<string>();
  for (const cell of cells) {
    if (isLeanJupyterCell(cell)) continue;
    const group = `${cell.language}\0${cell.session}`;
    if (seen.has(group)) continue;
    seen.add(group);
    await api.jupyterCell.clearAllOutputs({ file: currentFile, kernel: cell.kernel, session: cell.session, language: cell.language });
  }
  for (const key of Array.from(jupyterTaskState.keys())) jupyterTaskState.delete(key);
  renderJupyterPanel();
  setStatus("Jupyter outputs cleared");
}

async function showJupyterVariables(): Promise<void> {
  const cell = selectedJupyterCell();
  if (!cell) return;
  if (isLeanJupyterCell(cell)) {
    jupyterVars.hidden = false;
    jupyterVars.textContent = "Lean cells do not expose variables";
    return;
  }
  jupyterVars.hidden = false;
  jupyterVars.textContent = "Loading variables...";
  try {
    const result = await api.jupyterCell.variables({ file: currentFile, kernel: cell.kernel, session: cell.session, language: cell.language });
    if (!result.supported) {
      jupyterVars.textContent = `Variables unavailable for ${cell.kernel}`;
      return;
    }
    renderJupyterVariablesTable(jupyterVars, result.variables || [], "No variables");
  } catch (error) {
    jupyterVars.textContent = error instanceof Error ? error.message : "Variable load failed";
  }
}

function renderJupyterRuntime(result: JupyterTasksResult): void {
  jupyterRuntime.hidden = false;
  const server = result.server || {};
  const cleanup = result.cleanup || {};
  const kernels = Array.isArray(result.kernels) ? result.kernels : [];
  const head = document.createElement("div");
  head.className = "aaronnote-jupyter-runtime-head";
  const active = Number(server.activeRequests || 0);
  head.innerHTML = `
    <strong>Runtime</strong>
    <span data-runtime-summary></span>
    <div data-runtime-actions></div>
  `;
  head.querySelector<HTMLElement>("[data-runtime-summary]")!.textContent = [
    server.status || "not-started",
    server.owned ? `pid ${server.pid ?? ""}` : "",
    active ? `${active} request${active === 1 ? "" : "s"}` : "",
    `kernel ttl ${formatRuntimeDuration(cleanup.kernelIdleTtlMs)}`,
    `server ttl ${formatRuntimeDuration(cleanup.serverIdleTtlMs)}`,
  ].filter(Boolean).join(" · ");
  const actions = head.querySelector<HTMLElement>("[data-runtime-actions]")!;
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh";
  refresh.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void showJupyterTasks();
  });
  const force = document.createElement("button");
  force.type = "button";
  force.textContent = "Force cleanup";
  force.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void cleanupJupyterRuntime(true);
  });
  actions.append(refresh, force);

  const list = document.createElement("div");
  list.className = "aaronnote-jupyter-runtime-list";
  if (kernels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-jupyter-empty";
    empty.textContent = "No live kernels";
    list.append(empty);
  } else {
    for (const task of kernels) {
      const row = document.createElement("div");
      row.className = "aaronnote-jupyter-runtime-task";
      row.dataset.status = String(task.status || "");
      const main = document.createElement("button");
      main.type = "button";
      main.className = "aaronnote-jupyter-runtime-main";
      main.textContent = `${task.kernel || "kernel"} / ${task.session || "default"}`;
      main.title = task.file || "";
      main.addEventListener("click", (event) => {
        event.preventDefault();
        const cell = scanJupyterCells().find((item) =>
          item.kernel === task.kernel && item.session === task.session && (!task.lastCellId || item.id === task.lastCellId)
        );
        if (cell) {
          editor.view.dispatch({ selection: { anchor: cell.from }, scrollIntoView: true });
          editor.focus();
        }
      });
      const meta = document.createElement("span");
      meta.textContent = [
        task.status || "idle",
        task.running ? `running ${formatRuntimeDuration(task.runningMs)}` : `idle ${formatRuntimeDuration(task.idleMs)}`,
        task.totalRuns ? `${task.totalRuns} run${task.totalRuns === 1 ? "" : "s"}` : "",
        task.executionCount != null ? `In [${task.executionCount}]` : "",
        task.lastCellId ? `cell ${task.lastCellId}` : "",
        task.lastError || "",
      ].filter(Boolean).join(" · ");
      const rowActions = document.createElement("div");
      const interrupt = document.createElement("button");
      interrupt.type = "button";
      interrupt.textContent = "Interrupt";
      interrupt.disabled = !task.kernel || !task.session || !task.file;
      interrupt.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void api.jupyterCell.interrupt({ file: task.file, kernel: task.kernel, session: task.session })
          .then(() => showJupyterTasks())
          .catch((error) => setStatus(error instanceof Error ? error.message : "Jupyter interrupt failed"));
      });
      const kill = document.createElement("button");
      kill.type = "button";
      kill.textContent = "Kill";
      kill.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void api.jupyterCell.shutdown({ key: task.key, id: task.id, file: task.file, kernel: task.kernel, session: task.session })
          .then(() => showJupyterTasks())
          .catch((error) => setStatus(error instanceof Error ? error.message : "Jupyter kill failed"));
      });
      rowActions.append(interrupt, kill);
      row.append(main, meta, rowActions);
      list.append(row);
    }
  }
  jupyterRuntime.replaceChildren(head, list);
}

async function showJupyterTasks(): Promise<void> {
  jupyterRuntime.hidden = false;
  jupyterRuntime.textContent = "Loading runtime...";
  try {
    renderJupyterRuntime(await api.jupyterCell.tasks());
  } catch (error) {
    jupyterRuntime.textContent = error instanceof Error ? error.message : "Runtime load failed";
  }
}

async function cleanupJupyterRuntime(force = false): Promise<void> {
  jupyterRuntime.hidden = false;
  jupyterRuntime.textContent = force ? "Force cleaning runtime..." : "Cleaning idle runtime...";
  try {
    const result = await api.jupyterCell.cleanup({ force });
    renderJupyterRuntime(result);
    const removed = result.removed?.length || 0;
    setStatus(removed ? `Cleaned ${removed} Jupyter kernel${removed === 1 ? "" : "s"}` : "No idle Jupyter kernels");
  } catch (error) {
    jupyterRuntime.textContent = error instanceof Error ? error.message : "Runtime cleanup failed";
  }
}

function jupyterCellAtCommandPosition(position: number, cells = scanJupyterCells()): JupyterPanelCell | null {
  return cells.find((cell) => position >= cell.from && position <= cell.to) ?? null;
}

function sourceRangeFromEventTarget(event: Event): { from: number; to: number } | null {
  let el: Element | null = event.target instanceof Element ? event.target : null;
  while (el) {
    const from = Number((el as HTMLElement).dataset?.cmSourceFrom);
    const to = Number((el as HTMLElement).dataset?.cmSourceTo);
    if (Number.isFinite(from) && Number.isFinite(to)) return { from, to };
    el = el.parentElement;
  }
  return null;
}

function jupyterCellFromPointer(event: MouseEvent, fallbackToSelection = true): JupyterPanelCell | null {
  const sourceRange = sourceRangeFromEventTarget(event);
  if (sourceRange) {
    const fromWidget = jupyterCellAtCommandPosition(sourceRange.from)
      ?? scanJupyterCells().find((cell) => sourceRange.from >= cell.from && sourceRange.from <= cell.to)
      ?? null;
    if (fromWidget) return fromWidget;
  }
  const posAtCoords = editor.view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (typeof posAtCoords !== "number") return fallbackToSelection ? selectedJupyterCell() : null;
  return jupyterCellAtCommandPosition(posAtCoords) ?? (fallbackToSelection ? selectedJupyterCell() : null);
}

async function openJupyterCellSource(cell: JupyterPanelCell): Promise<void> {
  if (!jupyterExecutionAvailable) {
    setStatus("Cell editing is unavailable in reader mode");
    return;
  }
  if (!currentFile) {
    setStatus("Save note first");
    return;
  }
  await api.jupyterCell.openScript({
    file: currentFile,
    cellId: cell.id,
    kernel: cell.kernel,
    session: cell.session,
    language: cell.language,
    storage: "ipynb",
    cells: jupyterCellsForContext(cell),
  });
}

async function deleteJupyterCellBlock(cell: JupyterPanelCell): Promise<void> {
  if (rejectReadOnlyAction("Read-only pane")) return;
  if (!jupyterExecutionAvailable) {
    setStatus("Cell editing is unavailable in reader mode");
    return;
  }
  if (!currentFile) {
    setStatus("Save note first");
    return;
  }
  // The scan that produced `cell` is memoized by document identity, so the
  // offset can be stale. Re-resolve it and refuse to touch a line that is no
  // longer this marker rather than deleting an unrelated one.
  const doc = editor.view.state.doc;
  const line = doc.lineAt(Math.min(Math.max(cell.from, 0), doc.length));
  if (!JUPYTER_CELL_RE.test(line.text)) {
    setStatus("Cell marker moved; nothing deleted");
    return;
  }
  // Markdown source is the runtime document: the @@cell marker is what makes
  // the cell exist at all. Remove it first so the action the user asked for
  // always lands, then reconcile the hidden notebook. A notebook left with a
  // stale cell is recoverable; a marker that survives its own delete is the
  // bug this ordering fixes.
  let from = line.from;
  let to = line.to;
  if (to < doc.length) to += 1;
  else if (from > 0) from -= 1;
  editor.replaceMarkdownRange(from, to, "");
  jupyterTaskState.delete(jupyterCellKey(cell));
  jupyterScanMarkdown = null;
  renderJupyterPanel();
  try {
    await ensureJupyterScript(cell);
    await api.jupyterCell.documentMutate({
      file: currentFile,
      cellId: cell.id,
      kernel: cell.kernel,
      session: cell.session,
      language: cell.language,
      op: "delete",
    });
    setStatus(`Deleted Jupyter cell ${cell.id}`);
  } catch (error) {
    setStatus(error instanceof Error
      ? `Deleted cell ${cell.id}; notebook cleanup failed: ${error.message}`
      : `Deleted cell ${cell.id}; notebook cleanup failed`);
  }
}

type AaronContextMenuItem = NoemaMenuItem;

function hideContextMenu(): void {
  contextMenuController.close();
}

function runContextEditorCommand(command: EditorCommand, value = ""): boolean {
  editor.focus();
  return editor.runCommand(command, value);
}

function syncFormatPainterUi(): void {
  const state = editor.getFormatPainterState();
  if (state) document.body.dataset.noemaFormatPainter = state.mode;
  else delete document.body.dataset.noemaFormatPainter;
}

function formatPainterDetail(): string {
  const state = editor.getFormatPainterState();
  if (!state) return "No copied format";
  return `${state.mode} · ${state.snapshot.types.join(", ") || "plain text"}`;
}

function captureFormatPainter(mode: "once" | "continuous"): boolean {
  if (currentReadOnly) {
    setStatus("Read-only pane");
    return false;
  }
  const snapshot = editor.captureFormat(mode);
  syncFormatPainterUi();
  if (!snapshot) {
    setStatus("Select text before copying its format");
    return false;
  }
  setStatus(`Format painter ${mode}: ${snapshot.types.join(", ") || "plain text"}`);
  return true;
}

function applyFormatPainter(): boolean {
  if (rejectReadOnlyAction("Read-only pane")) return false;
  editor.focus();
  const applied = editor.applyCapturedFormat();
  syncFormatPainterUi();
  setStatus(applied ? "Format painted" : "Copy a format and select target text first");
  return applied;
}

function clearFormatPainter(announce = true): boolean {
  if (!editor.getFormatPainterState()) return false;
  editor.clearFormatPainter();
  syncFormatPainterUi();
  if (announce) setStatus("Format painter canceled");
  return true;
}

function markdownHrefFromPointer(event: MouseEvent): string {
  const element = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
  const renderedHref = element?.closest<HTMLAnchorElement>("a[href]")?.getAttribute("href") || "";
  if (renderedHref) return cleanHref(renderedHref);
  const pos = editor.view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (typeof pos !== "number") return "";
  return cleanHref(markdownHrefAt(editor.view.state, pos) || "");
}

type ContextMathTarget = {
  kind: "inline" | "block";
  from: number;
  to: number;
  tex: string;
  contentFrom?: number;
  contentTo?: number;
};

function mathTargetAtPosition(pos: number): ContextMathTarget | null {
  const state = editor.view.state;
  const safePos = Math.max(0, Math.min(pos, state.doc.length));
  const blockRanges = getBlockMathRanges(state);
  const block = rangeAtPosition(safePos, blockRanges);
  if (block) {
    return {
      kind: "block",
      from: block.from,
      to: block.to,
      tex: block.tex,
      contentFrom: block.contentFrom,
      contentTo: block.contentTo,
    };
  }

  const line = state.doc.lineAt(safePos);
  INLINE_MATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_MATH_RE.exec(line.text)) !== null) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (safePos < from || safePos > to) continue;
    if (rangeOverlapsAny(from, to, blockRanges)) continue;
    return { kind: "inline", from, to, tex: match[1] || "" };
  }
  return null;
}

function mathTargetFromSourceElement(target: EventTarget | null): ContextMathTarget | null {
  const element = target instanceof Element
    ? target.closest<HTMLElement>(".cm-math-inline, .cm-math-inline-editor, .cm-math-block, .cm-math-block-editor")
    : null;
  if (!element) return null;
  // The widget's `data-cm-source-*` attributes are written once at toDOM() time
  // and deliberately go stale: display-math decorations are mapped rather than
  // rebuilt when an edit does not touch math, so a widget keeps its original
  // coordinates after any edit earlier in the note. Ask the view where this
  // element actually sits instead.
  try {
    const position = editor.view.posAtDOM(element, 1);
    if (Number.isFinite(position)) {
      const resolved = mathTargetAtPosition(position);
      if (resolved) return resolved;
    }
  } catch (_) {
    // The element may already be detached from the current view tree.
  }
  const from = Number(element.dataset.cmSourceFrom);
  const to = Number(element.dataset.cmSourceTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null;
  return mathTargetAtPosition(Math.min(to, from + 1));
}

function mathTargetFromPointer(event: MouseEvent): ContextMathTarget | null {
  const elementTarget = mathTargetFromSourceElement(event.target);
  if (elementTarget) return elementTarget;
  const pos = editor.view.posAtCoords({ x: event.clientX, y: event.clientY });
  return typeof pos === "number" ? mathTargetAtPosition(pos) : null;
}

function convertInlineMathToBlock(target: ContextMathTarget, sourceTex = target.tex): boolean {
  if (rejectReadOnlyAction("Read-only pane")) return false;
  if (target.kind !== "inline") return false;
  const state = editor.view.state;
  const line = state.doc.lineAt(target.from);
  const before = state.doc.sliceString(line.from, target.from);
  const after = state.doc.sliceString(target.to, line.to);
  const prefix = before.trim().length > 0 ? "\n" : "";
  const suffix = after.trim().length > 0 ? "\n" : "";
  const tex = normalizeVisualTexLatex(sourceTex).trim();
  const replacement = `${prefix}\\[\n${tex}\n\\]${suffix}`;
  const replaced = editor.preserveViewport(() => (
    editor.replaceMarkdownRange(target.from, target.to, replacement, "end")
  ));
  setStatus("Converted inline math to display math");
  scheduleAssistUpdate({ mathPreview: true, cursor: true });
  return replaced.to > replaced.from;
}

function convertBlockMathToInline(target: ContextMathTarget, sourceTex = target.tex): boolean {
  if (rejectReadOnlyAction("Read-only pane")) return false;
  if (target.kind !== "block") return false;
  const tex = normalizeVisualTexLatex(sourceTex).trim().replace(/\s*\n\s*/g, " ");
  const replacement = `\\(${tex}\\)`;
  editor.preserveViewport(() => {
    editor.replaceMarkdownRange(target.from, target.to, replacement, "end");
  });
  setStatus("Converted display math to inline math");
  scheduleAssistUpdate({ mathPreview: true, cursor: true });
  return true;
}

type ManagedFormulaStyle = {
  body: string;
  color: string;
  background: string;
  variant: string;
  size: string;
};

const formulaVariantCommands = new Set(["mathbf", "mathrm", "mathsf", "mathtt", "mathcal", "mathbb", "mathfrak"]);
const formulaSizeCommands = new Set(["small", "normalsize", "large", "Large", "LARGE", "huge"]);

function readBracedFormulaArgument(source: string, from: number): { value: string; end: number } | null {
  let start = from;
  while (/\s/.test(source[start] ?? "")) start++;
  if (source[start] !== "{") return null;
  let depth = 1;
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") {
      index++;
      continue;
    }
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) {
      return { value: source.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function outerFormulaCommand(source: string, command: string, argumentCount: number): string[] | null {
  const prefix = `\\${command}`;
  if (!source.startsWith(prefix)) return null;
  const args: string[] = [];
  let offset = prefix.length;
  for (let index = 0; index < argumentCount; index++) {
    const argument = readBracedFormulaArgument(source, offset);
    if (!argument) return null;
    args.push(argument.value);
    offset = argument.end;
  }
  return source.slice(offset).trim() ? null : args;
}

function managedFormulaStyle(tex: string): ManagedFormulaStyle {
  const style: ManagedFormulaStyle = { body: tex.trim(), color: "", background: "", variant: "", size: "" };
  for (;;) {
    const before = style.body;
    const color = outerFormulaCommand(style.body, "textcolor", 2);
    if (color) {
      style.color = color[0]!.trim();
      style.body = color[1]!.trim();
      continue;
    }
    const background = outerFormulaCommand(style.body, "colorbox", 2);
    if (background) {
      style.background = background[0]!.trim();
      style.body = background[1]!.trim();
      continue;
    }
    const variant = style.body.match(/^\\([A-Za-z]+)\b/)?.[1] ?? "";
    if (formulaVariantCommands.has(variant)) {
      const args = outerFormulaCommand(style.body, variant, 1);
      if (args) {
        style.variant = variant;
        style.body = args[0]!.trim();
        continue;
      }
    }
    if (style.body.startsWith("{") && style.body.endsWith("}")) {
      const inner = style.body.slice(1, -1).trim();
      const size = inner.match(/^\\([A-Za-z]+)\s+/)?.[1] ?? "";
      if (formulaSizeCommands.has(size)) {
        style.size = size === "normalsize" ? "" : size;
        style.body = inner.replace(/^\\[A-Za-z]+\s+/, "").trim();
        continue;
      }
    }
    if (style.body === before) return style;
  }
}

function wrapManagedFormulaStyle(body: string, style: Omit<ManagedFormulaStyle, "body">): string {
  let result = body.trim();
  if (style.variant) result = `\\${style.variant}{${result}}`;
  if (style.size) result = `{\\${style.size} ${result}}`;
  if (style.background) result = `\\colorbox{${style.background}}{${result}}`;
  if (style.color) result = `\\textcolor{${style.color}}{${result}}`;
  return result;
}

function replaceContextMathTex(target: ContextMathTarget, tex: string, status: string): boolean {
  if (rejectReadOnlyAction("Read-only pane")) return false;
  const live = mathTargetAtPosition(Math.min(editor.view.state.doc.length, target.from + 1));
  if (!live || live.kind !== target.kind) return false;
  const state = editor.view.state;
  const compatibleTex = normalizeVisualTexLatex(tex);
  editor.preserveViewport(() => {
    if (live.kind === "inline") {
      const from = live.from + 2;
      const to = live.to - 2;
      const nextFormulaTo = live.to + compatibleTex.length - (to - from);
      editor.view.dispatch({
        changes: { from, to, insert: compatibleTex },
        selection: { anchor: nextFormulaTo },
      });
    } else {
      const rawContent = state.doc.sliceString(live.contentFrom!, live.contentTo!);
      const indent = rawContent.match(/^[ \t]*/)?.[0]
        || state.doc.lineAt(live.from).text.match(/^[ \t]*/)?.[0]
        || "";
      const insert = `${compatibleTex.trim().split("\n").map((line) => `${indent}${line.trim()}`).join("\n")}\n`;
      const nextFormulaTo = live.to + insert.length - (live.contentTo! - live.contentFrom!);
      editor.view.dispatch({
        changes: { from: live.contentFrom!, to: live.contentTo!, insert },
        selection: { anchor: nextFormulaTo },
      });
    }
  });
  setStatus(status);
  scheduleAssistUpdate({ mathPreview: true, cursor: true });
  return true;
}

function applyFormulaStyle(
  target: ContextMathTarget,
  patch: Partial<Omit<ManagedFormulaStyle, "body">>,
  status: string,
): boolean {
  const current = managedFormulaStyle(target.tex);
  const next = wrapManagedFormulaStyle(current.body, {
    color: patch.color ?? current.color,
    background: patch.background ?? current.background,
    variant: patch.variant ?? current.variant,
    size: patch.size ?? current.size,
  });
  return replaceContextMathTex(target, next, status);
}

function applyFormulaLayout(target: ContextMathTarget, layout: VisualTexDisplayLayout): boolean {
  const current = managedFormulaStyle(target.tex);
  const body = setVisualTexDisplayLayout(current.body, layout);
  const next = wrapManagedFormulaStyle(body, current);
  if (target.kind === "inline") return convertInlineMathToBlock(target, next);
  return replaceContextMathTex(target, next, `Formula layout: ${layout}`);
}

function dismissLiveTexStudio(): void {
  const wasOpen = !liveTexStudio.hidden;
  liveTexEditor?.destroy();
  liveTexEditor = null;
  liveTexTarget = null;
  liveTexDraft = "";
  liveTexEditorHost.replaceChildren();
  liveTexEditorTools.replaceChildren();
  liveTexStudio.hidden = true;
  if (wasOpen) {
    host.dispatchEvent(new CustomEvent("aaronnote:inline-math-edit-state", {
      bubbles: true,
      detail: { active: false, kind: "studio" },
    }));
  }
}

function fallbackLiveTexStudio(target: ContextMathTarget, error: unknown): void {
  editor.preserveViewport(() => {
    dismissLiveTexStudio();
    const live = mathTargetAtPosition(Math.min(editor.view.state.doc.length, target.from + 1));
    if (live?.kind === "inline") {
      editor.setMarkdownSelection(live.from + 2, live.to - 2, { scrollIntoView: false });
    } else if (live?.kind === "block") {
      editor.setMarkdownSelection(live.contentFrom!, live.contentTo!, { scrollIntoView: false });
    }
    editor.focus();
  });
  setStatus(`${error instanceof Error ? error.message : "LiveTeX unavailable"}; 已回退到 TeX 源码与预览`);
  scheduleAssistUpdate({ mathPreview: true, cursor: true });
}

function applyLiveTexStudio(focusEditor = true): boolean {
  const target = liveTexTarget;
  if (!target) return false;
  const latex = normalizeVisualTexLatex(liveTexEditor?.value() ?? liveTexDraft).trim();
  const live = mathTargetAtPosition(Math.min(editor.view.state.doc.length, target.from + 1));
  if (!live || live.kind !== target.kind) {
    setStatus("The original formula is no longer available; LiveTeX remains open");
    return false;
  }
  if (!latex) {
    editor.preserveViewport(() => {
      editor.replaceMarkdownRange(live.from, live.to, "", "end");
      dismissLiveTexStudio();
      if (focusEditor) editor.focus();
    });
    setStatus("Empty formula removed");
    scheduleAssistUpdate({ mathPreview: true, cursor: true });
    return true;
  }
  if (live.kind === "inline" && visualTexDisplayLayout(latex) !== "equation") {
    const changed = editor.preserveViewport(() => {
      const converted = convertInlineMathToBlock(live, latex);
      if (converted) {
        dismissLiveTexStudio();
        if (focusEditor) editor.focus();
      }
      return converted;
    });
    return changed;
  }
  const changed = editor.preserveViewport(() => {
    const replaced = replaceContextMathTex(live, latex, "Formula updated in LiveTeX; save queued");
    if (replaced) {
      dismissLiveTexStudio();
      if (focusEditor) editor.focus();
    }
    return replaced;
  });
  return changed;
}

function closeLiveTexStudioWithApply(): void {
  if (liveTexStudio.hidden) return;
  applyLiveTexStudio();
}

function openContextLiveTex(target: ContextMathTarget, returnMode?: VimLiteMode): boolean {
  if (rejectReadOnlyAction("Read-only pane")) return false;
  finishInlineMathEditing(editor.view);
  const live = mathTargetAtPosition(Math.min(editor.view.state.doc.length, target.from + 1)) ?? target;
  dismissLiveTexStudio();
  // Context-menu buttons receive focus before their action runs. Preserve the
  // mode captured when the menu opened instead of the blur-reset mode.
  visualMathReturnMode = returnMode ?? vim.mode();
  liveTexTarget = { ...live };
  liveTexDraft = normalizeVisualTexLatex(live.tex);
  liveTexZoom = 1;
  liveTexZoomLabel.value = "100%";
  liveTexStage.style.setProperty("--noema-livetex-zoom", "1");
  liveTexStage.dataset.align = "center";
  liveTexStudio.hidden = false;
  host.dispatchEvent(new CustomEvent("aaronnote:inline-math-edit-state", {
    bubbles: true,
    detail: { active: true, kind: "studio" },
  }));
  liveTexEditor = mountVisualTexDisplayEditor(liveTexEditorHost, {
    latex: liveTexDraft,
    macros: getKatexMacros(),
    entry: { kind: "all" },
    advanced: true,
    commitOnBlur: false,
    toolbarHost: liveTexEditorTools,
    onInput: (latex) => { liveTexDraft = normalizeVisualTexLatex(latex); },
    // The studio owns its Apply/Close lifecycle. MathLive emits move-out while
    // the pointer travels from the field to the header Apply button; closing
    // here used to clear the target before the ensuing click could write back.
    onCommit: (direction) => {
      if (direction === "submit" || direction === "save") applyLiveTexStudio();
    },
    onUnavailable: (error) => fallbackLiveTexStudio(live, error),
  });
  return true;
}

function commitActiveLiveTexForBoundary(focusEditor = false): boolean {
  if (!visualMathEditorActive) return true;
  if (!liveTexStudio.hidden) return applyLiveTexStudio(focusEditor);
  return finishInlineMathEditing(editor.view);
}

function revealLiveTexStudioSource(): boolean {
  const target = liveTexTarget;
  if (!target) return false;
  const sourceOffset = liveTexEditor?.sourceOffset() ?? 0;
  if (!applyLiveTexStudio(false)) return false;
  const live = mathTargetAtPosition(Math.min(editor.view.state.doc.length, target.from + 1));
  if (!live) return false;
  const revealed = revealFormulaSource(editor.view, live.from, live.to, sourceOffset);
  if (revealed) editor.focus();
  return revealed;
}

liveTexStudio.querySelectorAll<HTMLButtonElement>("[data-livetex-align]").forEach((button) => {
  button.addEventListener("click", () => {
    liveTexStage.dataset.align = button.dataset.livetexAlign || "center";
    liveTexEditor?.focus();
  });
});
liveTexStudio.querySelectorAll<HTMLButtonElement>("[data-livetex-zoom]").forEach((button) => {
  button.addEventListener("click", () => {
    liveTexZoom = Math.max(0.7, Math.min(1.6, liveTexZoom + (button.dataset.livetexZoom === "in" ? 0.1 : -0.1)));
    liveTexStage.style.setProperty("--noema-livetex-zoom", liveTexZoom.toFixed(2));
    liveTexZoomLabel.value = `${Math.round(liveTexZoom * 100)}%`;
    liveTexEditor?.focus();
  });
});
liveTexStudio.querySelector<HTMLButtonElement>("[data-livetex-close]")!
  .addEventListener("mousedown", (event) => event.preventDefault());
liveTexStudio.querySelector<HTMLButtonElement>("[data-livetex-close]")!
  .addEventListener("click", closeLiveTexStudioWithApply);
liveTexStudio.querySelector<HTMLButtonElement>("[data-livetex-apply]")!
  .addEventListener("mousedown", (event) => event.preventDefault());
liveTexStudio.querySelector<HTMLButtonElement>("[data-livetex-apply]")!
  .addEventListener("click", applyLiveTexStudio);
liveTexStudio.addEventListener("mousedown", (event) => {
  if (event.target === liveTexStudio) closeLiveTexStudioWithApply();
});
liveTexStudioPanel.addEventListener("mousedown", (event) => event.stopPropagation());
window.addEventListener("keydown", (event) => {
  if (liveTexStudio.hidden || event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closeLiveTexStudioWithApply();
}, { capture: true });

const formulaColorOptions = ["", "red", "orange", "yellow", "lime", "green", "teal", "blue", "indigo", "purple", "magenta", "black", "white"];
const formulaLayoutOptions: Array<{ value: string; label: string }> = [
  { value: "inline", label: "Inline" },
  { value: "equation", label: "Equation" },
  { value: "align", label: "Align (numbered)" },
  { value: "align*", label: "Align (unnumbered)" },
  { value: "aligned", label: "Aligned" },
  { value: "gather", label: "Gather (numbered)" },
  { value: "gather*", label: "Gather (unnumbered)" },
  { value: "gathered", label: "Gathered" },
  { value: "split", label: "Split" },
  { value: "multline", label: "Multline (numbered)" },
  { value: "multline*", label: "Multline (unnumbered)" },
  { value: "cases", label: "Cases" },
  { value: "matrix", label: "Matrix" },
  { value: "pmatrix", label: "Parenthesized matrix" },
  { value: "bmatrix", label: "Bracketed matrix" },
];

async function openFormulaManager(target: ContextMathTarget): Promise<void> {
  const current = managedFormulaStyle(target.tex);
  const currentLayout = target.kind === "inline" ? "inline" : visualTexDisplayLayout(current.body);
  const result = await openFormModal("Formula options", [
    { id: "layout", label: "Layout", type: "select", value: currentLayout, options: formulaLayoutOptions, group: "Structure" },
    { id: "color", label: "Text color", type: "select", value: current.color, options: formulaColorOptions.map((value) => ({ value, label: value || "Default" })), group: "Appearance" },
    { id: "background", label: "Highlight", type: "select", value: current.background, options: formulaColorOptions.map((value) => ({ value, label: value || "None" })) },
    { id: "variant", label: "Math alphabet", type: "select", value: current.variant, options: [
      { value: "", label: "Normal" }, { value: "mathbf", label: "Bold" },
      { value: "mathrm", label: "Roman" }, { value: "mathsf", label: "Sans serif" },
      { value: "mathtt", label: "Monospace" }, { value: "mathcal", label: "Calligraphic" },
      { value: "mathbb", label: "Blackboard" }, { value: "mathfrak", label: "Fraktur" },
    ] },
    { id: "size", label: "Size", type: "select", value: current.size, options: [
      { value: "", label: "Normal" }, { value: "small", label: "Small" },
      { value: "large", label: "Large" }, { value: "Large", label: "Larger" },
      { value: "LARGE", label: "Very large" }, { value: "huge", label: "Huge" },
    ] },
  ], "Apply");
  if (!result) return;
  const live = mathTargetAtPosition(Math.min(editor.view.state.doc.length, target.from + 1));
  if (!live) return;
  const latest = managedFormulaStyle(live.tex);
  const layout = result.layout as VisualTexDisplayLayout | "inline";
  const body = layout === "inline" ? latest.body : setVisualTexDisplayLayout(latest.body, layout);
  const styled = wrapManagedFormulaStyle(body, {
    color: result.color || "",
    background: result.background || "",
    variant: result.variant || "",
    size: result.size || "",
  });
  if (layout === "inline" && live.kind === "block") convertBlockMathToInline(live, styled);
  else if (layout !== "inline" && live.kind === "inline") convertInlineMathToBlock(live, styled);
  else replaceContextMathTex(live, styled, "Formula options applied");
}

async function copyCurrentNotePath(): Promise<void> {
  if (!currentFile) return;
  await copyText(currentFile);
  setStatus("Note path copied");
}

async function copyContextLink(href: string): Promise<void> {
  await copyText(href);
  setStatus("Link copied");
}

function canOpenHrefInEmacs(href: string): boolean {
  const raw = cleanHref(href);
  if (!raw) return false;
  if (raw.startsWith("#")) return Boolean(currentFile);
  return Boolean(resolveHrefTarget(raw).note?.file);
}

async function openHrefInEmacs(href: string): Promise<void> {
  const raw = cleanHref(href);
  if (!raw) return;
  const target = resolveHrefTarget(raw);
  const file = target.note?.file || (raw.startsWith("#") ? currentFile : "");
  if (!file) {
    setStatus("No Emacs target for link");
    return;
  }
  await api.emacs.open({ file });
}

function canSystemOpenHref(href: string): boolean {
  const raw = cleanHref(href);
  return Boolean(raw && !raw.startsWith("#"));
}

async function systemOpenHref(href: string): Promise<void> {
  const raw = cleanHref(href);
  if (!raw || raw.startsWith("#")) return;
  await openSystemTarget(raw, currentFile).catch((err) => {
    setStatus(err instanceof Error ? err.message : `Cannot open: ${raw}`);
  });
}

async function pasteIntoEditorFromContextMenu(): Promise<boolean> {
  editor.focus();
  return editor.pasteFromClipboard();
}

type AaronContextMenuTarget = {
  x: number;
  y: number;
  href?: string;
  cell?: JupyterPanelCell | null;
};

function showContextMenu(event: MouseEvent, target: Partial<AaronContextMenuTarget> = {}): void {
  contextMenu.classList.remove("is-bibliography", "is-math");
  const selection = editor.getMarkdownSelection();
  const hasSelection = selection.from !== selection.to;
  const planningTarget = planningEditTargetFromPointer(event);
  const cell = target.cell !== undefined ? target.cell : jupyterCellFromPointer(event, false);
  const mathTarget = mathTargetFromPointer(event);
  const contextVimMode = vim.mode();
  contextMenu.classList.toggle("is-math", Boolean(mathTarget));
  const href = cleanHref(target.href || markdownHrefFromPointer(event));
  const cellDetail = cell
    ? isLeanJupyterCell(cell) ? `${cell.language} / ${cell.session}` : `${cell.language} / ${cell.kernel} / ${cell.session}`
    : "";
  const items: AaronContextMenuItem[] = [];

  if (serverReaderMode) {
    if (href) {
      const detail = hrefPath(href) || href;
      items.push(
        { label: "Open", detail, run: () => openExternalUrl(href) },
        { label: "Copy Link", detail: "clipboard", run: () => copyContextLink(href) },
      );
    } else if (hasSelection) {
      items.push({ label: "Copy Selection", detail: primaryShortcut("C"), run: () => copyEditorSelection() });
    } else {
      const block = editor.getBlockContext();
      if (block.type.includes("heading")) {
        items.push(
          { label: "Fold Heading", detail: "section", run: () => runContextEditorCommand("fold-heading") },
          { label: "Unfold Heading", detail: "section", run: () => runContextEditorCommand("unfold-heading") },
        );
      }
      if (block.type.includes("code")) {
        items.push({ label: "Copy Code", detail: "block", run: () => runContextEditorCommand("copy-code") });
      }
      items.push({ label: "Find in Note", detail: primaryShortcut("F"), run: () => openFindPanel() });
      if (serverReader.showSource) {
        items.push({ label: editor.isSourceMode() ? "Markdown View" : "Source View", detail: primaryShortcut("/"), run: () => togglePresentationOrSource() });
      }
      items.push({ label: "Copy Page Path", detail: currentFile ? fileNameFromPath(currentFile) : "", disabled: !currentFile, run: () => copyCurrentNotePath() });
    }
  } else if (planningTarget) {
    items.push({
      label: "Agenda...",
      detail: planningTarget.detail,
      disabled: currentReadOnly,
      run: () => openAgendaEditPop(planningTarget),
    });
  } else if (mathTarget) {
    const styled = managedFormulaStyle(mathTarget.tex);
    const currentLayout = mathTarget.kind === "block" ? visualTexDisplayLayout(styled.body) : "inline";
    items.push({
      label: "Open LiveTeX",
      detail: "visual editor",
      disabled: currentReadOnly,
      run: () => openContextLiveTex(mathTarget, contextVimMode),
    });
    if (mathTarget.kind === "inline") {
      items.push({
        label: "Convert to Display Math",
        detail: "equation",
        disabled: currentReadOnly,
        run: () => convertInlineMathToBlock(mathTarget),
      });
    } else {
      items.push(
        { label: "Equation", detail: currentLayout === "equation" ? "current" : "plain", disabled: currentReadOnly || currentLayout === "equation", run: () => applyFormulaLayout(mathTarget, "equation") },
        { label: "Align", detail: currentLayout === "align*" ? "current" : "unnumbered rows", disabled: currentReadOnly || currentLayout === "align*", run: () => applyFormulaLayout(mathTarget, "align*") },
        { label: "Aligned", detail: currentLayout === "aligned" ? "current" : "align at relations", disabled: currentReadOnly || currentLayout === "aligned", run: () => applyFormulaLayout(mathTarget, "aligned") },
        { label: "Gathered", detail: currentLayout === "gathered" ? "current" : "center rows", disabled: currentReadOnly || currentLayout === "gathered", run: () => applyFormulaLayout(mathTarget, "gathered") },
        { label: "Split", detail: currentLayout === "split" ? "current" : "single equation", disabled: currentReadOnly || currentLayout === "split", run: () => applyFormulaLayout(mathTarget, "split") },
        { label: "Convert to Inline Math", detail: "\\( ... \\)", disabled: currentReadOnly, run: () => convertBlockMathToInline(mathTarget) },
      );
    }
    items.push(
      { separator: true, label: "" },
      { label: "Highlight Yellow", detail: "background", disabled: currentReadOnly, run: () => applyFormulaStyle(mathTarget, { background: "yellow" }, "Formula highlighted") },
      { label: "Color Indigo", detail: "foreground", disabled: currentReadOnly, run: () => applyFormulaStyle(mathTarget, { color: "indigo" }, "Formula color applied") },
      { label: "Clear Color & Highlight", detail: "keep structure", disabled: currentReadOnly || (!styled.color && !styled.background), run: () => applyFormulaStyle(mathTarget, { color: "", background: "" }, "Formula styling cleared") },
      { label: "Formula Options...", detail: "advanced", disabled: currentReadOnly, run: () => openFormulaManager(mathTarget) },
      { label: "Copy TeX", detail: "clipboard", run: () => copyText(mathTarget.tex) },
    );
  } else if (cell) {
    items.push(
      { label: "Run Cell", detail: cellDetail, disabled: !currentFile || !jupyterExecutionAvailable, run: () => runJupyterCell(cell) },
      { label: "Edit Cell Source", detail: cell.id, disabled: !currentFile || !jupyterExecutionAvailable, run: () => openJupyterCellSource(cell) },
      { label: "Run Section", detail: cell.session, disabled: !currentFile || !jupyterExecutionAvailable, run: () => runJupyterCells("section") },
      ...(isLeanJupyterCell(cell) ? [{
        label: "Convert to Python Cell",
        detail: "Lean -> python3",
        disabled: currentReadOnly,
        run: () => exitJupyterCellFromLean(cell),
      }] : []),
      { label: "Kernel Tool", detail: "switch", disabled: isLeanJupyterCell(cell) || !jupyterExecutionAvailable, run: () => void openJupyterKernelTool(cell) },
      { label: "Delete Cell Block", detail: "source + output", danger: true, disabled: currentReadOnly || !jupyterExecutionAvailable, run: () => deleteJupyterCellBlock(cell) },
    );
  } else if (href) {
    const detail = hrefPath(href) || href;
    items.push(
      { label: "Open", detail, run: () => openExternalUrl(href) },
      { label: `Open in ${sourceEditorName()}`, detail: "target note", disabled: serverReaderMode || !canOpenHrefInEmacs(href), run: () => openHrefInEmacs(href) },
      { label: "System Open", detail: "default app", disabled: !canSystemOpenHref(href), run: () => systemOpenHref(href) },
      { label: "Copy Link", detail: "clipboard", run: () => copyContextLink(href) },
    );
  } else if (hasSelection) {
    const painterState = editor.getFormatPainterState();
    items.push(
      { label: "Copy Selection", detail: primaryShortcut("C"), run: () => copyEditorSelection() },
      {
        label: "Format Painter",
        detail: painterState ? formatPainterDetail() : "copy / apply",
        disabled: currentReadOnly,
        submenu: [
          { label: "Copy Format Once", detail: "next selection", run: () => captureFormatPainter("once") },
          { label: "Copy Format Continuously", detail: "until canceled", run: () => captureFormatPainter("continuous") },
          { separator: true, label: "" },
          { label: "Apply Copied Format", detail: painterState ? formatPainterDetail() : "inactive", disabled: !painterState, run: applyFormatPainter },
          { label: "Cancel Format Painter", detail: "Escape", disabled: !painterState, run: () => clearFormatPainter() },
        ],
      },
      { label: "Bold", detail: primaryShortcut("B"), disabled: currentReadOnly, run: () => runContextEditorCommand("bold") },
      { label: "Italic", detail: primaryShortcut("I"), disabled: currentReadOnly, run: () => runContextEditorCommand("italic") },
      { label: "Inline Code", detail: "`code`", disabled: currentReadOnly, run: () => runContextEditorCommand("code") },
      { label: "Link", detail: primaryShortcut("K"), disabled: currentReadOnly, run: () => runContextEditorCommand("link") },
      { label: "Superscript", detail: "^text^", disabled: currentReadOnly, run: () => runContextEditorCommand("superscript") },
      { label: "Subscript", detail: "~text~", disabled: currentReadOnly, run: () => runContextEditorCommand("subscript") },
      { label: "Footnote", detail: "[^1]", disabled: currentReadOnly, run: () => runContextEditorCommand("insert-footnote") },
      { label: "Revision...", detail: "@@revision", disabled: currentReadOnly, run: () => {
        updateSelectionTool();
        runSelectionCommand("revision-form");
      } },
    );
  } else {
    const block = editor.getBlockContext();
    items.push(
      { label: "Move Block Up", detail: block.type, disabled: currentReadOnly, run: () => runContextEditorCommand("move-block-up") },
      { label: "Move Block Down", detail: block.type, disabled: currentReadOnly, run: () => runContextEditorCommand("move-block-down") },
      ...(block.type.includes("heading") ? [
        { label: "Fold Heading", detail: "section", run: () => runContextEditorCommand("fold-heading") },
        { label: "Unfold Heading", detail: "section", run: () => runContextEditorCommand("unfold-heading") },
      ] : []),
      ...(block.type.includes("code") ? [
        { label: "Copy Code", detail: "block", run: () => runContextEditorCommand("copy-code") },
      ] : []),
      {
        label: "Insert…",
        detail: "quick insert",
        disabled: currentReadOnly,
        loadSubmenu: async () => editor.getQuickInsertItems("").map((item) => ({
          id: `quick-insert:${item.id}`,
          label: item.label,
          detail: item.detail,
          run: () => editor.runQuickInsert(item),
        })),
      },
      { label: "Document Properties", detail: "org-env(meta)", disabled: currentReadOnly, run: () => runContextEditorCommand("edit-properties") },
      { label: "Paste", detail: primaryShortcut("V"), disabled: currentReadOnly, run: () => pasteIntoEditorFromContextMenu() },
      { label: "Find in Note", detail: primaryShortcut("F"), run: () => openFindPanel() },
      { label: "Save", detail: currentReadOnly ? "read-only" : primaryShortcut("S"), disabled: currentReadOnly || !currentFile, run: () => save() },
      { label: headingNumberingPreference.enabled ? "Hide Heading Numbers" : "Show Heading Numbers", detail: "visual only", run: toggleHeadingNumbering },
      { label: slideDeck?.isSlides()
        ? (slideDeck.isRevealView() ? "Edit slides" : "Present slides")
        : (editor.isSourceMode() ? "Markdown View" : "Source View"), detail: primaryShortcut("/"), run: () => togglePresentationOrSource() },
      { label: "Copy Note Path", detail: currentFile ? fileNameFromPath(currentFile) : "", disabled: !currentFile, run: () => copyCurrentNotePath() },
    );
  }

  const x = target.x ?? event.clientX;
  const y = target.y ?? event.clientY;
  contextMenuController.open(items, { left: x, top: y });
}

function toggleJupyterPanel(): void {
  jupyterPanel.hidden = !jupyterPanel.hidden;
  jupyterButton.setAttribute("aria-expanded", jupyterPanel.hidden ? "false" : "true");
  if (!jupyterPanel.hidden) renderJupyterPanel();
}

function closeJupyterPanel(): void {
  jupyterPanel.hidden = true;
  jupyterButton.setAttribute("aria-expanded", "false");
}

function saveBody(changeToken: EditorSaveChangeToken | null = null, forceFull = false) {
  const incremental =
    !forceFull &&
    !forceFullEditorSave &&
    !serverMode() &&
    !currentRemote &&
    currentIncrementalSave &&
    Boolean(currentVersion) &&
    Boolean(changeToken);
  return {
    file: currentFile,
    ...(incremental ? { changes: changeToken!.payload } : { content: editor.getMarkdown() }),
    mode: editor.isSourceMode() ? "source" : "markdown",
    clientId,
    seq: ++saveSequence,
    baseMtimeMs: currentMtimeMs,
    baseVersion: currentVersion,
    refresh: "deferred",
  };
}

function incrementalEditorSaveReady(): boolean {
  return (
    !forceFullEditorSave &&
    !serverMode() &&
    !currentRemote &&
    currentIncrementalSave &&
    Boolean(currentVersion) &&
    editorSaveChanges.hasPending()
  );
}

type EditorSaveSnapshot = {
  file: string;
  revision: number;
  changeToken: EditorSaveChangeToken | null;
  body: ReturnType<typeof saveBody>;
};

function restoreEditorSaveChanges(snapshot: EditorSaveSnapshot): void {
  if (!snapshot.changeToken || snapshot.file !== currentFile) return;
  if (!editorSaveChanges.restore(snapshot.changeToken)) forceFullEditorSave = true;
}

const saveDrain = new SaveDrain<EditorSaveSnapshot, Awaited<ReturnType<typeof api.notes.save>>>({
  capture() {
    if (currentReadOnly || !currentFile || revision === savedRevision) return null;
    desktopSaveConflict = false;
    updateTitle();
    setStatus("Saving...");
    const changeToken = editorSaveChanges.capture();
    return {
      file: currentFile,
      revision,
      changeToken,
      body: saveBody(changeToken),
    };
  },
  write(snapshot) {
    return api.notes.save(snapshot.body);
  },
  apply(snapshot, result) {
    // Applying a response to a newly opened note would corrupt its dirty and
    // mtime tracking. Navigation normally awaits the drain, but retain this
    // guard for host-driven opens.
    if (snapshot.file !== currentFile) return false;
    if (result.stale) {
      restoreEditorSaveChanges(snapshot);
      setStatus("Saving newer edit...");
      return true;
    }
    if (result.conflict) {
      restoreEditorSaveChanges(snapshot);
      desktopSaveConflict = true;
      setStatus(result.message || `Save conflict; reopen from ${sourceEditorName()}`);
      return false;
    }
    if (result.ok === false) {
      restoreEditorSaveChanges(snapshot);
      setStatus(result.message || "Save rejected");
      return false;
    }
    currentMtimeMs = Number(result.mtimeMs) || currentMtimeMs;
    currentVersion = String(result.version || currentVersion);
    if (typeof result.incrementalSave === "boolean") currentIncrementalSave = result.incrementalSave;
    forceFullEditorSave = false;
    applyIndexPayload(result);
    savedRevision = Math.max(savedRevision, snapshot.revision);
    updateTitle();
    setStatus(revision === savedRevision ? "Saved" : "Saving newer edit...");
    return true;
  },
  fail(error, snapshot) {
    restoreEditorSaveChanges(snapshot);
    setStatus(error instanceof Error ? error.message : "Save failed");
  },
  active(value) {
    desktopSaveInFlight = value;
    updateTitle();
  },
});

let keepaliveSaveKey = "";

function savePendingNoteKeepalive(): void {
  if (!commitActiveLiveTexForBoundary(false)) return;
  if (!currentFile || revision === savedRevision || !noteAutoSaveEnabled(currentRemote)) return;
  const key = `${currentFile}:${revision}`;
  if (key === keepaliveSaveKey) return;
  keepaliveSaveKey = key;
  api.notes.saveKeepalive(saveBody(null, true));
}

async function save(commitLiveTex = true): Promise<void> {
  if (commitLiveTex && !commitActiveLiveTexForBoundary(true)) return;
  window.clearTimeout(saveTimer);
  if (saveIdleHandle && "cancelIdleCallback" in window) window.cancelIdleCallback(saveIdleHandle);
  saveIdleHandle = 0;
  if (currentReadOnly) {
    savedRevision = revision;
    updateTitle();
    setStatus("Read-only pane");
    return;
  }
  if (!currentFile || revision === savedRevision) return;
  await saveDrain.request();
}

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  if (saveIdleHandle && "cancelIdleCallback" in window) window.cancelIdleCallback(saveIdleHandle);
  saveIdleHandle = 0;
  if (currentReadOnly) return;
  if (!currentFile || applyingContent || revision === savedRevision) return;
  if (!noteAutoSaveEnabled(currentRemote)) {
    setStatus("Edited — save manually");
    return;
  }
  setStatus("Edited");
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    // The large-document idle gate existed to keep whole-document
    // serialization and JSON encoding away from active typing. Normal desktop
    // and Emacs saves now send only a composed CM6 ChangeSet, so delaying that
    // tiny request can make the editor appear unsaved for another 2.5 seconds
    // without reducing main-thread work. Keep the gate only for a real
    // full-source compatibility/recovery save.
    if (
      incrementalEditorSaveReady() ||
      editor.getMarkdownLength() < LARGE_DOCUMENT_CHARS ||
      !("requestIdleCallback" in window)
    ) {
      void save(false);
      return;
    }
    saveIdleHandle = window.requestIdleCallback(() => {
      saveIdleHandle = 0;
      const scheduling = navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } };
      if (scheduling.scheduling?.isInputPending?.()) {
        scheduleSave();
        return;
      }
      void save(false);
    }, { timeout: 2500 });
  }, 650);
}

let rendererReloadPending = false;
window.AaronnotePrepareRendererReload = async () => {
  if (rendererReloadPending) return false;
  rendererReloadPending = true;
  try {
    if (!currentFile && revision !== savedRevision && editor.getMarkdownLength() > 0) {
      setStatus("Renderer updated — preserve the scratch text, then reopen Noema");
      rendererReloadPending = false;
      return false;
    }
    if (!currentReadOnly && currentFile && revision !== savedRevision) {
      if (!noteAutoSaveEnabled(currentRemote)) {
        setStatus("Renderer updated — save the remote note, then reopen Noema");
        rendererReloadPending = false;
        return false;
      }
      await save();
      if (revision !== savedRevision) {
        setStatus("Renderer updated — reload deferred until the note is saved");
        rendererReloadPending = false;
        return false;
      }
    }
    await flushCursorPosition();
    setStatus("Renderer updated — reloading…");
    return true;
  } catch (error) {
    rendererReloadPending = false;
    setStatus(error instanceof Error ? error.message : "Renderer reload failed");
    return false;
  }
};

function cursorPositionKey(position: Pick<CursorPosition, "file" | "client" | "mode" | "from" | "to" | "scrollY">): string {
  return [
    position.file,
    position.client || "",
    position.mode,
    Math.max(0, Math.floor(position.from)),
    Math.max(0, Math.floor(position.to)),
    Math.max(0, Math.floor(position.scrollY)),
  ].join("|");
}

function currentCursorPosition(): CursorPosition | null {
  if (!currentFile) return null;
  const { from, to } = editor.getMarkdownSelection();
  return {
    file: currentFile,
    ...(currentClient ? { client: currentClient } : {}),
    mode: editor.isSourceMode() ? "source" : "markdown",
    from: Math.max(0, from),
    to: Math.max(0, to),
    scrollY: Math.max(0, Math.floor(host.scrollTop || 0)),
    updatedAt: Date.now(),
  };
}

function rememberCursorPosition(position: CursorPosition, positions?: CursorPosition[]): void {
  if (Array.isArray(positions)) {
    cursorPositions = positions;
    return;
  }
  const client = position.client || "";
  const index = cursorPositions.findIndex((entry) => (
    entry.file === position.file && (entry.client || "") === client
  ));
  if (index >= 0) cursorPositions[index] = position;
  else cursorPositions.unshift(position);
}

async function loadCursorPositions(): Promise<CursorPosition[]> {
  if (cursorPositionsLoaded) return cursorPositions;
  if (cursorPositionsLoadPromise) return cursorPositionsLoadPromise;
  const loading = (async (): Promise<CursorPosition[]> => {
    try {
      const result = await api.session.getPositions();
      cursorPositions = Array.isArray(result.positions) ? result.positions : [];
    } catch {
      cursorPositions = [];
    } finally {
      cursorPositionsLoaded = true;
    }
    return cursorPositions;
  })();
  cursorPositionsLoadPromise = loading;
  try {
    return await loading;
  } finally {
    if (cursorPositionsLoadPromise === loading) cursorPositionsLoadPromise = null;
  }
}

function rememberedCursorPosition(file: string, positions = cursorPositions): CursorPosition | undefined {
  if (currentClient) {
    const scoped = positions.find((position) => (
      position.file === file && position.client === currentClient
    ));
    if (scoped) return scoped;
  }
  // The unscoped slot is a backwards-compatible "last used" fallback for a
  // newly-created pane/window that does not have its own cursor history yet.
  return positions.find((position) => position.file === file && !position.client)
    ?? positions.find((position) => position.file === file);
}

function trackCursorPosition(): CursorPosition | null {
  const position = currentCursorPosition();
  if (!position) return null;
  const key = cursorPositionKey(position);
  if (key !== lastTrackedCursorPositionKey) {
    lastTrackedCursorPositionKey = key;
    rememberCursorPosition(position);
  }
  return position;
}

async function persistCursorPosition(position: CursorPosition): Promise<void> {
  const key = cursorPositionKey(position);
  if (key === lastSavedCursorPositionKey) return;
  // Queue the captured position itself. Re-reading currentCursorPosition()
  // after an in-flight request completes can observe a different note and
  // silently drop the cursor belonging to the note we just left.
  const snapshot = { ...position };
  const flush = cursorPositionFlushTail.then(async () => {
    if (key === lastSavedCursorPositionKey) return;
    try {
      const result = await api.session.savePosition(snapshot);
      rememberCursorPosition(snapshot, result.positions);
      lastSavedCursorPositionKey = key;
    } catch {
      // Cursor position memory is best-effort and should never block editing.
    }
  });
  cursorPositionFlushTail = flush;
  await flush;
}

function noteCursorPositionEvent(): void {
  trackCursorPosition();
}

function pushNavigationBackLocation(location = trackCursorPosition()): void {
  if (!location || restoringNavigationBack || restoringNavigationForward) return;
  navigationForwardStack = [];
  pushNavigationLocation(navigationBackStack, location);
  try {
    window.history.pushState({ aaronnoteNavigation: true }, "", window.location.href);
  } catch {
    // Browser history is an optional convenience; the in-memory stack remains valid.
  }
}

function pushNavigationLocation(stack: CursorPosition[], location: CursorPosition): void {
  const key = cursorPositionKey(location);
  const top = stack[stack.length - 1];
  if (top && cursorPositionKey(top) === key) return;
  stack.push({ ...location, updatedAt: Date.now() });
  if (stack.length > NAVIGATION_BACK_STACK_MAX) {
    stack.splice(0, stack.length - NAVIGATION_BACK_STACK_MAX);
  }
}

function restoreCursorPosition(location: CursorPosition): void {
  const length = editor.getMarkdownLength();
  const from = Math.min(Math.max(0, location.from), length);
  const to = Math.min(Math.max(0, location.to), length);
  if ((!serverReaderMode || serverReader.showSource)
      && !slideDeck?.isSlides() && (location.mode === "source") !== editor.isSourceMode()) editor.toggleSource();
  sourceButton.classList.toggle("is-active", editor.isSourceMode());
  editor.setMarkdownSelection(from, to);
  if (!passiveServerReader) {
    editor.revealCursor();
    editor.focus();
  }
  trackCursorPosition();
  scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true, toc: true, selectionTool: true });
}

async function restoreNavigationBack(): Promise<boolean> {
  const location = navigationBackStack.pop();
  if (!location) return false;
  const current = trackCursorPosition();
  if (current) pushNavigationLocation(navigationForwardStack, current);
  restoringNavigationBack = true;
  try {
    if (location.file !== currentFile) await openFile(location.file);
    restoreCursorPosition(location);
    return true;
  } finally {
    restoringNavigationBack = false;
  }
}

async function restoreNavigationForward(): Promise<boolean> {
  const location = navigationForwardStack.pop();
  if (!location) return false;
  const current = trackCursorPosition();
  if (current) pushNavigationLocation(navigationBackStack, current);
  restoringNavigationForward = true;
  try {
    if (location.file !== currentFile) await openFile(location.file);
    restoreCursorPosition(location);
    return true;
  } finally {
    restoringNavigationForward = false;
  }
}

async function flushCursorPosition(): Promise<void> {
  const position = trackCursorPosition();
  if (position) await persistCursorPosition(position);
}

function flushCursorPositionKeepalive(): void {
  const position = trackCursorPosition();
  if (!position) return;
  rememberCursorPosition(position);
  api.session.savePositionKeepalive(position);
}

function notifyClientClosedKeepalive(): void {
  if (clientCloseNotified) return;
  clientCloseNotified = true;
  api.session.closeClientKeepalive({
    client: currentClient,
    clientId,
    file: currentFile,
  });
}

function applyOpenedNote(
  opened: Awaited<ReturnType<typeof api.notes.bootstrap>>,
  fallbackFile?: string,
  rememberedPositions: CursorPosition[] = cursorPositions,
  options: ApplyOpenedNoteOptions = {},
): void {
  const previousFile = currentFile;
  const revealCursor = options.revealCursor !== false && !passiveServerReader;
  const focusEditor = options.focusEditor !== false && !passiveServerReader;
  const updateStatus = options.updateStatus !== false;
  const resetVim = options.resetVim !== false;
  const reloadNoteIndex = options.reloadNotes !== false;
  currentFile = String(opened.file || fallbackFile || "");
  // The same file can be reopened with its document revision reset to zero.
  // Let that new editing session emit its own pagehide keepalive.
  keepaliveSaveKey = "";
  currentTitle = String(opened.title || "").trim();
  currentKind = String(opened.kind || "");
  currentStandalone = Boolean(opened.standalone);
  currentIncrementalSave = opened.incrementalSave === true;
  currentRemote = Boolean(opened.remote);
  currentReadOnly = initialReadOnly;
  applyReadOnlyUi();
  applyIndexPayload(opened);
  if (Array.isArray(opened.snippets)) snippets = withBuiltinSnippets(opened.snippets);
  currentMtimeMs = Number(opened.mtimeMs) || 0;
  currentVersion = String(opened.version || "");
  const hasPendingOpenTarget = Boolean(pendingOpenHash || pendingOpenDomTarget || pendingTodoTarget);
  const remembered = !opened.selection && !pendingOpenHash && !pendingOpenDomTarget && !pendingTodoTarget
    ? rememberedCursorPosition(currentFile, rememberedPositions)
    : undefined;
  applyingContent = true;
  editor.setMarkdown(String(opened.content || ""), {
    history: "reset",
    preserveView: options.preserveView === true,
  });
  syncFormatPainterUi();
  revision = 0;
  savedRevision = 0;
  desktopSaveConflict = false;
  // Cursor memory restores position, not the transient Source/Markdown tool
  // view. A regular note open should use the file's natural mode (Markdown
  // for notes), otherwise leaving a note in Source makes every later open of
  // that note feel permanently stuck there. Explicit reload preservation and
  // back/forward navigation still restore their view modes separately.
  const mode = options.preserveView
    ? (editor.isSourceMode() ? "source" : "markdown")
    : opened.mode;
  if ((!serverReaderMode || serverReader.showSource)
      && String(currentKind || "").trim().toLowerCase() !== "slides"
      && (mode === "source") !== editor.isSourceMode()) editor.toggleSource();
  sourceButton.classList.toggle("is-active", editor.isSourceMode());
  slideDeck?.sync(currentKind);
  renderModeToggleLabel(vim.mode());
  // During reload, the server selection belongs to the original open/jump
  // request and must not replace the cursor of this already-open editor.
  const from = Number(opened.selection?.from ?? remembered?.from);
  const to = Number(opened.selection?.to ?? remembered?.to ?? from);
  let shouldRevealCursor = false;
  if (!options.preserveView && Number.isFinite(from) && !passiveServerReader) {
    const length = editor.getMarkdownLength();
    const safeFrom = Math.min(Math.max(0, from), length);
    const safeTo = Math.min(Math.max(0, Number.isFinite(to) ? to : from), length);
    editor.setMarkdownSelection(safeFrom, safeTo, { scrollIntoView: false });
    if (revealCursor) {
      shouldRevealCursor = true;
      editor.revealCursor();
    }
  }
  applyingContent = false;
  if (currentFile !== previousFile) copilotFileChangeHandlers.forEach((handler) => handler());
  scheduleWritingStats(true);
  if (currentReadOnly) {
    revision = savedRevision;
    setProseDiagnostics(editor.view, []);
  }
  const restored = currentCursorPosition();
  lastSavedCursorPositionKey = restored ? cursorPositionKey(restored) : "";
  lastTrackedCursorPositionKey = lastSavedCursorPositionKey;
  if (restored) rememberCursorPosition(restored);
  snippetSession.clear();
  transientSurfaces.close(["snippet-popup", "math-preview", "prose-popover", "context-menu"], "document-change");
  proseLifecycle.invalidate("note-changed");
  setProseDiagnostics(editor.view, []);
  selectionTool.hidden = true;
  selectionMore.hidden = true;
  if (resetVim) vim.setMode("insert");
  updateTitle();
  void api.emacs.currentFile(currentFile, currentClient);
  if (updateStatus) {
    setStatus(
      currentReadOnly
        ? "Read-only"
        : currentFile
          ? currentRemote ? "Ready — manual save" : "Ready"
          : "Scratch",
    );
  }
  if (focusEditor) editor.focus();
  scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true, toc: true });
  scheduleBibliographyRefresh(true);
  if (!currentReadOnly) scheduleAutomaticProseCheck(2200);
  if (shouldRevealCursor && !options.preserveView && !hasPendingOpenTarget) {
    revealCursorAfterLayout();
  }
  const targetHash = pendingOpenHash;
  const targetDom = pendingOpenDomTarget;
  const targetTodo = pendingTodoTarget;
  pendingOpenHash = "";
  pendingOpenDomTarget = "";
  pendingTodoTarget = null;
  if (targetHash || targetDom || targetTodo) {
    window.requestAnimationFrame(() => {
      if (targetTodo && jumpToTodoTarget(targetTodo)) return;
      if (targetDom && jumpToDomTarget(targetDom)) return;
      if (targetHash && jumpToHash(targetHash)) return;
      if (targetTodo) { setStatus("Todo location not found"); return; }
      setStatus(targetDom ? `DOM target not found: ${targetDom}` : `Anchor not found: ${targetHash}`);
    });
  }
  window.dispatchEvent(new CustomEvent("aaronnote:note-opened", {
    detail: { file: currentFile, title: currentTitle },
  }));
  if (reloadNoteIndex && openedNoteNeedsIndexReload(opened, notesIndexLoaded)) scheduleInitialNoteIndexReload();
  if (!Array.isArray(opened.snippets) && snippets.length === 0) void reloadSnippets(true);
}

async function openFile(
  file?: string,
  bootstrap = false,
  beforeApply?: Promise<unknown>,
): Promise<void> {
  const target = file || undefined;
  try {
    if (!commitActiveLiveTexForBoundary(false)) return;
    if (currentFile) await flushCursorPosition();
    if (currentFile && revision !== savedRevision) {
      if (!noteAutoSaveEnabled(currentRemote)) {
        setStatus("Remote note has unsaved changes; save before switching");
        return;
      }
      await save();
      if (revision !== savedRevision) return;
    }
    const openPromise = target && !bootstrap
      ? api.notes.open(target)
      : api.notes.bootstrap(target);
    const [opened, positions] = await Promise.all([openPromise, loadCursorPositions()]);
    // Initial bootstrap may fetch the document while renderer prerequisites
    // load.  Gate only installation so I/O overlaps without a KaTeX/theme
    // first-paint flash.
    if (beforeApply) await beforeApply;
    applyOpenedNote(opened, target, positions);
  } catch (error) {
    applyingContent = false;
    setStatus(error instanceof Error ? error.message : "Open failed");
  }
}

async function reloadCurrentFilePreservingCursor(options: {
  silent?: boolean;
  preserveView?: boolean;
} = {}): Promise<void> {
  if (!currentFile) return;
  if (!commitActiveLiveTexForBoundary(false)) return;
  const position = trackCursorPosition();
  if (position) rememberCursorPosition(position);
  if (!currentReadOnly && revision !== savedRevision) {
    if (!noteAutoSaveEnabled(currentRemote)) {
      setStatus("Remote note has unsaved changes; save before refreshing");
      return;
    }
    await save();
    if (revision !== savedRevision) return;
  }
  if (!options.silent) setStatus("Refreshing...");
  try {
    const opened = await api.notes.open(currentFile);
    applyOpenedNote(
      opened,
      currentFile,
      position ? [position, ...cursorPositions] : cursorPositions,
      options.silent
        ? {
            revealCursor: false,
            focusEditor: false,
            updateStatus: false,
            resetVim: false,
            reloadNotes: false,
            preserveView: options.preserveView,
          }
        : { preserveView: options.preserveView },
    );
    if (pendingExternalSave?.file === currentFile) pendingExternalSave = null;
    if (!options.silent) setStatus(currentReadOnly ? "Read-only refreshed" : "Refreshed");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Refresh failed");
  }
}

async function reconcileCurrentFileAfterCoreReconnect(): Promise<void> {
  if (!currentFile || pendingExternalSaveRefreshInFlight) return;
  if (pendingExternalSave?.file === currentFile) {
    await refreshPendingExternalSaveOnFocus();
    return;
  }
  // Never overwrite a genuine local draft merely because the event stream
  // was interrupted. Its next save will use the normal mtime conflict guard.
  if (revision !== savedRevision) return;
  await reloadCurrentFilePreservingCursor({ silent: true, preserveView: true });
}

async function refreshPendingExternalSaveOnFocus(): Promise<void> {
  const pending = pendingExternalSave;
  if (!pending || pendingExternalSaveRefreshInFlight) return;
  if (!currentFile || pending.file !== currentFile) {
    pendingExternalSave = null;
    return;
  }
  if (revision !== savedRevision) {
    setStatus("Changed in another pane; refresh before saving");
    return;
  }
  pendingExternalSaveRefreshInFlight = true;
  try {
    if (pending.mtimeMs) currentMtimeMs = pending.mtimeMs;
    await reloadCurrentFilePreservingCursor({ silent: true, preserveView: true });
    if (pendingExternalSave === pending) pendingExternalSave = null;
  } finally {
    pendingExternalSaveRefreshInFlight = false;
  }
}

async function openInitialFile(beforeApply?: Promise<unknown>): Promise<void> {
  const file = initialParams.get("file") || undefined;
  currentClient = initialParams.get("client") || "";
  pendingOpenHash = initialParams.get("hash") || "";
  pendingOpenDomTarget = initialParams.get("dom") || "";
  currentReadOnly = initialReadOnly;
  applyReadOnlyUi();
  await openFile(file, true, beforeApply);
}

let copilotTexContextCache: {
  doc: object;
  position: number;
  range: { from: number; to: number } | null;
} | null = null;

function copilotTexSourceRange(): { from: number; to: number } | null {
  const doc = editor.view.state.doc;
  const position = editor.getMarkdownSelection().to;
  if (copilotTexContextCache?.doc === doc && copilotTexContextCache.position === position) {
    return copilotTexContextCache.range;
  }
  const formula = formulaRangeAtWidgetPosition(editor.view.state, position);
  const revealed = formulaSourceRangeAtPosition(editor.view, position);
  const range = formula && position >= formula.contentFrom && position <= formula.contentTo
    ? { from: formula.contentFrom, to: formula.contentTo }
    : revealed;
  copilotTexContextCache = { doc, position, range };
  return range;
}

function isCopilotTexContext(): boolean {
  return Boolean(copilotTexSourceRange());
}

setupCopilot({
  editor,
  host,
  currentFile: () => currentFile,
  clientId: () => clientId,
  vimMode: () => vim.mode(),
  setStatus,
  onChange: (handler) => {
    changeHandlers.add(handler);
    return () => changeHandlers.delete(handler);
  },
  onSelectionChange: (handler) => {
    selectionChangeHandlers.add(handler);
    return () => selectionChangeHandlers.delete(handler);
  },
  onVimModeChange: (handler) => {
    vimModeChangeHandlers.add(handler);
    return () => vimModeChangeHandlers.delete(handler);
  },
  onActiveChange: (handler) => {
    copilotActiveChangeHandlers.add(handler);
    return () => copilotActiveChangeHandlers.delete(handler);
  },
  onFileChange: (handler) => {
    copilotFileChangeHandlers.add(handler);
    return () => copilotFileChangeHandlers.delete(handler);
  },
  onKeyDown: (handler) => {
    const listener = (event: KeyboardEvent) => {
      if (handler(event)) event.stopImmediatePropagation();
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  },
  onAction: () => () => {},
  onSettingsChange: () => () => {},
  getSettings: () => ({ idleDelayMs: 850, largeBufferThresholdKb: 512 }),
  isActive: () => !serverReaderMode
    && !paused
    && rendererActivityState !== "quiescent"
    && rendererActivityState !== "hidden"
    && rendererActivityState !== "destroyed"
    && !visualMathEditorActive
    && editorSurfaceVisible(),
  isCursorInTexSource: isCopilotTexContext,
  texSourceRangeAtCursor: copilotTexSourceRange,
  onDocumentEvent: subscribe,
  preserveScroll: (update) => editor.preserveViewport(update),
  jumpSnippetNext: jumpSnippetTabstop,
  jumpSnippetPrevious: jumpSnippetTabstopBack,
  forwardDelimiter: () => jumpTexUnit(editor.view, 1) || jumpStructuralDelimiter(editor.view, 1),
  backwardDelimiter: () => jumpTexUnit(editor.view, -1) || jumpStructuralDelimiter(editor.view, -1),
});

function toggleSourceMode(): void {
  if (serverReaderMode && !serverReader.showSource) return;
  // Source is an explicit pencil-tool action.  When invoked from Reveal, first
  // return to the ordinary note so the raw source is immediately visible.
  if (slideDeck?.isRevealView()) slideDeck.toggleView();
  editor.toggleSource();
  sourceButton.classList.toggle("is-active", editor.isSourceMode());
  slideDeck?.refresh();
  renderModeToggleLabel(vim.mode());
  editor.focus();
  scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
}

function togglePresentationOrSource(): void {
  if (!slideDeck?.isSlides()) {
    toggleSourceMode();
    return;
  }
  // Cmd-/ always comes back to WYSIWYG, even if Source was used earlier.
  if (slideDeck.isRevealView() && editor.isSourceMode()) editor.toggleSource();
  slideDeck.toggleView();
  if (slideDeck.isRevealView()) {
    closeToolsPanel();
    closeRoamToolsPanel();
    closeJupyterPanel();
  }
  renderModeToggleLabel(vim.mode());
  sourceButton.classList.toggle("is-active", editor.isSourceMode());
}

function isEditorCommand(command: string): command is EditorCommand {
  return editorCommands.has(command as EditorCommand);
}

function primaryMod(event: KeyboardEvent): boolean {
  return primaryModifierDown(event, desktopPlatform);
}

type ProseCheckInput = {
  automatic: boolean;
  file: string;
  revision: number;
  settings: LanguageToolSettings;
};

type ProseCheckApiResult = Awaited<ReturnType<typeof api.proseCheck.run>>;

type ProseCheckRunResult = {
  input: ProseCheckInput;
  response?: ProseCheckApiResult;
  elapsedMs: number;
  empty?: boolean;
  deferred?: boolean;
};

const proseRetryRequests = new Set<number>();
let proseBusyRequestId = 0;
let proseManualStageTimer = 0;
let proseRetryTimer = 0;

function proseProfile() {
  return PROSE_PROFILES[languageToolSettings.performanceProfile] ?? PROSE_PROFILES.balanced;
}

function proseCheckSegments(automatic = false): Array<{ from: number; text: string }> {
  const doc = editor.view.state.doc;
  const selection = editor.getMarkdownSelection();
  const profile = proseProfile();
  const padding = automatic ? profile.padding : PROSE_SCOPE_PADDING;
  const maxChars = automatic ? profile.maxChars : PROSE_SCOPE_MAX_CHARS;
  const rawRanges = !automatic && selection.from !== selection.to
    ? [{ from: selection.from, to: selection.to }]
    : editor.view.visibleRanges.map((range) => ({
      from: Math.max(0, range.from - padding),
      to: Math.min(doc.length, range.to + padding),
    }));
  const ranges = rawRanges
    .map((range) => ({
      from: doc.lineAt(Math.max(0, Math.min(range.from, doc.length))).from,
      to: doc.lineAt(Math.max(0, Math.min(range.to, doc.length))).to,
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to + 1) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  const segments: Array<{ from: number; text: string }> = [];
  let remaining = maxChars;
  for (const range of merged) {
    if (remaining <= 0) break;
    const to = Math.min(range.to, range.from + remaining);
    const text = editor.markdownBetween(range.from, to);
    if (text) segments.push({ from: range.from, text });
    remaining -= text.length;
  }
  return segments;
}

function hideProsePopover(): void {
  prosePopover.hidden = true;
  prosePopover.replaceChildren();
  activeProseDiagnostic = null;
}

function proseCheckInput(automatic: boolean): ProseCheckInput {
  return {
    automatic,
    file: currentFile,
    revision,
    settings: { ...languageToolSettings },
  };
}

function proseAutoSignature(): string {
  const ranges = editor.view.visibleRanges.map((range) => `${range.from}:${range.to}`).join(",");
  return [
    currentFile,
    revision,
    editor.getMarkdownLength(),
    languageToolSettings.performanceProfile,
    languageToolSettings.language,
    languageToolSettings.level,
    ranges,
  ].join("|");
}

function clearProseManualStageTimer(): void {
  if (!proseManualStageTimer) return;
  window.clearTimeout(proseManualStageTimer);
  proseManualStageTimer = 0;
}

function clearProseRetryTimer(): void {
  if (!proseRetryTimer) return;
  window.clearTimeout(proseRetryTimer);
  proseRetryTimer = 0;
}

function scheduleProseRetry(): void {
  clearProseRetryTimer();
  const delayMs = Math.max(0, proseAutoSuspendedUntil - Date.now());
  proseRetryTimer = window.setTimeout(() => {
    proseRetryTimer = 0;
    scheduleAutomaticProseCheck(0);
  }, delayMs);
}

function setProseBusy(busy: boolean, requestId = 0): void {
  if (busy) {
    proseBusyRequestId = requestId;
    statusLabel.setAttribute("aria-busy", "true");
    statusLabel.dataset.proseState = "checking";
    return;
  }
  if (requestId && requestId !== proseBusyRequestId) return;
  proseBusyRequestId = 0;
  statusLabel.removeAttribute("aria-busy");
  delete statusLabel.dataset.proseState;
  clearProseManualStageTimer();
}

function proseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Prose check failed";
}

async function executeProseCheck(
  input: ProseCheckInput,
  context: ProseCheckContext,
): Promise<ProseCheckRunResult> {
  if (input.file !== currentFile || input.revision !== revision) {
    return { input, elapsedMs: 0, deferred: true };
  }
  if (context.kind === "auto" && Date.now() < proseAutoSuspendedUntil) {
    return { input, elapsedMs: 0, deferred: true };
  }
  const segments = proseCheckSegments(input.automatic);
  if (segments.length === 0) return { input, elapsedMs: 0, empty: true };
  const startedAt = performance.now();
  const response = await api.proseCheck.run({
    requestId: `${clientId}:prose:${context.id}`,
    file: input.file,
    segments,
    totalChars: editor.getMarkdownLength(),
    allowLocalFallback: !input.automatic && input.settings.manualLocalFallback,
    interactive: !input.automatic,
  });
  return { input, response, elapsedMs: Math.max(0, performance.now() - startedAt) };
}

function observeProseCheck(result: ProseCheckRunResult, context: ProseCheckContext): void {
  if (context.kind !== "auto" || !result.response) return;
  const failures = (result.response.tools ?? []).filter((tool) => tool.ok === false && !tool.optional);
  if (failures.length > 0) {
    proseAutoSuspendedUntil = Date.now() + languageToolSettings.retryCooldownMs;
    proseRetryRequests.add(context.id);
    languageToolHealth = failures.map((tool) => tool.message || "NAS unavailable").join("; ");
    return;
  }
  proseAutoSuspendedUntil = 0;
  clearProseRetryTimer();
  languageToolHealth = `Online · ${Math.round(result.elapsedMs)} ms`;
}

function applyProseCheck(result: ProseCheckRunResult, context: ProseCheckContext): boolean {
  if (result.deferred) return false;
  if (result.input.file !== currentFile || result.input.revision !== revision) return false;
  if (result.empty) {
    if (context.kind === "manual" && context.id === proseBusyRequestId) {
      setProseDiagnostics(editor.view, []);
      setStatus("Nothing to check");
    }
    return true;
  }
  const response = result.response!;
  const tools = response.tools ?? [];
  const failures = tools.filter((tool) => tool.ok === false && !tool.optional);
  const usedLocalCli = tools.some((tool) => tool.message?.includes("used local CLI"));
  if (context.kind === "auto" && failures.length > 0) return false;
  if (context.kind === "manual") {
    if (failures.length === 0 && !usedLocalCli) {
      proseAutoSuspendedUntil = 0;
      clearProseRetryTimer();
      languageToolHealth = `Online · ${Math.round(result.elapsedMs)} ms`;
    } else if (usedLocalCli) {
      proseAutoSuspendedUntil = Date.now() + languageToolSettings.retryCooldownMs;
      scheduleProseRetry();
      languageToolHealth = "NAS offline · local CLI used manually";
    } else {
      proseAutoSuspendedUntil = Date.now() + languageToolSettings.retryCooldownMs;
      scheduleProseRetry();
      languageToolHealth = failures.map((tool) => tool.message || "LanguageTool failed").join("; ");
    }
  }
  const diagnostics = (response.diagnostics ?? []) as ProseDiagnostic[];
  setProseDiagnostics(editor.view, diagnostics);
  if (context.kind === "manual" && context.id === proseBusyRequestId) {
    const partial = response.scope?.partial ? " (bounded scope)" : "";
    const localFallback = usedLocalCli ? " (local CLI)" : "";
    setStatus(failures.length > 0
      ? failures.map((tool) => tool.message || `${tool.source} failed`).join("; ")
      : `${diagnostics.length} prose issue${diagnostics.length === 1 ? "" : "s"}${partial}${localFallback}`);
  }
  return true;
}

function onProseCheckState(state: ProseCheckState): void {
  if (state.kind !== "manual" || state.phase === "terminal") return;
  setProseBusy(true, state.id);
  setOwnedProseStatus(state.id, state.phase === "scheduled" ? "Prose check queued..." : "Checking prose on NAS...");
  clearProseManualStageTimer();
  if (state.phase === "running" && languageToolSettings.manualLocalFallback) {
    proseManualStageTimer = window.setTimeout(() => {
      if (proseBusyRequestId === state.id) setOwnedProseStatus(state.id, "Checking prose with local CLI...");
    }, languageToolSettings.remoteTimeoutMs + 150);
  }
}

function onProseCheckFinally(outcome: ProseCheckOutcome): void {
  if (outcome.kind === "auto") {
    if (outcome.terminal === "failed" || outcome.terminal === "timeout") {
      proseAutoSuspendedUntil = Date.now() + languageToolSettings.retryCooldownMs;
      proseRetryRequests.add(outcome.id);
      languageToolHealth = outcome.terminal === "timeout"
        ? "NAS check timed out"
        : proseErrorMessage(outcome.error);
    }
    if (proseRetryRequests.delete(outcome.id)) {
      scheduleProseRetry();
    }
    return;
  }
  const ownsBusyStatus = outcome.id === proseBusyRequestId;
  const ownsStatusText = statusLabel.dataset.proseOwner === String(outcome.id);
  setProseBusy(false, outcome.id);
  if (!ownsBusyStatus || !ownsStatusText) return;
  if (outcome.terminal === "failed") setStatus(proseErrorMessage(outcome.error));
  else if (outcome.terminal === "timeout") setStatus("Prose check timed out");
  else if (outcome.terminal === "stale" || outcome.terminal === "not-applied") setStatus("Prose check superseded");
  else if (outcome.terminal === "cancelled") {
    const message = outcome.reason === "document-edited"
      ? "Prose check canceled after edit"
      : outcome.reason === "page-hidden"
        ? "Prose check paused"
        : outcome.reason === "settings-changed"
          ? "Prose check canceled after settings change"
          : "Prose check canceled";
    setStatus(message);
  }
}

const proseLifecycle = new ProseCheckLifecycle<ProseCheckInput, ProseCheckRunResult>({
  autoDebounceMs: PROSE_PROFILES.balanced.idleMs,
  deadlineMs: (input, kind) => input.settings.remoteTimeoutMs
    + (kind === "manual" && input.settings.manualLocalFallback ? LANGUAGETOOL_LOCAL_DEADLINE_ALLOWANCE_MS : 2_000),
  run: executeProseCheck,
  observe: observeProseCheck,
  apply: applyProseCheck,
  onState: onProseCheckState,
  onFinally: onProseCheckFinally,
  onCancel: ({ context }) => api.proseCheck.cancelKeepalive(`${clientId}:prose:${context.id}`),
});

// All renderer activity-sensitive systems share this one state transition.
// The host adapters only send pause/resume facts; they never maintain a
// second implementation of editor quiescence or background scheduling.
const rendererActivity = createRendererActivityGate([
  { setPaused: setMeasuredWidgetObservationPaused },
  { setPaused: setViewportDecorationRefreshPaused },
  imageAnimationActivityParticipant(editor.view.contentDOM),
  focusQuiescence,
  assistScheduler,
  proseLifecycle,
  writingStatsController!,
  mathSnippetIndex,
  localGraphPanel,
  graphOverlayActivity,
], {
  activityTarget: document,
  autoStart: true,
  onStateChange: (state) => {
    rendererActivityState = state;
    document.documentElement.classList.toggle("aaronnote-quiescent", state === "quiescent");
    // Copilot's transport lifecycle is still the same renderer path: it only
    // sees the shared activity fact and never owns a host-specific idle timer.
    copilotActiveChangeHandlers.forEach((handler) => handler());
  },
});
// A newly mounted editor starts active even before the first browser event.
rendererActivity.notifyActivity();

function scheduleAutomaticProseCheck(delayMs: number = proseProfile().idleMs): void {
  if (!languageToolSettings.automaticEnabled || currentReadOnly || !currentFile
      || paused || document.hidden || !editorSurfaceVisible()) return;
  const cooldownMs = Math.max(0, proseAutoSuspendedUntil - Date.now());
  proseLifecycle.scheduleAuto(proseCheckInput(true), proseAutoSignature(), Math.max(delayMs, cooldownMs));
}

function runProseCheck(automatic = false): void {
  if (automatic) {
    scheduleAutomaticProseCheck(0);
    return;
  }
  hideProsePopover();
  void proseLifecycle.runManual(proseCheckInput(false));
}

function runProseCheckShortcut(event: KeyboardEvent): boolean {
  if (!matchHotKey("Primary+Shift+C", event, { platform: desktopPlatform })) return false;
  event.preventDefault();
  void runProseCheck(false);
  return true;
}

function removeProseDiagnostics(predicate: (diagnostic: ProseDiagnostic) => boolean): void {
  setProseDiagnostics(editor.view, allProseDiagnostics(editor.view).filter((diagnostic) => !predicate(diagnostic)));
  hideProsePopover();
}

function showProsePopover(diagnostic: ProseDiagnostic, x: number, y: number): void {
  activeProseDiagnostic = diagnostic;
  const message = document.createElement("div");
  message.className = "aaronnote-prose-message";
  message.textContent = `${diagnostic.source}: ${diagnostic.message}`;
  prosePopover.replaceChildren(message);
  for (const suggestion of (diagnostic.suggestions ?? []).slice(0, 8)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.proseAction = "replace";
    button.dataset.value = suggestion;
    button.textContent = suggestion || "Remove";
    prosePopover.append(button);
  }
  const ignore = document.createElement("button");
  ignore.type = "button";
  ignore.dataset.proseAction = "ignore";
  ignore.textContent = "Ignore";
  prosePopover.append(ignore);
  if (diagnostic.word) {
    const accept = document.createElement("button");
    accept.type = "button";
    accept.dataset.proseAction = "accept";
    accept.textContent = `Add “${diagnostic.word}”`;
    prosePopover.append(accept);
  }
  prosePopover.style.left = `${Math.max(8, Math.min(window.innerWidth - 320, x))}px`;
  prosePopover.style.top = `${Math.max(8, Math.min(window.innerHeight - 160, y + 8))}px`;
  prosePopover.hidden = false;
}

function plainEscapeKey(event: KeyboardEvent): boolean {
  return event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing;
}

function runFormattingShortcut(event: KeyboardEvent): boolean {
  if (!primaryMod(event) || event.altKey || event.isComposing) return false;
  const key = event.key.toLowerCase();
  const command: EditorCommand | "" = event.shiftKey && key === "x" ? "strike"
    : !event.shiftKey && key === "b" ? "bold"
    : !event.shiftKey && key === "i" ? "italic"
    : !event.shiftKey && key === "k" ? "link"
    : "";
  if (!command) return false;
  event.preventDefault();
  if (rejectReadOnlyAction("Read-only pane")) return true;
  editor.runCommand(command);
  editor.focus();
  return true;
}

function runSourceToggleShortcut(event: KeyboardEvent): boolean {
  if (serverReaderMode && !serverReader.showSource) return false;
  if (!primaryMod(event) || event.shiftKey || event.altKey || event.isComposing) return false;
  if (event.key !== "/" && event.code !== "Slash") return false;
  event.preventDefault();
  if (!liveTexStudio.hidden) {
    revealLiveTexStudioSource();
    scheduleAssistUpdate({ mathPreview: true, cursor: true });
    return true;
  }
  const selection = editor.view.state.selection.main;
  const formula = mathTargetAtPosition(selection.head);
  if (!slideDeck?.isRevealView()
    && formula
    && selection.anchor >= formula.from
    && selection.anchor <= formula.to
    && selection.head >= formula.from
    && selection.head <= formula.to
    && openContextLiveTex(formula)) {
    scheduleAssistUpdate({ mathPreview: true, cursor: true });
    return true;
  }
  if (!commitActiveLiveTexForBoundary(true)) return true;
  togglePresentationOrSource();
  return true;
}

function fileNameFromPath(path: string): string {
  return String(path || "").split(/[\\/]/).filter(Boolean).at(-1) || path || "";
}

function decodeNoteRef(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

function encodeMarkdownHrefPath(path: string): string {
  return String(path || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => encodeURIComponent(decodeNoteRef(part)))
    .join("/");
}

function applyIndexPayload(payload: { notes?: NoteSummary[]; note?: NoteSummary; kind?: string; standalone?: boolean; indexVersion?: number; relationshipSource?: string }): void {
  const indexChanged = payloadUpdatesNoteIndex(payload);
  const presentationChanged = typeof payload.kind === "string";
  if (typeof payload.indexVersion === "number" && payload.indexVersion > lastNotesIndexVersion) {
    lastNotesIndexVersion = payload.indexVersion;
  }
  if (Array.isArray(payload.notes)) {
    notes = payload.notes;
    notesIndexLoaded = true;
  }
  else if (payload.note?.file) {
    const index = notes.findIndex((note) => note.file === payload.note?.file);
    if (index >= 0) notes = notes.map((note, i) => i === index ? payload.note! : note);
    else notes = [...notes, payload.note];
  }
  if (presentationChanged) currentKind = payload.kind!;
  if (typeof payload.standalone === "boolean") currentStandalone = payload.standalone;
  if (typeof payload.relationshipSource === "string") currentRelationshipSource = payload.relationshipSource;
  if (indexChanged) {
    pathSuggestions = [...new Set(notes
      .flatMap((note) => [note.path, note.file, note.link])
      .map((value) => String(value || "").trim())
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    scheduleAssistUpdate({ toc: true });
    localGraphPanel.invalidate();
    desktopKnowledgeDock?.refresh();
    void refreshAgendaView();
  }
  if (presentationChanged) {
    slideDeck?.sync(currentKind);
    renderModeToggleLabel(vim.mode());
  }
}

async function reloadNotes(force = false): Promise<void> {
  try {
    const msg = await api.notes.list(force);
    applyIndexPayload(msg);
    void loadPathSuggestions();
  } catch (error) {
    if (force) setStatus(error instanceof Error ? error.message : "Note index failed");
  }
}

function scheduleInitialNoteIndexReload(): void {
  if (initialNotesIdleHandle || notesIndexLoaded) return;
  const run = (deadline?: IdleDeadline) => {
    initialNotesIdleHandle = 0;
    if (notesIndexLoaded) return;
    const scheduling = navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } };
    if (!deadline?.didTimeout && scheduling.scheduling?.isInputPending?.()) {
      scheduleInitialNoteIndexReload();
      return;
    }
    void reloadNotes(false);
  };
  if ("requestIdleCallback" in window) {
    initialNotesIdleHandle = window.requestIdleCallback(run, { timeout: 1500 });
  } else {
    initialNotesIdleHandle = window.setTimeout(() => run(), 0);
  }
}

function obsidianTaskFailure(task: import("./api-client.ts").ObsidianImportTask): Error {
  const detail = [task.error, task.detail].map((value) => String(value || "").trim()).filter(Boolean).join(" · ");
  return new Error(detail || task.message || `Obsidian import ${task.state}`);
}

async function waitForObsidianTask(
  taskID: string,
  accepted: ReadonlySet<string>,
  timeoutMs = 20 * 60 * 1000,
): Promise<import("./api-client.ts").ObsidianImportTask> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await api.imports.obsidianTask(taskID);
    setStatus(`${task.message || "Obsidian import"} · ${Math.max(0, Math.min(100, task.progress || 0))}%`);
    if (accepted.has(task.state)) return task;
    if (task.state === "failed" || task.state === "cancelled") throw obsidianTaskFailure(task);
    await new Promise((resolveWait) => window.setTimeout(resolveWait, 250));
  }
  throw new Error("Obsidian import timed out");
}

function obsidianVaultName(sourcePath: string, suggested = ""): string {
  const segment = String(suggested || sourcePath.split(/[\\/]/).filter(Boolean).pop() || "Obsidian Vault").trim();
  return segment.replace(/[\\/:*?"<>|]+/g, "-").replace(/^\.+|\.+$/g, "").trim() || "Obsidian Vault";
}

async function importObsidianVault(): Promise<void> {
  if (activeObsidianTaskID) {
    setStatus("An Obsidian import is already active");
    return;
  }
  let sourcePath = "";
  if (window.noemaDesktop?.selectDirectory) {
    const selection = await window.noemaDesktop.selectDirectory({ title: "Choose Obsidian Vault" });
    if (selection.canceled) return;
    sourcePath = selection.path;
  } else {
    const values = await openFormModal("Import Obsidian Vault", [{
      id: "path", label: "Vault folder", required: true,
      description: "Enter the absolute path to a Vault containing a .obsidian directory.",
    }], "Analyze");
    sourcePath = values?.path?.trim() || "";
  }
  if (!sourcePath) return;

  try {
    setStatus("Analyzing Obsidian Vault…");
    const started = await api.imports.obsidianAnalyze(sourcePath);
    activeObsidianTaskID = started.taskID;
    const ready = await waitForObsidianTask(started.taskID, new Set(["ready"]));
    const analysis = ready.analysis || {};
    const vaultName = obsidianVaultName(sourcePath, String(analysis.vaultName || analysis.notebookName || ""));
    const warnings = Array.isArray(analysis.warnings) ? analysis.warnings.length : 0;
    const destination = await openFormModal("Import Obsidian Vault", [{
      id: "destination",
      label: "Destination folder",
      value: `Imports/${vaultName}`,
      required: true,
      description: `${Number(analysis.markdownCount) || 0} Markdown notes · ${Number(analysis.importableAssetCount) || 0} assets · ${Number(analysis.missingCount) || 0} unresolved links · ${warnings} warnings. The original Vault is not modified.`,
    }], "Import");
    if (!destination) {
      await api.imports.obsidianCancel(started.taskID);
      setStatus("Obsidian import cancelled");
      return;
    }
    const target = destination.destination.trim().replace(/^\/+|\/+$/g, "");
    if (!target) throw new Error("Choose a destination below the note root");
    await api.imports.obsidianStart(started.taskID, target);
    const completed = await waitForObsidianTask(started.taskID, new Set(["completed"]));
    await reloadNotes(true);
    const result = completed.result || {};
    setStatus(`Imported ${Number(result.markdownCount) || 0} notes and ${Number(result.importedAttachmentCount) || 0} assets to ${String(result.destination || target)}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Obsidian import failed");
  } finally {
    activeObsidianTaskID = "";
  }
}

async function cancelObsidianImport(): Promise<void> {
  const taskID = activeObsidianTaskID;
  if (!taskID) {
    setStatus("No cancellable Obsidian import is active");
    return;
  }
  try {
    await api.imports.obsidianCancel(taskID);
    setStatus("Obsidian import cancelled");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Obsidian import could not be cancelled at this stage");
  }
}

async function loadPathSuggestions(): Promise<void> {
  if (!currentFile) return;
  try {
    const msg = await api.notes.pathSuggestions(currentFile);
    if (Array.isArray(msg.paths)) pathSuggestions = msg.paths;
  } catch {
    // Keep the coarse note-index suggestions from applyIndexPayload.
  }
}

function currentNote(): NoteSummary | undefined {
  return currentNoteFromIndex(notes, currentFile, currentTitle);
}

function noteSearchValues(note: NoteSummary): string[] {
  return [
    note.id,
    note.key,
    note.title,
    note.path,
    note.link,
    note.source,
    note.file,
    ...(note.aliases ?? []),
    ...(note.tags ?? []),
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function resolveNoteRef(ref: string): NoteSummary | undefined {
  const raw = decodeNoteRef(String(ref || "").replace(/^roam:\/\//i, "").split(/[?#@]/, 1)[0] || "").trim();
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  return notes.find((note) => noteSearchValues(note).some((value) => value.toLowerCase() === key))
    ?? notes.find((note) => noteSearchValues(note).some((value) => value.toLowerCase().includes(key)));
}

function openNote(
  note: NoteSummary,
  options: { newWindow?: boolean; hash?: string; domTarget?: string; equationTag?: string; inlineTag?: string } = {},
): void {
  if (!note.file) return;
  const before = trackCursorPosition();
  noteCursorPositionEvent();
  if (options.newWindow) {
    const url = new URL(window.location.href);
    url.searchParams.set("file", note.file);
    if (options.hash) url.searchParams.set("hash", options.hash);
    if (options.domTarget) url.searchParams.set("dom", options.domTarget);
    window.open(url.toString(), "_blank", "noopener,noreferrer");
    return;
  }
  if (note.file === currentFile) {
    let jumped = false;
    if (options.domTarget) {
      jumped = jumpToDomTarget(options.domTarget);
      if (!jumped) setStatus(`DOM target not found: ${options.domTarget}`);
    } else if (options.hash) {
      jumped = jumpToHash(options.hash);
      if (!jumped) setStatus(`Anchor not found: ${options.hash}`);
    }
    if (jumped) pushNavigationBackLocation(before);
    if (options.domTarget || options.hash) return;
  }
  pushNavigationBackLocation(before);
  pendingOpenHash = options.hash || "";
  pendingOpenDomTarget = options.domTarget || "";
  void openFile(note.file);
}

function openLocationFromHost(options: { file?: string; hash?: string; dom?: string }): void {
  const file = String(options.file || "").trim();
  const hash = String(options.hash || "").trim();
  const domTarget = String(options.dom || "").trim();
  if (!file) return;
  const before = trackCursorPosition();
  if (file === currentFile) {
    const jumped = domTarget ? jumpToDomTarget(domTarget) : hash ? jumpToHash(hash) : false;
    if (jumped) pushNavigationBackLocation(before);
    else if (domTarget) setStatus(`DOM target not found: ${domTarget}`);
    else if (hash) setStatus(`Anchor not found: ${hash}`);
    return;
  }
  pushNavigationBackLocation(before);
  pendingOpenHash = hash;
  pendingOpenDomTarget = domTarget;
  void openFile(file);
}

function cleanHref(href: string): string {
  return String(href || "").trim();
}

function isMarginNoteProtocol(protocol: string | null): boolean {
  return Boolean(protocol && /^marginnote(?:\d+)?(?:app)?$/i.test(protocol));
}

function hrefPath(href: string): string {
  const raw = cleanHref(href);
  if (!raw) return "";
  if (/^file:\/\//i.test(raw)) {
    try {
      return decodeNoteRef(new URL(raw).pathname);
    } catch {
      return decodeNoteRef(raw.replace(/^file:\/\//i, ""));
    }
  }
  const path = raw
    .replace(/^file:/i, "")
    .split(/[?#]/, 1)[0]
    .trim();
  const fileDomMatch = path.match(/^(.+?\.(?:md|markdown|typ))@/i);
  return decodeNoteRef(fileDomMatch?.[1] || path);
}

function hrefHash(href: string): string {
  const raw = cleanHref(href);
  const hashIndex = raw.indexOf("#");
  if (hashIndex < 0) return "";
  return decodeNoteRef(raw.slice(hashIndex + 1).split(/[?&]/, 1)[0] || "").trim();
}

function normalizeNotePath(path: string): string {
  const normalized = String(path || "").replace(/\\/g, "/");
  const absolute = normalized.startsWith("/");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function dirnamePath(path: string): string {
  const normalized = normalizeNotePath(path);
  const index = normalized.lastIndexOf("/");
  if (index < 0) return "";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

function joinNotePath(baseDir: string, path: string): string {
  if (!baseDir || path.startsWith("/")) return normalizeNotePath(path);
  return normalizeNotePath(`${baseDir}/${path}`);
}

function notePathKey(value: unknown): string {
  return normalizeNotePath(String(value || "")
    .replace(/^file:(?:\/\/)?/i, "")
    .replace(/^\.\/+/, ""));
}

function noteMatchesPath(note: NoteSummary, path: string): boolean {
  const key = notePathKey(path);
  if (!key) return false;
  return [note.path, note.link, note.file, note.source]
    .map(notePathKey)
    .some((value) => value === key || value.endsWith(`/${key}`));
}

function noteHrefCandidates(href: string): string[] {
  const path = hrefPath(href);
  const candidates = new Set<string>();
  const add = (value: string) => {
    const normalized = normalizeNotePath(value);
    if (normalized) candidates.add(normalized);
  };
  add(path);
  add(path.replace(/^\.\/+/, ""));
  if (!path.startsWith("/") && currentFile) add(joinNotePath(dirnamePath(currentFile), path));
  const note = currentNote();
  if (!path.startsWith("/") && note?.path) add(joinNotePath(dirnamePath(note.path), path));
  return [...candidates];
}

function markdownNoteHref(href: string): boolean {
  const protocol = hrefProtocol(href);
  if (protocol && protocol !== "file") return false;
  return /\.(?:md|markdown|typ)$/i.test(hrefPath(href));
}

function splitRoamLikeHref(href: string): { ref: string; hash: string; dom: string } | null {
  const raw = cleanHref(href);
  if (!raw || (hrefProtocol(raw) && !/^roam:\/\//i.test(raw))) return null;
  // `@@parent@child` is the current-document form of the same hierarchical
  // DOM path used by `roam://note@parent@child`.
  if (raw.startsWith("@@")) {
    const dom = normalizeDomTargetPath(raw.slice(2));
    return dom ? { ref: "", hash: "", dom } : null;
  }
  let body = raw.replace(/^roam:\/\//i, "").split(/[?&]/, 1)[0] || "";
  let hash = "";
  const hashIndex = body.indexOf("#");
  if (hashIndex >= 0) {
    hash = decodeNoteRef(body.slice(hashIndex + 1));
    body = body.slice(0, hashIndex);
  }
  let dom = "";
  const fileDomMatch = body.match(/^(.+?\.(?:md|markdown|typ))@(.+)$/i);
  if (fileDomMatch) {
    body = fileDomMatch[1] || "";
    dom = normalizeDomTargetPath(fileDomMatch[2] || "");
  } else {
    const atIndex = body.indexOf("@");
    if (atIndex >= 0) {
      dom = normalizeDomTargetPath(body.slice(atIndex + 1));
      body = body.slice(0, atIndex);
    }
  }
  const ref = decodeNoteRef(body.replace(/^\/+/, "").replace(/[.,;:]+$/, "")).trim();
  if (!ref && !hash && !dom) return null;
  return { ref, hash: hash.trim(), dom };
}

function resolveHrefNote(href: string): NoteSummary | undefined {
  const raw = cleanHref(href);
  if (!raw) return undefined;
  const roamLike = splitRoamLikeHref(raw);
  if (roamLike?.ref && /^roam:\/\//i.test(raw)) return resolveNoteRef(roamLike.ref);
  const path = hrefPath(raw);
  for (const candidate of noteHrefCandidates(raw)) {
    const exactPath = notes.find((note) => noteMatchesPath(note, candidate));
    if (exactPath?.file) return exactPath;
    const byRef = resolveNoteRef(candidate);
    if (byRef?.file) return byRef;
  }
  if (!hrefProtocol(raw) && path && !markdownNoteHref(raw)) return resolveNoteRef(path);
  return undefined;
}

function resolveHrefTarget(href: string): { note?: NoteSummary; hash: string; domTarget: string } {
  const raw = cleanHref(href);
  if (raw.startsWith("@@")) {
    return {
      note: currentNote(),
      hash: "",
      domTarget: normalizeDomTargetPath(raw.slice(2)),
    };
  }
  const roamLike = splitRoamLikeHref(raw);
  if (roamLike) {
    const note = roamLike.ref ? resolveNoteRef(roamLike.ref) : undefined;
    if (note?.file || /^roam:\/\//i.test(raw)) return { note, hash: roamLike.hash, domTarget: roamLike.dom };
  }
  return {
    note: resolveHrefNote(raw),
    hash: hrefHash(raw),
    domTarget: roamLike?.dom || "",
  };
}

function slugifyAnchor(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function jumpToHash(hash: string): boolean {
  const clean = normalizeInlineTag(hash.replace(/^#/, ""));
  if (!clean) return false;
  const blockPosition = orgEnvBlockIdentityPosition(editor.view.state, clean);
  if (blockPosition !== null) {
    editor.setMarkdownSelection(blockPosition);
    editor.revealCursor();
    editor.focus();
    noteCursorPositionEvent();
    return true;
  }
  const markdown = editor.getMarkdown();
  const explicitAnchor = markdown.indexOf(`{#${clean}}`);
  const planningId = explicitAnchor < 0
    ? new RegExp(`\\{[^{}\\n]*\\bid\\s*[:=]\\s*["']?${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:["']|(?=\\s|[,}]))`, "i").exec(markdown)?.index ?? -1
    : -1;
  const genericBlockPosition = explicitAnchor >= 0 ? explicitAnchor : planningId;
  if (genericBlockPosition >= 0) {
    editor.setMarkdownSelection(genericBlockPosition);
    editor.revealCursor();
    editor.focus();
    noteCursorPositionEvent();
    return true;
  }
  const equationTag = clean.replace(/^eq-/i, "");
  const equation = getEquationTagHits(editor.view.state)
    .find((hit) => hit.tag.toLowerCase() === equationTag.toLowerCase());
  if (equation) {
    editor.setMarkdownSelection(equation.from, equation.to);
    editor.revealCursor();
    editor.focus();
    noteCursorPositionEvent();
    return true;
  }
  const inline = inlineTagAnchorsFromText(editor.getMarkdown())
    .find((anchor) => anchor.tag.toLowerCase() === clean.toLowerCase()
      || `tag-${anchor.tag}`.toLowerCase() === clean.toLowerCase());
  if (inline) {
    editor.setMarkdownSelection(inline.pos, inline.to);
    editor.revealCursor();
    editor.focus();
    noteCursorPositionEvent();
    return true;
  }
  const allHeadings = markdownHeadingsFromText(editor.view.state.doc);
  const heading = resolveAnchorHeading(allHeadings, clean)
    ?? allHeadings.find((item) => item.text.toLowerCase() === clean.toLowerCase()
      || item.slug === clean
      || slugifyAnchor(item.text) === clean);
  if (heading) {
    editor.setMarkdownSelection(heading.pos);
    editor.revealCursor();
    editor.focus();
    noteCursorPositionEvent();
    return true;
  }
  return false;
}

function openExternalUrl(href: string, options: { newWindow?: boolean } = {}): void {
  const raw = cleanHref(href);
  if (!raw) return;
  const wikiTarget = raw.match(/^roam:\/\/wiki\/(.+)$/i)?.[1];
  const stableWikiTarget = window.__noemaAppConfig?.config.workspace.layout === "wiki"
    ? raw.match(/^roam:\/\/(?!wiki\/)([^@#/?]+)(?:#[^?]*)?$/i)?.[1]
    : "";
  if (wikiTarget || stableWikiTarget) {
    const target = wikiTarget ? decodeURIComponent(wikiTarget) : raw;
    const missingTitle = wikiTarget ? decodeURIComponent(wikiTarget) : stableWikiTarget || raw;
    void api.wiki.resolveLink(target, currentFile).then((result) => {
      if (result.status === "resolved" && result.candidates[0]?.file) {
        openNote({
          id: result.candidates[0].id,
          title: result.candidates[0].title,
          file: result.candidates[0].file,
          path: result.candidates[0].path,
          roam: true,
        }, { newWindow: options.newWindow, hash: result.fragment });
        return;
      }
      if (result.status === "missing-fragment") {
        setStatus(`Block target not found: ${result.fragment}`);
        return;
      }
      const url = new URL("/wiki", location.origin);
      if (result.status === "missing") {
        if (serverReaderMode) {
          url.searchParams.set("q", missingTitle);
        } else {
          url.searchParams.set("new", "1");
          url.searchParams.set("title", missingTitle);
          if (currentFile) url.searchParams.set("source", currentFile);
        }
      } else {
        url.searchParams.set("q", missingTitle);
      }
      if (options.newWindow) window.open(url, "_blank", "noopener");
      else window.location.assign(url);
    }).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
    return;
  }
  if (!safeHref(raw)) {
    setStatus("Blocked unsafe link");
    return;
  }
  const before = trackCursorPosition();
  noteCursorPositionEvent();
  const hash = hrefHash(raw);
  const target = resolveHrefTarget(raw);
  const note = target.note;
  const targetHash = target.hash || hash;
  const targetDom = target.domTarget;
  if (note?.file) {
    if (note.file === currentFile && targetDom) {
      const jumped = jumpToDomTarget(targetDom);
      if (jumped) pushNavigationBackLocation(before);
      else setStatus(`DOM target not found: ${targetDom}`);
      return;
    }
    if (note.file === currentFile && targetHash) {
      const jumped = jumpToHash(targetHash);
      if (jumped) pushNavigationBackLocation(before);
      else setStatus(`Anchor not found: ${targetHash}`);
      return;
    }
    openNote(note, { newWindow: options.newWindow, hash: targetHash, domTarget: targetDom });
    return;
  }
  if (/^roam:\/\//i.test(raw)) {
    setStatus(`Roam note not found: ${splitRoamLikeHref(raw)?.ref || raw}`);
    return;
  }
  if (raw.startsWith("#")) {
    const jumped = jumpToHash(hash || raw.slice(1));
    if (jumped) pushNavigationBackLocation(before);
    else setStatus(`Anchor not found: ${hash || raw.slice(1)}`);
    return;
  }
  const protocol = hrefProtocol(raw);
  if (!protocol) {
    const targetPath = hrefPath(raw) || raw;
    void openSystemTarget(targetPath, currentFile)
      .catch((err) => setStatus(err instanceof Error ? err.message : `Cannot open: ${targetPath}`));
    return;
  }
  if (protocol === "zotero") {
    void openSystemTarget(raw)
      .then(() => setStatus("Opened Zotero link"))
      .catch((err) => setStatus(err instanceof Error ? err.message : "Failed to open Zotero link"));
    return;
  }
  // MarginNote schemes are Emacs-owned routes; never hand them to the browser.
  if (isMarginNoteProtocol(protocol)) {
    void openSystemTarget(raw, currentFile)
      .catch((err) => setStatus(err instanceof Error ? err.message : "Failed to open Maginnote link"));
    return;
  }
  if (desktopMode && ["http", "https", "mailto"].includes(protocol)) {
    void openSystemTarget(raw, currentFile)
      .catch((err) => setStatus(err instanceof Error ? err.message : `Cannot open: ${raw}`));
    return;
  }
  if (options.newWindow) {
    window.open(raw, "_blank", "noopener,noreferrer");
    return;
  }
  window.location.href = raw;
}

function relationTags(note: NoteSummary | undefined): string[] {
  return [...new Set([...(note?.tags ?? []), ...(note?.inlineTags ?? [])]
    .map((tag) => String(tag || "").trim().replace(/^#/, ""))
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function openTagFilter(tag: string): void {
  const clean = String(tag || "").trim().replace(/^#/, "");
  if (!clean) return;
  const rows = notes
    .filter((note) => relationTags(note).some((item) => item.toLowerCase() === clean.toLowerCase()))
    .map((note) => ({
      title: note.title || note.path || note.file || canonicalRoamNoteId(note) || "Untitled",
      detail: [note.path || note.file || "", relationTags(note).join(", ")].filter(Boolean).join(" - "),
      kind: "TAG",
    }));
  showRoamToolRows(`#${clean}`, rows);
}

function normalizeInlineTag(value: string): string {
  return String(value || "")
    .replace(/[\r\n\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type DomTargetEntry = {
  label: string;
  slug: string;
  path: string[];
  labelPath: string[];
  level?: number;
  pos?: number;
  to?: number;
  notePath?: string;
};

function normalizeDomTarget(value: string): string {
  return decodeNoteRef(String(value || ""))
    .replace(/^@/, "")
    .replace(/[\r\n\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function domTargetPathSegments(value: string): string[] {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .split("@")
    .map((segment) => normalizeDomTarget(segment))
    .filter(Boolean);
}

function slugDomTarget(value: string): string {
  return normalizeDomTarget(value)
    .toLowerCase()
    .replace(/[`*_~()[\]{}#+.!<>:;,'"@]/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

function normalizeDomTargetPath(value: string): string {
  return domTargetPathSegments(value)
    .map(slugDomTarget)
    .filter(Boolean)
    .join("@");
}

function domTargetPathLabel(path: readonly string[]): string {
  return path.filter(Boolean).join(" / ");
}

function targetSegmentMatches(actual: string, wanted: string): boolean {
  const actualNorm = normalizeDomTarget(actual).toLowerCase();
  const wantedNorm = normalizeDomTarget(wanted).toLowerCase();
  if (actualNorm && actualNorm === wantedNorm) return true;
  const actualSlug = slugDomTarget(actual);
  const wantedSlug = slugDomTarget(wanted);
  return Boolean(actualSlug && wantedSlug && actualSlug === wantedSlug);
}

function targetPathMatches(actualPath: readonly string[], wantedPath: readonly string[], allowSuffix = true): boolean {
  if (wantedPath.length === 0 || actualPath.length === 0) return false;
  const pathMatchesAt = (offset: number) => wantedPath.every((segment, index) =>
    targetSegmentMatches(actualPath[offset + index] || "", segment));
  if (actualPath.length === wantedPath.length && pathMatchesAt(0)) return true;
  if (!allowSuffix || actualPath.length < wantedPath.length) return false;
  return pathMatchesAt(actualPath.length - wantedPath.length);
}

function findDomTargetEntry(entries: readonly DomTargetEntry[], rawTarget: string): DomTargetEntry | undefined {
  const targetPath = domTargetPathSegments(rawTarget);
  if (targetPath.length === 0) return undefined;
  if (targetPath.length > 1) {
    return entries.find((entry) => targetPathMatches(entry.path, targetPath, false))
      ?? entries.find((entry) => targetPathMatches(entry.path, targetPath, true));
  }
  const target = targetPath[0] || "";
  const targetSlug = slugDomTarget(target);
  const targetNorm = normalizeDomTarget(target).toLowerCase();
  return entries.find((entry) => {
    const label = normalizeDomTarget(entry.label).toLowerCase();
    return label === targetNorm || entry.slug === targetSlug || entry.slug === targetNorm;
  });
}

function currentDomTargets(): DomTargetEntry[] {
  const stack: string[] = [];
  const labelStack: string[] = [];
  return markdownHeadingsFromText(editor.view.state.doc).map((heading) => {
    const level = Math.max(1, Number(heading.level || 1));
    const label = normalizeDomTarget(heading.text);
    const slug = heading.slug || slugDomTarget(label);
    stack.length = Math.min(stack.length, level - 1);
    labelStack.length = Math.min(labelStack.length, level - 1);
    stack.push(slug);
    labelStack.push(label);
    return {
      label,
      slug,
      path: [...stack],
      labelPath: [...labelStack],
      level,
      pos: heading.pos,
      to: heading.to ?? heading.pos + heading.text.length,
    };
  });
}

function jumpToDomTarget(rawTarget: string): boolean {
  const target = normalizeDomTargetPath(rawTarget);
  if (!target) return false;
  const hit = findDomTargetEntry(currentDomTargets(), target);
  if (!hit) return false;
  editor.setMarkdownSelection(hit.pos ?? 0, hit.to ?? hit.pos ?? 0);
  editor.revealCursor();
  editor.focus();
  setStatus(`DOM target ${target}`);
  scheduleAssistUpdate({ toc: true });
  noteCursorPositionEvent();
  return true;
}

function tagSlugSegment(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function activeHeadingPath(): string[] {
  const pos = editor.getMarkdownSelection().from;
  const stack: string[] = [];
  for (const heading of markdownHeadingsFromText(editor.view.state.doc)) {
    if (heading.pos > pos) break;
    stack[heading.level - 1] = heading.text;
    stack.length = heading.level;
  }
  return stack;
}

function anchorTagOccurrences(content = editor.getMarkdown()): string[] {
  return [
    ...equationTagsFromText(content),
    ...inlineTagAnchorsFromText(content).map((anchor) => anchor.tag),
  ].map(normalizeInlineTag).filter(Boolean);
}

function allAnchorTagSuggestions(content = editor.getMarkdown()): string[] {
  return [...new Set(anchorTagOccurrences(content))].sort((a, b) => a.localeCompare(b));
}

function nextAnchorTagSuggestion(kind: "equation" | "inline"): string {
  const headingParts = activeHeadingPath().map(tagSlugSegment).filter(Boolean);
  const fallback = tagSlugSegment(currentNote()?.title || fileNameFromPath(currentFile || "note")) || "anchor";
  const core = headingParts.slice(-3).join(".") || fallback;
  const base = kind === "equation" ? `eq:${core}` : core;
  const used = new Set(allAnchorTagSuggestions().map((tag) => tag.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}.${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}.${Date.now()}`;
}

function noteAnchorHref(note: NoteSummary | undefined, hash: string): string {
  const cleanHash = String(hash || "").replace(/^#/, "");
  if (roamFeaturesEnabled() && note?.roam) return roamHrefForNote(note, cleanHash);
  const target = note?.path || note?.link || currentFile || note?.file || fileNameFromPath(currentFile || "note.md");
  return `${encodeMarkdownHrefPath(target)}${cleanHash ? `#${cleanHash}` : ""}`;
}

function inlineTagReferenceMarkdown(tag: string): string {
  const clean = normalizeInlineTag(tag);
  return `[${escapeMarkdownLinkText(`#${clean}`)}](${noteAnchorHref(currentNote(), encodeURIComponent(clean))})`;
}

function equationReferenceMarkdown(tag: string): string {
  const clean = normalizeInlineTag(tag);
  return `[${escapeMarkdownLinkText(clean)}](${noteAnchorHref(currentNote(), `eq-${encodeURIComponent(clean)}`)})`;
}

function blockReferenceMarkdown(block: { id: string; kind: string; title: string }): string {
  const fallback = block.kind ? block.kind[0]!.toUpperCase() + block.kind.slice(1) : `#${block.id.slice(-6)}`;
  const label = block.title || fallback;
  return `[${escapeMarkdownLinkText(label)}](${noteAnchorHref(currentNote(), encodeURIComponent(block.id))})`;
}

function inlineTagMarkdown(tag: string): string {
  return `@@tag[${normalizeInlineTag(tag)}]`;
}

function inlineTagAtCursor(): string {
  const selection = editor.getMarkdownSelection();
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  return inlineTagAnchorsFromText(editor.getMarkdown())
    .find((anchor) => from === to ? from >= anchor.pos && from <= anchor.to : from < anchor.to && to > anchor.pos)
    ?.tag ?? "";
}

function focusedEditableOutsideEditor(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || host.contains(active)) return false;
  return Boolean(active.closest("input, textarea, select, [contenteditable='true']"));
}

async function copyText(text: string): Promise<void> {
  await writeSystemClipboard(text);
}


window.AaronnoteCopyBlockTarget = async (blockId: string): Promise<string> => {
  const target = noteAnchorHref(currentNote(), encodeURIComponent(blockId));
  await copyText(target);
  setStatus(`Block target copied: #${blockId.slice(-6)}`);
  return target;
};

let findMatches: FindMatch[] = [];
let findIndex = -1;

function selectedMarkdownText(): string {
  const selection = editor.getMarkdownSelection();
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  return from < to ? editor.textBetween(from, to) : "";
}

function clearFindHighlights(): void {
  findMatches = [];
  findIndex = -1;
  editor.view.dispatch({ effects: setFindHighlightRanges.of([]) });
  findCount.textContent = "0/0";
}

function updateFindHighlights(): void {
  const ranges = findMatches.map((match, index) => ({
    from: match.from,
    to: match.to,
    current: index === findIndex,
  }));
  editor.view.dispatch({ effects: setFindHighlightRanges.of(ranges) });
}

function gotoFindMatch(index: number): void {
  if (findMatches.length === 0) {
    findIndex = -1;
    updateFindHighlights();
    findCount.textContent = "0/0";
    return;
  }
  findIndex = ((index % findMatches.length) + findMatches.length) % findMatches.length;
  const match = findMatches[findIndex]!;
  editor.setMarkdownSelection(match.from, match.to);
  updateFindHighlights();
  findCount.textContent = `${findIndex + 1}/${findMatches.length}`;
}

function refreshFind(query = findInput.value, keepCurrent = true): void {
  const result = createFindPattern(query, false);
  if (result.error) {
    clearFindHighlights();
    findCount.textContent = result.error;
    return;
  }
  findMatches = collectFindMatches(editor.getMarkdown(), result.pattern);
  if (findMatches.length === 0) {
    findIndex = -1;
    updateFindHighlights();
    findCount.textContent = query ? "0/0" : "0/0";
    return;
  }
  if (keepCurrent && findIndex >= 0 && findIndex < findMatches.length) {
    gotoFindMatch(findIndex);
    return;
  }
  const selection = editor.getMarkdownSelection();
  const cursor = Math.max(selection.from, selection.to);
  const next = findMatches.findIndex((match) => match.to >= cursor);
  gotoFindMatch(next >= 0 ? next : 0);
}

function openFindPanel(): void {
  const selected = selectedMarkdownText();
  if (selected && !selected.includes("\n")) findInput.value = selected;
  findPanel.hidden = false;
  selectionTool.hidden = true;
  refreshFind(findInput.value, false);
  findInput.focus();
  findInput.select();
}

function closeFindPanel(): void {
  findPanel.hidden = true;
  clearFindHighlights();
  editor.focus();
}

async function copyEditorSelection(cut = false): Promise<boolean> {
  const active = activeEditorSelection();
  let text = active ? active.text() : "";
  if (!text) {
    const selection = editor.getMarkdownSelection();
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    // A copy the host asked for arrives with no DOM selection at all — Emacs
    // owns the focus at that moment. Fall back to CodeMirror's own rule, which
    // also gives a bare cursor its whole line instead of nothing.
    text = from < to ? editor.textBetween(from, to) : copiedText(editor.view.state);
  }
  if (!text) return false;
  const copied = await writeSystemClipboard(text);
  if (!copied) {
    setStatus("Copy failed");
    return false;
  }
  if (cut && !currentReadOnly) cutCopiedSelection();
  setStatus(cut ? "Selection cut" : "Selection copied");
  selectionTool.hidden = true;
  return true;
}

/** Remove what `copyEditorSelection` just took, matching its linewise rule. */
function cutCopiedSelection(): void {
  const state = editor.view.state;
  const ranges = state.selection.ranges.filter((range) => !range.empty);
  if (ranges.length > 0) {
    editor.view.dispatch({
      changes: ranges.map((range) => ({ from: range.from, to: range.to })),
      scrollIntoView: true,
    });
    return;
  }
  const line = state.doc.lineAt(state.selection.main.from);
  editor.view.dispatch({
    changes: { from: line.from, to: Math.min(state.doc.length, line.to + 1) },
    scrollIntoView: true,
  });
}

function runClipboardShortcut(event: KeyboardEvent): boolean {
  if (!primaryMod(event) || event.shiftKey || event.altKey || event.isComposing) return false;
  if (!modal.hidden || !toolsPanel.hidden || !roamToolsPanel.hidden || focusedEditableOutsideEditor()) return false;
  const key = event.key.toLowerCase();
  if (key === "c") {
    const selection = editor.getMarkdownSelection();
    if (selection.from === selection.to && !activeEditorSelection()) return false;
    event.preventDefault();
    void copyEditorSelection();
    return true;
  }
  if (key === "v") {
    event.preventDefault();
    if (rejectReadOnlyAction("Read-only pane")) return true;
    editor.focus();
    void editor.pasteFromClipboard();
    return true;
  }
  return false;
}

function runFindShortcut(event: KeyboardEvent): boolean {
  if (!primaryMod(event) || event.shiftKey || event.altKey || event.isComposing) return false;
  if (!modal.hidden || !toolsPanel.hidden || !roamToolsPanel.hidden) return false;
  if (event.key.toLowerCase() !== "f") return false;
  event.preventDefault();
  openFindPanel();
  return true;
}

function parseTagPrompt(value: string | null): string[] {
  const byKey = new Map<string, string>();
  for (const tag of String(value || "").split(/[, ]+/)) {
    const clean = tag.trim().replace(/^#/, "");
    if (!clean) continue;
    const key = clean.toLowerCase();
    const previous = byKey.get(key);
    if (!previous || clean === key) byKey.set(key, clean);
  }
  return [...byKey.values()];
}

function tagSuggestions(): string[] {
  return collectTagSuggestions(notes);
}

async function databaseTagSuggestions(): Promise<string[]> {
  const local = tagSuggestions();
  try {
    const result = await api.completions.tags("");
    return collectTagSuggestions([
      { tags: local },
      { tags: Array.isArray(result.tags) ? result.tags : [] },
    ]);
  } catch {
    return local;
  }
}

type ModalField = {
  id: string;
  label: string;
  value?: string;
  type?: "text" | "tag" | "tags" | "select" | "suggest";
  suggestions?: string[];
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  description?: string;
  group?: string;
  tagValues?: readonly string[];
  onTagChanges?: (changes: TagChangeSet) => void;
};

function openFormModal(title: string, fields: ModalField[], submitLabel = "OK"): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    modal.innerHTML = "";
    const panel = document.createElement("form");
    panel.className = fields.some((field) => field.type === "tag" || field.type === "tags") ? "aaronnote-modal-panel has-tags" : "aaronnote-modal-panel";
    const heading = document.createElement("h2");
    heading.textContent = title;
    panel.appendChild(heading);
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    const focusTargets = new Map<string, HTMLInputElement | HTMLSelectElement>();
    const tagPickers = new Map<string, ReturnType<typeof createTagPicker>>();

    let previousGroup = "";
    fields.forEach((field, index) => {
      if (field.group && field.group !== previousGroup) {
        const group = document.createElement("div");
        group.className = "aaronnote-modal-field-group";
        group.textContent = field.group;
        panel.appendChild(group);
      }
      previousGroup = field.group || previousGroup;
      const label = document.createElement("label");
      label.textContent = field.label;
      if (field.required) label.textContent += " *";
      if (field.type === "select") {
        const select = document.createElement("select");
        select.name = field.id;
        for (const opt of field.options || []) {
          const option = document.createElement("option");
          option.value = opt.value;
          option.textContent = opt.label;
          select.appendChild(option);
        }
        select.value = field.value || (field.options?.[0]?.value ?? "");
        select.required = Boolean(field.required);
        label.appendChild(select);
        inputs.set(field.id, select);
        focusTargets.set(field.id, select);
        panel.appendChild(label);
        if (field.description) {
          const help = document.createElement("small");
          help.className = "aaronnote-modal-field-help";
          help.textContent = field.description;
          panel.appendChild(help);
        }
        return;
      }
      if (field.type === "tag" || field.type === "tags") {
        const picker = createTagPicker({
          name: field.id,
          value: field.tagValues ?? field.value ?? "",
          suggestions: field.suggestions || [],
          multiple: field.type === "tags",
          allowCreate: field.type === "tags",
          placeholder: field.placeholder,
        });
        label.appendChild(picker.root);
        inputs.set(field.id, picker.input);
        focusTargets.set(field.id, picker.search);
        tagPickers.set(field.id, picker);
        panel.appendChild(label);
        if (field.description) {
          const help = document.createElement("small");
          help.className = "aaronnote-modal-field-help";
          help.textContent = field.description;
          panel.appendChild(help);
        }
        return;
      }
      const input = document.createElement("input");
      input.name = field.id;
      input.value = field.value || "";
      input.required = Boolean(field.required);
      input.placeholder = field.placeholder || "";
      input.autocomplete = "off";
      input.spellcheck = false;
      if (field.suggestions?.length) {
        const listId = `aaronnote-modal-list-${index}`;
        const list = document.createElement("datalist");
        list.id = listId;
        for (const suggestion of field.suggestions) {
          const option = document.createElement("option");
          option.value = suggestion;
          list.appendChild(option);
        }
        input.setAttribute("list", listId);
        label.append(input, list);
      } else {
        label.appendChild(input);
      }
      inputs.set(field.id, input);
      focusTargets.set(field.id, input);
      panel.appendChild(label);
      if (field.description) {
        const help = document.createElement("small");
        help.className = "aaronnote-modal-field-help";
        help.textContent = field.description;
        panel.appendChild(help);
      }

      if (field.type === "suggest" && field.suggestions?.length) {
        const picker = document.createElement("div");
        picker.className = "aaronnote-modal-suggestion-picker";
        for (const tag of field.suggestions.slice(0, 40)) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = tag;
          button.addEventListener("click", () => {
            input.value = tag;
            input.dispatchEvent(new Event("input", { bubbles: true }));
          });
          picker.appendChild(button);
        }
        panel.appendChild(picker);
      }
    });

    const actions = document.createElement("div");
    actions.className = "aaronnote-modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = submitLabel;
    actions.append(cancel, submit);
    panel.appendChild(actions);

    const close = (value: Record<string, string> | null): void => {
      modal.hidden = true;
      modal.innerHTML = "";
      editor.focus();
      resolve(value);
    };
    cancel.addEventListener("click", () => close(null));
    modal.addEventListener("mousedown", (event) => {
      if (event.target === modal) close(null);
    }, { once: true });
    panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close(null);
    });
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      const value: Record<string, string> = {};
      for (const [id, input] of inputs) value[id] = input.value;
      for (const field of fields) {
        const picker = tagPickers.get(field.id);
        if (picker && field.onTagChanges) field.onTagChanges(picker.changes());
      }
      close(value);
    });
    modal.appendChild(panel);
    modal.hidden = false;
    window.setTimeout(() => fields[0] && focusTargets.get(fields[0].id)?.focus(), 0);
  });
}

function currentMarkdownText(): string {
  return editor.view.state.doc.toString();
}

type PlanningNodeLike = {
  kind: string;
  status?: string;
  title?: string;
  attrs?: Record<string, string>;
  raw: string;
  shape?: string;
  span: { from: number; to: number; line?: number; column?: number };
};

type PlanningEditTarget = {
  from: number;
  to: number;
  detail: string;
};

const AGENDA_ARG_ALIASES: Record<string, string[]> = {
  project: ["project", "proj"],
  ddl: ["ddl", "due", "deadline"],
  sche: ["sche", "scheduled", "start"],
  end: ["end", "finish"],
  prio: ["prio", "priority"],
  repeat: ["repeat", "rep", "every"],
  warn: ["warn", "lead"],
  after: ["after", "dep"],
  blocks: ["blocks"],
  area: ["area"],
  phase: ["phase"],
  goal: ["goal"],
  effort: ["effort"],
  progress: ["progress", "pct"],
  owner: ["owner"],
  date: ["date", "when"],
  context: ["context", "ctx"],
  from: ["from"],
  to: ["to"],
};

const AGENDA_DATE_FIELDS = new Set(["ddl", "sche", "end", "date", "from", "to"]);

function agendaNodes(): PlanningNodeLike[] {
  return scanPlanningNodes(currentMarkdownText()) as PlanningNodeLike[];
}

function agendaArgValue(attrs: Record<string, string> | undefined, canon: string): string {
  for (const key of AGENDA_ARG_ALIASES[canon] || [canon]) {
    const value = String(attrs?.[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function agendaArgWriteKey(attrs: Record<string, string> | undefined, canon: string): string {
  for (const key of AGENDA_ARG_ALIASES[canon] || [canon]) {
    if (Object.prototype.hasOwnProperty.call(attrs || {}, key)) return key;
  }
  return (AGENDA_ARG_ALIASES[canon] || [canon])[0] || canon;
}

function setAgendaPatchValue(
  patch: Record<string, string | null>,
  attrs: Record<string, string> | undefined,
  canon: string,
  rawValue: string,
  options: { skipIfInherited?: boolean } = {},
): void {
  const value = normalizeAgendaFieldValue(canon, rawValue);
  for (const key of AGENDA_ARG_ALIASES[canon] || [canon]) patch[key] = null;
  if (!value || options.skipIfInherited) return;
  patch[agendaArgWriteKey(attrs, canon)] = value;
}

function stripMetaQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function projectFromMetaBody(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(project|proj)\s*:\s*(.+?)\s*$/i);
    if (match?.[2]) return stripMetaQuotes(match[2]);
  }
  return "";
}

function currentFileProjectFromMarkdown(): string {
  const md = currentMarkdownText();
  const front = md.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)?.[1] || "";
  const org = md.match(/^\s*#\+begin\s+meta\s*\r?\n([\s\S]*?)\r?\n\s*#\+end\s+meta\s*$/im)?.[1] || "";
  return projectFromMetaBody(org) || projectFromMetaBody(front);
}

function agendaProjectSlug(text: string): string {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "") || "";
}

function inferredProjectForNode(node: PlanningNodeLike, nodes: PlanningNodeLike[]): string {
  const own = agendaArgValue(node.attrs, "project");
  if (own) return own;
  const metaProject = currentFileProjectFromMarkdown();
  if (metaProject) return metaProject;
  const previousProject = [...nodes]
    .reverse()
    .find((candidate) => candidate.kind === "project" && candidate.span.from < node.span.from);
  if (previousProject) return agendaArgValue(previousProject.attrs, "project") || agendaProjectSlug(previousProject.title || "");
  if (node.kind === "project") return agendaProjectSlug(node.title || "");
  return "";
}

function agendaProjectSuggestions(nodes: PlanningNodeLike[], fallback = ""): string[] {
  const values = new Set<string>();
  const add = (value: unknown): void => {
    const clean = String(value || "").trim();
    if (clean) values.add(clean);
  };
  add(fallback);
  add(currentFileProjectFromMarkdown());
  for (const node of nodes) {
    add(agendaArgValue(node.attrs, "project"));
    if (node.kind === "project") add(agendaProjectSlug(node.title || ""));
  }
  for (const todo of agendaTodos) add((todo.canon as Record<string, string> | undefined)?.project);
  for (const note of notes) add((note as NoteSummary & { project?: string }).project);
  return [...values].sort((a, b) => a.localeCompare(b));
}

async function agendaProjectSuggestionsWithGlobal(nodes: PlanningNodeLike[], fallback = ""): Promise<string[]> {
  const values = new Set(agendaProjectSuggestions(nodes, fallback));
  const add = (value: unknown): void => {
    const clean = String(value || "").trim();
    if (clean) values.add(clean);
  };
  try {
    const agenda = await api.notes.agenda({ includePlanning: true, days: 1 });
    for (const project of agenda.projects || []) {
      add(project.canon?.project);
      add(project.args?.project);
      add(project.args?.proj);
      if (!project.canon?.project && !project.args?.project && !project.args?.proj) add(agendaProjectSlug(project.title || project.text || ""));
    }
    for (const project of agenda.projectModel || []) add(project.key);
    for (const task of agenda.gantt?.lanes || []) add(task.key);
  } catch {
    // Local editor suggestions should still work if the full agenda is unavailable.
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

function agendaDateOnly(time = Date.now()): string {
  const d = new Date(time);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function agendaDateTime(time = Date.now()): string {
  const d = new Date(time);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${agendaDateOnly(time)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function normalizeAgendaFieldValue(canon: string, rawValue: string): string {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  if (AGENDA_DATE_FIELDS.has(canon)) return normalizeDateValue(value) || value;
  if (canon === "prio") return value.slice(0, 1).toUpperCase();
  if (canon === "progress") return String(Math.max(0, Math.min(100, Number(value) || 0)));
  return value;
}

function planningWidgetFromTarget(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target : null;
  return element?.closest<HTMLElement>("[data-planning-kind][data-planning-source-from][data-planning-source-to]") ?? null;
}

function planningNodeAtPointer(event: MouseEvent): PlanningNodeLike | null {
  const nodes = agendaNodes();
  const widget = planningWidgetFromTarget(event.target);
  if (widget) {
    const from = Number(widget.dataset.planningSourceFrom);
    return nodes.find((node) => node.span.from === from)
      || nodes.find((node) => Number.isFinite(from) && node.span.from <= from && from <= node.span.to)
      || null;
  }
  const pos = editor.view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (typeof pos !== "number") return null;
  return nodes.find((node) => node.span.from <= pos && pos <= node.span.to) || null;
}

function planningEditTargetFromPointer(event: MouseEvent): PlanningEditTarget | null {
  const node = planningNodeAtPointer(event);
  if (!node) return null;
  const kind = node.kind.toUpperCase();
  const title = String(node.title || "").trim();
  return {
    from: node.span.from,
    to: node.span.to,
    detail: title ? `${kind} - ${title}` : kind,
  };
}

function planningNodeForTarget(target: PlanningEditTarget): { node: PlanningNodeLike; nodes: PlanningNodeLike[] } | null {
  const nodes = agendaNodes();
  const node = nodes.find((candidate) => candidate.span.from === target.from)
    || nodes.find((candidate) => candidate.span.from <= target.from && target.from <= candidate.span.to)
    || nodes.find((candidate) => candidate.span.from <= target.to && target.to <= candidate.span.to)
    || null;
  return node ? { node, nodes } : null;
}

function agendaStatusOptions(kind: string): { value: string; label: string }[] {
  if (kind === "project") {
    return [
      { value: "active", label: "Active" },
      { value: "paused", label: "Paused" },
      { value: "done", label: "Done" },
      { value: "cancelled", label: "Cancelled" },
    ];
  }
  return [
    { value: "todo", label: "Todo" },
    { value: "doing", label: "Doing" },
    { value: "done", label: "Done" },
    { value: "blocked", label: "Blocked" },
    { value: "cancelled", label: "Cancelled" },
  ];
}

function agendaEditFields(
  node: PlanningNodeLike,
  nodes: PlanningNodeLike[],
  defaults: { inheritedProject?: string; projectSuggestions?: string[] } = {},
): { fields: ModalField[]; inheritedProject: string } {
  const kind = node.kind;
  const attrs = node.attrs || {};
  const inheritedProject = defaults.inheritedProject ?? inferredProjectForNode(node, nodes);
  const projectSuggestions = defaults.projectSuggestions ?? agendaProjectSuggestions(nodes, inheritedProject);
  const field = (id: string, label: string, value = "", suggestions?: string[], type: ModalField["type"] = "text"): ModalField => ({ id, label, value, suggestions, type });
  const project = field("project", "Project", agendaArgValue(attrs, "project") || inheritedProject, projectSuggestions, "suggest");
  const fields: ModalField[] = [];
  if (kind === "todo" || kind === "itodo") {
    fields.push({
      id: "status",
      label: "Status",
      type: "select",
      value: node.status || "todo",
      options: agendaStatusOptions(kind),
    });
    fields.push(
      project,
      field("prio", "Priority", agendaArgValue(attrs, "prio"), ["A", "B", "C"]),
      field("ddl", "Deadline", agendaArgValue(attrs, "ddl"), ["today", "tomorrow", "+3d", "+1w"]),
      field("sche", "Scheduled", agendaArgValue(attrs, "sche"), ["today", "tomorrow", "+3d", "+1w"]),
      field("end", "End", agendaArgValue(attrs, "end"), ["today", "tomorrow", "+1w"]),
      field("effort", "Effort", agendaArgValue(attrs, "effort"), ["30m", "1h", "2h", "4h"]),
      field("progress", "Progress", agendaArgValue(attrs, "progress"), ["0", "25", "50", "75", "100"]),
      field("repeat", "Repeat", agendaArgValue(attrs, "repeat"), ["+1d", "+1w", "+1m"]),
      field("after", "After", agendaArgValue(attrs, "after")),
      field("context", "Context", agendaArgValue(attrs, "context")),
    );
  } else if (kind === "project") {
    fields.push({
      id: "status",
      label: "Status",
      type: "select",
      value: node.status || "active",
      options: agendaStatusOptions(kind),
    });
    fields.push(
      project,
      field("area", "Area", agendaArgValue(attrs, "area")),
      field("phase", "Phase", agendaArgValue(attrs, "phase")),
      field("owner", "Owner", agendaArgValue(attrs, "owner")),
      field("goal", "Goal", agendaArgValue(attrs, "goal")),
      field("progress", "Progress", agendaArgValue(attrs, "progress"), ["0", "25", "50", "75", "100"]),
      field("sche", "Start", agendaArgValue(attrs, "sche"), ["today", "tomorrow", "+1w"]),
      field("end", "End", agendaArgValue(attrs, "end"), ["today", "tomorrow", "+1w"]),
      field("ddl", "Deadline", agendaArgValue(attrs, "ddl"), ["today", "tomorrow", "+1w"]),
    );
  } else if (kind === "milestone") {
    fields.push(
      project,
      field("date", "Date", agendaArgValue(attrs, "date") || agendaDateOnly(), ["today", "tomorrow", "+1w"]),
    );
  } else if (kind === "clock") {
    fields.push(
      project,
      field("from", "From", agendaArgValue(attrs, "from") || agendaDateTime(), ["now"]),
      field("to", "To", agendaArgValue(attrs, "to"), ["now"]),
    );
  }
  return { fields, inheritedProject };
}

function statusPatchForAgendaNode(node: PlanningNodeLike, selectedStatus: string): string | undefined {
  const kind = node.kind;
  if (kind !== "todo" && kind !== "itodo" && kind !== "project") return undefined;
  const implicit = kind === "project" ? "active" : "todo";
  const selected = String(selectedStatus || implicit).trim().toLowerCase();
  const current = String(node.status || implicit).trim().toLowerCase();
  if (selected === current && !node.status) return undefined;
  if (kind !== "project" && selected === "todo") return "";
  return selected;
}

function agendaPatchFromForm(
  node: PlanningNodeLike,
  values: Record<string, string>,
  inheritedProject: string,
): { status?: string; attrs: Record<string, string | null> } {
  const attrs = node.attrs || {};
  const patch: { status?: string; attrs: Record<string, string | null> } = { attrs: {} };
  const nextStatus = statusPatchForAgendaNode(node, values.status || "");
  if (nextStatus !== undefined) patch.status = nextStatus;
  for (const key of Object.keys(AGENDA_ARG_ALIASES)) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const value = values[key] || "";
    const inherited = key === "project"
      && !agendaArgValue(attrs, "project")
      && normalizeAgendaFieldValue("project", value) === inheritedProject;
    setAgendaPatchValue(patch.attrs, attrs, key, value, { skipIfInherited: inherited });
  }
  return patch;
}

async function openAgendaEditPop(target: PlanningEditTarget): Promise<void> {
  const found = planningNodeForTarget(target);
  if (!found) {
    setStatus("Agenda item not found");
    return;
  }
  const { node, nodes } = found;
  const inheritedProject = inferredProjectForNode(node, nodes);
  const projectSuggestions = await agendaProjectSuggestionsWithGlobal(nodes, inheritedProject);
  const { fields } = agendaEditFields(node, nodes, { inheritedProject, projectSuggestions });
  if (fields.length === 0) {
    setStatus("No editable agenda fields");
    return;
  }
  const title = `${node.kind.toUpperCase()} - ${String(node.title || "").trim() || "Agenda"}`;
  const values = await openFormModal(title, fields, "Apply");
  if (!values) return;
  const patch = agendaPatchFromForm(node, values, inheritedProject);
  const nextRaw = patchPlanningNodeRaw(node, patch);
  if (nextRaw === node.raw) {
    setStatus("Agenda unchanged");
    return;
  }
  editor.replaceMarkdownRange(node.span.from, node.span.to, nextRaw, "end");
  scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true, toc: true });
  setStatus("Agenda updated");
}

function openLatexScopeModal(scopes: readonly LatexExportScope[]): Promise<LatexExportScope[] | null> {
  return new Promise((resolve) => {
    modal.innerHTML = "";
    const panel = document.createElement("form");
    panel.className = "aaronnote-modal-panel aaronnote-latex-export-panel";

    const heading = document.createElement("h2");
    heading.textContent = "Export LaTeX";
    const help = document.createElement("p");
    help.className = "aaronnote-latex-export-help";
    help.textContent = "Choose exactly what goes into the .tex file. A section includes all of its nested subsections.";
    panel.append(heading, help);

    const headingScopes = scopes.filter((scope) => scope.kind === "heading");
    const search = document.createElement("input");
    search.type = "search";
    search.className = "aaronnote-latex-export-search";
    search.placeholder = "Filter sections…";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.setAttribute("aria-label", "Filter export sections");
    if (headingScopes.length > 0) panel.appendChild(search);

    const list = document.createElement("div");
    list.className = "aaronnote-latex-export-scopes";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "LaTeX export scopes");
    list.setAttribute("aria-multiselectable", "true");
    panel.appendChild(list);

    let selectedIds = new Set([scopes.some((scope) => scope.kind === "selection") ? "selection" : "document"]);
    let focusedId = [...selectedIds][0]!;
    let visibleScopes = [...scopes];

    const selectedScopes = (): LatexExportScope[] =>
      scopes.filter((scope) => selectedIds.has(scope.id));

    const close = (value: LatexExportScope[] | null): void => {
      modal.hidden = true;
      modal.innerHTML = "";
      modal.removeEventListener("mousedown", onBackdrop);
      editor.focus();
      resolve(value);
    };

    const render = (): void => {
      const query = search.value.trim().toLocaleLowerCase();
      visibleScopes = query
        ? headingScopes.filter((scope) => `${scope.title} ${scope.detail}`.toLocaleLowerCase().includes(query))
        : [...scopes];
      if (!visibleScopes.some((scope) => scope.id === focusedId)) {
        focusedId = visibleScopes.find((scope) => scope.active)?.id || visibleScopes[0]?.id || "";
      }

      const fragment = document.createDocumentFragment();
      if (visibleScopes.length === 0) {
        const empty = document.createElement("div");
        empty.className = "aaronnote-latex-export-empty";
        empty.textContent = "No matching sections";
        fragment.appendChild(empty);
      }
      for (const scope of visibleScopes) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "aaronnote-latex-export-scope";
        row.dataset.scopeId = scope.id;
        row.setAttribute("role", "checkbox");
        row.setAttribute("aria-checked", String(selectedIds.has(scope.id)));
        row.tabIndex = scope.id === focusedId ? 0 : -1;
        row.style.setProperty("--latex-scope-depth", String(scope.kind === "heading" ? Math.max(0, scope.level - 1) : 0));

        const marker = document.createElement("span");
        marker.className = "aaronnote-latex-export-radio";
        marker.setAttribute("aria-hidden", "true");
        const copy = document.createElement("span");
        copy.className = "aaronnote-latex-export-scope-copy";
        const name = document.createElement("span");
        name.className = "aaronnote-latex-export-scope-name";
        name.textContent = scope.title;
        if (scope.active) {
          const badge = document.createElement("span");
          badge.className = "aaronnote-latex-export-current";
          badge.textContent = "cursor";
          name.appendChild(badge);
        }
        const detail = document.createElement("span");
        detail.className = "aaronnote-latex-export-scope-detail";
        detail.textContent = scope.detail;
        copy.append(name, detail);
        row.append(marker, copy);
        const toggleScope = (): void => {
          selectedIds = toggleLatexExportScopeSelection(scopes, selectedIds, scope.id);
          focusedId = scope.id;
          render();
          list.querySelector<HTMLElement>(`[data-scope-id="${CSS.escape(scope.id)}"]`)?.focus();
        };
        row.addEventListener("click", toggleScope);
        row.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" || event.isComposing) return;
          event.preventDefault();
          toggleScope();
        });
        fragment.appendChild(row);
      }
      list.replaceChildren(fragment);
      const selected = selectedScopes();
      selectionSummary.textContent = selected.length === 0
        ? "Select at least one section"
        : selected.some((scope) => scope.kind !== "heading")
          ? selected[0]!.title
          : `${selected.length} ${selected.length === 1 ? "section" : "sections"} selected`;
      submit.disabled = selected.length === 0;
      submit.textContent = selected.length > 1 ? `Choose Path · ${selected.length}` : "Choose Path";
    };

    const moveSelection = (delta: number): void => {
      if (visibleScopes.length === 0) return;
      const current = Math.max(0, visibleScopes.findIndex((scope) => scope.id === focusedId));
      const next = Math.max(0, Math.min(visibleScopes.length - 1, current + delta));
      focusedId = visibleScopes[next]!.id;
      render();
      list.querySelector<HTMLElement>(`[data-scope-id="${CSS.escape(focusedId)}"]`)?.focus();
    };

    search.addEventListener("input", render);
    panel.addEventListener("keydown", (event) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(null);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(event.key === "ArrowDown" ? 1 : -1);
      }
    });
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = selectedScopes();
      if (selected.length > 0) close(selected);
    });

    const selectionSummary = document.createElement("div");
    selectionSummary.className = "aaronnote-latex-export-selection-summary";
    selectionSummary.setAttribute("aria-live", "polite");
    panel.appendChild(selectionSummary);
    const actions = document.createElement("div");
    actions.className = "aaronnote-modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => close(null));
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Choose Path";
    actions.append(cancel, submit);
    panel.appendChild(actions);

    const onBackdrop = (event: MouseEvent): void => {
      if (event.target === modal) close(null);
    };
    modal.addEventListener("mousedown", onBackdrop);
    modal.appendChild(panel);
    modal.hidden = false;
    render();
    window.setTimeout(() => {
      if (headingScopes.length > 6) search.focus();
      else list.querySelector<HTMLElement>(`[data-scope-id="${CSS.escape(focusedId)}"]`)?.focus();
    }, 0);
  });
}

function currentPrintablePdfDocument(): { html: string; title: string; defaultPath: string } | null {
  if (!currentFile) return null;
  const note = currentNote();
  const title = note?.title || fileNameFromPath(currentFile).replace(/\.[^.]+$/, "") || "Noema";
  const defaultPath = /\.(?:md|markdown)$/i.test(currentFile)
    ? currentFile.replace(/\.(?:md|markdown)$/i, ".pdf")
    : `${currentFile}.pdf`;
  const html = renderPublishedNoteHTML(currentMarkdownText(), {
    title,
    group: note?.groupLabel || note?.groupKey || "Root",
    date: note?.date || "",
    kind: note?.kind || currentKind || "default",
    format: "pdf",
    root: `${location.origin}/`,
    assetResolver: (source) => window.AaronnoteResolveAssetUrl?.(source) || source,
  });
  return { html, title, defaultPath };
}

async function currentSelfContainedHtmlDocument(): Promise<{ html: string; title: string; defaultPath: string } | null> {
  if (!currentFile) return null;
  const note = currentNote();
  const title = note?.title || fileNameFromPath(currentFile).replace(/\.[^.]+$/, "") || "Noema";
  const defaultPath = /\.(?:md|markdown)$/i.test(currentFile)
    ? currentFile.replace(/\.(?:md|markdown)$/i, ".html")
    : `${currentFile}.html`;
  const themeId = document.documentElement.dataset.noemaTheme || "aaronnote";
  const lightThemes = new Set(["claude", "daylight", "mediki"]);
  const html = await createSelfContainedNoteHTML(currentMarkdownText(), {
    title,
    group: note?.groupLabel || note?.groupKey || "Root",
    date: note?.date || "",
    kind: note?.kind || currentKind || "default",
    themeId,
    alternateThemeId: lightThemes.has(themeId) ? "aaronnote" : "daylight",
    assetResolver: (source) => window.AaronnoteResolveAssetUrl?.(source) || source,
    document,
    baseUrl: location.href,
  });
  return { html, title, defaultPath };
}

if (desktopMode && initialParams.get("desktopPrintProbe") === "1") {
  window.__noemaDesktopPrintDocument = currentPrintablePdfDocument;
}

async function exportPdfTool(): Promise<void> {
  if (!window.noemaDesktop?.exportPdf) {
    setStatus("PDF export is available in Noema.app");
    return;
  }
  finishInlineMathEditing(editor.view);
  const printable = currentPrintablePdfDocument();
  if (!printable) {
    setStatus("Open a desktop note before exporting PDF");
    return;
  }
  setStatus("Choose PDF output path…");
  try {
    const result = await window.noemaDesktop.exportPdf(printable);
    if (result.canceled) {
      setStatus("PDF export canceled");
      return;
    }
    setStatus(`Exported PDF · ${fileNameFromPath(result.path)}`);
  } catch (error) {
    setStatus(`PDF export failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exportHtmlTool(): Promise<void> {
  if (!window.noemaDesktop?.exportHtml) {
    setStatus("Self-contained HTML export is available in Noema.app");
    return;
  }
  finishInlineMathEditing(editor.view);
  setStatus("Preparing self-contained HTML…");
  try {
    const standalone = await currentSelfContainedHtmlDocument();
    if (!standalone) {
      setStatus("Open a desktop note before exporting HTML");
      return;
    }
    const result = await window.noemaDesktop.exportHtml(standalone);
    if (result.canceled) {
      setStatus("HTML export canceled");
      return;
    }
    setStatus(`Exported HTML · ${fileNameFromPath(result.path)}`);
  } catch (error) {
    setStatus(`HTML export failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exportLatexTool(): Promise<void> {
  if (!currentFile) {
    setStatus("Open a note before exporting LaTeX");
    return;
  }

  const markdown = currentMarkdownText();
  const selection = editor.getMarkdownSelection();
  const allHeadings = markdownHeadingsFromText(editor.view.state.doc);
  const scopes = buildLatexExportScopes({
    markdown,
    headings: allHeadings,
    selection,
    cursor: editor.view.state.selection.main.head,
  });
  const chosenScopes = await openLatexScopeModal(scopes);
  if (!chosenScopes) {
    setStatus("LaTeX export canceled");
    return;
  }

  const content = latexExportScopesContent(markdown, chosenScopes);
  const title = fileNameFromPath(currentFile).replace(/\.[^.]+$/, "") || "Noema";
  const scope = chosenScopes.length === 1 ? chosenScopes[0]!.kind : "headings";

  try {
    const defaultInfo = await api.latex.defaults({ file: currentFile, title });

    // 1. Pick a template. Defaults to the last one used for this note, else Article.
    let templates: LatexTemplate[] = [];
    try {
      templates = (await api.latex.templates()).templates || [];
    } catch {
      templates = [];
    }
    let chosenTemplate: LatexTemplate | null = null;
    if (templates.length > 0) {
      const rememberedFile = String(defaultInfo.template || "");
      const fallback =
        templates.find((t) => t.key === "noema-article")
        || templates.find((t) => t.key === "aaronnote-article")
        || templates[0]!;
      const preselect = templates.find((t) => t.file === rememberedFile) || fallback;
      const picked = await openFormModal("Export LaTeX — template", [{
        id: "template",
        label: "Template",
        type: "select",
        value: preselect.key,
        options: templates.map((t) => ({ value: t.key, label: `${t.name} (${t.engine})` })),
      }], "Continue");
      if (!picked) {
        setStatus("LaTeX export canceled");
        return;
      }
      chosenTemplate = templates.find((t) => t.key === picked.template) || preselect;
    }

    // 2. Collect template-declared variables (course code, student id, …).
    const rememberedVars = (defaultInfo.vars && typeof defaultInfo.vars === "object" ? defaultInfo.vars : {}) as Record<string, string>;
    let vars: Record<string, string> = {};
    if (chosenTemplate && chosenTemplate.vars.length > 0) {
      const filled = await openFormModal(
        `${chosenTemplate.name} — fields`,
        chosenTemplate.vars.map((v) => ({
          id: v.id,
          label: v.label || v.id,
          type: v.input === "select" ? "select" as const : "text" as const,
          options: v.options,
          required: v.required,
          placeholder: v.placeholder,
          description: v.description,
          group: v.group,
          value: rememberedVars[v.id] ?? v.default ?? "",
        })),
        "Continue",
      );
      if (!filled) {
        setStatus("LaTeX export canceled");
        return;
      }
      vars = filled;
    }

    // 3. Choose the output path, then export.
    setStatus("Choose LaTeX output path...");
    const chosen = desktopPlatform === "win32" && window.noemaDesktop?.chooseSavePath
      ? await window.noemaDesktop.chooseSavePath({
        title: "Export LaTeX as",
        defaultPath: String(defaultInfo.outputPath || ""),
        extension: "tex",
      })
      : await api.latex.chooseOutputPath({
        file: currentFile,
        title,
        defaultPath: defaultInfo.outputPath || "",
      });
    if (chosen.canceled) {
      setStatus("LaTeX export canceled");
      return;
    }
    if (chosen.ok === false || !chosen.path) {
      setStatus(`LaTeX export failed: ${String(chosen.message || "output path was not selected")}`);
      return;
    }
    setStatus("Exporting LaTeX…");
    await api.latex.export({
      file: currentFile,
      content,
      documentContent: currentMarkdownText(),
      outputPath: String(chosen.path),
      title,
      scope,
      ...(chosenTemplate ? { templatePath: chosenTemplate.file, engine: chosenTemplate.engine } : {}),
      ...(Object.keys(vars).length > 0 ? { vars } : {}),
    });
    setStatus("LaTeX export added to tasks");
  } catch (err) {
    setStatus(`LaTeX export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function latexExportAgentLabel(id: string): string {
  switch (id) {
    case "claude": return "Claude";
    case "opencode": return "OpenCode";
    case "codex":
    default: return "Codex";
  }
}

function latexExportAgentOptions(status: LatexExportAgentStatus): { value: string; label: string }[] {
  const agents = status.agents?.length
    ? status.agents
    : ["codex", "claude", "opencode"].map((id) => ({ id, label: latexExportAgentLabel(id), current: id === status.agent }));
  return agents.map((agent) => {
    const id = String(agent.id || "").trim();
    const suffix = [
      agent.current ? "current" : "",
      agent.available === false ? "unavailable" : "",
    ].filter(Boolean).join(", ");
    return {
      value: id,
      label: `${agent.label || latexExportAgentLabel(id)}${suffix ? ` (${suffix})` : ""}`,
    };
  }).filter((option) => option.value);
}

async function switchLatexExportAgentTool(): Promise<void> {
  setStatus("Loading LaTeX export agents...");
  try {
    const status = await api.latex.agentStatus();
    const current = String(status.agent || "codex");
    const picked = await openFormModal("LaTeX export agent", [{
      id: "agent",
      label: "Agent backend",
      type: "select",
      value: current,
      options: latexExportAgentOptions(status),
    }], "Switch");
    if (!picked) {
      setStatus("LaTeX export agent switch canceled");
      return;
    }
    const next = await api.latex.setAgent({ agent: picked.agent });
    setStatus(`LaTeX export agent: ${latexExportAgentLabel(String(next.agent || picked.agent))}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "LaTeX export agent switch failed");
  }
}

async function updateNoteMeta(
  action: (body: Record<string, unknown>) => Promise<Awaited<ReturnType<typeof api.notes.bootstrap>>>,
  body: Record<string, unknown>,
  success: string,
): Promise<void> {
  if (!currentFile) {
    setStatus("No current note");
    return;
  }
  setStatus("Updating note");
  try {
    const msg = await action({
      file: currentFile,
      content: editor.getMarkdown(),
      ...body,
    });
    applyOpenedNote(msg, currentFile);
    setStatus(success);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Update failed");
  }
}

async function quickAddMeta(): Promise<void> {
  const project = currentFileProjectFromMarkdown();
  const projectSuggestions = await agendaProjectSuggestionsWithGlobal(agendaNodes(), project);
  const tags = await databaseTagSuggestions();
  const result = await openFormModal("Quick add meta", [
    { id: "title", label: "Title", value: currentNote()?.title || fileLabel.textContent || "Untitled" },
    { id: "project", label: "Project", type: "suggest", value: project, suggestions: projectSuggestions },
    { id: "tags", label: "Tags", type: "tags", value: (currentNote()?.tags || []).join(", "), suggestions: tags },
  ], "Register");
  if (!result) return;
  await updateNoteMeta(api.meta.add, {
    title: result.title,
    project: result.project,
    tags: parseTagPrompt(result.tags),
    kind: currentKind || "default",
  }, "Meta registered");
}

async function unregisterMeta(): Promise<void> {
  const result = await openFormModal("Unregister meta", [
    { id: "confirm", label: "Type REMOVE to delete roam meta", value: "" },
  ], "Remove");
  if (result?.confirm !== "REMOVE") return;
  await updateNoteMeta(api.meta.remove, {}, "Meta unregistered");
}

async function commitCurrentMetadataEdit(
  edit: ReturnType<typeof planMarkdownTagChanges>,
  success: string,
  unchanged: string,
): Promise<void> {
  if (!edit.changed) {
    setStatus(unchanged);
    return;
  }
  editor.preserveViewport(() => {
    editor.view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert } });
  });
  setStatus(success);
  await save();
}

async function addTag(): Promise<void> {
  if (!currentFile) {
    setStatus("No current note");
    return;
  }
  const suggestions = await databaseTagSuggestions();
  let changes: TagChangeSet = { add: [], remove: [] };
  const result = await openFormModal("Add tag", [
    {
      id: "tags",
      label: "Tags",
      type: "tags",
      tagValues: [],
      suggestions,
      onTagChanges: (next) => { changes = next; },
    },
  ], "Add");
  if (!result) return;
  const edit = planMarkdownTagChanges(currentMarkdownText(), changes);
  await commitCurrentMetadataEdit(edit, "Tags added to document", "No tags added");
}

async function manageNoteTags(): Promise<void> {
  if (!currentFile) {
    setStatus("No current note");
    return;
  }
  const fileTags = metadataTagsFromMarkdown(currentMarkdownText()) ?? [];
  const project = currentFileProjectFromMarkdown();
  const projectSuggestions = await agendaProjectSuggestionsWithGlobal(agendaNodes(), project);
  const tags = await databaseTagSuggestions();
  let tagChanges: TagChangeSet = { add: [], remove: [] };
  const result = await openFormModal("Note meta", [
    { id: "project", label: "Project", type: "suggest", value: project, suggestions: projectSuggestions },
    {
      id: "tags",
      label: "Tags",
      type: "tags",
      tagValues: fileTags,
      suggestions: tags,
      onTagChanges: (next) => { tagChanges = next; },
    },
  ], "Update");
  if (!result) return;
  const edit = planMarkdownMetadataChanges(currentMarkdownText(), {
    tags: tagChanges,
    project: result.project,
  });
  await commitCurrentMetadataEdit(edit, "Metadata updated in document", "Metadata unchanged");
}

async function manageCurrentNoteTags(): Promise<void> {
  if (!currentFile) {
    setStatus("No current note");
    return;
  }
  const note = currentNote();
  const fileTags = metadataTagsFromMarkdown(currentMarkdownText()) ?? [];
  const title = note?.title || fileLabel.textContent || fileNameFromPath(currentFile) || "Untitled";
  const suggestions = await databaseTagSuggestions();
  let changes: TagChangeSet = { add: [], remove: [] };
  const result = await openFormModal(`Tags — ${title}`, [{
    id: "tags",
    label: "File tags",
    type: "tags",
    tagValues: fileTags,
    suggestions,
    placeholder: "Search or type a new tag…",
    description: "Type a new tag and press Enter to create it; use ↑/↓ for existing tags, or click × to remove.",
    onTagChanges: (next) => { changes = next; },
  }], "Save tags");
  if (!result) return;
  const edit = planMarkdownTagChanges(currentMarkdownText(), changes);
  await commitCurrentMetadataEdit(edit, "Tags updated in document", "File tags unchanged");
}

async function insertRoamIdLink(): Promise<void> {
  const selection = editor.getMarkdownSelection();
  const selected = selection.from === selection.to ? "" : editor.textBetween(selection.from, selection.to).trim();
  pendingKnowledgeInsert = { from: selection.from, to: selection.to, selected };
  showKnowledgeSearch();
  setStatus("Search for a note to insert");
}

function activeDisplayMathTarget(): { tex: string; replace: (nextTex: string) => void } | null {
  const state = editor.view.state;
  const cursor = state.selection.main.from;
  const range = rangeAtPosition(cursor, getBlockMathRanges(state));
  if (!range || cursor <= range.from || cursor >= range.to) return null;
  return {
    tex: range.tex,
    replace: (nextTex: string) => editor.replaceMarkdownRange(range.contentFrom, range.contentTo, nextTex, "end"),
  };
}

function existingLatexTag(tex: string): string {
  return tex.match(/\\tag\s*\{([^{}\n]+)\}/)?.[1]?.trim() || "";
}

function upsertLatexTag(tex: string, tag: string): string {
  const clean = tex.replace(/\s*\\tag\s*\{[^{}\n]*\}/g, "").replace(/\s+$/g, "");
  const separator = clean.includes("\n") ? "\n" : " ";
  return `${clean}${separator}\\tag{${tag}}`;
}

async function tagOrCopyRef(): Promise<void> {
  const math = activeDisplayMathTarget();
  if (math) {
    const existing = existingLatexTag(math.tex);
    if (existing) {
      await copyText(equationReferenceMarkdown(existing));
      setStatus(`Equation ref copied: ${existing}`);
      return;
    }
    const result = await openFormModal("Equation tag", [
      { id: "tag", label: "LaTeX tag", value: nextAnchorTagSuggestion("equation"), suggestions: allAnchorTagSuggestions() },
    ], "Tag & Copy Ref");
    if (!result?.tag) return;
    const tag = normalizeInlineTag(result.tag);
    math.replace(upsertLatexTag(math.tex, tag));
    await copyText(equationReferenceMarkdown(tag));
    setStatus(`Equation tag ${tag}; ref copied`);
    scheduleAssistUpdate({ mathPreview: true, toc: true });
    return;
  }

  const block = orgEnvBlockIdentityAtPosition(editor.view.state, editor.getMarkdownSelection().from);
  if (block) {
    await copyText(blockReferenceMarkdown(block));
    setStatus(`Block ref copied: #${block.id.slice(-6)}`);
    return;
  }

  const inline = inlineTagAtCursor();
  if (inline) {
    await copyText(inlineTagReferenceMarkdown(inline));
    setStatus(`Inline anchor ref copied: ${inline}`);
    return;
  }

  const result = await openFormModal("Inline anchor", [
    { id: "tag", label: "Anchor tag", value: nextAnchorTagSuggestion("inline"), suggestions: allAnchorTagSuggestions() },
  ], "Tag & Copy Ref");
  if (!result?.tag) return;
  const tag = normalizeInlineTag(result.tag);
  const selection = editor.getMarkdownSelection();
  editor.replaceMarkdownRange(selection.to, selection.to, inlineTagMarkdown(tag), "end");
  await copyText(inlineTagReferenceMarkdown(tag));
  setStatus(`Inline anchor ${tag}; ref copied`);
  scheduleAssistUpdate({ snippets: true, toc: true });
}

function changedRows(changed: unknown): Array<{ title: string; detail?: string; kind?: string }> {
  return (Array.isArray(changed) ? changed : []).slice(0, 80).map((item) => {
    const value = item as { title?: string; path?: string; file?: string; count?: number; tags?: string[] };
    return {
      title: value.title || value.path || value.file || "Untitled",
      detail: [
        value.path || value.file || "",
        typeof value.count === "number" ? `${value.count} refs` : "",
        Array.isArray(value.tags) ? value.tags.join(", ") : "",
      ].filter(Boolean).join(" - "),
      kind: typeof value.count === "number" ? "REF" : "TAG",
    };
  });
}

function showRoamToolRows(title: string, rows: Array<{ title: string; detail?: string; kind?: string }>): void {
  roamToolsTitle.textContent = title;
  const frag = document.createDocumentFragment();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-empty";
    empty.textContent = "No issues";
    frag.appendChild(empty);
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "aaronnote-roam-tool-item";
    const kind = document.createElement("span");
    kind.className = "aaronnote-roam-tool-kind";
    kind.textContent = row.kind || "ROAM";
    const body = document.createElement("div");
    body.className = "aaronnote-roam-tool-body";
    const titleEl = document.createElement("strong");
    titleEl.textContent = row.title;
    body.appendChild(titleEl);
    if (row.detail) {
      const detail = document.createElement("span");
      detail.textContent = row.detail;
      body.appendChild(detail);
    }
    item.append(kind, body);
    frag.appendChild(item);
  }
  roamToolsList.replaceChildren(frag);
  roamToolsPanel.classList.remove("is-agenda");
  roamToolsPanel.hidden = false;
}

type AgendaMode = "open" | "all" | "done" | "cancelled" | "today" | "overdue";
type TodoTarget = { index?: number; line?: number; source?: string };

let agendaTodos: TodoItem[] = [];
let agendaMode: AgendaMode = "open";
let agendaQuery = "";

function todoString(todo: TodoItem, ...keys: string[]): string {
  for (const key of keys) {
    const value = todo[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function todoStatus(todo: TodoItem): string {
  const status = todoString(todo, "status").toLowerCase();
  if (!status || status === "open" || status === "unchecked") return "todo";
  if (status === "cancel" || status === "canceled") return "cancelled";
  if (status === "complete" || status === "completed") return "done";
  return status;
}

function todoDate(todo: TodoItem): string {
  return todoString(todo, "ddl", "deadline", "due", "date").slice(0, 10);
}

function todoClosed(todo: TodoItem): boolean {
  return ["done", "cancelled"].includes(todoStatus(todo));
}

function todoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function todoOverdue(todo: TodoItem): boolean {
  const date = todoDate(todo);
  return !!date && date < todoToday() && !todoClosed(todo);
}

function todoTitle(todo: TodoItem): string {
  return todoString(todo, "title", "noteTitle", "note", "noteId", "path", "file") || "Untitled";
}

function todoText(todo: TodoItem): string {
  return todoString(todo, "text", "context", "source") || "(empty todo)";
}

function todoTags(todo: TodoItem): string[] {
  const tags = Array.isArray(todo.tags) ? todo.tags : [];
  const inlineTags = Array.isArray(todo.inlineTags) ? todo.inlineTags : [];
  return [...tags, ...inlineTags].map(String).filter(Boolean);
}

function todoHaystack(todo: TodoItem): string {
  return [
    todoStatus(todo),
    todoDate(todo),
    todoTitle(todo),
    todoText(todo),
    todoString(todo, "id", "noteId", "roamId", "path", "file"),
    ...todoTags(todo),
  ].join(" ").toLowerCase();
}

function agendaMatchesQuery(todo: TodoItem): boolean {
  const query = agendaQuery.trim().toLowerCase();
  if (!query) return true;
  return query.split(/\s+/).every((term) => todoHaystack(todo).includes(term));
}

function agendaVisibleTodos(): TodoItem[] {
  return agendaTodos.filter((todo) => {
    if (!agendaMatchesQuery(todo)) return false;
    switch (agendaMode) {
      case "all": return true;
      case "done": return todoStatus(todo) === "done";
      case "cancelled": return todoStatus(todo) === "cancelled";
      case "today": return !todoClosed(todo) && todoDate(todo) === todoToday();
      case "overdue": return todoOverdue(todo);
      case "open":
      default: return !todoClosed(todo);
    }
  }).sort((a, b) => {
    const ad = todoDate(a) || "9999-99-99";
    const bd = todoDate(b) || "9999-99-99";
    return ad.localeCompare(bd)
      || todoStatus(a).localeCompare(todoStatus(b))
      || todoTitle(a).localeCompare(todoTitle(b))
      || todoText(a).localeCompare(todoText(b));
  });
}

function agendaCounts(): Record<AgendaMode, number> {
  return {
    open: agendaTodos.filter((todo) => !todoClosed(todo)).length,
    all: agendaTodos.length,
    done: agendaTodos.filter((todo) => todoStatus(todo) === "done").length,
    cancelled: agendaTodos.filter((todo) => todoStatus(todo) === "cancelled").length,
    today: agendaTodos.filter((todo) => !todoClosed(todo) && todoDate(todo) === todoToday()).length,
    overdue: agendaTodos.filter(todoOverdue).length,
  };
}

function todoTargetFromItem(todo: TodoItem): TodoTarget {
  return {
    index: typeof todo.index === "number" ? todo.index : undefined,
    line: typeof todo.line === "number" ? todo.line : undefined,
    source: todoString(todo, "source"),
  };
}

// Resolve a todo's source range in the live editor document. Prefers the
// scanned offset, falls back to a source/line search so it survives small drifts.
function todoRangeInEditor(target: TodoTarget): { from: number; to: number } | null {
  const doc = editor.getMarkdown();
  const source = target.source || "";
  const firstLine = source.split("\n")[0] || "";
  if (typeof target.index === "number" && target.index >= 0 && target.index <= doc.length) {
    if (source && doc.slice(target.index, target.index + source.length) === source) {
      return { from: target.index, to: target.index + source.length };
    }
    if (firstLine && doc.slice(target.index, target.index + firstLine.length) === firstLine) {
      return { from: target.index, to: target.index + firstLine.length };
    }
  }
  if (firstLine) {
    const found = doc.indexOf(firstLine);
    if (found >= 0) return { from: found, to: found + firstLine.length };
  }
  if (typeof target.line === "number" && target.line > 0) {
    let from = 0;
    for (let line = 1; line < target.line; line += 1) {
      const next = doc.indexOf("\n", from);
      if (next < 0) { from = -1; break; }
      from = next + 1;
    }
    if (from >= 0 && from <= doc.length) return { from, to: from };
  }
  return null;
}

function jumpToTodoTarget(target: TodoTarget): boolean {
  const range = todoRangeInEditor(target);
  if (!range) return false;
  editor.setMarkdownSelection(range.from, Math.min(range.to, editor.getMarkdownLength()));
  editor.revealCursor();
  editor.focus();
  noteCursorPositionEvent();
  return true;
}

function agendaOpenTodo(todo: TodoItem): void {
  const file = todoString(todo, "file");
  if (!file) return;
  const target = todoTargetFromItem(todo);
  closeRoamToolsPanel();
  if (sameOpenFile(file)) {
    if (!jumpToTodoTarget(target)) setStatus("Todo location not found");
    return;
  }
  pendingTodoTarget = target;
  void openFile(file);
}

function toggleAgendaSurface(): void {
  if (!roamToolsPanel.hidden && roamToolsPanel.classList.contains("is-agenda")) closeRoamToolsPanel();
  else void openAgendaTool();
}

function todoStatusSourcePrefix(status: string, commandName = "todo"): string {
  const s = (status || "todo").toLowerCase();
  const command = commandName.toLowerCase() === "itodo" ? "itodo" : "todo";
  return s === "todo" || s === "open" || s === "unchecked" ? `@@${command} ` : `@@${command}(${s}) `;
}

type TodoUpdateResult = {
  file?: string;
  from?: number;
  to?: number;
  source?: string;
  nextSource?: string;
  mtimeMs?: number;
};

function fileBasename(path: string): string {
  return String(path || "").split(/[\\/]/).pop() || String(path || "");
}

// True when two paths point at the open note. `todo.file`/`result.file` come
// from different server normalizations than `currentFile`, so exact-string
// comparison alone is too strict; fall back to basename equality.
function sameOpenFile(path: string): boolean {
  const file = String(path || "");
  if (!file || !currentFile) return false;
  return file === currentFile || fileBasename(file) === fileBasename(currentFile);
}

// Reflect a status change in the open editor so the CM6 page updates immediately
// instead of going stale until the next reload. The server already wrote the same
// change to disk, so we suppress dirty tracking and resync mtime to avoid a false
// save conflict. The change is located by the server's exact offset+source first,
// then by a source-text search so it survives unsaved-edit drift.
function applyTodoStatusInEditor(todo: TodoItem, status: string, result: TodoUpdateResult): void {
  if (!sameOpenFile(result.file || todoString(todo, "file"))) return;
  const doc = editor.getMarkdown();
  const docLen = doc.length;
  const oldSource = String(result.source || todoString(todo, "source") || "");
  let from = -1;
  let to = -1;
  const serverFrom = Number(result.from);
  const serverTo = Number(result.to);
  // 1) exact server offsets when the source still matches there
  if (oldSource && Number.isInteger(serverFrom) && serverFrom >= 0 && serverTo > serverFrom
    && serverTo <= docLen && doc.slice(serverFrom, serverTo) === oldSource) {
    from = serverFrom;
    to = serverTo;
  }
  // 2) scanned offset on the todo item
  if (from < 0 && oldSource && typeof todo.index === "number"
    && todo.index >= 0 && todo.index + oldSource.length <= docLen
    && doc.slice(todo.index, todo.index + oldSource.length) === oldSource) {
    from = todo.index;
    to = todo.index + oldSource.length;
  }
  // 3) source-text search (survives offset drift from unsaved edits)
  if (from < 0 && oldSource) {
    const found = doc.indexOf(oldSource);
    if (found >= 0) { from = found; to = found + oldSource.length; }
  }
  // 4) last resort: line/index range finder
  if (from < 0) {
    const range = todoRangeInEditor(todoTargetFromItem(todo));
    if (!range) return;
    from = range.from;
    to = range.to;
  }
  const current = editor.markdownBetween(from, to);
  const next = result.nextSource && current === oldSource
    ? String(result.nextSource)
    : current.replace(/^@@(todo|itodo)(?:\([^)\n]*\))?[ \t]+/i, (_match, command) => todoStatusSourcePrefix(status, command));
  if (next === current) return;
  applyingContent = true;
  editor.replaceMarkdownRange(from, to, next);
  applyingContent = false;
  const mtimeMs = Number(result.mtimeMs) || 0;
  if (mtimeMs) {
    currentMtimeMs = mtimeMs;
    // The patch API returns an mtime but no content fingerprint. The editor
    // applied the same patch locally, so use that exact mtime as the next
    // conflict baseline instead of retaining the pre-patch fingerprint.
    currentVersion = "";
  }
  updateTitle();
}

async function agendaUpdateTodo(todo: TodoItem, status: string): Promise<void> {
  try {
    const result = await api.notes.updateTodo({
      file: todoString(todo, "file"),
      id: todoString(todo, "id"),
      index: todo.index,
      source: todoString(todo, "source"),
      text: todoText(todo),
      status,
    }) as TodoUpdateResult;
    applyTodoStatusInEditor(todo, status, result);
    const payload = await api.notes.todos(currentFile);
    agendaTodos = Array.isArray(payload.todos) ? payload.todos : [];
    renderAgendaTool();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Todo update failed");
  }
}

function renderAgendaTool(): void {
  roamToolsTitle.textContent = "Agenda";
  const counts = agendaCounts();
  const visible = agendaVisibleTodos();
  const rootEl = document.createElement("div");
  rootEl.className = "aaronnote-agenda-tool";

  const filters = document.createElement("div");
  filters.className = "aaronnote-agenda-filters";
  const filterLabels: Array<[AgendaMode, string]> = [
    ["open", "Open"],
    ["today", "Today"],
    ["overdue", "Overdue"],
    ["all", "All"],
    ["done", "Done"],
    ["cancelled", "Cancelled"],
  ];
  for (const [mode, label] of filterLabels) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = mode === agendaMode ? "is-active" : "";
    button.textContent = `${label} ${counts[mode]}`;
    button.addEventListener("click", () => {
      agendaMode = mode;
      renderAgendaTool();
    });
    filters.appendChild(button);
  }

  const search = document.createElement("input");
  search.type = "search";
  search.value = agendaQuery;
  search.placeholder = "Search status, tag, title, roam id, file, date...";
  search.addEventListener("input", () => {
    agendaQuery = search.value;
    renderAgendaTool();
  });
  filters.appendChild(search);
  rootEl.appendChild(filters);

  const subnav = document.createElement("div");
  subnav.className = "aaronnote-agenda-subnav";
  const fullAgenda = document.createElement("button");
  fullAgenda.type = "button";
  fullAgenda.textContent = "Full Agenda";
  fullAgenda.addEventListener("click", () => {
    window.location.href = "/agenda?view=agenda";
  });
  subnav.appendChild(fullAgenda);
  rootEl.appendChild(subnav);

  const meta = document.createElement("div");
  meta.className = "aaronnote-agenda-meta";
  meta.textContent = `${visible.length} shown - ${todoToday()}`;
  rootEl.appendChild(meta);

  const list = document.createElement("div");
  list.className = "aaronnote-agenda-list";
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-empty";
    empty.textContent = "No matching tasks";
    list.appendChild(empty);
  }
  for (const todo of visible) {
    const row = document.createElement("div");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.className = "aaronnote-agenda-row";
    row.dataset.status = todoStatus(todo);
    row.addEventListener("click", () => agendaOpenTodo(todo));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        agendaOpenTodo(todo);
      }
    });

    const status = document.createElement("span");
    status.className = "aaronnote-agenda-status";
    status.textContent = todoStatus(todo).toUpperCase();

    const date = document.createElement("span");
    date.className = "aaronnote-agenda-date";
    date.textContent = todoDate(todo) || "no date";

    // Single-file agenda: the note title/file is redundant, so show only the
    // todo text itself.
    const body = document.createElement("span");
    body.className = "aaronnote-agenda-body";
    const text = document.createElement("span");
    text.textContent = todoText(todo);
    body.append(text);

    const line = document.createElement("span");
    line.className = "aaronnote-agenda-line";
    const lineValue = typeof todo.line === "number" ? todo.line : "";
    line.textContent = lineValue ? `L${lineValue}` : "";

    const actions = document.createElement("span");
    actions.className = "aaronnote-agenda-actions";
    const closed = todoClosed(todo);
    const actionLabels: Array<[string, string]> = closed
      ? [["Reopen", "todo"], ["Doing", "doing"]]
      : [["Done", "done"], ["Cancel", "cancelled"]];
    for (const [label, nextStatus] of actionLabels) {
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = label;
      action.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void agendaUpdateTodo(todo, nextStatus);
      });
      actions.appendChild(action);
    }

    row.append(status, date, body, line, actions);
    list.appendChild(row);
  }
  rootEl.appendChild(list);
  roamToolsList.replaceChildren(rootEl);
  roamToolsPanel.classList.add("is-agenda");
  roamToolsPanel.hidden = false;
  agendaButton.setAttribute("aria-expanded", "true");
}

async function openAgendaTool(): Promise<void> {
  try {
    roamToolsTitle.textContent = "Agenda";
    roamToolsList.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "aaronnote-empty";
    loading.textContent = "Loading agenda...";
    roamToolsList.appendChild(loading);
    roamToolsPanel.classList.add("is-agenda");
    roamToolsPanel.hidden = false;
    const payload = await api.notes.todos(currentFile);
    agendaTodos = Array.isArray(payload.todos) ? payload.todos : [];
    agendaMode = "open";
    renderAgendaTool();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Agenda failed");
  }
}

async function renameRoamTagTool(): Promise<void> {
  const suggestions = await databaseTagSuggestions();
  const result = await openFormModal("Rename roam tag", [
    { id: "from", label: "Current tag", type: "tag", value: "", suggestions },
    { id: "to", label: "New tag", value: "" },
    { id: "confirm", label: "Type RENAME to update all roam notes", value: "" },
  ], "Rename");
  if (!result || result.confirm !== "RENAME") return;
  setStatus("Renaming roam tag");
  try {
    const msg = await api.roamTools.renameTag({ from: parseTagPrompt(result.from)[0] || result.from, to: result.to });
    applyIndexPayload(msg as { notes?: NoteSummary[] });
    showRoamToolRows(`Renamed ${msg.changedCount ?? 0} notes`, changedRows(msg.changed));
    setStatus(`Renamed tag in ${msg.changedCount ?? 0} notes`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Roam tag rename failed");
  }
}

async function deleteRoamTagTool(): Promise<void> {
  const suggestions = await databaseTagSuggestions();
  const result = await openFormModal("Delete roam tag", [
    { id: "tag", label: "Tag", type: "tag", value: "", suggestions },
    { id: "confirm", label: "Type DELETE to remove it from all roam notes", value: "" },
  ], "Delete");
  if (!result || result.confirm !== "DELETE") return;
  setStatus("Deleting roam tag");
  try {
    const msg = await api.roamTools.deleteTag({ tag: parseTagPrompt(result.tag)[0] || result.tag });
    applyIndexPayload(msg as { notes?: NoteSummary[] });
    showRoamToolRows(`Deleted tag from ${msg.changedCount ?? 0} notes`, changedRows(msg.changed));
    setStatus(`Deleted tag from ${msg.changedCount ?? 0} notes`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Roam tag delete failed");
  }
}

async function tagOverlapReportTool(): Promise<void> {
  setStatus("Scanning tag overlap");
  try {
    const report = await api.roamTools.tagOverlap();
    const duplicateRows = (Array.isArray(report.duplicateCase) ? report.duplicateCase : []).map((item) => {
      const value = item as { variants?: string[] };
      return { title: `Case variants: ${(value.variants || []).join(" / ")}`, detail: "Use Rename tag to normalize these", kind: "CASE" };
    });
    const overlapRows = (Array.isArray(report.overlaps) ? report.overlaps : []).map((item) => {
      const value = item as { a?: string; b?: string; aCount?: number; bCount?: number; sharedCount?: number; containment?: number };
      return {
        title: `${value.a || ""} overlaps ${value.b || ""}`,
        detail: `${value.sharedCount ?? 0} shared - ${value.aCount ?? 0}/${value.bCount ?? 0} notes - ${Math.round((value.containment ?? 0) * 100)}% containment`,
        kind: "TAG",
      };
    });
    showRoamToolRows(`Tag overlap (${report.tagCount ?? 0} tags)`, [...duplicateRows, ...overlapRows]);
    setStatus("Tag overlap scanned");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Tag overlap scan failed");
  }
}

async function rewritePathRefsTool(): Promise<void> {
  const result = await openFormModal("Rewrite path references", [
    { id: "oldPath", label: "Old target path", value: "", suggestions: pathSuggestions },
    { id: "newPath", label: "New target path", value: "", suggestions: pathSuggestions },
    { id: "confirm", label: "Type UPDATE to rewrite Markdown path links", value: "" },
  ], "Update");
  if (!result || result.confirm !== "UPDATE") return;
  setStatus("Rewriting path references");
  try {
    const msg = await api.roamTools.rewritePathRefs({ oldPath: result.oldPath, newPath: result.newPath });
    applyIndexPayload(msg as { notes?: NoteSummary[] });
    showRoamToolRows(`Rewrote ${msg.referenceCount ?? 0} references`, changedRows(msg.changed));
    setStatus(`Rewrote ${msg.referenceCount ?? 0} references`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Path reference rewrite failed");
  }
}

type ToolAction = {
  id: string;
  group: "document" | "view" | "writing" | "publish" | "knowledge" | "maintenance";
  title: string;
  detail: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
};

const TOOL_GROUPS: Array<{ id: ToolAction["group"]; label: string }> = [
  { id: "document", label: "Document" },
  { id: "view", label: "View & layout" },
  { id: "writing", label: "Writing & review" },
  { id: "publish", label: "Present & export" },
  { id: "knowledge", label: "Knowledge base" },
  { id: "maintenance", label: "Maintenance & settings" },
];

async function trashCurrentNoteTool(): Promise<void> {
  if (!currentFile || currentReadOnly || serverReaderMode) {
    setStatus(currentReadOnly ? "Read-only pane" : "Open a note first");
    return;
  }
  const deletingFile = currentFile;
  const name = fileNameFromPath(deletingFile);
  const result = await openFormModal(`Move document to ${platformLabels.trash}`, [{
    id: "confirm",
    label: `Type TRASH to move ${name} to the ${platformLabels.trash}`,
    required: true,
    placeholder: "TRASH",
    description: revision !== savedRevision
      ? "This document has unsaved changes. They will not be saved before it is moved."
      : `The document remains recoverable from the ${platformLabels.trash}.`,
  }], `Move to ${platformLabels.trash}`);
  if (!result) return;
  if (result.confirm.trim() !== "TRASH") {
    setStatus("Type TRASH exactly to move the document");
    return;
  }
  setStatus(`Moving ${name} to ${platformLabels.trash}...`);
  try {
    const deleted = await api.notes.trash(deletingFile);
    const remaining = (deleted.notes ?? []).find((note) => note.file && note.file !== deletingFile);
    applyIndexPayload(deleted);
    revision = 0;
    savedRevision = 0;
    currentFile = "";
    copilotFileChangeHandlers.forEach((handler) => handler());
    if (remaining?.file) {
      await openFile(remaining.file);
      setStatus(`${name} moved to ${platformLabels.trash}`);
      return;
    }
    const wikiUrl = new URL("/wiki", window.location.origin);
    if (desktopMode) wikiUrl.searchParams.set("host", "desktop");
    window.location.assign(wikiUrl);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Move to Trash failed");
  }
}

async function zoteroImportBibtexTool(): Promise<void> {
  if (!currentFile) {
    setStatus("Open a note before importing Zotero BibTeX");
    return;
  }
  const selection = editor.getMarkdownSelection();
  const query = selection.from !== selection.to
    ? editor.getMarkdown().slice(selection.from, selection.to).trim().slice(0, 500)
    : "";
  const targetFile = (bibliographyModel.references ?? []).find((ref) => ref.entry?.file)?.entry?.file
    || bibliographyModel.namespaces?.find((namespace) => namespace.file)?.file
    || "";
  await api.emacs.zoteroImport({ currentFile, targetFile, query, client: currentClient });
  setStatus("Choose the BibTeX target and Zotero item in Emacs");
}

function applyLanguageToolConfiguration(settings: LanguageToolSettings, settingsRevision = ""): void {
  const changed = JSON.stringify(settings) !== JSON.stringify(languageToolSettings);
  languageToolSettings = { ...settings };
  if (settingsRevision) languageToolRevision = settingsRevision;
  if (!changed) return;
  languageToolHealth = "Not tested";
  proseAutoSuspendedUntil = 0;
  clearProseRetryTimer();
  proseLifecycle.invalidate("settings-changed");
  setProseDiagnostics(editor.view, []);
  hideProsePopover();
  if (languageToolSettings.automaticEnabled) scheduleAutomaticProseCheck();
}

async function loadLanguageToolConfiguration(): Promise<void> {
  const sequence = ++languageToolLoadSequence;
  try {
    const result = await api.proseCheck.settings();
    if (sequence !== languageToolLoadSequence) return;
    if (result.defaults) languageToolDefaults = { ...result.defaults };
    if (result.settings) applyLanguageToolConfiguration(result.settings, result.revision);
  } catch (error) {
    if (sequence === languageToolLoadSequence) languageToolHealth = proseErrorMessage(error);
  }
}

function languageToolActionDetail(): string {
  let server = languageToolSettings.serverUrl;
  try {
    server = new URL(server).host || server;
  } catch {
    // Keep the configured text when it is not yet a valid URL.
  }
  return `${server} · ${languageToolSettings.language} · Auto ${languageToolSettings.automaticEnabled ? "on" : "off"}`;
}

async function languageToolSettingsTool(): Promise<void> {
  const saved = await openLanguageToolSettingsTool({
    modal,
    api: api.proseCheck,
    settings: languageToolSettings,
    defaults: languageToolDefaults,
    revision: languageToolRevision,
    status: languageToolHealth,
    onClose: () => toolsButton.focus(),
  });
  if (!saved) return;
  languageToolLoadSequence += 1;
  applyLanguageToolConfiguration(saved.settings, saved.revision);
  setStatus("LanguageTool settings saved");
}

async function openStandaloneSlideView(): Promise<void> {
  if (!currentFile || currentNoteIsSlides() || !/\.(?:md|markdown)$/i.test(currentFile)) return;
  if (!commitActiveLiveTexForBoundary(false)) return;
  const url = new URL("/slides", window.location.origin);
  url.searchParams.set("file", currentFile);
  // Appine/xwidget cannot reliably navigate an about:blank WindowProxy after
  // an async save. Open the final route while the click gesture is active.
  window.open(url.toString(), "_blank", "noopener,noreferrer");
  setStatus("Opening Slide view");
  if (!currentReadOnly && revision !== savedRevision) {
    if (!noteAutoSaveEnabled(currentRemote)) {
      setStatus("Slide view opened with the last saved version");
      return;
    }
    await save();
    if (revision !== savedRevision) {
      setStatus("Slide view opened with the last saved version");
      return;
    }
  }
}

function currentNoteIsSlides(): boolean {
  return slideDeck?.isSlides() === true || String(currentKind || "").trim().toLowerCase() === "slides";
}

function toolActions(): ToolAction[] {
  const offerSlideView = Boolean(
    currentFile
    && /\.(?:md|markdown)$/i.test(currentFile)
    && !currentNoteIsSlides(),
  );
  const canSetSlideTheme = Boolean(slideDeck && (offerSlideView || currentNoteIsSlides()));
  const slideTheme = slideDeck?.getTheme() ?? "dark";
  const common: ToolAction[] = [
    {
      id: "configuration",
      group: "maintenance",
      title: "Configuration",
      detail: "Themes and application settings",
      run: openConfigurationPage,
    },
    { id: "save", group: "document", title: "Save document", detail: "Write current changes to disk", disabled: currentReadOnly || !currentFile, run: () => void save() },
    { id: "refresh", group: "document", title: "Refresh from disk", detail: "Reload the current document", disabled: !currentFile, run: () => void reloadCurrentFilePreservingCursor({ preserveView: true }) },
    { id: "source", group: "view", title: editor.isSourceMode() ? "Markdown view" : "Source view", detail: "Switch between rendered Markdown and source", run: () => toggleSourceMode() },
    { id: "heading-numbers", group: "view", title: headingNumberingPreference.enabled ? "Hide heading numbers" : "Show heading numbers", detail: `${headingNumberingPreference.format} · visual only`, run: toggleHeadingNumbering },
    {
      id: "open-source-editor",
      group: "document",
      title: `Open in ${sourceEditorName()}`,
      detail: "Open this document in the host source editor",
      disabled: !currentFile,
      run: () => void api.emacs.open({ file: currentFile })
        .then(() => setStatus(`Opened in ${sourceEditorName()}`))
        .catch((error) => setStatus(`Open failed: ${String(error)}`)),
    },
    ...(desktopMode ? [{
      id: "reveal-current-file",
      group: "document" as const,
      title: `Reveal in ${platformLabels.fileManager}`,
      detail: "Show this document in its folder",
      disabled: !currentFile,
      run: () => void window.noemaDesktop?.revealPath(currentFile)
        .then(() => setStatus(`Revealed document in ${platformLabels.fileManager}`))
        .catch((error) => setStatus(`Reveal failed: ${String(error)}`)),
    }] : []),
    { id: "copy-note-path", group: "document", title: "Copy document path", detail: currentFile ? fileNameFromPath(currentFile) : "No document open", disabled: !currentFile, run: () => void copyCurrentNotePath() },
    { id: "trash-note", group: "document", title: `Move document to ${platformLabels.trash}`, detail: "Recoverable deletion from the note root", disabled: currentReadOnly || !currentFile, danger: true, run: () => { runHostCommand({ command: "trash-current-note" }); } },
    ...(offerSlideView ? [{
      id: "slide-view",
      group: "publish" as const,
      title: "Slide view",
      detail: "Present this ordinary Markdown in a new read-only page",
      run: () => void openStandaloneSlideView(),
    }] : []),
    ...(canSetSlideTheme ? [{
      id: "slides-theme",
      group: "publish" as const,
      title: `Slides theme: ${slideTheme === "dark" ? "Dark" : "Light"}`,
      detail: `Switch presentation to ${slideTheme === "dark" ? "light" : "dark"}`,
      run: () => {
        const theme = slideDeck?.toggleTheme();
        if (theme) {
          renderModeToggleLabel(vim.mode());
          setStatus(`Slides ${theme} theme`);
        }
      },
    }] : []),
    ...(slideDeck?.isSlides() ? [{ id: "slides-mirror", group: "publish" as const, title: "Reveal mirror", detail: "Edit this note's .slides JavaScript mirror", run: () => void slideDeck?.openMirror() }] : []),
    { id: "toc", group: "view", title: "Page outline", detail: "Headings from the live CM6 index", run: togglePageOutline },
    { id: "tag-ref", group: "writing", title: "Tag / copy reference", detail: "Equation tag, inline anchor, and reference copy", run: () => void tagOrCopyRef() },
    { id: "format-copy", group: "writing", title: "Copy selection format", detail: "Activate one-shot Markdown format painter", disabled: currentReadOnly, run: () => captureFormatPainter("once") },
    { id: "format-copy-continuous", group: "writing", title: "Copy format continuously", detail: "Keep painting selections until canceled", disabled: currentReadOnly, run: () => captureFormatPainter("continuous") },
    { id: "format-apply", group: "writing", title: "Apply copied format", detail: formatPainterDetail(), disabled: currentReadOnly || !editor.getFormatPainterState(), run: applyFormatPainter },
    { id: "format-cancel", group: "writing", title: "Cancel format painter", detail: formatPainterDetail(), disabled: !editor.getFormatPainterState(), run: () => clearFormatPainter() },
    { id: "export-latex", group: "publish", title: "Export LaTeX", detail: "Write selection, heading, or document to a .tex file", run: () => void exportLatexTool() },
    { id: "latex-export-agent", group: "publish", title: "Switch export agent", detail: "Choose Codex, Claude, or OpenCode for LaTeX polish", run: () => void switchLatexExportAgentTool() },
    { id: "zotero-import-bibtex", group: "writing", title: "Import Zotero BibTeX", detail: "Use the Zotero picker and append to a local .bib file", run: () => void zoteroImportBibtexTool() },
    { id: "languagetool", group: "writing", title: "LanguageTool", detail: languageToolActionDetail(), run: () => void languageToolSettingsTool() },
    { id: "reload-snippets", group: "maintenance", title: "Reload snippets", detail: "Refresh shared Markdown and TeX snippets", run: () => void reloadSnippets() },
    {
      id: "reset-snippet-ranking",
      group: "maintenance",
      title: "Reset snippet ranking",
      detail: "Clear local snippet frequency and recency history",
      run: () => {
        snippetUsage.clear();
        hideToolsPanel();
        setStatus("Snippet ranking reset");
      },
    },
  ];
  return [
    ...common,
    { id: "reload-index", group: "maintenance", title: "Reload note index", detail: "Refresh documents, tags, and links", run: () => void reloadNotes(true) },
    { id: "add-meta", group: "knowledge", title: "Add document metadata", detail: "Register title, kind, and tags", run: () => void quickAddMeta() },
    { id: "remove-meta", group: "knowledge", title: "Remove document metadata", detail: "Delete the current document meta block", run: () => void unregisterMeta() },
    { id: "hide-roam", group: "knowledge", title: "Hide from knowledge graph", detail: "Keep metadata but set roam off", run: () => void updateNoteMeta(api.meta.hideRoam, {}, "roam: off set") },
    { id: "activate-roam", group: "knowledge", title: "Show in knowledge graph", detail: "Clear roam off for the current document", run: () => void updateNoteMeta(api.meta.activateRoam, {}, "roam: off cleared") },
    { id: "tag-manager", group: "knowledge", title: "Tag management", detail: "Search, create, and remove tags on the current note", run: () => void manageCurrentNoteTags() },
    { id: "add-tag", group: "knowledge", title: "Add tags", detail: "Append tags to the current document", run: () => void addTag() },
    { id: "manage-tags", group: "knowledge", title: "Manage metadata", detail: "Edit project and tags", run: () => void manageNoteTags() },
    { id: "insert-roam-idlink", group: "knowledge", title: "Insert knowledge link", detail: "Search notes and insert an ID link", run: () => void insertRoamIdLink() },
    { id: "rename-tag", group: "knowledge", title: "Rename tag across notes", detail: "Bulk rename a knowledge-base tag", run: () => void renameRoamTagTool() },
    { id: "delete-tag", group: "knowledge", title: "Delete tag across notes", detail: "Bulk remove a knowledge-base tag", run: () => void deleteRoamTagTool() },
    { id: "tag-overlap", group: "knowledge", title: "Tag overlap report", detail: "Find duplicate and overlapping tags", run: () => void tagOverlapReportTool() },
    { id: "rewrite-paths", group: "maintenance", title: "Rewrite path references", detail: "Bulk update Markdown path links", run: () => void rewritePathRefsTool() },
  ];
}

function renderLayoutZoomTool(): HTMLElement {
  const panel = document.createElement("section");
  panel.className = "aaronnote-layout-zoom-tool";
  const head = document.createElement("div");
  head.className = "aaronnote-layout-zoom-head";
  const title = document.createElement("strong");
  title.textContent = "🫴 Layout zoom";
  const value = document.createElement("span");
  value.dataset.layoutZoomValue = "";
  value.textContent = layoutZoomPercent();
  head.append(title, value);

  const controls = document.createElement("div");
  controls.className = "aaronnote-layout-zoom-controls";
  const actions: Array<{ action: "out" | "reset" | "in"; label: string; title: string }> = [
    { action: "out", label: "-", title: "M-- / Cmd+-" },
    { action: "reset", label: "100%", title: "M-0 / Cmd+0" },
    { action: "in", label: "+", title: "M-= / Cmd+=" },
  ];
  for (const item of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.layoutZoomAction = item.action;
    button.title = item.title;
    button.textContent = item.label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (item.action === "out") stepLayoutZoom(-1, { announce: true });
      else if (item.action === "in") stepLayoutZoom(1, { announce: true });
      else resetLayoutZoom({ announce: true });
      editor.focus();
    });
    controls.appendChild(button);
  }

  const hint = document.createElement("p");
  hint.textContent = "M-= / M-- / M-0 reflows Markdown layout. Pinch and C-Tab use visual zoom; C-0 resets it.";
  panel.append(head, controls, hint);
  return panel;
}

function openConfigurationPage(): void {
  const url = new URL("/config", window.location.origin);
  window.open(url.toString(), "_blank", "noopener,noreferrer");
  setStatus("Opening configuration");
}

function renderToolsPanel(): void {
  toolsList.replaceChildren();
  const actions = toolActions();
  for (const group of TOOL_GROUPS) {
    const groupActions = actions.filter((action) => action.group === group.id);
    if (group.id !== "view" && groupActions.length === 0) continue;
    const section = document.createElement("section");
    section.className = "aaronnote-tool-group";
    section.dataset.toolGroup = group.id;
    const heading = document.createElement("h2");
    heading.textContent = group.label;
    section.appendChild(heading);
    if (group.id === "view") section.appendChild(renderLayoutZoomTool());
    for (const action of groupActions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "aaronnote-tool-action";
      button.dataset.action = action.id;
      if (action.danger) button.dataset.danger = "true";
      button.disabled = Boolean(action.disabled);
      const title = document.createElement("strong");
      title.textContent = action.title;
      const detail = document.createElement("span");
      detail.textContent = action.detail;
      button.append(title, detail);
      button.addEventListener("click", () => {
        closeToolsPanel();
        action.run();
      });
      section.appendChild(button);
    }
    toolsList.appendChild(section);
  }
  updateLayoutZoomTool();
}

function toggleToolsPanel(): void {
  if (serverReaderMode) return;
  if (toolsPanel.hidden) renderToolsPanel();
  toolsPanel.hidden = !toolsPanel.hidden;
  const expanded = !toolsPanel.hidden;
  toolsButton.setAttribute("aria-expanded", String(expanded));
  modeToggle.setAttribute("aria-expanded", String(expanded));
  modeToggle.classList.toggle("is-active", expanded);
}

function closeToolsPanel(): void {
  toolsPanel.hidden = true;
  toolsButton.setAttribute("aria-expanded", "false");
  modeToggle.setAttribute("aria-expanded", "false");
  modeToggle.classList.remove("is-active");
}

function closeRoamToolsPanel(): void {
  roamToolsPanel.hidden = true;
  roamToolsPanel.classList.remove("is-agenda");
  agendaButton.setAttribute("aria-expanded", "false");
}

function editorSurfaceVisible(): boolean {
  return !host.hidden && document.body.contains(host);
}

function editorOwnsActiveSurface(): boolean {
  const active = document.activeElement;
  if (!active || !host.contains(active)) return false;
  if (active.closest("[data-aaronnote-vim='native']")) return false;
  const editable = active.closest<HTMLElement>("input, textarea, select, [contenteditable='true']");
  return !editable || editable.classList.contains("cm-content");
}

function clearMathPreviewErrorTimer(): void {
  window.clearTimeout(mathPreviewErrorTimer);
  mathPreviewErrorTimer = 0;
}

function hideMathPreview(): void {
  clearMathPreviewErrorTimer();
  // The field DOM is intentionally retained for cheap re-entry, but no
  // MathLive timer, overlay RAF or source-coordinate work may survive outside
  // the active formula boundary.
  liveTexPreview?.suspend();
  mathPreview.hidden = true;
  mathPreview.classList.remove("is-display", "is-error", "is-overflowing");
  mathPreviewVisualHost.hidden = false;
  mathPreviewFallback.hidden = true;
  mathPreviewFallback.textContent = "";
  mathPreview.style.left = "";
  mathPreview.style.top = "";
  mathPreview.style.width = "";
  mathPreview.style.height = "";
  mathPreviewSession = null;
  mathPreviewPendingErrorKey = "";
  mathPreviewWidth = 0;
}

function hideSnippetPopup(): void {
  snippetPopup.hidden = true;
  snippetPopupItems = [];
  snippetPopupIndex = 0;
  snippetDeleteBefore = 0;
  snippetRenderKey = "";
  snippetPopupMatchKey = "";
  snippetPopupChooseHandler = null;
}

function placeFloating(el: HTMLElement, rect: { left: number; top: number; bottom: number } | null, width = 340): void {
  if (!rect) {
    el.hidden = true;
    return;
  }
  const margin = 8;
  const resolvedWidth = Math.min(width, Math.max(220, window.innerWidth - margin * 2));
  const left = Math.min(
    Math.max(margin, rect.left),
    Math.max(margin, window.innerWidth - resolvedWidth - margin),
  );
  const height = Math.min(el.offsetHeight || 180, Math.max(160, window.innerHeight - margin * 2));
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - margin) top = rect.top - height - 8;
  if (top < margin) top = Math.max(margin, window.innerHeight - height - margin);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${resolvedWidth}px`;
}

function placeFloatingAbove(
  el: HTMLElement,
  rect: { left: number; top: number; bottom: number } | null,
  width = 320,
  bottomRect?: { bottom: number } | null,
): void {
  if (!rect) {
    el.hidden = true;
    return;
  }
  const margin = 8;
  const resolvedWidth = Math.min(width, Math.max(220, window.innerWidth - margin * 2));
  const left = Math.min(
    Math.max(margin, rect.left),
    Math.max(margin, window.innerWidth - resolvedWidth - margin),
  );
  const height = Math.min(el.offsetHeight || 180, Math.max(160, window.innerHeight - margin * 2));
  let top = rect.top - height - 8;
  if (top < margin) top = (bottomRect ?? rect).bottom + 8;
  if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - height - margin);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${resolvedWidth}px`;
}

function currentSnippetKind(): string {
  return currentKind.trim().toLowerCase();
}

function cursorInsideMetaSnippetContext(ctx: ReturnType<typeof editor.cursorContext>): boolean {
  const before = ctx.before.toLowerCase();
  const open = before.lastIndexOf("#+begin meta");
  const close = before.lastIndexOf("#+end meta");
  return open >= 0 && open > close && ctx.after.toLowerCase().includes("#+end meta");
}

function proseSnippetContext(ctx: ReturnType<typeof editor.cursorContext>, mode: string): boolean {
  if (mode !== "markdown-mode" || cursorInsideMetaSnippetContext(ctx)) return false;
  const type = editor.getBlockContext().type.toLowerCase();
  return !type.includes("code") && !type.includes("html") && !type.includes("link");
}

function matchingSnippets(
  prefix: string,
  mode: string,
  ctx: ReturnType<typeof editor.cursorContext>,
): SnippetSummary[] {
  const inMeta = cursorInsideMetaSnippetContext(ctx);
  const inProse = proseSnippetContext(ctx, mode);
  const mathContext = mode === "tex-mode";
  const commandChannel = mathContext && prefix.startsWith("\\");
  const atChannel = mathContext && prefix.startsWith("@");
  const candidates = mathContext
    ? mathSnippetCandidates()
    : snippets;
  return matchingSnippetsForPrefix(candidates, prefix, {
    kind: currentSnippetKind(),
    mode,
    limit: 10,
    allowFuzzy: commandChannel || atChannel,
    context: mathContext ? "math" : undefined,
    usage: snippetUsage,
    documentFrequency: mathSnippetIndex.frequencies(),
  })
    .filter((snippet) => {
      if (snippet.context === "org-meta") return inMeta;
      if (snippet.context === "prose") return inProse;
      if (snippet.context?.startsWith("math")) return mathContext;
      return !inMeta || snippet.context !== "markdown";
    });
}

function mathSnippetCandidates(): SnippetSummary[] {
  return [...snippets, ...mathSnippetIndex.candidates()];
}

function matchingMathEditorSnippetCompletion(prefix: string): {
  prefix: string;
  deleteBefore: number;
  matches: SnippetSummary[];
} {
  const query = MATH_EDITOR_LAYOUT_ALIASES[prefix.toLowerCase()];
  const candidates = mathSnippetCandidates()
    .filter((snippet) => !snippet.context || snippet.context.startsWith("math"));
  const options = {
    kind: currentSnippetKind(),
    mode: "tex-mode",
    limit: 10,
    allowFuzzy: prefix.startsWith("\\") || prefix.startsWith("@"),
    context: "math",
    usage: snippetUsage,
    documentFrequency: mathSnippetIndex.frequencies(),
  } as const;
  if (query) {
    return {
      prefix,
      deleteBefore: prefix.length,
      matches: matchingSnippetsForPrefix(candidates, query, options),
    };
  }
  return matchingSnippetsAtTokenBoundary(candidates, prefix, options);
}

function builtinDisplayMathSnippetP(snippet: SnippetSummary): boolean {
  return snippet.source === BUILTIN_SNIPPET_SOURCE
    && snippet.mode === "markdown-mode"
    && snippet.key === ":";
}

function snippetWithSmartBlockBoundaries(snippet: SnippetSummary, deleteBefore: number): SnippetSummary {
  if (!builtinDisplayMathSnippetP(snippet)) return snippet;
  const body = String(snippet.body || "");
  const selection = editor.getMarkdownSelection();
  const replaceFrom = Math.max(0, selection.from - deleteBefore);
  const replaceTo = selection.to;
  const doc = editor.view.state.doc;
  const line = doc.lineAt(replaceFrom);
  const before = doc.sliceString(line.from, replaceFrom);
  const after = doc.sliceString(replaceTo, line.to);
  const prefix = before.trim().length > 0 ? "\n" : "";
  const suffix = after.trim().length > 0 ? "\n" : "";
  if (!prefix && !suffix) return snippet;
  return { ...snippet, body: `${prefix}${body}${suffix}` };
}

function insertSnippet(snippet: SnippetSummary, deleteBefore = 0): boolean {
  const resolvedSnippet = snippetWithSmartBlockBoundaries(snippet, deleteBefore);
  if (!snippetSession.insert(resolvedSnippet, deleteBefore)) return false;
  snippetUsage.record(snippet);
  setStatus(`Inserted ${snippet.key || snippet.name || "snippet"}`);
  scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
  return true;
}

function jumpSnippetTabstop(): boolean {
  const moved = snippetSession.next();
  if (moved) {
    setStatus("Snippet field");
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
  }
  return moved;
}

function jumpSnippetTabstopBack(): boolean {
  const moved = snippetSession.previous();
  if (moved) {
    setStatus("Snippet field");
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
  }
  return moved;
}

function snippetPrefix(before: string): string {
  return before.match(/([A-Za-z0-9_:/;.+\\-]{1,40})$/)?.[1] ?? "";
}

function markdownEscapedAt(text: string, index: number): boolean {
  let slashCount = 0;
  for (let pos = index - 1; pos >= 0 && text[pos] === "\\"; pos--) slashCount++;
  return slashCount % 2 === 1;
}

function markdownLinkLabelEnd(line: string, openBracket: number): number {
  for (let pos = openBracket + 1; pos < line.length; pos++) {
    if (line[pos] === "]" && !markdownEscapedAt(line, pos)) return pos;
  }
  return -1;
}

function markdownLinkTargetEnd(line: string, openParen: number): number {
  let depth = 0;
  let quote = "";
  for (let pos = openParen + 1; pos < line.length; pos++) {
    const ch = line[pos] || "";
    if (markdownEscapedAt(line, pos)) continue;
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if ((ch === "\"" || ch === "'") && /\s/.test(line[pos - 1] ?? "")) {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      if (depth === 0) return pos;
      depth--;
    }
  }
  return -1;
}

function markdownLinkTargetBounds(rawTarget: string): { href: string; start: number; end: number } | null {
  const leading = rawTarget.match(/^\s*/)?.[0].length ?? 0;
  if (rawTarget[leading] === "<") {
    for (let index = leading + 1; index < rawTarget.length; index++) {
      if (rawTarget[index] === ">" && !markdownEscapedAt(rawTarget, index)) {
        const href = rawTarget.slice(leading + 1, index).trim();
        return href ? { href, start: leading + 1, end: index } : null;
      }
    }
  }
  const titleMatch = rawTarget.match(/\s+(?:"[^"]*"|'[^']*')\s*$/);
  const beforeTitleEnd = titleMatch?.index ?? rawTarget.length;
  const start = leading;
  const end = rawTarget.slice(0, beforeTitleEnd).replace(/\s+$/, "").length;
  if (start >= end) return null;
  return { href: rawTarget.slice(start, end), start, end };
}

function markdownInlineLinkTargetAtCursor(): {
  href: string;
  prefix: string;
  deleteBefore: number;
} | null {
  const selection = editor.getMarkdownSelection();
  const pos = Math.max(0, Math.min(selection.from, editor.view.state.doc.length));
  const line = editor.view.state.doc.lineAt(pos);
  const localPos = pos - line.from;
  for (let start = 0; start < line.text.length; start++) {
    if (line.text[start] !== "[" || markdownEscapedAt(line.text, start)) continue;
    if (start > 0 && line.text[start - 1] === "!" && !markdownEscapedAt(line.text, start - 1)) continue;
    const labelEnd = markdownLinkLabelEnd(line.text, start);
    if (labelEnd < 0 || line.text[labelEnd + 1] !== "(") continue;
    const targetOpen = labelEnd + 1;
    const targetEnd = markdownLinkTargetEnd(line.text, targetOpen);
    if (targetEnd < 0) continue;
    if (localPos < targetOpen + 1 || localPos > targetEnd + 1) {
      start = targetEnd;
      continue;
    }
    const rawTarget = line.text.slice(targetOpen + 1, targetEnd);
    const bounds = markdownLinkTargetBounds(rawTarget);
    if (!bounds) return null;
    const targetLocal = Math.max(bounds.start, Math.min(localPos - (targetOpen + 1), bounds.end));
    return {
      href: bounds.href,
      prefix: rawTarget.slice(bounds.start, targetLocal),
      deleteBefore: targetLocal - bounds.start,
    };
  }
  return null;
}

function completionDetail(snippet: SnippetSummary): string {
  const group = String(snippet.group || "");
  if (group === "path") return snippet.source || "";
  if (group === "roam") return snippet.body ? `roam -> ${snippet.body}` : "roam";
  if (group === "tag") return snippet.source ? `inline tag in ${snippet.source}` : "inline tag";
  if (group === "dom") return snippet.source ? `DOM target in ${snippet.source}` : "DOM target";
  if (group === "bib-namespace") return snippet.source || "bibliography";
  if (group === "bib-key") return snippet.source || "BibTeX entry";
  return snippetDetail(snippet);
}

function completionPreviewText(snippet: SnippetSummary): string {
  const group = String(snippet.group || "");
  if (group === "path") return "";
  if (group === "roam" || group === "tag" || group === "dom" || group === "bib-namespace" || group === "bib-key") {
    return String(snippet.source || snippet.body || "").replace(/\s+/g, " ").trim().slice(0, 96);
  }
  return String(snippet.body || "").replace(/\s+/g, " ").trim().slice(0, 96);
}

function pathCompletionPrefix(before: string): string {
  const match = before.match(/(?:^|[\s([{"'=])([^\s\])}"'`<>#@]*\/[^\s\])}"'`<>#@]*)$/);
  const prefix = match?.[1] ?? "";
  if (!prefix || prefix.startsWith("//") || hrefProtocol(prefix)) return "";
  return prefix;
}

function roamCompletionPrefix(before: string): string | null {
  const match = before.match(/(?:^|[\s([{"'=])roam:\/\/([^\s\])}"'`<>]*)$/i);
  return match ? match[1] ?? "" : null;
}

function inlineTagCompletionPrefix(before: string): string | null {
  const match = before.match(/@@tag\[([^\]\n]*)$/);
  return match ? match[1] ?? "" : null;
}

// Completion for `after:`/`blocks:`/`task:` dependency-ref values on
// @@todo/@@itodo/@@project/@@milestone/@@clock lines — same key set
// planning-dsl.mjs treats as dep-refs. Lightweight pattern match (no full
// command parse), matching the other detectors in this waterfall.
function depRefCompletionContext(before: string): { prefix: string; quoted: boolean } | null {
  const match = before.match(/(?:^|[\s,{])(?:after|blocks|task)\s*[:=]\s*(")?([^,;{}"\n]*)$/i);
  if (!match) return null;
  return { prefix: match[2] ?? "", quoted: Boolean(match[1]) };
}

// `serializePlanningValue` (shared/planning-dsl.mjs) quotes any value with
// whitespace/punctuation; mirror that here so an inserted multi-word text
// ref round-trips instead of getting truncated by the attr parser.
function needsPlanningValueQuotes(value: string): boolean {
  return /[\s,;{}[\]"']/.test(value);
}

function displayPathCompletion(path: string, prefix: string): string {
  if (prefix.startsWith("./") && !path.startsWith("./") && !path.startsWith("../") && !path.startsWith("/")) return `./${path}`;
  return path;
}

function isPureTraversalPath(path: string): boolean {
  const parts = path.replace(/\\/g, "/").split("/").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => part === "." || part === "..");
}

function pathCompletionRank(path: string, prefix: string): number {
  const display = displayPathCompletion(path, prefix);
  const sameDir = display.startsWith("./") ? 0 : 100;
  const parentPenalty = (display.match(/\.\.\//g) ?? []).length * 25;
  const dirPenalty = display.split("/").length;
  const directoryBoost = display.endsWith("/") ? -2 : 0;
  const exactPrefixBoost = display.toLowerCase().startsWith(prefix.toLowerCase()) ? -4 : 0;
  return sameDir + parentPenalty + dirPenalty + directoryBoost + exactPrefixBoost;
}

function noteFromCompletionRef(ref: string): NoteSummary | undefined {
  if (!String(ref || "").trim() || ref === "." || ref === "./") return currentNote();
  if (ref === "@@") return currentNote();
  return resolveHrefNote(ref) || resolveNoteRef(ref);
}

function tagCompletionContext(before: string): { note: NoteSummary; tagPrefix: string } | null {
  const roamMatch = before.match(/(?:^|[\s([{"'=])roam:\/\/([^\s\])}"'`<>#]*)#([^\s\])}"'`<>]*)$/i);
  if (roamMatch) {
    const note = noteFromCompletionRef(roamMatch[1] ?? "");
    if (note) return { note, tagPrefix: roamMatch[2] ?? "" };
  }
  const pathMatch = before.match(/(?:^|[\s([{"'=])((?:\.{1,2}\/|\.|[^\s\])}"'`<>#@]+)[^\s\])}"'`<>#@]*)#([^\s\])}"'`<>]*)$/);
  if (pathMatch) {
    const note = noteFromCompletionRef(pathMatch[1] ?? "");
    if (note) return { note, tagPrefix: pathMatch[2] ?? "" };
  }
  return null;
}

function domCompletionParts(rawHref: string): { ref: string; parentSegments: string[]; domPrefix: string } | null {
  const clean = cleanHref(rawHref);
  if (!clean || clean.includes("#")) return null;
  if (clean.startsWith("@@")) {
    const rawDom = clean.slice(2);
    const endsAtSeparator = rawDom.length > 0 && rawDom.endsWith("@");
    const segments = domTargetPathSegments(rawDom);
    return {
      ref: "@@",
      parentSegments: endsAtSeparator ? segments : segments.slice(0, -1),
      domPrefix: endsAtSeparator ? "" : segments[segments.length - 1] || "",
    };
  }
  const roamTarget = splitRoamLikeHref(clean);
  if (roamTarget?.dom) {
    const endsAtSeparator = /@$/.test(clean);
    const segments = domTargetPathSegments(roamTarget.dom);
    return {
      ref: roamTarget.ref,
      parentSegments: endsAtSeparator ? segments : segments.slice(0, -1),
      domPrefix: endsAtSeparator ? "" : segments[segments.length - 1] || "",
    };
  }
  const fileDomMatch = clean.match(/^(.+?\.(?:md|markdown|typ))@(.+)$/i);
  const plainDomMatch = fileDomMatch ? null : clean.match(/^(.+?)@([^@]*)$/);
  const match = fileDomMatch || plainDomMatch;
  if (!match) return null;
  const endsAtSeparator = /@$/.test(clean);
  const segments = domTargetPathSegments(match[2] || "");
  return {
    ref: match[1] || "",
    parentSegments: endsAtSeparator ? segments : segments.slice(0, -1),
    domPrefix: endsAtSeparator ? "" : segments[segments.length - 1] || "",
  };
}

function domCompletionContext(before: string): { note: NoteSummary; domPrefix: string; parentSegments: string[] } | null {
  const match = before.match(/(?:^|[\s([{"'=])((?:roam:\/\/|\.{1,2}\/|\.|[^\s()[\]{}"'`<>#]+)[^\s()[\]{}"'`<>#]*)$/i);
  const parts = match ? domCompletionParts(match[1] ?? "") : null;
  if (!parts) return null;
  const note = noteFromCompletionRef(parts.ref);
  if (!note) return null;
  return { note, domPrefix: parts.domPrefix, parentSegments: parts.parentSegments };
}

async function matchingTagCompletions(note: NoteSummary, prefix: string): Promise<SnippetSummary[]> {
  const query = prefix.toLowerCase().replace(/^tag-/, "");
  let tags: string[];
  let blocks: Array<{ id: string; kind: string; label: string }>;
  if (note.file === currentFile) {
    tags = [...new Set(allAnchorTagSuggestions().map((tag) => normalizeInlineTag(tag).replace(/^#/, "")).filter(Boolean))].sort();
    const live = getOrgEnvBlockIdentities(editor.view.state)
      .map((block) => ({ id: block.id, kind: block.kind, label: block.title || block.kind }));
    const indexed = (note.blocks || []).map((block) => ({ id: block.id, kind: block.envKind || block.kind, label: block.label || block.id }));
    blocks = [...new Map([...live, ...indexed].map((block) => [block.id, block])).values()];
  } else {
    // Cross-note fragments come only from the target note's cached index.
    tags = [...(note.inlineTags ?? [])].map((t) => normalizeInlineTag(t).replace(/^#/, "")).filter(Boolean);
    blocks = (note.blocks || []).map((block) => ({ id: block.id, kind: block.envKind || block.kind, label: block.label || block.id }));
  }
  const candidates = [
    ...[...new Set(tags)].map((tag) => ({ id: tag, kind: "tag", label: `#${tag}` })),
    ...blocks,
  ];
  return [...new Map(candidates.map((item) => [item.id.toLowerCase(), item])).values()]
    .filter((item) => !query || item.id.toLowerCase().includes(query) || item.label.toLowerCase().includes(query))
    .sort((a, b) => Number(a.kind !== "tag") - Number(b.kind !== "tag") || a.label.localeCompare(b.label))
    .slice(0, 12)
    .map((item) => ({
      key: item.id,
      name: item.kind === "tag" ? item.label : `${item.label} · #${item.id.slice(-6)}`,
      mode: "markdown-mode",
      group: item.kind === "tag" ? "tag" : "block",
      kind: item.kind,
      body: encodeURIComponent(item.id),
      source: note.path || note.file || canonicalRoamNoteId(note),
    }));
}

function indexedDomTargets(note: NoteSummary): DomTargetEntry[] {
  const indexed = (note.domTargets ?? []).map((target) => {
    const label = normalizeDomTarget(target.label || target.slug || "");
    const slug = slugDomTarget(target.slug || label);
    const path = (Array.isArray(target.path) && target.path.length > 0 ? target.path : [slug])
      .map((segment) => slugDomTarget(segment))
      .filter(Boolean);
    const labelPath = (Array.isArray(target.labelPath) && target.labelPath.length > 0 ? target.labelPath : [label])
      .map(normalizeDomTarget)
      .filter(Boolean);
    return { label, slug, path, labelPath, level: Math.max(1, Number(target.level || 1)), notePath: target.notePath || note.path || "" };
  }).filter((target) => target.label && target.slug && target.path.length > 0);
  return indexed;
}

function domTargetsForCompletion(note: NoteSummary): DomTargetEntry[] {
  if (note.file === currentFile) return currentDomTargets();
  return indexedDomTargets(note);
}

function immediateDomCompletionTargets(entries: readonly DomTargetEntry[], parentSegments: readonly string[]): DomTargetEntry[] {
  const parentPath = parentSegments.map(slugDomTarget).filter(Boolean);
  const parentLength = parentPath.length;
  return entries.filter((entry) => {
    if (entry.path.length !== parentLength + 1) return false;
    if (parentLength === 0) return true;
    return targetPathMatches(entry.path.slice(0, parentLength), parentPath, false);
  });
}

function descendantDomCompletionTargets(entries: readonly DomTargetEntry[], parentSegments: readonly string[]): DomTargetEntry[] {
  const parentPath = parentSegments.map(slugDomTarget).filter(Boolean);
  const parentLength = parentPath.length;
  return entries.filter((entry) => {
    if (entry.path.length <= parentLength) return false;
    if (parentLength === 0) return true;
    return targetPathMatches(entry.path.slice(0, parentLength), parentPath, false);
  });
}

function matchingDomCompletions(note: NoteSummary, prefix: string, parentSegments: readonly string[] = []): SnippetSummary[] {
  const query = normalizeDomTarget(prefix).toLowerCase();
  const entries = domTargetsForCompletion(note);
  const parentPath = parentSegments.map(slugDomTarget).filter(Boolean);
  const candidates = query
    ? descendantDomCompletionTargets(entries, parentSegments)
      .filter((target) => target.slug.includes(query) || target.label.toLowerCase().includes(query))
    : immediateDomCompletionTargets(entries, parentSegments);
  return candidates.slice(0, 12).map((target) => {
    // A filtered result can be a deeper descendant. Insert every path segment
    // below the already-authored parent so local, path and roam completions all
    // retain an unambiguous hierarchical target.
    const relativePath = target.path.slice(parentPath.length);
    const encodedPath = relativePath.map((segment) => encodeURIComponent(segment)).join("@");
    return {
      key: relativePath.join("@") || target.slug,
      name: `@${relativePath.join("@") || target.slug}`,
      mode: "markdown-mode",
      group: "dom",
      body: encodedPath || encodeURIComponent(target.slug),
      source: domTargetPathLabel(target.labelPath) || note.path || note.file || canonicalRoamNoteId(note) || target.label,
    };
  });
}

async function matchingRoamCompletions(prefix: string): Promise<SnippetSummary[]> {
  if (!roamFeaturesEnabled()) return [];
  const needle = prefix.trim().toLowerCase();
  try {
    const result = await api.completions.roam(needle);
    return (result.notes ?? []).map((note) => ({
      key: note.title || note.id,
      name: note.title || note.id,
      body: `${encodeURIComponent(note.id || note.key)}`,
      mode: "markdown-mode",
      group: "roam",
      source: note.path || note.id,
    }));
  } catch {
    return [];
  }
}

async function matchingInlineTagCompletions(prefix: string): Promise<SnippetSummary[]> {
  const needle = normalizeInlineTag(prefix).toLowerCase();
  const localTags = allAnchorTagSuggestions().map(normalizeInlineTag).filter(Boolean);
  let backendTags: string[] = [];
  try {
    const result = await api.completions.tags(needle);
    backendTags = result.tags ?? [];
  } catch {
    // fall back to local tags only
  }
  const tags = new Map<string, string>();
  for (const tag of [...localTags, ...backendTags]) {
    const clean = normalizeInlineTag(tag).replace(/^#/, "");
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!tags.has(key)) tags.set(key, clean);
  }
  return [...tags.values()]
    .filter((tag) => !needle || tag.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 12)
    .map((tag) => ({
      key: tag,
      name: tag,
      body: `${tag}]`,
      mode: "markdown-mode",
      group: "tag",
      source: tag,
    }));
}

async function matchingTodoRefCompletions(prefix: string, quoted: boolean): Promise<SnippetSummary[]> {
  try {
    const result = await api.completions.todoRefs({ prefix, file: currentFile });
    return (result.items ?? []).map((item) => {
      const ref = item.ref || "";
      const needsQuotes = !quoted && !item.hasId && needsPlanningValueQuotes(ref);
      return {
        key: ref,
        name: item.label || ref,
        body: needsQuotes ? `"${ref}"` : ref,
        mode: "markdown-mode",
        group: "todo-ref",
        source: item.file || "",
      };
    });
  } catch {
    return [];
  }
}

async function matchingBibliographyCompletions(kind: "namespaces" | "keys", prefix: string, namespace = ""): Promise<SnippetSummary[]> {
  try {
    const result = await api.completions.bibliography({
      file: currentFile,
      content: editor.getMarkdown(),
      kind,
      prefix,
      namespace,
    });
    const diagnostics = bibliographyDiagnosticTexts(result.diagnostics);
    if (diagnostics.length > 0) setStatus(`Bibliography completion: ${diagnostics[0]}`);
    return (result.items ?? []).map((item) => ({
      key: item.key || item.name || "",
      name: item.name || item.key || "",
      body: item.body || item.key || "",
      mode: "markdown-mode",
      group: kind === "namespaces" ? "bib-namespace" : "bib-key",
      source: item.detail || item.source || "",
    }));
  } catch (error) {
    setStatus(`Bibliography completion failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function matchingPathCompletions(prefix: string): Promise<SnippetSummary[]> {
  if (!prefix || !currentFile) return [];
  try {
    const result = await api.notes.pathSuggestions(currentFile, prefix);
    const paths = result.paths ?? [];
    return paths
      .filter((path) => !isPureTraversalPath(displayPathCompletion(path, prefix)))
      .sort((a, b) => {
        const rank = pathCompletionRank(a, prefix) - pathCompletionRank(b, prefix);
        return rank || displayPathCompletion(a, prefix).localeCompare(displayPathCompletion(b, prefix));
      })
      .slice(0, 8)
      .map((path) => {
        const displayPath = displayPathCompletion(path, prefix);
        const note = resolveHrefNote(displayPath);
        const roamId = roamFeaturesEnabled() && note?.roam ? canonicalRoamNoteId(note) : "";
        return {
          key: displayPath,
          name: displayPath,
          mode: "markdown-mode",
          group: "path",
          body: roamId ? roamHrefForNote(note) : displayPath,
          source: note?.title && note.title !== displayPath ? note.title : "",
        };
      });
  } catch {
    return [];
  }
}


function renderSnippetPopup(prefix: string, rect: { left: number; top: number; bottom: number } | null): void {
  const nextKey = `${prefix}\n${snippetPopupIndex}\n${snippetPopupItems.map((snippet) => `${snippet.mode}:${snippet.key}:${snippet.name}`).join("\n")}`;
  if (!snippetPopup.hidden && snippetRenderKey === nextKey) {
    placeFloating(snippetPopup, rect);
    revealSnippetPopupActiveOption();
    return;
  }
  snippetRenderKey = nextKey;
  snippetPopup.innerHTML = "";
  snippetPopupItems.forEach((snippet, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `aaronnote-snippet-option-${index}`;
    button.className = index === snippetPopupIndex
      ? "aaronnote-snippet-option is-active"
      : "aaronnote-snippet-option";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === snippetPopupIndex ? "true" : "false");

    const number = document.createElement("span");
    number.className = "aaronnote-snippet-option-number";
    number.textContent = index < 9 ? String(index + 1) : index === 9 ? "0" : "";

    const key = document.createElement("span");
    key.className = "aaronnote-snippet-option-key";
    key.textContent = snippetLabel(snippet);

    const detail = document.createElement("span");
    detail.className = "aaronnote-snippet-option-detail";
    detail.textContent = completionDetail(snippet);

    button.append(number, key, detail);
    const previewText = completionPreviewText(snippet);
    if (previewText) {
      const preview = document.createElement("span");
      preview.className = "aaronnote-snippet-option-preview";
      preview.textContent = previewText;
      button.appendChild(preview);
    }
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      snippetPopupIndex = index;
      chooseSnippetPopupItem();
    });
    // Do not let a popup appearing under a stationary pointer steal the
    // keyboard selection. A real pointer movement still selects the row.
    button.addEventListener("pointermove", () => {
      if (snippetPopupIndex === index) return;
      snippetPopupIndex = index;
      updateSnippetPopupActiveOption();
    });
    snippetPopup.appendChild(button);
  });
  snippetPopup.dataset.prefix = prefix;
  snippetPopup.setAttribute("aria-activedescendant", `aaronnote-snippet-option-${snippetPopupIndex}`);
  snippetPopup.hidden = false;
  placeFloating(snippetPopup, rect);
  revealSnippetPopupActiveOption();
}

function revealSnippetPopupActiveOption(): void {
  const option = snippetPopup.querySelector<HTMLElement>(".aaronnote-snippet-option.is-active");
  if (!option || snippetPopup.clientHeight <= 0) return;
  const top = option.offsetTop;
  const bottom = top + option.offsetHeight;
  if (top < snippetPopup.scrollTop) snippetPopup.scrollTop = top;
  else if (bottom > snippetPopup.scrollTop + snippetPopup.clientHeight) {
    snippetPopup.scrollTop = bottom - snippetPopup.clientHeight;
  }
}

function updateSnippetPopupActiveOption(): void {
  snippetPopup.querySelectorAll<HTMLButtonElement>(".aaronnote-snippet-option").forEach((button, index) => {
    const active = index === snippetPopupIndex;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  snippetPopup.setAttribute("aria-activedescendant", `aaronnote-snippet-option-${snippetPopupIndex}`);
  revealSnippetPopupActiveOption();
}

function showSnippetPopup(
  prefix: string,
  items: SnippetSummary[],
  deleteBefore: number,
  rect: { left: number; top: number; bottom: number } | null,
  chooseHandler: ((snippet: SnippetSummary) => boolean) | null = null,
): void {
  const matchKey = `${prefix}\n${items.map((snippet) => `${snippet.kind}:${snippet.mode}:${snippet.group}:${snippet.key}:${snippet.name}`).join("\n")}`;
  snippetDeleteBefore = deleteBefore;
  if (matchKey !== snippetPopupMatchKey) {
    snippetPopupIndex = 0;
    snippetRenderKey = "";
  } else {
    snippetPopupIndex = Math.min(snippetPopupIndex, items.length - 1);
  }
  snippetPopupMatchKey = matchKey;
  snippetPopupItems = items;
  snippetPopupChooseHandler = chooseHandler;
  renderSnippetPopup(prefix, rect);
}

function mathAtCursor(ctx: ReturnType<typeof editor.cursorContext>): {
  tex: string;
  display: boolean;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  doc: object;
  geometryEpoch: number;
  selection: { anchor: number; head: number };
  rect: { left: number; top: number; bottom: number } | null;
  rectEnd?: { bottom: number } | null;
} | null {
  const state = editor.view.state;
  const selection = state.selection.main;
  const cursor = selection.head;
  const geometryFor = (display: boolean, from: number, to: number) => {
    const formula = mathPreviewFormulaKey({ display, from });
    const cached = mathPreviewSession;
    if (cached?.formula === formula
      && cached.to === to
      && cached.doc === state.doc
      && cached.geometryEpoch === mathPreviewGeometryEpoch) {
      return { rect: cached.anchorRect, rectEnd: cached.bottomRect };
    }
    const contextStart = Math.max(0, cursor - ctx.before.length);
    const rectAtSourceOffset = (offset: number) => {
      try {
        const direct = editor.view.coordsAtPos(Math.max(0, Math.min(state.doc.length, offset)));
        if (direct) return { left: direct.left, top: direct.top, bottom: direct.bottom };
      } catch (_) {
        // A decoration may be changing in the same frame. The cursor-context
        // geometry remains a stable fallback until CM6 finishes measuring it.
      }
      return ctx.rectAtOffset(offset - contextStart);
    };
    return {
      rect: rectAtSourceOffset(from) ?? ctx.rect ?? rectAtSourceOffset(cursor),
      rectEnd: rectAtSourceOffset(to),
    };
  };
  const blockRanges = getBlockMathRanges(state);
  const displayMath = rangeAtPosition(cursor, blockRanges);
  if (displayMath
    && selection.anchor >= displayMath.contentFrom
    && selection.anchor <= displayMath.contentTo
    && selection.head >= displayMath.contentFrom
    && selection.head <= displayMath.contentTo) {
    const body = state.doc.sliceString(displayMath.contentFrom, displayMath.contentTo);
    const geometry = geometryFor(true, displayMath.from, displayMath.to);
    return {
      tex: body,
      display: true,
      from: displayMath.from,
      to: displayMath.to,
      contentFrom: displayMath.contentFrom,
      contentTo: displayMath.contentTo,
      doc: state.doc,
      geometryEpoch: mathPreviewGeometryEpoch,
      selection: {
        anchor: Math.max(0, Math.min(body.length, selection.anchor - displayMath.contentFrom)),
        head: Math.max(0, Math.min(body.length, selection.head - displayMath.contentFrom)),
      },
      rect: geometry.rect,
      rectEnd: geometry.rectEnd,
    };
  }

  const line = state.doc.lineAt(cursor);
  INLINE_MATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_MATH_RE.exec(line.text)) !== null) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    const tex = match[1] || "";
    const contentFrom = from + 2;
    const contentTo = to - 2;
    if (cursor < contentFrom || cursor > contentTo) continue;
    if (selection.anchor < contentFrom || selection.anchor > contentTo) continue;
    if (rangeOverlapsAny(from, to, blockRanges)) continue;
    const geometry = geometryFor(false, from, to);
    return {
      tex,
      display: false,
      from,
      to,
      contentFrom,
      contentTo,
      doc: state.doc,
      geometryEpoch: mathPreviewGeometryEpoch,
      selection: {
        anchor: Math.max(0, Math.min(tex.length, selection.anchor - contentFrom)),
        head: Math.max(0, Math.min(tex.length, selection.head - contentFrom)),
      },
      rect: geometry.rect,
      rectEnd: geometry.rectEnd,
    };
  }
  return null;
}

function snippetContextMode(
  ctx: ReturnType<typeof editor.cursorContext>,
  activeMath: ReturnType<typeof mathAtCursor> = mathAtCursor(ctx),
): string {
  if (activeMath) return "tex-mode";
  const state = editor.view.state;
  const cursor = state.selection.main.from;
  const block = editor.getBlockContext();
  const blockType = block.type.toLowerCase();
  if (blockType.includes("code") || blockType.includes("html")) return "markdown-mode";

  // Recovery for an unfinished inline delimiter. Work is bounded to the
  // current line, so typing never creates a document-wide recognition pass.
  const line = state.doc.lineAt(cursor);
  const before = line.text.slice(0, cursor - line.from);
  let inlineOpen = -1;
  for (let pos = 0; pos < before.length - 1; pos++) {
    if (before[pos] !== "\\" || markdownEscapedAt(before, pos)) continue;
    if (before[pos + 1] === "(") {
      inlineOpen = pos;
      pos += 1;
    } else if (before[pos + 1] === ")" && inlineOpen >= 0) {
      inlineOpen = -1;
      pos += 1;
    }
  }
  if (inlineOpen >= 0) return "tex-mode";

  // Unfinished display math is searched only in a 16 KiB window and stops at
  // the nearest delimiter line.
  const windowFrom = Math.max(block.from, cursor - 16 * 1024);
  const source = state.doc.sliceString(windowFrom, cursor);
  const open = source.lastIndexOf("\\[");
  const close = source.lastIndexOf("\\]");
  return open > close ? "tex-mode" : "markdown-mode";
}

function clearCompletionCache(): void {
  completionEpoch.cancel();
  completionTimer.cancel();
  completionContextKey = "";
  completionPendingItems = null;
}

function scheduleAsyncCompletion(
  contextKey: string,
  renderPrefix: string,
  deleteBefore: number,
  rect: { left: number; top: number; bottom: number } | null,
  fetchFn: () => Promise<SnippetSummary[]>,
): void {
  if (renderPrefix === snippetSuppressedPrefix) {
    hideSnippetPopup();
    clearCompletionCache();
    return;
  }
  // Same context: show cached result immediately, no new request needed.
  if (contextKey === completionContextKey && completionPendingItems !== null) {
    if (completionPendingItems.length > 0) {
      showSnippetPopup(renderPrefix, completionPendingItems, deleteBefore, rect);
    } else {
      hideSnippetPopup();
    }
    return;
  }
  // New context: start a fresh epoch; keep old popup visible while request is in flight.
  completionContextKey = contextKey;
  completionPendingItems = null;
  const run = completionEpoch.begin();
  completionTimer.schedule(() => {
    void fetchFn().then((items) => {
      if (!run.current) return;
      completionPendingItems = items;
      if (items.length > 0) {
        showSnippetPopup(renderPrefix, items, deleteBefore, rect);
      } else {
        hideSnippetPopup();
      }
    }).catch(() => {
      if (!run.current) return;
      hideSnippetPopup();
    });
  });
}

function quickInsertFilter(item: QuickInsertItem): string[] {
  return [
    item.id,
    item.label,
    item.detail ?? "",
    item.command ?? "",
    item.value ?? "",
    ...(item.keywords ?? []),
    ...(QUICK_INSERT_ALIASES[item.id] ?? []),
  ].filter(Boolean);
}

function showSlashQuickInsert(
  ctx: ReturnType<typeof editor.cursorContext>,
  activeMath: ReturnType<typeof mathAtCursor> | undefined,
): boolean {
  const selection = editor.getMarkdownSelection();
  if (selection.from !== selection.to) return false;
  const blockType = editor.getBlockContext().type.toLowerCase();
  if (blockType.includes("code") || blockType.includes("html")) return false;
  if (snippetContextMode(ctx, activeMath === undefined ? mathAtCursor(ctx) : activeMath) !== "markdown-mode") return false;

  const trigger = findSlashHint(ctx.before, ctx.after);
  if (!trigger) return false;
  const sourceItems = editor.getQuickInsertItems("");
  const byId = new Map(sourceItems.map((item) => [item.id, item]));
  const items = resolveHintMenuItems(sourceItems.map((item) => ({
    entryKey: item.id,
    filter: quickInsertFilter(item),
    item,
  })), {
    enabled: slashMenuPreferences.enabled,
    query: trigger.query,
    order: slashMenuPreferences.order,
    visible: (entryKey) => !slashMenuPreferences.hidden.has(entryKey),
  });
  if (items.length === 0) {
    hideSnippetPopup();
    return true;
  }

  showSnippetPopup(
    `${trigger.key}${trigger.query}`,
    items.slice(0, 18).map(({ item }) => ({
      id: `quick-insert:${item.id}`,
      key: item.id,
      name: item.label,
      description: item.detail,
      mode: "markdown-mode",
      group: "quick-insert",
      body: item.markdown ?? "",
      source: item.detail ?? item.command ?? "",
      provider: "quick-insert",
      browserCompatible: true,
    })),
    trigger.deleteBefore,
    ctx.rect,
    (snippet) => {
      const item = byId.get(String(snippet.key || ""));
      if (!item) return false;
      const current = editor.getMarkdownSelection();
      const from = Math.max(0, current.from - trigger.deleteBefore);
      const removed = editor.markdownBetween(from, current.to);
      editor.replaceMarkdownRange(from, current.to, "");
      const applied = editor.runQuickInsert(item);
      if (!applied) editor.replaceMarkdownRange(from, from, removed);
      return applied;
    },
  );
  return true;
}

function updateSnippetPopup(
  ctx: ReturnType<typeof editor.cursorContext>,
  activeMath: ReturnType<typeof mathAtCursor> | undefined = undefined,
): void {
  if (!editorOwnsActiveSurface()) {
    hideSnippetPopup();
    clearCompletionCache();
    return;
  }

  const activeChoices = snippetSession.activeChoices();
  if (activeChoices.length > 0) {
    clearCompletionCache();
    showSnippetPopup("choice", activeChoices.slice(0, 10).map((choice, index) => ({
      id: `choice:${index}:${choice}`,
      key: choice,
      name: "Snippet choice",
      description: "Replace the active snippet field",
      mode: "tex-mode",
      provider: "choice",
      body: choice,
      browserCompatible: true,
    })), 0, ctx.rect);
    return;
  }

  const wikiContext = wikiLinkCompletionContext(ctx.before, ctx.after);
  if (wikiContext) {
    const renderPrefix = `[[${wikiContext.prefix}`;
    scheduleAsyncCompletion(
      `wiki:${wikiContext.hasClosingDelimiter ? "closed" : "open"}:${wikiContext.prefix}`,
      renderPrefix,
      wikiContext.prefix.length,
      ctx.rect,
      async () => wikiCompletionSnippets((await loadWikiCompletionIndex()).notes, wikiContext),
    );
    return;
  }

  // Link target completion ([...](here) or inline href position)
  const linkTarget = markdownInlineLinkTargetAtCursor();
  if (linkTarget) {
    const targetPrefix = cleanHref(linkTarget.prefix);
    const target = cleanHref(linkTarget.href);

    const hashIndex = targetPrefix.lastIndexOf("#");
    if (hashIndex >= 0) {
      const ref = targetPrefix.slice(0, hashIndex);
      const note = noteFromCompletionRef(ref || target);
      if (!note) { hideSnippetPopup(); clearCompletionCache(); return; }
      const tagPrefix = targetPrefix.slice(hashIndex + 1);
      const renderPrefix = `#${tagPrefix}`;
      scheduleAsyncCompletion(
        `link-tag:${note.file}:${tagPrefix}`,
        renderPrefix,
        tagPrefix.length,
        ctx.rect,
        () => matchingTagCompletions(note, tagPrefix),
      );
      return;
    }

    const domParts = domCompletionParts(targetPrefix);
    if (domParts) {
      const note = noteFromCompletionRef(domParts.ref);
      if (!note) { hideSnippetPopup(); clearCompletionCache(); return; }
      const renderPrefix = `@${domParts.domPrefix}`;
      if (renderPrefix === snippetSuppressedPrefix) { hideSnippetPopup(); clearCompletionCache(); return; }
      const matches = matchingDomCompletions(note, domParts.domPrefix, domParts.parentSegments);
      if (matches.length === 0) { hideSnippetPopup(); clearCompletionCache(); return; }
      clearCompletionCache();
      showSnippetPopup(renderPrefix, matches, domParts.domPrefix.length, ctx.rect);
      return;
    }

    const roamLinkPrefix = targetPrefix.match(/^roam:\/\/(.*)$/i)?.[1];
    if (roamLinkPrefix != null) {
      if (!roamFeaturesEnabled()) { hideSnippetPopup(); clearCompletionCache(); return; }
      const renderPrefix = `roam://${roamLinkPrefix}`;
      scheduleAsyncCompletion(
        `link-roam:${roamLinkPrefix}`,
        renderPrefix,
        roamLinkPrefix.length,
        ctx.rect,
        () => matchingRoamCompletions(roamLinkPrefix),
      );
      return;
    }

    if (pathCompletionPrefix(` ${targetPrefix}`) === targetPrefix) {
      scheduleAsyncCompletion(
        `link-path:${currentFile}:${targetPrefix}`,
        targetPrefix,
        targetPrefix.length,
        ctx.rect,
        () => matchingPathCompletions(targetPrefix),
      );
      return;
    }

    hideSnippetPopup();
    clearCompletionCache();
    return;
  }

  const domContext = domCompletionContext(ctx.before);
  if (domContext) {
    const renderPrefix = `@${domContext.domPrefix}`;
    if (renderPrefix === snippetSuppressedPrefix) { hideSnippetPopup(); clearCompletionCache(); return; }
    const matches = matchingDomCompletions(domContext.note, domContext.domPrefix, domContext.parentSegments);
    if (matches.length === 0) { hideSnippetPopup(); clearCompletionCache(); return; }
    clearCompletionCache();
    showSnippetPopup(renderPrefix, matches, domContext.domPrefix.length, ctx.rect);
    return;
  }

  const tagContext = tagCompletionContext(ctx.before);
  if (tagContext) {
    const renderPrefix = `#${tagContext.tagPrefix}`;
    scheduleAsyncCompletion(
      `tag:${tagContext.note.file}:${tagContext.tagPrefix}`,
      renderPrefix,
      tagContext.tagPrefix.length,
      ctx.rect,
      () => matchingTagCompletions(tagContext.note, tagContext.tagPrefix),
    );
    return;
  }

  const inlineTagPrefix = inlineTagCompletionPrefix(ctx.before);
  if (inlineTagPrefix !== null) {
    const renderPrefix = `@@tag[${inlineTagPrefix}`;
    scheduleAsyncCompletion(
      `inline-tag:${inlineTagPrefix}`,
      renderPrefix,
      inlineTagPrefix.length,
      ctx.rect,
      () => matchingInlineTagCompletions(inlineTagPrefix),
    );
    return;
  }

  const citeNamespacePrefix = citeNamespaceCompletionPrefix(ctx.before);
  if (citeNamespacePrefix !== null) {
    const renderPrefix = citeNamespaceRenderPrefix(citeNamespacePrefix);
    scheduleAsyncCompletion(
      `bib-ns:${currentFile}:${citeNamespacePrefix}`,
      renderPrefix,
      citeNamespacePrefix.length,
      ctx.rect,
      () => matchingBibliographyCompletions("namespaces", citeNamespacePrefix),
    );
    return;
  }

  const citeKeyContext = citeKeyCompletionContext(ctx.before);
  if (citeKeyContext) {
    const renderPrefix = citeKeyRenderPrefix(citeKeyContext);
    scheduleAsyncCompletion(
      `bib-key:${currentFile}:${citeKeyContext.namespace}:${citeKeyContext.separator ?? " "}:${citeKeyContext.prefix}`,
      renderPrefix,
      citeKeyContext.prefix.length,
      ctx.rect,
      () => matchingBibliographyCompletions("keys", citeKeyContext.prefix, citeKeyContext.namespace),
    );
    return;
  }

  const roamPrefix = roamCompletionPrefix(ctx.before);
  if (roamPrefix !== null) {
    if (!roamFeaturesEnabled()) { hideSnippetPopup(); clearCompletionCache(); return; }
    const renderPrefix = `roam://${roamPrefix}`;
    scheduleAsyncCompletion(
      `roam:${roamPrefix}`,
      renderPrefix,
      roamPrefix.length,
      ctx.rect,
      () => matchingRoamCompletions(roamPrefix),
    );
    return;
  }

  const depRefContext = depRefCompletionContext(ctx.before);
  if (depRefContext) {
    const { prefix: depRefPrefix, quoted } = depRefContext;
    scheduleAsyncCompletion(
      `todo-ref:${currentFile}:${depRefPrefix}`,
      depRefPrefix,
      depRefPrefix.length,
      ctx.rect,
      () => matchingTodoRefCompletions(depRefPrefix, quoted),
    );
    return;
  }

  if (showSlashQuickInsert(ctx, activeMath)) {
    clearCompletionCache();
    return;
  }

  const pathPrefix = pathCompletionPrefix(ctx.before);
  if (pathPrefix) {
    scheduleAsyncCompletion(
      `path:${currentFile}:${pathPrefix}`,
      pathPrefix,
      pathPrefix.length,
      ctx.rect,
      () => matchingPathCompletions(pathPrefix),
    );
    return;
  }

  // Plain snippet completion — synchronous, no backend needed.
  clearCompletionCache();
  const prefix = snippetPrefix(ctx.before);
  if (!prefix || prefix === snippetSuppressedPrefix) {
    hideSnippetPopup();
    return;
  }
  if (!snippetCompletionArmed && snippetPopup.hidden) return;
  const mode = snippetContextMode(ctx, activeMath === undefined ? mathAtCursor(ctx) : activeMath);
  const matches = matchingSnippets(prefix, mode, ctx);
  if (matches.length === 0) {
    hideSnippetPopup();
    return;
  }
  showSnippetPopup(prefix, matches, prefix.length, ctx.rect);
}

function chooseSnippetPopupItem(): boolean {
  const snippet = snippetPopupItems[snippetPopupIndex];
  if (!snippet) return false;
  const chooseHandler = snippetPopupChooseHandler;
  if (chooseHandler) {
    hideSnippetPopup();
    const inserted = chooseHandler(snippet);
    if (snippetPopupChooseHandler) hideSnippetPopup();
    if (inserted) {
      snippetUsage.record(snippet);
      setStatus(`Inserted ${snippet.key || snippet.name || "formula snippet"}`);
    }
    return inserted;
  }
  if (snippet.provider === "choice") {
    const choice = snippet.key || "";
    hideSnippetPopup();
    const chosen = snippetSession.choose(choice);
    if (chosen) {
      setStatus(`Snippet choice: ${choice}`);
      scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    }
    return chosen;
  }
  const deleteBefore = snippetDeleteBefore;
  hideSnippetPopup();
  snippetSuppressedPrefix = "";
  const inserted = insertSnippet(snippet, deleteBefore);
  if (inserted && snippet.provider === "wiki-create") {
    openWikiPageCreation(String(snippet.source || snippet.key || "").trim());
  }
  return inserted;
}

function acceptSnippetPopupItem(): boolean {
  if (snippetPopup.hidden || snippetPopupItems.length === 0) return false;
  return chooseSnippetPopupItem();
}

function applySnippetPopupKeyAction(action: ReturnType<typeof snippetPopupKeyAction>): boolean {
  if (snippetPopup.hidden) return false;
  if (snippetPopupItems.length === 0) {
    hideSnippetPopup();
    return false;
  }
  switch (action.type) {
    case "move":
      snippetPopupIndex = (snippetPopupIndex + action.delta + snippetPopupItems.length) % snippetPopupItems.length;
      updateSnippetPopupActiveOption();
      return true;
    case "page":
      snippetPopupIndex = ((snippetPopupIndex + action.delta) % snippetPopupItems.length + snippetPopupItems.length) % snippetPopupItems.length;
      updateSnippetPopupActiveOption();
      return true;
    case "edge":
      snippetPopupIndex = action.edge === "first" ? 0 : snippetPopupItems.length - 1;
      updateSnippetPopupActiveOption();
      return true;
    case "accept":
      return acceptSnippetPopupItem();
    case "consume":
      return true;
    case "select":
      if (action.index < 0 || action.index >= snippetPopupItems.length) return false;
      snippetPopupIndex = action.index;
      return chooseSnippetPopupItem();
    case "dismiss":
      snippetSuppressedPrefix = snippetPopup.dataset.prefix ?? "";
      hideSnippetPopup();
      return true;
    case "none":
      return false;
  }
}

function handleSnippetPopupKey(event: KeyboardEvent): boolean {
  const handled = applySnippetPopupKeyAction(snippetPopupKeyAction({
    key: event.key === "\t" ? "Tab" : event.key, // xwidget may send "\t" instead of "Tab"
    shiftKey: event.shiftKey,
    commandKey: primaryMod(event),
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    isComposing: event.isComposing,
  }));
  if (handled) {
    event.preventDefault();
  }
  return handled;
}

function handleSnippetPopupHostKey(key: VimLiteKey): boolean {
  return applySnippetPopupKeyAction(snippetPopupKeyAction({
    key: key.key,
    shiftKey: key.shiftKey,
    commandKey: key.metaKey && !key.ctrlKey,
    ctrlKey: key.ctrlKey,
    altKey: key.altKey,
    isComposing: key.isComposing,
  }));
}

function expandSnippetAtCursor(): boolean {
  const ctx = editor.cursorContext(320);
  const prefix = snippetPrefix(ctx.before);
  if (!prefix) return false;
  const mode = snippetContextMode(ctx);
  const matches = matchingSnippets(prefix, mode, ctx);
  const exact = matches.find((snippet) => String(snippet.key || "") === prefix)
    ?? (matches.length === 1 ? matches[0] : undefined);
  if (!exact) return false;
  hideSnippetPopup();
  snippetSuppressedPrefix = "";
  return insertSnippet(exact, prefix.length);
}

/**
 * Which formula the preview is following. Deliberately excludes the TeX body:
 * editing inside a formula is not a new preview, and treating it as one reset
 * the cached width and forced a layout measurement on every keystroke.
 */
function mathPreviewFormulaKey(math: { display: boolean; from: number }): string {
  return `${math.display ? "display" : "inline"}:${math.from}`;
}

function sameMathPreviewRect(
  left: { left?: number; top?: number; bottom: number } | null,
  right: { left?: number; top?: number; bottom: number } | null,
): boolean {
  return left === right || Boolean(left && right
    && left.left === right.left
    && left.top === right.top
    && left.bottom === right.bottom);
}

function resetMathPreviewFitState(): void {
  const child = mathPreview.querySelector<HTMLElement>(".noema-visualtex-preview-field");
  if (child) {
    child.style.transform = "";
    child.style.transformOrigin = "";
    child.style.display = "";
    child.style.maxWidth = "";
  }
  mathPreview.style.height = "";
  mathPreview.style.minHeight = "";
  mathPreview.classList.remove("is-math-scaled");
}

function mathPreviewPreferredWidth(display: boolean): number {
  const margin = 8;
  const maxWidth = Math.max(220, window.innerWidth - margin * 2);
  const minimum = display ? 260 : 180;
  const fallback = display ? 480 : 240;
  const previousWidth = mathPreview.style.width;
  resetMathPreviewFitState();
  mathPreview.style.width = "max-content";
  const natural = Math.ceil(mathPreview.scrollWidth || mathPreview.offsetWidth || fallback);
  mathPreview.style.width = previousWidth;
  return Math.min(maxWidth, Math.max(minimum, natural));
}

function updateMathPreviewOverflow(): void {
  if (mathPreview.hidden || mathPreview.classList.contains("is-error")) return;
  resetMathPreviewFitState();
  const rendered = mathPreview.querySelector<HTMLElement>(".noema-visualtex-preview-field");
  if (!rendered) return;
  const style = window.getComputedStyle(mathPreview);
  const paddingX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  const paddingY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  const borderY = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
  const rect = rendered.getBoundingClientRect();
  const naturalWidth = Math.max(rect.width, rendered.scrollWidth, mathPreview.scrollWidth - paddingX);
  const naturalHeight = Math.max(rect.height, rendered.scrollHeight, mathPreview.scrollHeight - paddingY);
  const availableWidth = Math.max(1, mathPreview.clientWidth - paddingX);
  const availableHeight = Math.max(1, Math.min(420, window.innerHeight - 24) - paddingY - borderY);
  const scale = mathPreviewFitScale(availableWidth, availableHeight, naturalWidth, naturalHeight);
  const scaled = scale < 0.995;
  mathPreview.classList.toggle("is-overflowing", scaled);
  mathPreview.classList.toggle("is-math-scaled", scaled);
  if (!scaled) return;
  rendered.style.display = "block";
  rendered.style.maxWidth = "none";
  rendered.style.transformOrigin = "top left";
  rendered.style.transform = `scale(${scale})`;
  mathPreview.style.height = `${Math.ceil(naturalHeight * scale + paddingY + borderY)}px`;
}

function placeMathPreview(
  anchorRect: { left: number; top: number; bottom: number } | null,
  display: boolean,
  bottomRect?: { bottom: number } | null,
): void {
  mathPreview.classList.remove("is-overflowing");
  if (!mathPreviewWidth || mathPreviewWidth > window.innerWidth - 16) {
    mathPreviewWidth = mathPreviewPreferredWidth(display);
  }
  placeFloatingAbove(mathPreview, anchorRect, mathPreviewWidth, bottomRect);
  updateMathPreviewOverflow();
  placeFloatingAbove(mathPreview, anchorRect, mathPreviewWidth, bottomRect);
}

function mathPreviewPlaceholders(math: NonNullable<ReturnType<typeof mathAtCursor>>) {
  return snippetSession.previewState().stops
    .filter((stop) => stop.from === stop.to
      && stop.from >= math.contentFrom
      && stop.from <= math.contentTo)
    .map((stop) => ({
      offset: stop.from - math.contentFrom,
      active: stop.active,
      mirror: stop.mirror,
    }));
}

function showMathPreviewFallback(error: unknown): void {
  const session = mathPreviewSession;
  if (paused || !editorSurfaceVisible() || !session) return;
  const message = error instanceof Error ? error.message : String(error || "LiveTeX unavailable");
  mathPreviewVisualHost.hidden = true;
  mathPreviewFallback.hidden = false;
  mathPreviewFallback.textContent = `${session.tex}\n\nLiveTeX: ${formatMathRenderError(message, MATH_PREVIEW_ERROR_MAX_LENGTH)}`;
  mathPreview.classList.add("is-error");
  mathPreview.hidden = false;
  mathPreviewWidth = 0;
  placeFloatingAbove(
    mathPreview,
    session.anchorRect,
    session.display ? 680 : 380,
    session.bottomRect,
  );
}

function ensureLiveTexPreview(): VisualTexPreview {
  liveTexPreview ??= mountVisualTexPreview(mathPreviewVisualHost, {
    macros: getKatexMacros(),
    // AssistScheduler already keeps this to one latest update per animation
    // frame. Do not add a second 40 ms debounce between source input and the
    // resident MathLive mirror.
    syncIdleMs: 0,
    // Every callback below reads the session the assist frame already resolved.
    // Re-running cursorContext() + mathAtCursor() here scanned the same formula
    // up to three times per frame and could disagree with the frame that opened
    // the preview.
    onSourcePosition: (sourceOffset) => {
      const session = mathPreviewSession;
      if (!session) return;
      const position = session.contentFrom
        + Math.max(0, Math.min(session.tex.length, sourceOffset));
      editor.setMarkdownSelection(position, undefined, { scrollIntoView: true });
      editor.focus();
      scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    },
    onRendered: (contentChanged) => {
      const session = mathPreviewSession;
      if (mathPreview.hidden || paused || !session || !editorSurfaceVisible()) return;
      mathPreviewVisualHost.hidden = false;
      mathPreviewFallback.hidden = true;
      mathPreview.classList.remove("is-error");
      // Placement already ran when the formula/anchor changed. A caret-only
      // frame must not write popup styles immediately before the overlay reads
      // MathLive geometry, since that creates a forced layout on every arrow.
      if (!contentChanged) return;
      // The rendered formula just changed size; this is the one place allowed
      // to force a layout measurement.
      mathPreviewWidth = 0;
      placeMathPreview(session.anchorRect, session.display, session.bottomRect);
    },
    onUnavailable: showMathPreviewFallback,
  });
  return liveTexPreview;
}

function updateMathPreview(
  ctx: ReturnType<typeof editor.cursorContext>,
  allowNewPreview: boolean,
  activeMath: ReturnType<typeof mathAtCursor> = mathAtCursor(ctx),
): void {
  if (visualMathEditorActive) {
    if (!mathPreview.hidden || mathPreviewSession) hideMathPreview();
    return;
  }
  const math = activeMath;
  const placeholders = math ? mathPreviewPlaceholders(math) : [];
  if (!math || (math.tex.trim().length === 0 && placeholders.length === 0)) {
    if (!mathPreview.hidden || mathPreviewSession) hideMathPreview();
    return;
  }
  const nextFormula = mathPreviewFormulaKey(math);
  const anchorRect = math.rect ?? ctx.rect;
  const bottomRect = math.rectEnd ?? anchorRect;
  const previous = mathPreviewSession;
  const wasHidden = mathPreview.hidden;
  if (mathPreview.hidden && !allowNewPreview) return;
  if (previous?.formula !== nextFormula && !allowNewPreview) return;
  if (previous?.formula !== nextFormula) {
    clearMathPreviewErrorTimer();
    mathPreviewWidth = 0;
    mathPreview.classList.remove("is-error");
    mathPreview.classList.toggle("is-display", math.display);
    mathPreview.scrollLeft = 0;
    mathPreview.scrollTop = 0;
  }
  mathPreviewSession = {
    formula: nextFormula,
    tex: math.tex,
    to: math.to,
    contentFrom: math.contentFrom,
    display: math.display,
    doc: math.doc,
    geometryEpoch: math.geometryEpoch,
    anchorRect,
    bottomRect,
  };
  clearMathPreviewErrorTimer();
  mathPreviewPendingErrorKey = "";
  mathPreview.classList.remove("is-error");
  mathPreviewVisualHost.hidden = false;
  mathPreviewFallback.hidden = true;
  mathPreview.hidden = false;
  ensureLiveTexPreview().update({
    latex: math.tex,
    display: math.display,
    selection: math.selection,
    placeholders,
  });
  // Placement is independent of content synchronization: the anchor is already
  // known, and `placeFloatingAbove` is pure arithmetic over the cached width.
  // Deferring it to onRendered() left the pop hovering over the previously
  // edited formula for the whole debounce window.
  if (wasHidden
    || previous?.formula !== nextFormula
    || !sameMathPreviewRect(previous.anchorRect, anchorRect)
    || !sameMathPreviewRect(previous.bottomRect, bottomRect)) {
    placeFloatingAbove(
      mathPreview,
      anchorRect,
      mathPreviewWidth || (math.display ? 680 : 380),
      bottomRect,
    );
  }
}

type ActiveEditorSelection = { rect: DOMRect; text: () => string };

/** Whitespace-only selections offer no command; the read is bounded on purpose. */
const BLANK_SELECTION_PROBE_LIMIT = 4096;

function selectionLooksBlank(read: () => string, length: number): boolean {
  // Checking needs the text, so only check while the selection is small enough
  // for the read to be free; nobody selects four thousand blank characters.
  return length <= BLANK_SELECTION_PROBE_LIMIT && !read().trim();
}

/**
 * The screen box CodeMirror is painting the current selection into.
 *
 * It has to come from CodeMirror, not from `window.getSelection()`. The editor
 * runs `drawSelection`, whose whole job is to hide the browser's selection and
 * paint its own — so the DOM selection stays collapsed no matter how much text
 * is selected, and anything keyed off it sees nothing at all.
 */
function editorSelectionRect(from: number, to: number): DOMRect | null {
  const painted = [...host.querySelectorAll<HTMLElement>(".cm-selectionBackground")]
    .map((element) => element.getBoundingClientRect());
  const fromPainted = unionSelectionRect(painted);
  if (fromPainted) return fromPainted;
  // Scrolled out of the rendered viewport, or a theme without the layer.
  const head = editor.view.coordsAtPos(from);
  const tail = editor.view.coordsAtPos(to);
  return unionSelectionRect([head, tail].filter((coords) => coords !== null));
}

/**
 * The current editor selection as geometry plus a lazy text reader, or null
 * when there is nothing the selection UI applies to.
 *
 * CodeMirror's own selection is the authority; the DOM selection is consulted
 * only for text selected outside CodeMirror's model, such as inside a rendered
 * widget, which the browser still reports normally.
 *
 * `text` is a thunk on purpose. Positioning the floating toolbar needs only the
 * rect, and it runs on every `selectionchange` — which a pointer drag emits
 * continuously. Materializing the selected string there meant a drag across a
 * large note allocated the whole selection once per frame, which is enough on
 * its own to stall the WebKit surface (and, in the Emacs xwidget host, Emacs
 * along with it). Commands that genuinely need the text call the thunk.
 */
function activeEditorSelection(): ActiveEditorSelection | null {
  if (editor.isSourceMode()) return null;
  if (host.querySelector("[data-cm-visual-math='active']")) return null;

  const logical = editor.getSelection();
  const from = Math.min(logical.from, logical.to);
  const to = Math.max(logical.from, logical.to);
  if (from < to) {
    const read = (): string => editor.textBetween(from, to);
    if (selectionLooksBlank(read, to - from)) return null;
    const rect = editorSelectionRect(from, to);
    return rect ? { rect, text: read } : null;
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if (!anchor || !focus || !host.contains(anchor) || !host.contains(focus)) return null;
  const read = (): string => selection.toString();
  if (selectionLooksBlank(read, BLANK_SELECTION_PROBE_LIMIT)) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { rect, text: read };
}

function selectionTouchesEditor(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  return Boolean(anchor && focus && host.contains(anchor) && host.contains(focus));
}

function updateSelectionTool(active = activeEditorSelection()): void {
  if ((serverReaderMode && !serverReader.selectionToolbar) || !active || !modal.hidden) {
    selectionTool.hidden = true;
    selectionMore.hidden = true;
    selectionRevisionForm.hidden = true;
    return;
  }
  selectionRoamIdlink.hidden = currentStandalone;
  const margin = 8;
  const width = Math.min(520, Math.max(360, selectionTool.offsetWidth || 440));
  const left = Math.min(
    Math.max(margin, active.rect.left + active.rect.width / 2 - width / 2),
    Math.max(margin, window.innerWidth - width - margin),
  );
  const top = Math.max(margin, active.rect.top - 46);
  selectionTool.style.left = `${left}px`;
  selectionTool.style.top = `${top}px`;
  selectionTool.hidden = false;
}

async function copyActiveSelection(): Promise<void> {
  const active = activeEditorSelection();
  if (!active) return;
  const copied = await writeSystemClipboard(active.text());
  setStatus(copied ? "Selection copied" : "Copy failed");
  selectionTool.hidden = true;
}

function runSelectionCommand(command: string): void {
  if (command === "copy") {
    void copyActiveSelection();
    return;
  }
  if (command === "more") {
    selectionMore.hidden = !selectionMore.hidden;
    return;
  }
  if (command === "revision-form") {
    if (rejectReadOnlyAction("Read-only pane")) return;
    selectionMore.hidden = true;
    selectionRevisionForm.hidden = false;
    window.setTimeout(() => selectionRevisionForm.elements.namedItem("advice") instanceof HTMLElement
      && (selectionRevisionForm.elements.namedItem("advice") as HTMLElement).focus(), 0);
    return;
  }
  if (command === "insert-roam-idlink") {
    if (rejectReadOnlyAction("Read-only pane")) return;
    selectionMore.hidden = true;
    selectionTool.hidden = true;
    void insertRoamIdLink();
    return;
  }
  if (!["bold", "italic", "highlight", "strike", "code", "link", "superscript", "subscript", "insert-footnote"].includes(command)) return;
  if (rejectReadOnlyAction("Read-only pane")) return;
  editor.runCommand(command as EditorCommand);
  selectionTool.hidden = true;
  selectionMore.hidden = true;
  selectionRevisionForm.hidden = true;
}

function runAssistUpdate(flags: AssistUpdateFlags): void {
  const insertMode = vim.mode() === "insert";
  const wantsSnippets = !visualMathEditorActive && insertMode && (flags.snippets || !snippetPopup.hidden);
  const wantsMathPreview = !passiveServerReader
    && !visualMathEditorActive
    && (flags.mathPreview || !mathPreview.hidden);
  if (passiveServerReader || visualMathEditorActive) hideMathPreview();
  const needsCursorContext = wantsSnippets || wantsMathPreview;
  const ctx = needsCursorContext ? editor.cursorContext(!snippetPopup.hidden ? 640 : 320) : null;
  // Recognition is shared by snippet routing and LiveTeX. Never scan the same
  // formula twice in one assist frame, and never construct preview geometry
  // when no preview work was requested.
  const activeMath = ctx && wantsMathPreview ? mathAtCursor(ctx) : undefined;
  if (flags.toc) updateFloatingToc();
  if (flags.selectionTool && (!serverReaderMode || serverReader.selectionToolbar)) {
    // A drag in progress would have the toolbar chase the pointer, forcing a
    // layout read and a reposition every frame. `mouseup` schedules the one
    // pass that matters.
    const activeSelection = snippetPopup.hidden && modal.hidden && !isPointerSelecting(editor.view.state)
      ? activeEditorSelection()
      : null;
    updateSelectionTool(activeSelection);
  }
  // MathLive drives the shared snippet popup with its own cursor and prefix.
  // A scheduled CM6 assist pass must not replace or hide that popup using the
  // source cursor sitting behind the visual formula widget.
  if (visualMathEditorActive) return;
  if (!insertMode) {
    hideSnippetPopup();
    if (ctx && wantsMathPreview) updateMathPreview(ctx, flags.mathPreview, activeMath);
    return;
  }
  if (ctx) {
    if (wantsSnippets) updateSnippetPopup(ctx, activeMath);
    if (wantsMathPreview) updateMathPreview(ctx, flags.mathPreview, activeMath);
  }
}

function cancelAssistWork(): void {
  assistScheduler.cancel();
  clearCompletionCache();
  clearMathPreviewErrorTimer();
  hideSnippetPopup();
  hideMathPreview();
  selectionTool.hidden = true;
  selectionMore.hidden = true;
}

function applyPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  // One shared renderer activity gate is used by every host shell. Emacs and
  // Electron only contribute pause reasons; neither owns rendering behavior.
  rendererActivity.setPaused(next);
  document.documentElement.classList.toggle("aaronnote-paused", next);
  if (next) {
    cancelAssistWork();
  } else {
    if (pendingNotesRefresh) {
      pendingNotesRefresh = false;
      notesRefreshTimer.schedule(() => void reloadNotes(false));
    }
    scheduleAssistUpdate({ cursor: true, mathPreview: true, selectionTool: true, toc: true });
    scheduleAutomaticProseCheck();
  }
}

function setPausedReason(reason: string, active: boolean): void {
  if (active) pauseReasons.add(reason);
  else pauseReasons.delete(reason);
  applyPaused(pauseReasons.size > 0);
}

function scheduleAssistUpdate(options: AssistUpdateOptions = {}): void {
  assistScheduler.schedule(options);
}

function updateFloatingToc(): void {
  floatingTocPanel.update();
  desktopKnowledgeDock?.refresh();
}

async function reloadSnippets(silent = false): Promise<void> {
  if (!silent) setStatus("Reloading snippets");
  try {
    const msg = await api.notes.snippets();
    if (!Array.isArray(msg.snippets)) {
      const message = (msg as { message?: string }).message || "Snippet reload failed";
      throw new Error(message);
    }
    snippetSession.clear();
    snippets = withBuiltinSnippets(msg.snippets);
    hideSnippetPopup();
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true, toc: true });
    if (!silent) setStatus(`Reloaded ${snippets.length} snippets`);
  } catch (error) {
    if (!silent) setStatus(error instanceof Error ? error.message : "Snippet reload failed");
  }
}

function insertHostKeyText(key: string, text?: string): boolean {
  const literal = typeof text === "string" ? text
    : key === "Enter" ? "\n"
      : key === "Tab" ? "\t"
        : key.length === 1 ? key
          : "";
  if (!literal) return false;
  snippetCompletionArmed = key !== "Enter" && key !== "Tab";
  return runEditorTextInput(editor.view, literal);
}

function deleteHostKeyText(key: string): boolean {
  if (key !== "Backspace" && key !== "Delete") return false;
  return runEditorDelete(editor.view, key === "Backspace" ? "backward" : "forward");
}

function routeHostKeyToMathEditor(key: VimLiteKey, text?: string, code?: string): boolean {
  if (!visualMathEditorActive) return false;
  const event = new CustomEvent("aaronnote:math-host-key", {
    cancelable: true,
    detail: {
      key: key.key,
      code,
      text,
      ctrlKey: key.ctrlKey,
      metaKey: key.metaKey,
      altKey: key.altKey,
      shiftKey: key.shiftKey,
    },
  });
  document.dispatchEvent(event);
  return event.defaultPrevented;
}

function runHostKey(body: Record<string, unknown>): boolean {
  const rawKey = String(body.key || "");
  const shiftTabAlias = rawKey === "Backtab" || rawKey === "ISO_Left_Tab" || rawKey === "Shift-Tab";
  const spaceAlias = rawKey === "Spacebar" || rawKey === "Space" || rawKey === "SPC" || body.code === "Space";
  const enterAlias = body.code === "NumpadEnter" || /^(?:Return|RET|CR|NumpadEnter)$/i.test(rawKey);
  const backslashAlias = rawKey === "\\" || /^backslash$/i.test(rawKey)
    || (body.code === "Backslash" && !body.shiftKey && (!rawKey || rawKey === "Unidentified"));
  const key = shiftTabAlias ? "Tab" : spaceAlias ? " " : enterAlias ? "Enter" : backslashAlias ? "\\" : rawKey;
  if (!key) return false;
  const hostKey: VimLiteKey = {
    key,
    ctrlKey: Boolean(body.ctrlKey),
    metaKey: Boolean(body.metaKey),
    altKey: Boolean(body.altKey),
    shiftKey: Boolean(body.shiftKey) || shiftTabAlias,
  };
  if (routeHostKeyToMathEditor(
    hostKey,
    typeof body.text === "string" ? body.text : undefined,
    typeof body.code === "string" ? body.code : undefined,
  )) return true;
  const copilotKey = new CustomEvent("aaronnote:copilot-host-key", {
    cancelable: true,
    detail: {
      ...hostKey,
      code: typeof body.code === "string" ? body.code : undefined,
      text: typeof body.text === "string" ? body.text : undefined,
      isComposing: Boolean(body.isComposing),
    },
  });
  host.dispatchEvent(copilotKey);
  if (copilotKey.defaultPrevented) return true;
  editor.focus();
  if (key === "Escape" || key === "Esc") snippetSession.clear();
  if (handleSnippetPopupHostKey(hostKey)) {
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    return true;
  }
  if (vim.handleKey(hostKey)) {
    scheduleAssistUpdate({ mathPreview: true, cursor: true });
    return true;
  }
  const primaryBracket = !hostKey.altKey && !hostKey.shiftKey
    && hostKey.metaKey !== hostKey.ctrlKey;
  const bracketRight = body.code === "BracketRight" || key === "]";
  const bracketLeft = body.code === "BracketLeft" || key === "[";
  if (vim.mode() === "insert" && primaryBracket && (bracketRight || bracketLeft)) {
    const handled = bracketRight
      ? jumpSnippetTabstop() || jumpTexUnit(editor.view, 1) || jumpStructuralDelimiter(editor.view, 1)
      : jumpSnippetTabstopBack() || jumpTexUnit(editor.view, -1) || jumpStructuralDelimiter(editor.view, -1);
    if (handled) {
      scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    }
    // Cmd-[ / Cmd-] belong to the TeX/snippet navigation state. Consume an
    // unmatched chord as a no-op so CodeMirror never falls through to its
    // generic indentation binding.
    return true;
  }
  if (currentReadOnly) {
    if (key === "Tab" || key === "Enter" || key === "Backspace" || key === "Delete" || (!hostKey.ctrlKey && !hostKey.metaKey && !hostKey.altKey && key.length === 1)) {
      setStatus("Read-only pane");
      return true;
    }
    return false;
  }
  if (key === "Tab") {
    if (vim.mode() !== "insert") return false;
    editor.focus();
    if (snippetSession.active()) {
      const handled = hostKey.shiftKey ? jumpSnippetTabstopBack() : jumpSnippetTabstop();
      if (handled) {
        scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
        return true;
      }
    }
    if (hostKey.shiftKey) {
      const handled = jumpSnippetTabstopBack();
      if (handled) {
        scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
        return true;
      }
      runEditorTab(editor.view, true);
      scheduleAssistUpdate({ snippets: true, cursor: true });
      return true;
    }
    const snippetHandled = jumpSnippetTabstop() || expandSnippetAtCursor();
    if (snippetHandled) {
      scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
      return true;
    }
    runEditorTab(editor.view);
    scheduleAssistUpdate({ snippets: true, cursor: true });
    return true;
  }
  if (vim.mode() !== "insert" || hostKey.ctrlKey || hostKey.metaKey || hostKey.altKey) return false;
  if (/^(?:Arrow(?:Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/u.test(key)) {
    runEditorMovement(editor.view, key as EditorMovementKey, hostKey.shiftKey);
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    return true;
  }
  if (key === "Enter") {
    runEditorEnter(editor.view);
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    return true;
  }
  if (key === "Backspace" || key === "Delete") {
    const handled = deleteHostKeyText(key);
    if (handled) scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    return handled;
  }
  const inserted = insertHostKeyText(key, typeof body.text === "string" ? body.text : undefined);
  if (inserted) scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
  return inserted;
}

function runHostCommand(detail: unknown): boolean {
  const body = (detail && typeof detail === "object" ? detail : {}) as {
    command?: string;
    key?: string;
    value?: string;
    text?: string;
    file?: string;
    hash?: string;
    dom?: string;
    mode?: VimLiteMode;
    version?: number;
    mtimeMs?: number;
    clientId?: string;
    settings?: LanguageToolSettings;
    settingsRevision?: string;
    repositoryId?: string;
    phase?: string;
    error?: string;
    message?: string;
    notifyError?: boolean;
  };
  const command = String(body.command || "").trim().toLowerCase();
  if (!command) return false;

  switch (command) {
    case "notes-index-changed": {
      const version = typeof body.version === "number" ? body.version : 0;
      // Ignore stale broadcasts (e.g. replayed on reconnect).
      if (version && version <= lastNotesIndexVersion) return true;
      if (version) lastNotesIndexVersion = version;
      if (paused) {
        pendingNotesRefresh = true;
      } else {
        notesRefreshTimer.schedule(() => void reloadNotes(false));
      }
      return true;
    }
    case "agenda-changed":
      void refreshAgendaView();
      return true;
    case "wiki-index-changed": {
      wikiIndexCache = null;
      wikiIndexPromise = null;
      hideSnippetPopup();
      clearCompletionCache();
      scheduleAssistUpdate({ snippets: true });
      return true;
    }
    case "wiki-sync-state-changed": {
      const repositoryId = String(body.repositoryId || "Wiki repository");
      const phase = String(body.phase || "");
      if (phase === "conflicted") {
        setStatus(`${repositoryId} has a Git conflict; open Wiki repositories to resolve it`);
      } else if (phase === "error" && body.notifyError !== false) {
        setStatus(`${repositoryId} sync failed: ${String(body.error || "review Wiki repositories for recovery details")}`);
      }
      return true;
    }
    case "wiki-sync-batch-failed":
      setStatus(String(body.message || "Git sync needs attention; review Wiki repositories for recovery details."));
      return true;
    case "bibliography-index-changed":
      hideSnippetPopup();
      clearCompletionCache();
      snippetSuppressedPrefix = "";
      scheduleBibliographyRefresh(true);
      scheduleAssistUpdate({ snippets: true });
      return true;
    case "server-ready":
      void loadLanguageToolConfiguration();
      void loadNoemaAppConfig();
      return true;
    case "languagetool-settings-changed":
      languageToolLoadSequence += 1;
      if (body.settings) applyLanguageToolConfiguration(body.settings, body.settingsRevision);
      return true;
    case "note-saved": {
      const savedFile = String(body.file || "");
      if (!savedFile || savedFile !== currentFile) return true;
      if (String(body.clientId || "") === clientId) return true;
      const mtimeMs = Number(body.mtimeMs) || 0;
      pendingExternalSave = { file: savedFile, mtimeMs };
      if (revision !== savedRevision) {
        setStatus("Changed in another pane; refresh before saving");
      }
      return true;
    }
    case "key":
      return runHostKey(body as Record<string, unknown>);
    case "pause":
      setPausedReason("host", true);
      return true;
    case "resume":
      setPausedReason("host", false);
      return true;
    case "toggle-pause":
      setPausedReason("host", !pauseReasons.has("host"));
      return true;
    case "save":
      if (rejectReadOnlyAction("Read-only pane")) return true;
      void save();
      return true;
    case "trash-current-note":
    case "delete-current-note":
      if (rejectReadOnlyAction("Read-only pane")) return true;
      void trashCurrentNoteTool();
      return true;
    case "jupyter-cell-script-saved": {
      // The hidden script was edited and saved in Emacs; force @@cell widgets to
      // re-read their source and refresh the panel so both reflect the new code.
      const savedFile = String(body.file || "");
      if (!savedFile || savedFile === currentFile) {
        window.AaronnoteReloadCeilCells?.(savedFile || currentFile);
        if (!jupyterPanel.hidden) renderJupyterPanel();
      }
      setStatus("Jupyter cell script saved");
      return true;
    }
    case "refresh":
    case "reload":
      void reloadCurrentFilePreservingCursor({ preserveView: true });
      return true;
    case "prose-check":
    case "spell-check":
      void runProseCheck();
      return true;
    case "back":
    case "nav-back":
    case "navigation-back":
      void restoreNavigationBack();
      return true;
    case "forward":
    case "nav-forward":
    case "navigation-forward":
      void restoreNavigationForward();
      return true;
    case "find":
      openFindPanel();
      return true;
    case "knowledge-search":
    case "search-notes":
      showKnowledgeSearch();
      return true;
    case "knowledge-backlinks":
      if (desktopKnowledgeDock) desktopKnowledgeDock.toggle("backlinks");
      else localGraphPanel.toggle();
      return true;
    case "knowledge-mentions":
      if (desktopKnowledgeDock) desktopKnowledgeDock.toggle("mentions");
      else setStatus("Unlinked mentions are available in Noema.app Knowledge dock");
      return true;
    case "knowledge-tags":
      if (desktopKnowledgeDock) desktopKnowledgeDock.toggle("tags");
      else void manageCurrentNoteTags();
      return true;
    case "find-next":
      if (findPanel.hidden) openFindPanel();
      else gotoFindMatch(findIndex + 1);
      return true;
    case "find-previous":
      if (findPanel.hidden) openFindPanel();
      else gotoFindMatch(findIndex - 1);
      return true;
    case "focus":
      editor.focus();
      return true;
    case "paste":
      if (rejectReadOnlyAction("Read-only pane")) return true;
      editor.focus();
      void editor.pasteFromClipboard();
      return true;
    // Emacs routes Cmd-C/Cmd-X here rather than to the page's own key handling:
    // on the macOS xwidget port a key Emacs owns can never be replayed into
    // WebKit (see emacs/noema-xwidget-keys.el), so the copy has to be performed
    // by the page itself and written through the host clipboard.
    case "copy":
      void copyEditorSelection();
      return true;
    case "cut":
      if (rejectReadOnlyAction("Read-only pane")) return true;
      void copyEditorSelection(true);
      return true;
    case "escape":
    case "normal":
    case "vim-normal":
      if (clearFormatPainter()) return true;
      vim.setMode("normal");
      editor.focus();
      return true;
    case "insert":
    case "vim-insert":
      vim.setMode("insert");
      editor.focus();
      return true;
    case "jupyter-panel":
      toggleJupyterPanel();
      return true;
    case "jupyter-run-cell":
      void (async () => {
        const cell = selectedJupyterCell();
        if (cell) await runJupyterCell(cell);
      })();
      return true;
    case "jupyter-run-all":
      void runJupyterCells("all");
      return true;
    case "jupyter-run-section":
      void runJupyterCells("section");
      return true;
    case "jupyter-select-cell":
      selectJupyterCellFromHost(body as { file?: string; cellId?: string; id?: string });
      return true;
    case "jupyter-run-script-cell":
      void runJupyterCellFromHost(body as { file?: string; cellId?: string; id?: string });
      return true;
    case "jupyter-restart-run-all":
      void restartAndRunAllJupyterCells();
      return true;
    case "jupyter-interrupt":
      void interruptSelectedJupyterKernel();
      return true;
    case "jupyter-runtime-tasks":
      if (jupyterPanel.hidden) toggleJupyterPanel();
      void showJupyterTasks();
      return true;
    case "jupyter-cleanup":
      if (jupyterPanel.hidden) toggleJupyterPanel();
      void cleanupJupyterRuntime(Boolean((body as { force?: unknown }).force));
      return true;
    case "jupyter-switch-kernel":
      void switchJupyterKernelForCells(body as {
        language?: string;
        session?: string;
        kernel?: string;
        oldKernel?: string;
      });
      return true;
    case "toggle-source":
    case "source":
      toggleSourceMode();
      return true;
    case "toggle-heading-numbers":
    case "heading-numbers":
      toggleHeadingNumbering();
      return true;
    case "capture-format":
    case "capture-format-once":
    case "copy-format":
      return captureFormatPainter("once");
    case "capture-format-continuous":
    case "copy-format-continuous":
      return captureFormatPainter("continuous");
    case "apply-format":
    case "paint-format":
      return applyFormatPainter();
    case "clear-format-painter":
    case "cancel-format-painter":
      return clearFormatPainter();
    case "toggle-toc":
      togglePageOutline();
      return true;
    case "toggle-agenda":
      toggleAgendaSurface();
      return true;
    case "toggle-graph":
      if (desktopKnowledgeDock) desktopKnowledgeDock.toggle("graph");
      else localGraphPanel.toggle();
      return true;
    case "toggle-tools":
      toggleToolsPanel();
      return true;
    case "reload-index":
      void reloadNotes(true);
      return true;
    case "add-meta":
      void quickAddMeta();
      return true;
    case "remove-meta":
      void unregisterMeta();
      return true;
    case "hide-roam":
      void updateNoteMeta(api.meta.hideRoam, {}, "roam: off set");
      return true;
    case "activate-roam":
      void updateNoteMeta(api.meta.activateRoam, {}, "roam: off cleared");
      return true;
    case "tag-manager":
      void manageCurrentNoteTags();
      return true;
    case "add-tag":
      void addTag();
      return true;
    case "manage-tags":
      void manageNoteTags();
      return true;
    case "insert-roam-idlink":
      void insertRoamIdLink();
      return true;
    case "rename-tag":
      void renameRoamTagTool();
      return true;
    case "delete-tag":
      void deleteRoamTagTool();
      return true;
    case "tag-overlap":
      void tagOverlapReportTool();
      return true;
    case "rewrite-paths":
      void rewritePathRefsTool();
      return true;
    case "open-config":
    case "configuration":
    case "settings":
      openConfigurationPage();
      return true;
    case "task-manager":
      openTaskManager();
      return true;
    case "asset-maintenance":
      openAssetMaintenance({
        reveal: window.noemaDesktop ? (file) => { void window.noemaDesktop?.revealPath(file); } : undefined,
        setStatus,
      });
      return true;
    case "import-obsidian":
      void importObsidianVault();
      return true;
    case "cancel-obsidian-import":
      void cancelObsidianImport();
      return true;
    case "open-location":
      openLocationFromHost(body);
      return true;
    case "export-html":
      void exportHtmlTool();
      return true;
    case "export-pdf":
      void exportPdfTool();
      return true;
    case "export-latex":
      void exportLatexTool();
      return true;
    case "open-source-editor":
      if (!currentFile) {
        setStatus("Open a note first");
        return true;
      }
      void api.emacs.open({ file: currentFile })
        .then(() => setStatus(`Opened in ${sourceEditorName()}`))
        .catch((error) => setStatus(`Open failed: ${String(error)}`));
      return true;
    case "reveal-current-file":
      if (!currentFile || !window.noemaDesktop) {
        setStatus("No local note to reveal");
        return true;
      }
      void window.noemaDesktop.revealPath(currentFile)
        .then(() => setStatus(`Revealed note in ${platformLabels.fileManager}`))
        .catch((error) => setStatus(`Reveal failed: ${String(error)}`));
      return true;
    case "undo":
      if (rejectReadOnlyAction("Read-only pane")) return true;
      editor.focus();
      return editor.undo();
    case "redo":
      if (rejectReadOnlyAction("Read-only pane")) return true;
      editor.focus();
      return editor.redo();
    default:
      if (isEditorCommand(command)) {
        if (rejectReadOnlyAction("Read-only pane")) return true;
        editor.focus();
        return editor.runCommand(command, body.value || "");
      }
      return false;
  }
}

function togglePageOutline(): void {
  floatingTocPanel.toggle();
  updateFloatingToc();
  const expanded = tocButton.getAttribute("aria-expanded") === "true";
  statsToggle.setAttribute("aria-expanded", String(expanded));
  statsToggle.classList.toggle("is-active", expanded);
}

function openKnowledgeDockFromPage(event: MouseEvent): void {
  if (!desktopKnowledgeDock) return;
  event.preventDefault();
  if (!toc.classList.contains("is-collapsed")) togglePageOutline();
  desktopKnowledgeDock.show("backlinks");
}

tocButton.title = "Single-click Page outline; double-click Knowledge dock";
statsToggle.title = "Single-click Page outline; double-click Knowledge dock";
tocButton.addEventListener("click", togglePageOutline);
tocButton.addEventListener("dblclick", openKnowledgeDockFromPage);
statsToggle.addEventListener("click", togglePageOutline);
statsToggle.addEventListener("dblclick", openKnowledgeDockFromPage);
statsToggle.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  togglePageOutline();
});
agendaButton.addEventListener("click", () => {
  toggleAgendaSurface();
});
toolsButton.addEventListener("click", toggleToolsPanel);
function activateModeToggle(): void {
  if (slideDeck?.isRevealView()) {
    const theme = slideDeck.toggleTheme();
    renderModeToggleLabel(vim.mode());
    setStatus(`Slides ${theme} theme`);
    return;
  }
  if (!serverReaderMode) toggleToolsPanel();
}

modeToggle.addEventListener("click", activateModeToggle);
modeToggle.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activateModeToggle();
});
toolsClose.addEventListener("click", closeToolsPanel);
roamToolsClose.addEventListener("click", closeRoamToolsPanel);
jupyterButton.addEventListener("click", toggleJupyterPanel);
jupyterClose.addEventListener("click", closeJupyterPanel);
jupyterKernelLanguage.addEventListener("change", () => setJupyterKernelToolFromCell(null));
jupyterKernelSession.addEventListener("change", () => setJupyterKernelToolFromCell(null));
jupyterKernelOld.addEventListener("change", () => {
  if (jupyterKernelNew.value === "") jupyterKernelNew.value = jupyterKernelOld.value;
  renderJupyterKernelMatchPreview();
});
jupyterKernelNew.addEventListener("change", renderJupyterKernelMatchPreview);
if (!jupyterExecutionAvailable) {
  for (const control of jupyterPanel.querySelectorAll<HTMLButtonElement>("[data-jupyter-action]")) {
    if (control.dataset.jupyterAction === "refresh") continue;
    control.disabled = true;
    control.title = "Jupyter execution is unavailable in reader mode";
  }
}
jupyterPanel.addEventListener("click", (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-jupyter-action]");
  if (!button) return;
  event.preventDefault();
  const action = button.dataset.jupyterAction || "";
  if (action === "run-all") void runJupyterCells("all");
  else if (action === "run-above") void runJupyterCells("above");
  else if (action === "run-below") void runJupyterCells("below");
  else if (action === "run-section") void runJupyterCells("section");
  else if (action === "restart-run-all") void restartAndRunAllJupyterCells().catch((error) => setStatus(error instanceof Error ? error.message : "Jupyter restart failed"));
  else if (action === "interrupt") void interruptSelectedJupyterKernel().catch((error) => setStatus(error instanceof Error ? error.message : "Jupyter interrupt failed"));
  else if (action === "clear-all") void clearAllJupyterOutputs().catch((error) => setStatus(error instanceof Error ? error.message : "Clear outputs failed"));
  else if (action === "variables") void showJupyterVariables();
  else if (action === "toggle-kernel-tool") toggleJupyterKernelTool();
  else if (action === "tasks") void showJupyterTasks();
  else if (action === "cleanup") void cleanupJupyterRuntime(false);
  else if (action === "switch-kernel") {
    switchJupyterKernelFromTool();
    jupyterKernelTool.hidden = true;
  }
  else if (action === "refresh") {
    jupyterVars.hidden = true;
    jupyterRuntime.hidden = true;
    renderJupyterPanel();
  }
});
sourceButton.addEventListener("click", toggleSourceMode);
saveButton.addEventListener("click", () => void save());

function eventTargetsNativeWidgetInput(target: EventTarget | null): boolean {
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  return Boolean(element?.closest("[data-aaronnote-vim='native']"));
}

document.addEventListener("keydown", (event) => {
  if (handleXwidgetMathKeydown(event, {
    editor,
    editorHost: host,
    vim,
    allowDetachedTarget: !standaloneMode(),
    enabled: modal.hidden && toolsPanel.hidden && roamToolsPanel.hidden,
  })) return;
  // Cmd-/ is a document-surface boundary even while MathLive owns focus: first
  // commit the current draft, then toggle Source/WYSIWYG. Run it before the
  // generic native-widget guard, which intentionally ignores other shortcuts.
  if (runSourceToggleShortcut(event)) {
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    event.stopPropagation();
    return;
  }
  // Native widget editors are deliberately outside the document's Vim and
  // authoring-shortcut pipeline, regardless of the current document mode.
  if (eventTargetsNativeWidgetInput(event.target)) return;
  if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.length !== 1 && event.key !== "Tab") {
    snippetCompletionArmed = false;
  }
  // The editor's xwidget arrow-key guard runs in capture phase.  In Reveal it
  // must yield before that guard so Reveal receives arrows, PageUp/PageDown,
  // Home/End, Space and Escape.  Cmd-/ remains the way back to editing.
  if (slideDeck?.isRevealView() && modal.hidden && toolsPanel.hidden && roamToolsPanel.hidden) {
    if (runSourceToggleShortcut(event)) event.stopPropagation();
    return;
  }
  if (runFindShortcut(event)) {
    event.stopPropagation();
    return;
  }
  if (runProseCheckShortcut(event)) {
    event.stopPropagation();
    return;
  }
  if (primaryMod(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "p" && modal.hidden && toolsPanel.hidden && roamToolsPanel.hidden && !event.isComposing) {
    event.preventDefault();
    event.stopPropagation();
    void exportLatexTool();
    return;
  }
  if (!standaloneMode() && !serverReaderMode && handleXwidgetEmacsKeydown(event, { client: () => currentClient })) return;
  if (runVisualZoomShortcut(event)) {
    return;
  }
  if (runLayoutZoomShortcut(event)) {
    return;
  }
  if (handleXwidgetHistoryKeydown(event, {
    editor,
    editorHost: host,
    vim,
    allowDetachedTarget: !standaloneMode(),
    enabled: modal.hidden && toolsPanel.hidden && roamToolsPanel.hidden,
  })) {
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    return;
  }
  snippetSuppressedPrefix = event.key === "Escape" ? snippetSuppressedPrefix : "";
  if (plainEscapeKey(event)) snippetSession.clear();
  if (handleSnippetPopupKey(event)) {
    event.stopPropagation();
    return;
  }
  const texBracketDirection = !event.defaultPrevented
    && vim.mode() === "insert"
    && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    ? event.code === "BracketRight" || event.key === "]" ? 1
      : event.code === "BracketLeft" || event.key === "[" ? -1
        : 0
    : 0;
  if (texBracketDirection) {
    const snippetMoved = texBracketDirection > 0 ? jumpSnippetTabstop() : jumpSnippetTabstopBack();
    const handled = snippetMoved || (texBracketDirection > 0
      ? jumpTexUnit(editor.view, 1) || jumpStructuralDelimiter(editor.view, 1)
      : jumpTexUnit(editor.view, -1) || jumpStructuralDelimiter(editor.view, -1));
    event.preventDefault();
    event.stopPropagation();
    if (handled) {
      if (!snippetMoved) setStatus("TeX unit");
      scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    }
    // No generic Cmd-bracket indentation fallback: outside a TeX/snippet
    // scope this shortcut is intentionally a consumed no-op.
    return;
  }
  if (plainEscapeKey(event)) {
    if (!modal.hidden) return;
    if (!toolsPanel.hidden) {
      event.preventDefault();
      closeToolsPanel();
      editor.focus();
      return;
    }
    if (!roamToolsPanel.hidden) {
      event.preventDefault();
      closeRoamToolsPanel();
      editor.focus();
      return;
    }
    if (clearFormatPainter()) {
      event.preventDefault();
      editor.focus();
      return;
    }
  }
  if (handleXwidgetControlKeydown(event, {
    editor,
    editorHost: host,
    vim,
    allowDetachedTarget: !standaloneMode(),
    enabled: modal.hidden && toolsPanel.hidden && roamToolsPanel.hidden,
  })) {
    if (plainEscapeKey(event)) noteCursorPositionEvent();
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    return;
  }
  if (handleXwidgetVimKeydown(event, {
    editor,
    editorHost: host,
    vim,
    allowDetachedTarget: !standaloneMode(),
    enabled: modal.hidden && toolsPanel.hidden && roamToolsPanel.hidden,
  })) {
    if (plainEscapeKey(event)) noteCursorPositionEvent();
    scheduleAssistUpdate({ mathPreview: true, cursor: true });
    return;
  }
  if (vim.mode() === "insert" && (event.key === "Tab" || event.key === "\t") && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const handled = event.shiftKey
      ? jumpSnippetTabstopBack()
      : jumpSnippetTabstop() || expandSnippetAtCursor();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }
  if (handleXwidgetSpecialKeydown(event, {
    editor,
    editorHost: host,
    vim,
    allowDetachedTarget: !standaloneMode(),
    enabled: modal.hidden && toolsPanel.hidden && roamToolsPanel.hidden,
  })) {
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    return;
  }
  if (runClipboardShortcut(event)) {
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true, selectionTool: true });
    event.stopPropagation();
    return;
  }
  if (vim.handleKeyDown(event)) {
    if (plainEscapeKey(event)) noteCursorPositionEvent();
    scheduleAssistUpdate({ mathPreview: true, cursor: true });
    event.stopPropagation();
    return;
  }
  // Cmd-A builds a full-document selection inside CodeMirror without passing
  // through Vim, which would otherwise keep believing the caret is still a
  // collapsed Normal-mode cursor. Observe the chord without consuming it and
  // adopt the resulting range once CodeMirror has applied its transaction.
  // Cmd-D is deliberately left alone: it produces multiple ranges that the
  // modal selection model would collapse to one.
  if (primaryMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a") {
    adoptKeyboardSelectionIntoVim();
  }
  if (primaryMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
    event.stopPropagation();
    return;
  }
  if (runFormattingShortcut(event)) {
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    event.stopPropagation();
    return;
  }
}, true);
host.addEventListener("mouseup", () => {
  if (snippetPopup.hidden) snippetCompletionArmed = false;
});
host.addEventListener("click", (event) => {
  const target = event.target instanceof Element
    ? event.target.closest(".cm-prose-diagnostic")
    : null;
  if (!target) {
    if (!prosePopover.contains(event.target as Node)) hideProsePopover();
    return;
  }
  const position = editor.view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (position == null) return;
  const diagnostic = proseDiagnosticsAt(editor.view, position)[0];
  if (!diagnostic) return;
  event.preventDefault();
  event.stopPropagation();
  showProsePopover(diagnostic, event.clientX, event.clientY);
});
prosePopover.addEventListener("mousedown", (event) => event.preventDefault());
prosePopover.addEventListener("click", (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-prose-action]");
  const diagnostic = activeProseDiagnostic;
  if (!button || !diagnostic) return;
  event.preventDefault();
  event.stopPropagation();
  const action = button.dataset.proseAction;
  if (action === "replace") {
    if (rejectReadOnlyAction("Read-only pane")) return;
    editor.replaceMarkdownRange(diagnostic.from, diagnostic.to, button.dataset.value ?? "", "end");
    removeProseDiagnostics((entry) => entry === diagnostic);
    editor.focus();
    return;
  }
  if (action === "ignore") {
    removeProseDiagnostics((entry) => entry === diagnostic);
    editor.focus();
    return;
  }
  if (action === "accept" && diagnostic.word) {
    const word = diagnostic.word;
    void api.proseCheck.acceptWord(word)
      .then(() => {
        removeProseDiagnostics((entry) => entry.word?.toLowerCase() === word.toLowerCase());
        setStatus(`Added “${word}” to the Noema prose dictionary`);
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : "Adding word failed"));
  }
});
document.addEventListener("beforeinput", (event) => {
  if (handleXwidgetMathBeforeInput(event as InputEvent, {
    editor,
    editorHost: host,
    vim,
    allowDetachedTarget: !standaloneMode(),
    enabled: modal.hidden && toolsPanel.hidden && roamToolsPanel.hidden,
  })) return;
  if (eventTargetsNativeWidgetInput(event.target)) return;
  const ie = event as InputEvent;
  if (ie.inputType === "insertText" && ie.data && ie.data !== "\t") {
    snippetCompletionArmed = true;
  }
  // xwidget Tab: may arrive only as beforeinput(insertText, "\t") with no keydown.
  // Try snippet popup acceptance and snippet expansion before letting CM6 insert \t.
  if (ie.inputType === "insertText" && ie.data === "\t"
      && vim.mode() === "insert"
      && modal.hidden && toolsPanel.hidden && roamToolsPanel.hidden) {
    const accepted = applySnippetPopupKeyAction(snippetPopupKeyAction({
      key: "Tab", shiftKey: false, commandKey: false, ctrlKey: false, altKey: false, isComposing: false,
    }));
    if (accepted) {
      event.preventDefault();
      scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
      return;
    }
    if (jumpSnippetTabstop() || expandSnippetAtCursor()) {
      event.preventDefault();
      scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
      return;
    }
    runEditorTab(editor.view);
    event.preventDefault();
    scheduleAssistUpdate({ snippets: true, cursor: true });
    return;
  }
  if (handleXwidgetControlBeforeInput(event as InputEvent, {
    editor,
    editorHost: host,
    vim,
    allowDetachedTarget: !standaloneMode(),
    enabled: modal.hidden && toolsPanel.hidden && roamToolsPanel.hidden,
  })) {
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    return;
  }
  if (handleXwidgetSpecialBeforeInput(event as InputEvent, {
    editor,
    editorHost: host,
    vim,
    allowDetachedTarget: !standaloneMode(),
    enabled: modal.hidden && toolsPanel.hidden && roamToolsPanel.hidden,
  })) {
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true });
    return;
  }
  if (handleXwidgetVimBeforeInput(event as InputEvent, {
    editor,
    editorHost: host,
    vim,
    allowDetachedTarget: !standaloneMode(),
    enabled: modal.hidden && toolsPanel.hidden && roamToolsPanel.hidden,
  })) {
    scheduleAssistUpdate({ mathPreview: true, cursor: true });
  }
}, true);
document.addEventListener("selectionchange", () => {
  if (!editorSurfaceVisible()) return;
  // A pointer drag emits this continuously; `mouseup` runs the final pass.
  if (isPointerSelecting(editor.view.state)) return;
  if (selectionTouchesEditor() || !selectionTool.hidden) {
    scheduleAssistUpdate({ selectionTool: true });
  }
});
document.addEventListener("mousedown", (event) => {
  if (!editorSurfaceVisible() || event.defaultPrevented) return;
  if (!(event.target instanceof Node) || editor.view.dom.contains(event.target)) return;
  if (editor.view.state.selection.ranges.every((range) => range.empty)) return;
  // Hiding the toolbar is a UI concern.  A click outside the editor may move
  // focus, but it is not an implicit Escape and must not collapse Vim state.
  selectionTool.hidden = true;
  selectionMore.hidden = true;
});
document.addEventListener("mouseup", (event) => {
  if (!editorSurfaceVisible()) return;
  if (isPointerSelecting(editor.view.state)
      || (event.target instanceof Node && editor.view.dom.contains(event.target))) {
    // Insert mode owns native half-open selections (typing replaces them).
    // Normal/Visual adopt pointer selections into the modal selection model.
    if (vim.mode() !== "insert") vim.syncSelectionFromEditor();
    noteCursorPositionEvent();
  }
  scheduleAssistUpdate({ mathPreview: true, cursor: true, selectionTool: true });
});
window.addEventListener("resize", () => {
  mathPreviewGeometryEpoch++;
  liveTexPreview?.refreshLayout();
  scheduleAssistUpdate({ mathPreview: true, cursor: true, selectionTool: !selectionTool.hidden });
});
window.addEventListener("scroll", (event) => {
  const target = event.target;
  const editorViewportScrolled = target === document
    || target === window
    || (target instanceof Node && host.contains(target));
  if (!editorViewportScrolled) return;
  mathPreviewGeometryEpoch++;
  // A fixed formula/snippet/selection surface chasing an inertial scroll has
  // to read caret geometry and write overlay styles every frame. In WebKit it
  // also feeds back into CM6 measurement, visibly pulling the document in the
  // opposite direction. Viewport movement closes transient editing aids; the
  // next real cursor/input action may open them again at fresh coordinates.
  transientSurfaces.close(["snippet-popup", "math-preview", "prose-popover", "context-menu"], "viewport");
  selectionTool.hidden = true;
  selectionMore.hidden = true;
  selectionRevisionForm.hidden = true;
  if (serverReaderMode) scheduleAssistUpdate({ toc: true });
  if (target instanceof Node && host.contains(target)) {
    scheduleAutomaticProseCheck(proseProfile().scrollMs);
  }
}, { capture: true, passive: true });
selectionTool.addEventListener("mousedown", (event) => {
  if (!(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLSelectElement)) event.preventDefault();
});
selectionTool.addEventListener("click", (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-selection-command]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  runSelectionCommand(button.dataset.selectionCommand || "");
});
selectionRevisionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (rejectReadOnlyAction("Read-only pane")) return;
  const data = new FormData(selectionRevisionForm);
  const advice = String(data.get("advice") || "").trim();
  if (!advice) return;
  editor.focus();
  editor.runCommand("insert-revision", JSON.stringify({
    advice,
    reason: String(data.get("reason") || "").trim(),
    style: String(data.get("style") || "indigo"),
  }));
  selectionRevisionForm.reset();
  selectionRevisionForm.hidden = true;
  selectionTool.hidden = true;
});

findInput.addEventListener("input", () => refreshFind(findInput.value, false));
findInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeFindPanel();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    refreshFind(findInput.value, true);
    gotoFindMatch(findIndex + (event.shiftKey ? -1 : 1));
  }
});
findPrevButton.addEventListener("click", () => gotoFindMatch(findIndex - 1));
findNextButton.addEventListener("click", () => gotoFindMatch(findIndex + 1));
findCloseButton.addEventListener("click", closeFindPanel);
document.addEventListener("aaronnote:open-url", (event) => {
  const custom = event as CustomEvent<{ href?: string; newWindow?: boolean }>;
  const href = custom.detail?.href;
  if (!href) return;
  event.preventDefault();
  openExternalUrl(href, { newWindow: custom.detail?.newWindow === true });
});
document.addEventListener("aaronnote:preview-url", (event) => {
  const custom = event as CustomEvent<{ href?: string; x?: number; y?: number; persistent?: boolean }>;
  const href = custom.detail?.href;
  if (!href) return;
  event.preventDefault();
  linkPreview.show(href, Number(custom.detail?.x || 0), Number(custom.detail?.y || 0), {
    persistent: custom.detail?.persistent === true,
  });
});
document.addEventListener("aaronnote:open-attachment", (event) => {
  const custom = event as CustomEvent<{ href?: string }>;
  const href = custom.detail?.href;
  if (!href) return;
  event.preventDefault();
  const rawPath = hrefPath(href) || href;
  void openSystemTarget(rawPath, currentFile).catch((err) => setStatus(`Open failed: ${String(err)}`));
});
window.addEventListener("aaronnote:open-file", (event) => {
  const detail = (event as CustomEvent<{ file?: string }>).detail;
  if (detail?.file && detail.file !== currentFile) pushNavigationBackLocation();
  void openFile(detail?.file);
});

root.querySelectorAll<HTMLButtonElement>("[data-desktop-command]").forEach((button) => {
  button.addEventListener("click", () => {
    runHostCommand({ command: button.dataset.desktopCommand });
  });
});
root.querySelectorAll<HTMLButtonElement>("[data-server-command]").forEach((button) => {
  button.addEventListener("click", () => {
    const command = String(button.dataset.serverCommand || "");
    if (command === "back") history.back();
    else if (command === "forward") history.forward();
    else runHostCommand({ command });
  });
});
root.querySelectorAll<HTMLButtonElement>("[data-desktop-menu]").forEach((button) => {
  button.addEventListener("click", () => {
    const kind = button.dataset.desktopMenu === "window" ? "window" : "actions";
    const bounds = button.getBoundingClientRect();
    void window.noemaDesktop?.showMenu(kind, { x: bounds.left, y: bounds.bottom });
  });
});

const removeDesktopCommandListener = desktopMode
  ? window.noemaDesktop?.onCommand((detail) => runHostCommand(detail)) ?? null
  : null;

window.addEventListener("aaronnote:command", (event) => {
  const detail = (event as CustomEvent<unknown>).detail;
  const targetClient = detail && typeof detail === "object"
    ? String((detail as { client?: unknown }).client || "")
    : "";
  if (targetClient && targetClient !== currentClient) return;
  runHostCommand(detail);
});

function desktopExternalDrag(data: DataTransfer | null): boolean {
  if (!desktopMode || !data) return false;
  const types = Array.from(data.types || []);
  if (types.some((type) => type.startsWith("text/x-aaronnote-"))) return false;
  return data.files.length > 0 || types.includes("Files") || types.includes("text/uri-list");
}

function desktopDroppedPaths(data: DataTransfer): string[] {
  if (!window.noemaDesktop) return [];
  return Array.from(data.files)
    .map((file) => window.noemaDesktop?.filePath(file) || "")
    .filter(Boolean);
}

function updateDesktopDropOverlay(data: DataTransfer, forceAttachment: boolean): void {
  const disposition = desktopDropDisposition(desktopDroppedPaths(data), forceAttachment);
  desktopDropLabel.textContent = disposition.type === "open"
    ? "Open Markdown in a new Noema window"
    : "Insert files, links, or text at the cursor";
  desktopDropOverlay.hidden = false;
}

let desktopDragDepth = 0;
document.addEventListener("dragenter", (event) => {
  if (!desktopExternalDrag(event.dataTransfer)) return;
  desktopDragDepth += 1;
  updateDesktopDropOverlay(event.dataTransfer!, event.altKey);
  event.preventDefault();
}, true);
document.addEventListener("dragover", (event) => {
  if (!desktopExternalDrag(event.dataTransfer)) return;
  updateDesktopDropOverlay(event.dataTransfer!, event.altKey);
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  event.preventDefault();
}, true);
document.addEventListener("dragleave", (event) => {
  if (!desktopExternalDrag(event.dataTransfer) && desktopDropOverlay.hidden) return;
  desktopDragDepth = Math.max(0, desktopDragDepth - 1);
  if (desktopDragDepth === 0) desktopDropOverlay.hidden = true;
  event.preventDefault();
}, true);
document.addEventListener("drop", (event) => {
  if (!desktopExternalDrag(event.dataTransfer)) return;
  event.preventDefault();
  desktopDragDepth = 0;
  desktopDropOverlay.hidden = true;
  const data = event.dataTransfer!;
  const disposition = desktopDropDisposition(desktopDroppedPaths(data), event.altKey);
  if (disposition.type === "open") {
    window.noemaDesktop?.openFiles(disposition.paths);
    setStatus(disposition.paths.length === 1 ? "Opened note in a new window" : `Opened ${disposition.paths.length} notes`);
    return;
  }
  if (rejectReadOnlyAction("Read-only pane")) return;
  const position = editor.view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (typeof position === "number") editor.setMarkdownSelection(position);
  editor.focus();
  void editor.pasteFromDataTransfer(data).then((handled) => {
    if (!handled) {
      setStatus("This drop type could not be inserted");
      return;
    }
    setStatus("Drop inserted");
    scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true, toc: true });
  }).catch((error) => setStatus(`Drop failed: ${String(error)}`));
}, true);

let desktopOptionHeld = false;
window.addEventListener("keydown", (event) => { desktopOptionHeld = event.altKey; }, true);
window.addEventListener("keyup", (event) => { desktopOptionHeld = event.altKey; }, true);
window.addEventListener("blur", () => { desktopOptionHeld = false; });

const removeNativeDropListener = desktopMode && window.noemaDesktop?.onFileDrop
  ? window.noemaDesktop.onFileDrop((event) => {
    const disposition = desktopDropDisposition(event.paths, desktopOptionHeld);
    if (event.type === "leave") {
      desktopDropOverlay.hidden = true;
      return;
    }
    if (event.type === "enter" || event.type === "over") {
      desktopDropLabel.textContent = disposition.type === "open"
        ? "Open Markdown in a new Noema window"
        : "Insert files at the cursor";
      desktopDropOverlay.hidden = false;
      return;
    }
    desktopDropOverlay.hidden = true;
    if (disposition.type === "open") {
      window.noemaDesktop?.openFiles(disposition.paths);
      setStatus(disposition.paths.length === 1 ? "Opened note in a new window" : `Opened ${disposition.paths.length} notes`);
      return;
    }
    if (rejectReadOnlyAction("Read-only pane") || !window.noemaDesktop?.readDroppedFiles) return;
    void window.noemaDesktop.readDroppedFiles(disposition.paths).then((files) => {
      const transfer = new DataTransfer();
      files.forEach((file) => transfer.items.add(file));
      const position = event.position && editor.view.posAtCoords(event.position);
      if (typeof position === "number") editor.setMarkdownSelection(position);
      editor.focus();
      return editor.pasteFromDataTransfer(transfer);
    }).then((handled) => {
      if (!handled) setStatus("This drop type could not be inserted");
      else {
        setStatus("Drop inserted");
        scheduleAssistUpdate({ snippets: true, mathPreview: true, cursor: true, toc: true });
      }
    }).catch((error) => setStatus(`Drop failed: ${String(error)}`));
  })
  : null;

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    setPausedReason("visibility", true);
    void flushCursorPosition();
  } else {
    setPausedReason("visibility", false);
  }
});
window.addEventListener("pagehide", () => {
  proseLifecycle.invalidate("page-hidden");
  flushCursorPositionKeepalive();
  savePendingNoteKeepalive();
  notifyClientClosedKeepalive();
});
window.addEventListener("beforeunload", () => {
  savePendingNoteKeepalive();
  liveTexPreview?.destroy();
  liveTexPreview = null;
  removeNoemaThemeRuntime();
  removeDesktopCommandListener?.();
  removeNativeDropListener?.();
  coreReconnectController?.destroy();
  rendererActivity.destroy();
  focusQuiescence.destroy();
  vim.destroy();
  imeCoalesceTimer.cancel();
  zoomController.destroy();
  writingStatsController?.destroy();
  flushCursorPositionKeepalive();
  notifyClientClosedKeepalive();
});
window.addEventListener("popstate", () => {
  void restoreNavigationBack();
});

// Fetch the note/snippets, renderer config and KaTeX macros concurrently.  The
// note is installed only after config/macros settle, so its first paint is
// stable, while optional LanguageTool settings never gate editor readiness.
void (async () => {
  const configReady = (async () => {
    try {
      const config = await loadNoemaAppConfig();
      if (config.diagnostics[0]) setStatus(config.diagnostics[0].message);
    } catch (error) {
      setStatus(`Settings failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  const macrosReady = (async () => {
    try {
      const result = await api.config.katexMacros();
      if (result?.macros) setKatexMacros(result.macros);
    } catch (_) {
      // Macros are optional.
    }
  })();
  void loadLanguageToolConfiguration();
  await openInitialFile(Promise.all([configReady, macrosReady]));
})();
