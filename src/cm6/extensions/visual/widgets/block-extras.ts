/**
 * Phase 6 — Regex-scanned block widgets for the CM6 kernel.
 *
 * CM6 constraint: block:true decorations must come from StateField, not ViewPlugin.
 * This entire module uses StateField (full-doc scan).
 *
 * Three widget types:
 *
 *   [toc]  (case-insensitive, own line)
 *   #+begin <type> … #+end <type>  (org-mode style blocks)
 *   --- … ---  (YAML front matter at document start)
 *   --- / *** / ___  (horizontal rule)
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { MeasuredWidget } from "./measured-widget.ts";
import { shortHash } from "./measured-observer.ts";
import { StateEffect, StateField, type ChangeSet, type EditorState, type Extension, type Text } from "@codemirror/state";
import type { Range as CMRange } from "@codemirror/state";
import {
  getBlockMathRanges,
  mergeOverlappingRanges,
  positionInsideAnyRange,
  rangeOverlapsAny,
} from "../../../math-ranges.ts";
import {
  changesMightAffectFencedCodeRanges,
  fencedCodeRangesExtension,
  getFencedCodeRanges,
} from "../../../code-ranges.ts";
import {
  renderMarkdownInlineHTML,
  renderMarkdownHTML,
} from "../../../../render-html.ts";
import {
  ORG_META_PREAMBLE_LINE_LIMIT,
  editableMetaEntries,
  metaEntryMap,
  metaRoamIndexed,
  metaTags,
  orgMetaSummarySourceRange,
  parseOrgMetaDocument,
  showMetaTag,
  type MetaSummary,
} from "../../../../org-meta.ts";
import { applyImageLayout, imageLayoutFromAttrs, readImageTrailingAttrs, type ImageLayoutAttrs } from "../../../../image-attrs.ts";
import { supportedDiagramLang } from "../../../../diagram-langs.ts";
import { api } from "../../../../../aaronnote/api-client.ts";
import { hostMode } from "../../../../../aaronnote/host-mode.ts";
import { renderJupyterVariablesTable } from "../../../../jupyter-variables-view.ts";
import { tocIndexFromState, type MarkdownHeading } from "../../../toc-index.ts";
import { scanInlineCommands } from "../../../../command-syntax.ts";
import { semanticOutlineFromCommand, type SemanticOutline } from "../../../../semantic-outline.ts";
import { highlightCodeForEditor } from "../../../../code-highlight-async.ts";
import { parseOrgEnvIdentityTitle, shortBlockId } from "../../../../../shared/block-identity.mjs";
import type { JupyterWidgetKernelMessage } from "../../../../jupyter-widget-runtime.ts";
import type { JupyterMarkdownParser, WidgetMountFn } from "../../../../jupyter-rendermime.ts";
import { ceilCommandGeneratedId as sharedCeilCommandGeneratedId, ceilLanguageForKernel } from "./ceil-shared.ts";
import { parseSimpleFrontmatter } from "../../../../simple-frontmatter.ts";
import { protectedCitationRanges } from "../../../../../shared/bibliography-syntax.mjs";
import { createInteractiveCiteElement } from "./inline-commands.ts";
import {
  isMarkdownLinkOpenEvent,
  markdownLinkOpensNewWindow,
} from "../../../markdown-link-events.ts";
import { refreshViewportDecorations } from "../../../viewport-refresh.ts";
import { preserveEditorViewport } from "../../../viewport-stability.ts";

// ---------------------------------------------------------------------------
// TOC fold state (session-level, not editor history)
// ---------------------------------------------------------------------------

export const tocFoldEffect = StateEffect.define<{ key: string; folded: boolean }>();

function tocFoldReducer(state: Map<string, boolean>, effects: readonly StateEffect<unknown>[]): Map<string, boolean> {
  let next: Map<string, boolean> | undefined;
  for (const effect of effects) {
    if (effect.is(tocFoldEffect)) {
      if (!next) next = new Map(state);
      if (effect.value.folded) next.set(effect.value.key, true);
      else next.delete(effect.value.key);
    }
  }
  return next ?? state;
}

const tocFoldField = StateField.define<Map<string, boolean>>({
  create: () => new Map(),
  update(state, tr) { return tocFoldReducer(state, tr.effects); },
});

// ---------------------------------------------------------------------------
// Regexes / parsers
// ---------------------------------------------------------------------------

// [toc] alone on a line
const TOC_LINE_RE = /^[ \t]*\[toc\][ \t]*$/im;

const HR_LINE_RE = /^[ \t]{0,3}((?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

export interface OrgEnvBlock {
  from: number;
  to: number;
  openFrom: number;
  openTo: number;
  bodyFrom: number;
  bodyTo: number;
  closeFrom: number;
  closeTo: number;
  kind: string;
  title: string;
  blockId: string;
  blockIdFrom: number;
  body: string;
  titleAnchor: number;
  depth: number;
}

export interface OrgEnvContext {
  kind: string;
  depth: number;
}

interface OrgEnvOpenLineInfo {
  kind: string;
  title: string;
  blockId: string;
  blockIdFrom: number;
  titleAnchor: number;
}

interface OrgEnvTitlePatch {
  blocks: readonly OrgEnvBlock[];
  newBlock: OrgEnvBlock;
}

declare global {
  interface Window {
    AaronnoteCurrentFile?: () => string;
    AaronnoteResolveAssetUrl?: (src: string) => string;
    AaronnoteCopyBlockTarget?: (blockId: string) => Promise<string>;
    AaronnoteBlockTarget?: (blockId: string) => string;
    // Set by the block-extras ViewPlugin so the app shell can force @@cell
    // widgets to re-read their hidden source after an out-of-band edit (e.g.
    // the user saved the script buffer in Emacs). See notifyCeilScriptSaved.
    AaronnoteReloadCeilCells?: (file?: string) => void;
    AaronnoteRunCeilCell?: (cellId: string) => Promise<boolean>;
    AaronnotePublishJupyterCellResult?: (detail: {
      file: string;
      cellId: string;
      kernel: string;
      session: string;
      result: CeilExecutionResult;
    }) => void;
  }
}

const ceilRunHandlers = new Map<string, () => Promise<void>>();

function installCeilRunBridge(): void {
  window.AaronnoteRunCeilCell = async (cellId: string): Promise<boolean> => {
    const id = String(cellId || "").trim();
    const run = id ? ceilRunHandlers.get(id) : undefined;
    if (!run) return false;
    await run();
    return true;
  };
}

function registerCeilRunHandler(cellId: string, run: () => Promise<void>): () => void {
  installCeilRunBridge();
  const id = String(cellId || "").trim();
  if (!id) return () => {};
  ceilRunHandlers.set(id, run);
  return () => {
    if (ceilRunHandlers.get(id) === run) ceilRunHandlers.delete(id);
    if (ceilRunHandlers.size === 0 && window.AaronnoteRunCeilCell) {
      window.AaronnoteRunCeilCell = undefined;
    }
  };
}

/**
 * Live output events pushed from the server while a cell runs (see
 * createLiveOutputStream in server/lib/jupyter-cell.mjs). One window listener
 * fans out to the mounted cell widgets by cell id, mirroring how the run
 * bridge above is installed once and shared.
 */
export type CeilLiveEvent =
  | { kind: "status"; state: string }
  | { kind: "executionCount"; value: number | null }
  | { kind: "set"; index: number; output: Record<string, unknown> }
  | { kind: "append"; index: number; text: string }
  | { kind: "clear" };

export type CeilLiveDetail = {
  key?: string;
  runId?: string;
  cellId?: string;
  file?: string;
  kernel?: string;
  session?: string;
  phase?: "start" | "events" | "end" | "stdin" | "stdin-done";
  events?: CeilLiveEvent[];
  status?: string;
  executionCount?: number | null;
  /** phase "stdin": the kernel is blocked in input()/getpass() and wants an answer. */
  prompt?: string;
  password?: boolean;
};

const ceilLiveHandlers = new Map<string, (detail: CeilLiveDetail) => void>();
let ceilLiveBridgeInstalled = false;

function handleCeilLiveEvent(event: Event): void {
  const detail = (event as CustomEvent<CeilLiveDetail>).detail;
  const id = String(detail?.cellId || "").trim();
  if (!id) return;
  ceilLiveHandlers.get(id)?.(detail);
}

function registerCeilLiveHandler(cellId: string, handle: (detail: CeilLiveDetail) => void): () => void {
  const id = String(cellId || "").trim();
  if (!id) return () => {};
  if (!ceilLiveBridgeInstalled) {
    window.addEventListener("aaronnote:jupyter-cell", handleCeilLiveEvent);
    ceilLiveBridgeInstalled = true;
  }
  ceilLiveHandlers.set(id, handle);
  return () => {
    if (ceilLiveHandlers.get(id) === handle) ceilLiveHandlers.delete(id);
    if (ceilLiveHandlers.size === 0 && ceilLiveBridgeInstalled) {
      window.removeEventListener("aaronnote:jupyter-cell", handleCeilLiveEvent);
      ceilLiveBridgeInstalled = false;
    }
  };
}

/**
 * Apply one live patch to an outputs array being built. Mirrors the server's
 * own assembly exactly, so the array converges on the same value the execute
 * response will carry.
 */
export function applyCeilLiveEvent(
  outputs: Array<Record<string, unknown>>,
  event: CeilLiveEvent,
): Array<Record<string, unknown>> {
  if (event.kind === "clear") return [];
  if (event.kind === "set") {
    const next = outputs.slice();
    next[event.index] = event.output;
    return next;
  }
  if (event.kind === "append") {
    const next = outputs.slice();
    const target = next[event.index];
    if (target) next[event.index] = { ...target, text: String(target.text ?? "") + event.text };
    return next;
  }
  return outputs;
}

const ORG_ENV_OPEN_LINE_RE = /^([ \t]*#\+\s*begin\s+)(\S+)(?:([ \t]+)([^\n]*?))?[ \t]*$/i;
const ORG_ENV_SCAN_OPEN_RE = /^[ \t]*#\+\s*begin\s+(\S+)(?:[ \t]+([^\n]*))?[ \t]*$/i;

function orgEnvBoundaryRe(kind: string, boundary: "begin" | "end"): RegExp {
  const escapedKind = kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (boundary === "begin") return new RegExp(`^[ \\t]*#\\+\\s*begin\\s+${escapedKind}(?:\\s|$)`, "i");
  return new RegExp(`^[ \\t]*#\\+\\s*end\\s+${escapedKind}[ \\t]*$`, "i");
}

function combineExcludedRanges(
  ...lists: Array<ReadonlyArray<{ from: number; to: number }>>
): Array<{ from: number; to: number }> {
  return mergeOverlappingRanges(lists.flatMap((list) => Array.from(list)));
}

function blockExtraExcludedRanges(state: EditorState): Array<{ from: number; to: number }> {
  return combineExcludedRanges(getBlockMathRanges(state), getFencedCodeRanges(state));
}

// Depth-aware scanner: handles nested #+begin <kind> … #+end <kind>.
function scanOrgEnvBlocks(
  text: string,
  depthLevel = 0,
  baseOffset = 0,
  excludedRanges: ReadonlyArray<{ from: number; to: number }> = [],
): OrgEnvBlock[] {
  const results: OrgEnvBlock[] = [];
  let metaPreambleTo = -1;
  if (depthLevel === 0 && baseOffset === 0) {
    metaPreambleTo = text.length + 1;
    let lineFrom = 0;
    for (let line = 0; line < ORG_META_PREAMBLE_LINE_LIMIT; line++) {
      const newline = text.indexOf("\n", lineFrom);
      if (newline < 0) {
        metaPreambleTo = text.length + 1;
        break;
      }
      lineFrom = newline + 1;
      metaPreambleTo = lineFrom;
    }
  }
  let i = 0;
  while (i < text.length) {
    // Advance to the start of the next line
    const lineEnd = text.indexOf("\n", i);
    const lineEndPos = lineEnd === -1 ? text.length : lineEnd;
    if (positionInsideAnyRange(baseOffset + i, excludedRanges)) { i = lineEndPos + 1; continue; }
    const line = text.slice(i, lineEndPos);
    const openMatch = ORG_ENV_SCAN_OPEN_RE.exec(line);
    if (!openMatch) { i = lineEndPos + 1; continue; }

    const kind = openMatch[1].toLowerCase();
    if (kind === "lean4") { i = lineEndPos + 1; continue; }
    if (kind === "meta" && (metaPreambleTo < 0 || i >= metaPreambleTo)) {
      i = lineEndPos + 1;
      continue;
    }
    const rawTitle = (openMatch[2] ?? "").trim();
    const identity = parseOrgEnvIdentityTitle(kind, rawTitle);
    const title = identity.title;
    const blockFrom = i;
    const bodyStart = lineEndPos + 1;

    // Find matching #+end kind at this depth level
    const openRe = orgEnvBoundaryRe(kind, "begin");
    const closeRe = orgEnvBoundaryRe(kind, "end");

    let depth = 1, pos = bodyStart, closeFrom = -1, closeTo = -1;
    while (pos < text.length) {
      const nl = text.indexOf("\n", pos);
      const nextEnd = nl === -1 ? text.length : nl;
      if (positionInsideAnyRange(baseOffset + pos, excludedRanges)) { pos = nextEnd + 1; continue; }
      const cur = text.slice(pos, nextEnd);
      if (closeRe.test(cur)) { depth--; if (depth === 0) { closeFrom = pos; closeTo = nextEnd; break; } }
      else if (openRe.test(cur)) depth++;
      pos = nextEnd + 1;
    }

    if (closeFrom < 0) { i = lineEndPos + 1; continue; }

    const titleIndex = openMatch[2] ? line.indexOf(openMatch[2]) : -1;
    const blockIdIndex = identity.blockId ? line.lastIndexOf(identity.blockId) : -1;
    const body = text.slice(bodyStart, closeFrom);
    results.push({
      from: blockFrom,
      to: closeTo,
      openFrom: blockFrom,
      openTo: lineEndPos,
      bodyFrom: bodyStart,
      bodyTo: closeFrom,
      closeFrom,
      closeTo,
      kind,
      title,
      blockId: identity.blockId,
      blockIdFrom: blockIdIndex >= 0 ? blockFrom + blockIdIndex : -1,
      body,
      titleAnchor: titleIndex >= 0 ? blockFrom + titleIndex : lineEndPos,
      depth: depthLevel,
    });
    if (kind !== "meta") {
      for (const nested of scanOrgEnvBlocks(body, depthLevel + 1, baseOffset + bodyStart, excludedRanges)) {
        results.push({
          ...nested,
          from: bodyStart + nested.from,
          to: bodyStart + nested.to,
          openFrom: bodyStart + nested.openFrom,
          openTo: bodyStart + nested.openTo,
          bodyFrom: bodyStart + nested.bodyFrom,
          bodyTo: bodyStart + nested.bodyTo,
          closeFrom: bodyStart + nested.closeFrom,
          closeTo: bodyStart + nested.closeTo,
          titleAnchor: bodyStart + nested.titleAnchor,
          blockIdFrom: nested.blockIdFrom >= 0 ? bodyStart + nested.blockIdFrom : -1,
        });
      }
    }
    i = closeTo + 1;
  }
  return results.sort((a, b) => a.from - b.from || a.to - b.to);
}

function setSourceRange(el: HTMLElement, from: number, to: number): void {
  el.dataset.cmSourceFrom = String(from);
  el.dataset.cmSourceTo = String(to);
}

export function orgEnvExitTarget(state: EditorState): number | null {
  const pos = state.selection.main.from;
  const containing = orgEnvBlocksFromState(state)
    .filter((block) => block.openFrom < pos && pos <= block.closeTo)
    .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
  if (!containing) return null;
  return state.doc.sliceString(containing.closeTo, containing.closeTo + 1) === "\n"
    ? containing.closeTo + 1
    : containing.closeTo;
}

type OrgEnvContainerIndex = {
  blocks: readonly OrgEnvBlock[];
  /** Running maximum of `bodyTo` over `blocks[0..i]`, for early termination. */
  maxBodyTo: number[];
};

const orgEnvContainerIndexCache = new WeakMap<readonly OrgEnvBlock[], OrgEnvContainerIndex>();

function orgEnvContainerIndex(state: EditorState): OrgEnvContainerIndex {
  const source = orgEnvBlocksFromState(state);
  const cached = orgEnvContainerIndexCache.get(source);
  if (cached) return cached;
  const blocks = source
    .filter((block) => block.kind !== "meta")
    .slice()
    .sort((a, b) => a.bodyFrom - b.bodyFrom || a.bodyTo - b.bodyTo);
  const maxBodyTo: number[] = [];
  let running = Number.NEGATIVE_INFINITY;
  for (const block of blocks) {
    running = Math.max(running, block.bodyTo);
    maxBodyTo.push(running);
  }
  const index = { blocks, maxBodyTo };
  orgEnvContainerIndexCache.set(source, index);
  return index;
}

/**
 * Innermost org environment whose body contains `[from, to]`.
 *
 * This runs once per rendered formula/widget, so it must not allocate: the old
 * implementation filtered and sorted the note's entire org-env block list on
 * every call, making a decoration rebuild O(widgets x blocks).
 */
export function orgEnvContextForRange(state: EditorState, from: number, to: number): OrgEnvContext | null {
  const { blocks, maxBodyTo } = orgEnvContainerIndex(state);
  if (blocks.length === 0) return null;
  // Last block whose body can start at or before `from`.
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (blocks[mid]!.bodyFrom <= from) low = mid + 1;
    else high = mid;
  }
  for (let index = low - 1; index >= 0; index--) {
    if (maxBodyTo[index]! < to) break;
    const block = blocks[index]!;
    // Blocks are properly nested, so the latest-starting container is the
    // innermost one.
    if (block.bodyFrom <= from && to <= block.bodyTo) {
      return { kind: block.kind, depth: block.depth };
    }
  }
  return null;
}

function buildOrgEnvSource(kind: string, title: string, body: string): string {
  const bodyWithCloseNewline = body.endsWith("\n") ? body : `${body}\n`;
  return `${buildOrgEnvOpenLine(kind, title)}\n${bodyWithCloseNewline}#+end ${kind}`;
}

function buildOrgEnvOpenLine(kind: string, title: string): string {
  return title.trim().length > 0 ? `#+begin ${kind} ${title.trim()}` : `#+begin ${kind}`;
}

function parseOrgEnvOpenLine(line: string): OrgEnvOpenLineInfo | null {
  const match = ORG_ENV_OPEN_LINE_RE.exec(line);
  if (!match) return null;
  const rawTitle = match[4] ?? "";
  const identity = parseOrgEnvIdentityTitle(match[2], rawTitle);
  const title = identity.title;
  const blockIdIndex = identity.blockId ? line.lastIndexOf(identity.blockId) : -1;
  const titleAnchor = title.length > 0
    ? match[1].length + match[2].length + (match[3] ?? "").length + Math.max(0, rawTitle.search(/\S/))
    : line.length;
  return {
    kind: match[2].toLowerCase(),
    title,
    blockId: identity.blockId,
    blockIdFrom: blockIdIndex,
    titleAnchor,
  };
}

function stopEditorPropagation(event: Event): void {
  event.stopPropagation();
}

function renderDiagramPreview(source: string, lang: string, div: HTMLElement): void {
  const key = `mermaid\n${lang}\n${source.trim()}`;
  div.dataset.diagramRenderKey = key;
  div.textContent = "Loading diagram renderer...";
  void import("../../../../diagram-render.ts")
    .then(({ renderMermaidLazy }) => {
      if (div.dataset.diagramRenderKey !== key) return;
      renderMermaidLazy(source, div, (err) => {
        div.classList.add("cm-diagram-error");
        div.textContent = err;
      }, { lang });
    })
    .catch((err: unknown) => {
      if (div.dataset.diagramRenderKey !== key) return;
      div.classList.add("cm-diagram-error");
      div.textContent = err instanceof Error ? err.message : String(err);
    });
}

function enhanceRenderedMarkdown(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("pre > code[class*='language-']").forEach((code) => {
    const langClass = Array.from(code.classList).find((cls) => cls.startsWith("language-")) ?? "";
    const lang = langClass.slice("language-".length);
    if (!supportedDiagramLang(lang)) return;
    const pre = code.parentElement;
    if (!(pre instanceof HTMLPreElement)) return;
    const div = document.createElement("div");
    div.className = "cm-mermaid-block-preview";
    renderDiagramPreview(code.textContent ?? "", lang, div);
    pre.replaceWith(div);
  });
}

function stopInteractiveWidgetEvents(root: HTMLElement): void {
  for (const type of ["mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "beforeinput", "input"]) {
    root.addEventListener(type, stopEditorPropagation);
  }
}

type TikzAssetResult = {
  ok?: boolean;
  markdownPath?: string;
  message?: string;
};

type CeilKernelSpec = { name: string; displayName?: string; language?: string; attachable?: boolean };

type CeilMeta = {
  kernel: string;
  session: string;
  id: string;
  language: string;
  attrs: Array<{ key: string; value: string }>;
  changed: boolean;
};

type CeilCellContext = {
  cellId: string;
  kernel: string;
  session: string;
  language: string;
  code: string;
};

type CeilCellContextEntry = CeilCellContext & CeilMeta & {
  from: number;
  to: number;
};

type CeilExecutionResult = {
  ok?: boolean;
  cellId?: string;
  kernel?: string;
  session?: string;
  status?: string;
  executionCount?: number | null;
  outputs?: Array<Record<string, unknown>>;
  message?: string;
  stoppedAt?: string;
  autoRan?: boolean;
  results?: CeilExecutionResult[];
  plan?: Array<{ cellId?: string; mode?: string; selected?: boolean }>;
  widgetMessages?: JupyterWidgetKernelMessage[];
  widgetMessagesTruncated?: boolean;
  widgetOutputs?: Record<string, Array<Record<string, unknown>>>;
  live?: boolean;
  savedAt?: string;
  kernelRuntime?: {
    id?: string;
    name?: string;
    generation?: number;
  };
  widgetRuntime?: {
    id: string;
    name: string;
    generation?: number;
  };
  ui?: {
    outputFolded?: boolean;
    outputExpanded?: boolean;
  };
};

function ceilOutputUi(result: CeilExecutionResult | null): NonNullable<CeilExecutionResult["ui"]> {
  return result && result.ui && typeof result.ui === "object" ? result.ui : {};
}

function patchCeilOutputUi(result: CeilExecutionResult | null, patch: NonNullable<CeilExecutionResult["ui"]>): CeilExecutionResult {
  return {
    ...(result ?? { ok: true, status: "ok", outputs: [] }),
    ui: { ...ceilOutputUi(result), ...patch },
  };
}

function mergeCeilOutputUi(result: CeilExecutionResult | null, current: CeilExecutionResult | null): CeilExecutionResult | null {
  if (!result) return current;
  const ui = { ...ceilOutputUi(result), ...ceilOutputUi(current) };
  return Object.keys(ui).length > 0 ? { ...result, ui } : result;
}

function ceilResultStatusLabel(meta: Pick<CeilMeta, "id">, result: CeilExecutionResult | null): string {
  if (!result) return meta.id;
  const prefix = result.live === false ? "Saved " : "";
  if (result.executionCount != null) return `${prefix}In [${result.executionCount}]`;
  return result.status ? `${prefix}${result.status}` : meta.id;
}

function mergeCeilOutputFromServer(saved: CeilExecutionResult | null, current: CeilExecutionResult | null): CeilExecutionResult | null {
  if (!saved) return current;
  if (saved.widgetRuntime || saved.live === false) return mergeCeilOutputUi(saved, current);
  if (current?.widgetRuntime && current.live !== false) {
    return mergeCeilOutputUi({ ...saved, live: true, widgetRuntime: current.widgetRuntime }, current);
  }
  return mergeCeilOutputUi(saved, current);
}

const clearTikzDirtyEffect = StateEffect.define<string>();
const tikzAssetCache = new Map<string, Promise<TikzAssetResult>>();
const tikzRenderedSourceByAsset = new Map<string, string>();
const tikzPendingSourceByAsset = new Map<string, string>();
const DEFAULT_CEIL_KERNEL = "python3";
const DEFAULT_CEIL_SESSION = "default";
const DEFAULT_CEIL_LANGUAGE = "python";
const ceilKernelsCache = new Map<string, { at: number; kernels: CeilKernelSpec[] }>();
const ceilKernelsPending = new Map<string, Promise<CeilKernelSpec[]>>();
const ceilOutputCache = new Map<string, CeilExecutionResult>();
// Hidden-script source text keyed by file/kernel/session/cell id. Lets a widget
// that is rebuilt on every keystroke (typing `(`, `-`, `*` … forces a full
// block-extra redecoration) repaint synchronously instead of firing a
// readScriptCell IPC per rebuild — the storm this cache exists to kill.
const ceilSourceCache = new Map<string, string>();

// Forces @@cell widgets to re-read their hidden source. Value is the owning
// note file whose caches were invalidated (empty string = all files).
const ceilRefreshEffect = StateEffect.define<string>();
// Bumped on cache invalidation; folded into CeilCommandWidget identity so an
// out-of-band script save makes eq() report the widget as changed.
let ceilCacheEpoch = 0;

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, limit = 128): void {
  map.set(key, value);
  if (map.size <= limit) return;
  const oldest = map.keys().next();
  if (!oldest.done) map.delete(oldest.value);
}

function ceilSourceKey(file: string, meta: Pick<CeilMeta, "kernel" | "session" | "id">): string {
  return `${file}\0${meta.kernel}\0${meta.session}\0${meta.id}`;
}

function clearCeilCachesForFile(file: string): void {
  if (!file) {
    ceilSourceCache.clear();
    ceilOutputCache.clear();
    return;
  }
  const prefix = `${file}\0`;
  for (const key of Array.from(ceilSourceCache.keys())) {
    if (key.startsWith(prefix)) ceilSourceCache.delete(key);
  }
  for (const key of Array.from(ceilOutputCache.keys())) {
    if (key.startsWith(prefix)) ceilOutputCache.delete(key);
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function tikzTimestamp(date = new Date()): string {
  return [
    String(date.getFullYear()),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    "-",
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join("");
}

function nextTikzTimestamp(previous: string): string {
  const next = tikzTimestamp();
  return next === previous ? tikzTimestamp(new Date(Date.now() + 1000)) : next;
}

function tikzGeneratedId(timestamp: string): string {
  return `tikz-${timestamp}`;
}

function splitTikzTitle(title: string): { head: string; attrsRaw: string; layout: ImageLayoutAttrs } {
  const raw = String(title || "").trim();
  const open = raw.indexOf("{");
  if (open < 0) return { head: raw, attrsRaw: "", layout: imageLayoutFromAttrs({}) };
  const trailing = readImageTrailingAttrs(raw, open);
  if (!trailing || raw.slice(trailing.to).trim()) return { head: raw, attrsRaw: "", layout: imageLayoutFromAttrs({}) };
  return {
    head: raw.slice(0, open).trim(),
    attrsRaw: trailing.raw,
    layout: imageLayoutFromAttrs(trailing.attrs),
  };
}

function completeTikzTitle(title: string): { id: string; timestamp: string; attrsRaw: string; layout: ImageLayoutAttrs; changed: boolean } {
  const parsed = splitTikzTitle(title);
  const parts = parsed.head.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return { id: parts[0]!, timestamp: parts[1]!, attrsRaw: parsed.attrsRaw, layout: parsed.layout, changed: false };
  const timestamp = tikzTimestamp();
  const id = parts[0] || tikzGeneratedId(timestamp);
  return { id, timestamp, attrsRaw: parsed.attrsRaw, layout: parsed.layout, changed: true };
}

function tikzDirtyKeyFromTitle(title: string): string {
  const parsed = splitTikzTitle(title);
  return parsed.head.split(/\s+/, 1)[0] || "";
}

function currentNoteFile(): string {
  return window.AaronnoteCurrentFile?.() || "";
}

function cleanCeilToken(value: string, fallback: string): string {
  const clean = String(value || "").trim();
  return clean || fallback;
}

function stripCeilKernelParens(value: string): string {
  const clean = String(value || "").trim();
  const match = /^\(([^()]+)\)$/.exec(clean);
  return (match?.[1] ?? clean).trim();
}


function isLeanCeilRuntime(language: string, kernel: string): boolean {
  return /lean/i.test(language) || /lean/i.test(kernel);
}

type CeilCommandRange = {
  from: number;
  to: number;
  argsRaw: string;
  idRaw: string;
};

type CeilCommandMeta = CeilMeta & {
  rawArgs: string;
};

type CeilCommandDefaults = Pick<CeilMeta, "language" | "kernel" | "session">;

export type JupyterCellDescriptor = {
  from: number;
  to: number;
  cellId: string;
  kernel: string;
  session: string;
  language: string;
};

const CEIL_COMMAND_LINE_RE = /^([ \t]*)@@cell(?:[ \t]*\(([^)\n]*)\))?(?:[ \t]+\[([^\]\n]*)\])?[ \t]*$/i;

function parseCeilCommandLine(text: string, lineFrom: number): CeilCommandRange | null {
  const match = CEIL_COMMAND_LINE_RE.exec(text);
  if (!match) return null;
  const leading = match[1]?.length ?? 0;
  return {
    from: lineFrom + leading,
    to: lineFrom + text.length,
    argsRaw: match[2] ?? "",
    idRaw: match[3] ?? "",
  };
}

function ceilCommandGeneratedId(file: string, range: CeilCommandRange): string {
  return sharedCeilCommandGeneratedId(file, range.from, range.argsRaw, range.idRaw);
}

function ceilLooksLikeKernelToken(value: string): boolean {
  return /python3|sage|julia|ir|bash|zsh|node|javascript|typescript|lean4?/i.test(value);
}

function defaultCeilKernelForLanguage(language: string): string {
  if (/^lean4?$/i.test(language)) return "lean4";
  if (/^(?:bash|sh|shell|zsh)$/i.test(language)) return "bash";
  return DEFAULT_CEIL_KERNEL;
}

function parseCeilCommand(range: CeilCommandRange, file: string, defaults?: CeilCommandDefaults): CeilCommandMeta {
  const args = range.argsRaw.split(",").map((part) => part.trim()).filter(Boolean);
  let language = args[0] || defaults?.language || DEFAULT_CEIL_LANGUAGE;
  let kernel = "";
  let session = defaults?.session || DEFAULT_CEIL_SESSION;
  if (args.length === 1 && ceilLooksLikeKernelToken(args[0]!)) {
    kernel = args[0]!;
    language = ceilLanguageForKernel(kernel);
  } else if (args.length >= 3 || (args.length === 2 && ceilLooksLikeKernelToken(args[1]!))) {
    // Read the legacy language,kernel[,session] marker, but never write it.
    kernel = args[1] || "";
    session = args[2] || DEFAULT_CEIL_SESSION;
  } else {
    // Current marker authority is language,session.  Kernel selection belongs
    // to the sidecar session header and the Emacs global manager.
    session = args[1] || (args.length === 0
      ? (defaults?.session || DEFAULT_CEIL_SESSION)
      : DEFAULT_CEIL_SESSION);
  }
  if (!kernel && defaults?.kernel) {
    const defaultLanguage = ceilLanguageForKernel(defaults.kernel, defaults.language);
    const requestedLanguage = language.toLowerCase();
    if (!args[0] || requestedLanguage === defaults.language.toLowerCase() || requestedLanguage === defaultLanguage.toLowerCase()) {
      kernel = defaults.kernel;
    }
  }
  if (!kernel) kernel = defaultCeilKernelForLanguage(language);
  kernel = cleanCeilToken(stripCeilKernelParens(kernel), defaultCeilKernelForLanguage(language));
  session = cleanCeilToken(session, DEFAULT_CEIL_SESSION);
  language = ceilLanguageForKernel(kernel, language);
  const id = cleanCeilToken(range.idRaw, ceilCommandGeneratedId(file, range));
  const normalizedArgs = `${language}, ${session}`;
  return {
    kernel,
    session,
    id,
    language,
    attrs: [],
    rawArgs: range.argsRaw,
    changed: !range.idRaw.trim() || range.argsRaw.trim() !== normalizedArgs,
  };
}

function formatCeilCommand(meta: CeilCommandMeta): string {
  return `@@cell(${meta.language}, ${meta.session || DEFAULT_CEIL_SESSION}) [${meta.id}]`;
}

function replaceCeilCommandLine(view: EditorView, from: number, insert: string): void {
  if (from < 0 || from > view.state.doc.length) return;
  const line = view.state.doc.lineAt(from);
  const range = parseCeilCommandLine(line.text, line.from);
  if (!range) return;
  const prefix = line.text.slice(0, range.from - line.from);
  const next = `${prefix}${insert}`;
  if (line.text === next) return;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
}

function scheduleCeilCommandLineUpdate(view: EditorView, from: number, insert: string): void {
  window.requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    replaceCeilCommandLine(view, from, insert);
  });
}

function ceilOutputKey(file: string, meta: Pick<CeilMeta, "kernel" | "session" | "id">, body: string): string {
  return `${file}\0${meta.kernel}\0${meta.session}\0${meta.id}\0${shortHash(body)}`;
}

function sameCeilContext(a: CeilMeta, b: CeilMeta): boolean {
  return a.language === b.language && a.session === b.session;
}

function ceilCommandRangesFromState(state: EditorState): CeilCommandRange[] {
  const ranges = state.field(blockExtraRangesField, false) ?? scanBlockExtraRanges(state.doc, blockExtraExcludedRanges(state));
  return ranges.ceilCommands;
}

function ceilCommandDefaultsForState(state: EditorState, current: CeilCommandRange, file: string): CeilCommandDefaults | undefined {
  let previous: CeilCommandDefaults | undefined;
  for (const range of ceilCommandRangesFromState(state)) {
    if (range.from === current.from && range.to === current.to) continue;
    if (!range.argsRaw.trim()) continue;
    const meta = parseCeilCommand(range, file);
    const defaults = { language: meta.language, kernel: meta.kernel, session: meta.session };
    if (range.from < current.from) previous = defaults;
  }
  return previous;
}

function ceilCommandUsedIds(state: EditorState, file: string, current: CeilCommandRange): Set<string> {
  const used = new Set<string>();
  for (const range of ceilCommandRangesFromState(state)) {
    if (range.from === current.from && range.to === current.to) continue;
    const id = parseCeilCommand(range, file).id;
    if (id) used.add(id);
  }
  return used;
}

function uniqueCeilCommandId(state: EditorState, file: string, range: CeilCommandRange, baseId: string): string {
  const used = ceilCommandUsedIds(state, file, range);
  if (!used.has(baseId)) return baseId;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `ceil-${shortHash(`${file}\n${range.from}\n${range.argsRaw}\n${index}`)}`;
    if (!used.has(candidate)) return candidate;
  }
  return `ceil-${shortHash(`${file}\n${range.from}\n${range.argsRaw}\n${Date.now()}`)}`;
}

function parseCeilCommandForState(state: EditorState, range: CeilCommandRange, file: string): CeilCommandMeta {
  const meta = parseCeilCommand(range, file, ceilCommandDefaultsForState(state, range, file));
  if (!range.idRaw.trim()) {
    const uniqueId = uniqueCeilCommandId(state, file, range, meta.id);
    if (uniqueId !== meta.id) return { ...meta, id: uniqueId, changed: true };
  }
  return meta;
}

/** Read-only consumers (such as slides) use the exact same inherited @@cell
 * context and generated identity as the editable CM6 widget. */
export function jupyterCellsFromState(state: EditorState, file: string): JupyterCellDescriptor[] {
  return ceilCommandRangesFromState(state).map((range) => {
    const meta = parseCeilCommandForState(state, range, file);
    return {
      from: range.from,
      to: range.to,
      cellId: meta.id,
      kernel: meta.kernel,
      session: meta.session,
      language: meta.language,
    };
  });
}

function ceilCommandEntriesForContext(state: EditorState, target: CeilMeta, file: string): CeilCellContextEntry[] {
  return ceilCommandRangesFromState(state)
    .map((range) => ({ range, meta: parseCeilCommandForState(state, range, file) }))
    .filter(({ meta }) => sameCeilContext(meta, target))
    .map(({ range, meta }) => ({
      ...meta,
      from: range.from,
      to: range.to,
      cellId: meta.id,
      kernel: meta.kernel,
      session: meta.session,
      language: meta.language,
      code: "",
    }));
}

function ceilCommandCellsForContext(state: EditorState, target: CeilMeta, file: string): CeilCellContext[] {
  return ceilCommandEntriesForContext(state, target, file).map(({ cellId, kernel, session, language, code }) => ({
    cellId,
    kernel,
    session,
    language,
    code,
  }));
}

function uniqueCeilSessions(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const session = cleanCeilToken(value, "");
    if (!session || seen.has(session)) continue;
    seen.add(session);
    result.push(session);
  }
  return result;
}

function ceilSessionSuggestions(state: EditorState, target: CeilMeta, file: string): string[] {
  const sameKernel: string[] = [];
  const sameLanguage: string[] = [];
  const all: string[] = [];
  for (const range of ceilCommandRangesFromState(state)) {
    const meta = parseCeilCommandForState(state, range, file);
    all.push(meta.session);
    if (meta.language === target.language) sameLanguage.push(meta.session);
    if (meta.language === target.language && meta.kernel === target.kernel) sameKernel.push(meta.session);
  }
  return uniqueCeilSessions([target.session, ...sameKernel, ...sameLanguage, ...all, DEFAULT_CEIL_SESSION]);
}

function highlightedCeilCode(code: string, language: string): HTMLElement {
  const pre = document.createElement("pre");
  const codeEl = document.createElement("code");
  pre.append(codeEl);
  const ranges = highlightCodeForEditor(language, code);
  let pos = 0;
  for (const range of ranges) {
    if (range.from > pos) codeEl.append(document.createTextNode(code.slice(pos, range.from)));
    const span = document.createElement("span");
    span.className = range.className;
    span.textContent = code.slice(range.from, range.to);
    codeEl.append(span);
    pos = range.to;
  }
  if (pos < code.length) codeEl.append(document.createTextNode(code.slice(pos)));
  return pre;
}

function resolveAssetSrc(src: string): string {
  return window.AaronnoteResolveAssetUrl?.(src) ?? src;
}

function ensureTikzAsset(file: string, id: string, timestamp: string, source: string): Promise<TikzAssetResult> {
  const key = `${file}\n${id}\n${timestamp}\n${source}`;
  let existing = tikzAssetCache.get(key);
  if (!existing) {
    existing = api.assets.renderTikz({ file, id, timestamp, source })
      .catch((err: unknown) => ({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }));
    tikzAssetCache.set(key, existing);
    if (tikzAssetCache.size > 128) {
      const oldest = tikzAssetCache.keys().next().value as string | undefined;
      if (oldest) tikzAssetCache.delete(oldest);
    }
  }
  return existing;
}

function tikzSourceCacheKey(file: string, id: string): string {
  return `${file}\n${id}`;
}

function scheduleTikzOpenLineUpdate(
  view: EditorView,
  from: number,
  makeTitle: (info: OrgEnvOpenLineInfo) => string | null,
  effects: StateEffect<unknown>[] = [],
): void {
  window.requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    const line = view.state.doc.lineAt(from);
    const info = parseOrgEnvOpenLine(line.text);
    if (!info || info.kind !== "tikz") return;
    const title = makeTitle(info);
    if (!title) return;
    view.dispatch({
      changes: {
        from: line.from,
        to: line.to,
        insert: `#+ begin tikz ${title}`,
      },
      effects,
    });
  });
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

type TocHeading = MarkdownHeading;

interface BlockExtraRanges {
  toc: Array<{ from: number; to: number }>;
  semanticHeadings: Array<{ from: number; to: number; outline: SemanticOutline }>;
  ceilCommands: CeilCommandRange[];
  hrs: Array<{ from: number; to: number }>;
  frontMatter: { from: number; to: number; body: string } | null;
}

class TocWidget extends MeasuredWidget {
  headings: TocHeading[];
  foldState: ReadonlyMap<string, boolean>;
  signature: string;

  constructor(headings: TocHeading[], foldState: ReadonlyMap<string, boolean>) {
    super();
    this.headings = headings;
    this.foldState = foldState;
    this.signature = tocSignature(headings, foldState);
  }

  protected measureKey(): string { return "toc:" + shortHash(this.signature); }

  protected measureGroupKey(): string {
    const bucket = Math.min(8, Math.ceil(this.headings.length / 8));
    return `toc:count:${bucket}`;
  }

  protected estimatedHeightFallback(): number {
    let visible = 0;
    forEachVisibleTocHeading(this.headings, this.foldState, () => { visible++; });
    return Math.max(58, 38 + visible * 26);
  }

  eq(other: TocWidget): boolean {
    return this.signature === other.signature;
  }

  toDOM(view: EditorView): HTMLElement {
    const foldState = view.state.field(tocFoldField, false) ?? this.foldState;
    const div = document.createElement("div");
    div.className = "toc cm-toc";
    div.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    if (this.headings.length === 0) {
      const empty = document.createElement("div");
      empty.className = "toc-empty";
      empty.textContent = "(no headings yet)";
      div.append(empty);
      return this.registerMeasured(div, view);
    }

    // Determine which headings have children (for chevron rendering)
    const hasChildren = new Set<number>();
    for (let i = 0; i < this.headings.length - 1; i++) {
      if (this.headings[i + 1]!.level > this.headings[i]!.level) hasChildren.add(i);
    }

    const ul = document.createElement("ul");
    ul.className = "toc-list";
    forEachVisibleTocHeading(this.headings, foldState, (heading, idx, fKey) => {
      const isFolded = foldState.get(fKey) ?? false;
      const li = document.createElement("li");
      li.className = `toc-item toc-h${heading.level}`;
      li.style.setProperty("--toc-depth", String(Math.max(0, heading.level - 1)));
      li.dataset.level = String(heading.level);
      li.dataset.foldKey = fKey;

      if (hasChildren.has(idx)) {
        const chevron = document.createElement("button");
        chevron.type = "button";
        chevron.className = `toc-fold-chevron${isFolded ? " is-folded" : ""}`;
        chevron.setAttribute("aria-label", isFolded ? "Expand" : "Collapse");
        chevron.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const nowFolded = !(foldState.get(fKey) ?? false);
          view.dispatch({
            effects: tocFoldEffect.of({ key: fKey, folded: nowFolded }),
          });
        });
        li.append(chevron);
      }

      const span = document.createElement("span");
      span.className = "toc-item-text";
      span.textContent = heading.text || "(empty heading)";
      span.title = heading.text || "(empty heading)";
      li.append(span);

      li.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const currentHeadings = tocHeadingsFromState(view.state);
        const currentKeys = tocFoldKeys(currentHeadings);
        const currentHeading = currentHeadings[currentKeys.indexOf(fKey)] ?? heading;
        view.dispatch({ selection: { anchor: currentHeading.pos }, scrollIntoView: true });
        view.focus();
        const dom = view.domAtPos(currentHeading.pos).node;
        const el = dom instanceof Element ? dom : dom.parentElement;
        el?.scrollIntoView({ block: "start", behavior: "smooth" });
      });
      ul.append(li);
    });

    div.append(ul);
    return this.registerMeasured(div, view);
  }

  ignoreEvent(): boolean { return true; }
}

const SEMANTIC_HEADING_ESTIMATED_HEIGHT: Record<number, number> = {
  1: 458,
  2: 236,
  3: 180,
  4: 135,
  5: 101,
};

class SemanticHeadingWidget extends MeasuredWidget {
  outline: SemanticOutline;
  from: number;
  to: number;

  constructor(outline: SemanticOutline, from: number, to: number) {
    super();
    this.outline = outline;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string {
    return ["sem", this.outline.level, this.outline.kind, this.outline.slug, shortHash(this.outline.text)].join(":");
  }

  protected measureGroupKey(): string {
    const textBucket = Math.min(4, Math.ceil(this.outline.text.length / 36));
    return ["sem", "level", this.outline.level, "text", textBucket].join(":");
  }

  protected estimatedHeightFallback(): number {
    return SEMANTIC_HEADING_ESTIMATED_HEIGHT[this.outline.level] ?? SEMANTIC_HEADING_ESTIMATED_HEIGHT[2]!;
  }

  eq(other: SemanticHeadingWidget): boolean {
    return this.from === other.from
      && this.to === other.to
      && this.outline.level === other.outline.level
      && this.outline.kind === other.outline.kind
      && this.outline.label === other.outline.label
      && this.outline.text === other.outline.text
      && this.outline.slug === other.outline.slug;
  }

  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-semantic-heading aaronnote-section-heading";
    div.dataset.sectionKind = this.outline.kind;
    div.dataset.sectionLabel = this.outline.label;
    div.dataset.outlineLevel = String(this.outline.level);
    div.style.setProperty("--outline-level", String(this.outline.level));
    setSourceRange(div, this.from, this.to);

    const inner = document.createElement("div");
    inner.className = "aaronnote-section-heading-inner";

    const label = document.createElement("span");
    label.className = "aaronnote-section-label";
    label.textContent = this.outline.label;
    const title = document.createElement("span");
    title.className = "aaronnote-section-title";
    title.textContent = this.outline.text;
    inner.append(label, title);
    div.append(inner);

    div.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });
    window.requestAnimationFrame(() => {
      if (div.isConnected && view.dom.isConnected) view.requestMeasure();
    });
    return this.registerMeasured(div, view);
  }

  ignoreEvent(): boolean { return false; }
}

function tocFoldKeys(headings: readonly TocHeading[]): string[] {
  const counts = new Map<string, number>();
  const stack: Array<{ level: number; ordinal: number }> = [];
  return headings.map((heading) => {
    while (stack.length > 0 && heading.level <= stack[stack.length - 1]!.level) {
      stack.pop();
    }
    const parentPath = stack.map((part) => part.ordinal).join(".");
    const siblingGroup = `${parentPath}|${heading.level}`;
    const ordinal = (counts.get(siblingGroup) ?? 0) + 1;
    counts.set(siblingGroup, ordinal);
    const path = parentPath ? `${parentPath}.${ordinal}` : String(ordinal);
    stack.push({ level: heading.level, ordinal });
    return `${path}:${heading.level}:${heading.text}`;
  });
}

function tocHeadingsFromState(state: EditorState): TocHeading[] {
  return tocIndexFromState(state).headings.filter((heading) => !heading.omit);
}

function forEachVisibleTocHeading<T extends TocHeading>(
  headings: readonly T[],
  foldState: ReadonlyMap<string, boolean>,
  visit: (heading: T, index: number, foldKey: string) => void,
): void {
  const foldedDepths: number[] = [];
  const foldKeys = tocFoldKeys(headings);
  for (let idx = 0; idx < headings.length; idx++) {
    const heading = headings[idx]!;
    while (foldedDepths.length > 0 && heading.level <= foldedDepths[foldedDepths.length - 1]!) {
      foldedDepths.pop();
    }
    const visible = foldedDepths.length === 0;
    const foldKey = foldKeys[idx]!;
    if (visible) visit(heading, idx, foldKey);
    if (visible && foldState.get(foldKey)) foldedDepths.push(heading.level);
  }
}

function tocSignature(headings: TocHeading[], foldState?: ReadonlyMap<string, boolean>): string {
  const keys = tocFoldKeys(headings);
  const base = headings.map((h, index) => `${keys[index]}\t${h.level}\t${h.text}\t${h.source || "markdown"}\t${h.kind || ""}`).join("\n");
  if (!foldState || foldState.size === 0) return base;
  const foldedKeys = keys.filter((k) => foldState.get(k)).join(",");
  return `${base}\nfold:${foldedKeys}`;
}

function tocContentSignature(state: EditorState): string {
  return tocSignature(tocHeadingsFromState(state));
}

function scanBlockExtraLineRanges(
  doc: Text,
  startLine = 1,
  endLine = doc.lines,
  excludedRanges: ReadonlyArray<{ from: number; to: number }> = [],
): Pick<BlockExtraRanges, "toc" | "semanticHeadings" | "ceilCommands" | "hrs"> {
  const toc: Array<{ from: number; to: number }> = [];
  const semanticHeadings: Array<{ from: number; to: number; outline: SemanticOutline }> = [];
  const ceilCommands: CeilCommandRange[] = [];
  const hrs: Array<{ from: number; to: number }> = [];
  for (let lineNum = Math.max(1, startLine); lineNum <= Math.min(doc.lines, endLine); lineNum++) {
    const line = doc.line(lineNum);
    if (rangeOverlapsAny(line.from, line.to, excludedRanges)) continue;
    if (TOC_LINE_RE.test(line.text)) toc.push({ from: line.from, to: line.to });
    const ceilCommand = parseCeilCommandLine(line.text, line.from);
    if (ceilCommand) ceilCommands.push(ceilCommand);
    const trimmed = line.text.trim();
    if (trimmed.startsWith("@@part") || trimmed.startsWith("@@section")) {
      const command = scanInlineCommands(trimmed)[0];
      const outline = command && command.fullFrom === 0 && command.fullTo === trimmed.length
        ? semanticOutlineFromCommand(command)
        : null;
      if (outline) semanticHeadings.push({ from: line.from, to: line.to, outline });
    }
    if (HR_LINE_RE.test(line.text)) hrs.push({ from: line.from, to: line.to });
  }
  return { toc, semanticHeadings, ceilCommands, hrs };
}

function scanBlockExtraRanges(
  doc: Text,
  excludedRanges: ReadonlyArray<{ from: number; to: number }> = [],
): BlockExtraRanges {
  const { toc, semanticHeadings, ceilCommands, hrs } = scanBlockExtraLineRanges(doc, 1, doc.lines, excludedRanges);
  return { toc, semanticHeadings, ceilCommands, hrs, frontMatter: scanFrontMatter(doc) };
}

const blockExtraRangesField = StateField.define<BlockExtraRanges>({
  create: (state) => scanBlockExtraRanges(state.doc, blockExtraExcludedRanges(state)),
  update(ranges, tr) {
    if (tr.docChanged) {
      return canMapBlockExtraRanges(tr.startState.doc, tr.changes, ranges)
        ? mapBlockExtraRanges(ranges, tr.changes)
        : canPatchBlockExtraRangesNearChanges(tr.startState.doc, tr.changes, ranges)
          ? patchBlockExtraRangesNearChanges(tr.state.doc, ranges, tr.changes, blockExtraExcludedRanges(tr.state))
          : scanBlockExtraRanges(tr.state.doc, blockExtraExcludedRanges(tr.state));
    }
    return ranges;
  },
});

function canMapBlockExtraRanges(doc: Text, changes: ChangeSet, ranges: BlockExtraRanges): boolean {
  if (changesMightAffectFencedCodeRanges(doc, changes)) return false;
  let canMap = true;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!canMap) return;
    const fromLine = doc.lineAt(Math.min(fromA, doc.length));
    const toLine = doc.lineAt(Math.min(Math.max(fromA, toA), doc.length));
    const oldText = doc.sliceString(fromLine.from, toLine.to);
    const newText = inserted.toString();
    if (/[\n\[\]\-*_@(){}]/.test(oldText) || /[\n\[\]\-*_@(){}]/.test(newText)) {
      canMap = false;
      return;
    }
    if (ranges.frontMatter && fromA <= ranges.frontMatter.to && toA >= ranges.frontMatter.from) {
      canMap = false;
    }
  });
  return canMap;
}

function canPatchBlockExtraRangesNearChanges(doc: Text, changes: ChangeSet, ranges: BlockExtraRanges): boolean {
  if (changesMightAffectFencedCodeRanges(doc, changes)) return false;
  let canPatch = true;
  changes.iterChanges((fromA, toA, _fromB, _toB, _inserted) => {
    if (!canPatch) return;
    const changedLine = doc.lineAt(Math.min(fromA, doc.length));
    if (changedLine.number <= 2) {
      canPatch = false;
      return;
    }
    if (ranges.frontMatter && fromA <= ranges.frontMatter.to && toA >= ranges.frontMatter.from) {
      canPatch = false;
    }
  });
  return canPatch;
}

function mapBlockExtraRanges(ranges: BlockExtraRanges, changes: ChangeSet): BlockExtraRanges {
  return {
    toc: ranges.toc.map((range) => ({ from: changes.mapPos(range.from), to: changes.mapPos(range.to) })),
    semanticHeadings: ranges.semanticHeadings.map((range) => ({ from: changes.mapPos(range.from), to: changes.mapPos(range.to), outline: range.outline })),
    ceilCommands: ranges.ceilCommands.map((range) => ({ ...range, from: changes.mapPos(range.from), to: changes.mapPos(range.to) })),
    hrs: ranges.hrs.map((range) => ({ from: changes.mapPos(range.from), to: changes.mapPos(range.to) })),
    frontMatter: ranges.frontMatter
      ? {
        ...ranges.frontMatter,
        from: changes.mapPos(ranges.frontMatter.from),
        to: changes.mapPos(ranges.frontMatter.to),
      }
      : null,
  };
}

function patchBlockExtraRangesNearChanges(
  doc: Text,
  ranges: BlockExtraRanges,
  changes: ChangeSet,
  excludedRanges: ReadonlyArray<{ from: number; to: number }>,
): BlockExtraRanges {
  let fromB = Number.POSITIVE_INFINITY;
  let toB = 0;
  changes.iterChanges((_fromA, _toA, nextFrom, nextTo) => {
    fromB = Math.min(fromB, nextFrom);
    toB = Math.max(toB, nextTo);
  });
  if (!Number.isFinite(fromB)) return mapBlockExtraRanges(ranges, changes);
  // A newline can only split/join the changed source line for these line-owned
  // ranges (TOC, semantic headings, @@cell commands, and horizontal rules).
  // Rescanning one neighbouring line on each side covers that structural
  // reach without turning every Enter press into an O(document) pass. Changes
  // near front matter are rejected above and still use the full safe scan.
  const startLine = Math.max(1, doc.lineAt(Math.min(fromB, doc.length)).number - 1);
  const endLine = Math.min(doc.lines, doc.lineAt(Math.min(toB, doc.length)).number + 1);
  const affectedFrom = doc.line(startLine).from;
  const affectedTo = doc.line(endLine).to;
  const mapped = mapBlockExtraRanges(ranges, changes);
  const scanned = scanBlockExtraLineRanges(doc, startLine, endLine, excludedRanges);
  return {
    toc: [
      ...mapped.toc.filter((range) => range.to < affectedFrom || range.from > affectedTo),
      ...scanned.toc,
    ].sort((a, b) => a.from - b.from || a.to - b.to),
    semanticHeadings: [
      ...mapped.semanticHeadings.filter((range) => range.to < affectedFrom || range.from > affectedTo),
      ...scanned.semanticHeadings,
    ].sort((a, b) => a.from - b.from || a.to - b.to),
    ceilCommands: [
      ...mapped.ceilCommands.filter((range) => range.to < affectedFrom || range.from > affectedTo),
      ...scanned.ceilCommands,
    ].sort((a, b) => a.from - b.from || a.to - b.to),
    hrs: [
      ...mapped.hrs.filter((range) => range.to < affectedFrom || range.from > affectedTo),
      ...scanned.hrs,
    ].sort((a, b) => a.from - b.from || a.to - b.to),
    frontMatter: mapped.frontMatter,
  };
}

class OrgEnvOpenWidget extends MeasuredWidget {
  kind: string;
  title: string;
  blockId: string;
  anchor: number;
  depth: number;

  constructor(kind: string, title: string, blockId: string, anchor: number, depth: number) {
    super();
    this.kind = kind;
    this.title = title;
    this.blockId = blockId;
    this.anchor = anchor;
    this.depth = depth;
  }

  protected measureKey(): string { return "oopen:" + this.kind + ":" + this.title + ":" + this.blockId; }

  protected measureGroupKey(): string { return "oopen:" + this.kind; }

  protected estimatedHeightFallback(): number { return -1; }

  eq(other: OrgEnvOpenWidget): boolean {
    return this.kind === other.kind
      && this.title === other.title
      && this.blockId === other.blockId
      && this.anchor === other.anchor
      && this.depth === other.depth;
  }

  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-org-env-heading-widget org-env-heading";
    div.dataset.orgEnvKind = this.kind;
    div.style.setProperty("--org-env-depth", String(this.depth));
    div.dataset.label = envLabel(this.kind);
    const label = document.createElement("span");
    label.className = "cm-org-env-label org-env-heading-label";
    label.textContent = envLabel(this.kind);
    const title = document.createElement("span");
    title.className = "org-env-heading-title";
    title.dataset.empty = this.title ? "false" : "true";
    title.innerHTML = renderMarkdownInlineHTML(this.title);
    div.append(label, title);
    if (this.blockId) {
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "org-env-block-id";
      badge.textContent = `#${shortBlockId(this.blockId)}`;
      badge.title = window.AaronnoteBlockTarget?.(this.blockId) || this.blockId;
      badge.setAttribute("aria-label", `Copy block reference ${this.blockId}`);
      badge.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      badge.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void window.AaronnoteCopyBlockTarget?.(this.blockId).then((target) => {
          if (target) badge.title = target;
        });
      });
      div.append(badge);
    }
    div.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.anchor }, scrollIntoView: true });
      view.focus();
    });
    return this.registerMeasured(div, view);
  }

  ignoreEvent(): boolean { return false; }
}

class OrgEnvEndWidget extends MeasuredWidget {
  kind: string;
  depth: number;

  constructor(kind: string, depth: number) {
    super();
    this.kind = kind;
    this.depth = depth;
  }

  protected measureKey(): string { return "oend:" + this.kind; }

  protected measureGroupKey(): string { return "oend:" + this.kind; }

  protected estimatedHeightFallback(): number { return -1; }

  eq(other: OrgEnvEndWidget): boolean {
    return this.kind === other.kind && this.depth === other.depth;
  }

  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-org-env-end-widget";
    div.dataset.orgEnvKind = this.kind;
    div.style.setProperty("--org-env-depth", String(this.depth));
    return this.registerMeasured(div, view);
  }

  ignoreEvent(): boolean { return false; }
}

function envLabel(kind: string): string {
  const labels: Record<string, string> = {
    html: "HTML",
    meta: "Meta",
    theorem: "Theorem",
    thm: "Theorem",
    definition: "Definition",
    defn: "Definition",
    lemma: "Lemma",
    corollary: "Corollary",
    cor: "Corollary",
    proposition: "Proposition",
    prop: "Proposition",
    property: "Property",
    proof: "Proof",
    example: "Example",
    attention: "Attention",
    warning: "Warning",
    note: "Note",
    info: "Info",
    comment: "Comment",
    summary: "Summary",
    fold: "Fold",
    tikz: "TikZ",
    convention: "Convention",
    axiom: "Axiom",
    assumption: "Assumption",
    conjecture: "Conjecture",
    claim: "Claim",
    remark: "Remark",
    notation: "Notation",
    observation: "Observation",
    exercise: "Exercise",
    solution: "Solution",
    algorithm: "Algorithm",
    question: "Question",
  };
  return labels[kind] ?? kind;
}

function fallbackCeilKernels(current: string): CeilKernelSpec[] {
  const names = [current, DEFAULT_CEIL_KERNEL, "bash", "lean4", "sagemath"].filter(Boolean);
  return Array.from(new Set(names)).map((name) => ({ name, displayName: name }));
}

// Attach-file listings churn as kernels come and go, so a fresh picker open
// should not serve a stale list forever the way regular kernelspecs (which
// rarely change within a session) can.
const CEIL_KERNELS_CACHE_TTL_MS = 15_000;
function loadCeilKernels(file: string, current: string): Promise<CeilKernelSpec[]> {
  const cached = ceilKernelsCache.get(file);
  if (cached && Date.now() - cached.at < CEIL_KERNELS_CACHE_TTL_MS) {
    return Promise.resolve(cached.kernels);
  }
  const pending = ceilKernelsPending.get(file);
  if (pending) return pending;
  const request = api.jupyterCell.kernels({ file })
    .then((result) => {
      const specs = Array.isArray(result.kernels) && result.kernels.length > 0
        ? result.kernels.map((kernel) => ({
            name: String(kernel.name || ""),
            displayName: String(kernel.displayName || kernel.name || ""),
            language: String(kernel.language || ""),
          })).filter((kernel) => kernel.name)
        : fallbackCeilKernels(current);
      const attachable = Array.isArray(result.attachable)
        ? result.attachable.map((kernel) => ({
            name: String(kernel.name || ""),
            displayName: String(kernel.displayName || kernel.name || ""),
            language: String(kernel.language || ""),
            attachable: true,
          })).filter((kernel) => kernel.name)
        : [];
      const kernels = [...specs, ...attachable];
      ceilKernelsCache.set(file, { at: Date.now(), kernels });
      return kernels;
    })
    .catch(() => fallbackCeilKernels(current))
    .finally(() => { ceilKernelsPending.delete(file); });
  ceilKernelsPending.set(file, request);
  return request;
}

function populateCeilKernelSelect(select: HTMLSelectElement, kernels: CeilKernelSpec[], current: string): void {
  const specs = kernels.filter((kernel) => !kernel.attachable);
  const attachable = kernels.filter((kernel) => kernel.attachable);
  if (!kernels.some((kernel) => kernel.name === current)) specs.unshift({ name: current, displayName: current });
  const selected = select.value || current;
  select.replaceChildren();

  const kernelsGroup = document.createElement("optgroup");
  kernelsGroup.label = "Kernels";
  for (const kernel of specs) {
    const option = document.createElement("option");
    option.value = kernel.name;
    option.textContent = kernel.displayName && kernel.displayName !== kernel.name
      ? `${kernel.displayName} (${kernel.name})`
      : kernel.name;
    kernelsGroup.append(option);
  }
  select.append(kernelsGroup);

  if (attachable.length > 0) {
    const attachGroup = document.createElement("optgroup");
    attachGroup.label = "Attach";
    for (const kernel of attachable) {
      const option = document.createElement("option");
      option.value = kernel.name;
      option.textContent = kernel.displayName || kernel.name;
      attachGroup.append(option);
    }
    select.append(attachGroup);
  }

  select.value = [...specs, ...attachable].some((kernel) => kernel.name === selected) ? selected : current;
}

// Cell outputs render through the shared JupyterLab OutputArea stack
// (src/jupyter-rendermime.ts) so their layout, MIME preference, error/stream
// formatting, and ipywidget hosting match upstream Jupyter / VS Code Jupyter.

// Inline output view keeps very long stream text bounded so a runaway loop's
// output cannot freeze the editor; the Popout ("full") view shows everything
// the server kept (already capped server-side at ~1 MB).
const CEIL_INLINE_STREAM_LIMIT = 40_000;

function streamOutputText(output: Record<string, unknown>): string {
  const text = output.text;
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return text.map((item) => String(item ?? "")).join("");
  return "";
}

// Bound inline stream text; leave the full popout untouched.
function boundedCeilOutputs(outputs: Array<Record<string, unknown>>, full: boolean): Array<Record<string, unknown>> {
  if (full) return outputs;
  return outputs.map((output) => {
    if (String(output.output_type || "") !== "stream") return output;
    const text = streamOutputText(output);
    if (text.length <= CEIL_INLINE_STREAM_LIMIT) return output;
    const hidden = text.length - CEIL_INLINE_STREAM_LIMIT;
    return {
      ...output,
      text: `${text.slice(0, CEIL_INLINE_STREAM_LIMIT)}\n[aaronnote: ${hidden} more chars — use Popout for full output]`,
    };
  });
}

// Noema renders kernel markdown output with its own Markdown renderer so
// it matches note prose (KaTeX macros, link handling) instead of the stock
// marked-based parser.
const ceilMarkdownParser: JupyterMarkdownParser = {
  async render(source: string): Promise<string> {
    return renderMarkdownHTML(source);
  },
};

// The mounted OutputArea (and any live ipywidgets inside it) is disposed
// through this disposer, keyed by the host element it was rendered into.
const ceilOutputAreaDispose = new WeakMap<HTMLElement, () => void>();

function disposeCeilOutputArea(root: HTMLElement): void {
  const dispose = ceilOutputAreaDispose.get(root);
  if (dispose) {
    ceilOutputAreaDispose.delete(root);
    try { dispose(); } catch {}
  }
}

// Dispose any OutputArea rendered anywhere under (or at) `root` — used on
// widget teardown, where we only hold the enclosing cell element.
function disposeCeilOutputTree(root: HTMLElement): void {
  disposeCeilOutputArea(root);
  for (const el of root.querySelectorAll<HTMLElement>(".cm-ceil-output")) {
    disposeCeilOutputArea(el);
  }
}

// Lazily pull in the heavy widget manager only when an output actually hosts an
// ipywidget, keeping it out of the main editor bundle.
const mountCeilWidget: WidgetMountFn = (host, modelId, runtime, messages, widgetOutputs) => {
  (window as unknown as { __jupyter_widgets_assets_path__?: string }).__jupyter_widgets_assets_path__ ??=
    new URL("./", window.location.href).toString();
  return import("../../../../jupyter-widget-runtime.ts")
    .then(({ mountJupyterWidget }) => mountJupyterWidget(host, modelId, runtime, messages as JupyterWidgetKernelMessage[], widgetOutputs));
};

// The JupyterLab OutputArea/rendermime stack is large; load it on demand the
// first time a cell actually produces output, keeping it out of the main
// editor bundle (same rationale as the widget manager above).
let jupyterRenderModule: Promise<typeof import("../../../../jupyter-rendermime.ts")> | null = null;
function loadJupyterRender(): Promise<typeof import("../../../../jupyter-rendermime.ts")> {
  return (jupyterRenderModule ??= import("../../../../jupyter-rendermime.ts"));
}

// Guards against a stale async fill when the same host is re-rendered (e.g. an
// Expand toggle) before the render module finished loading.
const ceilRenderTokens = new WeakMap<HTMLElement, number>();

function preserveCeilScroll<T>(view: EditorView | undefined, update: () => T): T {
  return view ? preserveEditorViewport(view, update) : update();
}

function runCeilDomUpdate<T>(view: EditorView | undefined, preserveScroll: boolean, update: () => T): T {
  return preserveScroll ? preserveCeilScroll(view, update) : update();
}

function requestMeasurePreservingCeilScroll(view: EditorView | undefined): void {
  if (view) preserveEditorViewport(view, () => view.requestMeasure());
}

type CeilRenderOptions = {
  preserveScroll?: boolean;
};

function renderCeilOutputs(
  root: HTMLElement,
  result: CeilExecutionResult | null,
  full = false,
  view?: EditorView,
  renderOptions: CeilRenderOptions = {},
): void {
  const token = (ceilRenderTokens.get(root) ?? 0) + 1;
  ceilRenderTokens.set(root, token);
  if (!result) {
    runCeilDomUpdate(view, renderOptions.preserveScroll === true, () => {
      disposeCeilOutputArea(root);
      const empty = document.createElement("div");
      empty.className = "cm-ceil-output-empty";
      empty.textContent = "No output";
      root.replaceChildren(empty);
    });
    return;
  }
  const outputs = Array.isArray(result.outputs) ? result.outputs as Array<Record<string, unknown>> : [];
  if (outputs.length === 0) {
    runCeilDomUpdate(view, renderOptions.preserveScroll === true, () => {
      disposeCeilOutputArea(root);
      const empty = document.createElement("div");
      empty.className = "cm-ceil-output-empty";
      empty.textContent = result.status === "error" ? (result.message || "Execution failed") : "No output";
      root.replaceChildren(empty);
    });
    return;
  }
  const options = {
    widgetRuntime: result.widgetRuntime,
    widgetMessages: result.widgetMessages,
    widgetOutputs: result.widgetOutputs,
    mountWidget: mountCeilWidget,
    markdownParser: ceilMarkdownParser,
  };
  const bounded = boundedCeilOutputs(outputs, full);
  void loadJupyterRender().then(({ renderJupyterOutputs }) => {
    if (ceilRenderTokens.get(root) !== token) return;
    // Build the replacement OutputArea in a detached container *before*
    // touching the live DOM, then swap it in with one replaceChildren call.
    // Jupyter/VS Code never blank the cell between runs; clearing root first
    // (the old behavior here) produced a visible flash of empty space while
    // the new OutputArea/widgets were still being constructed.
    const nextHost = document.createElement("div");
    nextHost.className = root.className;
    const dispose = renderJupyterOutputs(nextHost, bounded, options);
    if (ceilRenderTokens.get(root) !== token) {
      dispose();
      return;
    }
    const replace = () => {
      disposeCeilOutputArea(root);
      root.replaceChildren(...Array.from(nextHost.childNodes));
      ceilOutputAreaDispose.set(root, dispose);
    };
    if (renderOptions.preserveScroll) preserveCeilScroll(view, replace);
    else replace();
    if (renderOptions.preserveScroll) requestMeasurePreservingCeilScroll(view);
    else view?.requestMeasure();
  }).catch((error) => {
    if (ceilRenderTokens.get(root) !== token) return;
    runCeilDomUpdate(view, renderOptions.preserveScroll === true, () => {
      disposeCeilOutputArea(root);
      const pre = document.createElement("pre");
      pre.className = "cm-ceil-output-error";
      pre.textContent = `Failed to render output: ${error instanceof Error ? error.message : String(error)}`;
      root.replaceChildren(pre);
    });
  });
}

function openCeilVariablesPopup(context: () => { file: string; kernel: string; session: string; language: string }): void {
  const overlay = document.createElement("div");
  overlay.className = "cm-ceil-output-popover";
  const panel = document.createElement("div");
  panel.className = "cm-ceil-output-popover-panel";
  const header = document.createElement("div");
  header.className = "cm-ceil-output-popover-header";
  const title = document.createElement("span");
  title.textContent = "Jupyter variables";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  const body = document.createElement("div");
  body.className = "cm-ceil-output-popover-body cm-ceil-variables-body";

  const load = async (): Promise<void> => {
    const { file, kernel, session, language } = context();
    body.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "cm-ceil-variables-empty";
    loading.textContent = "Loading…";
    body.append(loading);
    try {
      const result = await api.jupyterCell.variables({ file, kernel, session, language });
      if (result.supported === false) {
        body.replaceChildren();
        const unsupported = document.createElement("div");
        unsupported.className = "cm-ceil-variables-empty";
        unsupported.textContent = `Variables are not available for kernel "${kernel}".`;
        body.append(unsupported);
        return;
      }
      renderJupyterVariablesTable(body, Array.isArray(result.variables) ? result.variables : []);
    } catch (err) {
      body.replaceChildren();
      const errorLine = document.createElement("div");
      errorLine.className = "cm-ceil-variables-empty";
      errorLine.textContent = err instanceof Error ? err.message : String(err);
      body.append(errorLine);
    }
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") destroy();
  };
  const destroy = (): void => {
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  close.addEventListener("click", destroy);
  refresh.addEventListener("click", () => { void load(); });
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) destroy();
  });
  window.addEventListener("keydown", onKey);
  header.append(title, refresh, close);
  panel.append(header, body);
  overlay.append(panel);
  document.body.append(overlay);
  void load();
}

function openCeilOutputPopup(result: CeilExecutionResult | null): void {
  const overlay = document.createElement("div");
  overlay.className = "cm-ceil-output-popover";
  const panel = document.createElement("div");
  panel.className = "cm-ceil-output-popover-panel";
  const header = document.createElement("div");
  header.className = "cm-ceil-output-popover-header";
  const title = document.createElement("span");
  title.textContent = "Jupyter output";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  const body = document.createElement("div");
  body.className = "cm-ceil-output-popover-body";
  renderCeilOutputs(body, result, true);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") destroy();
  };
  const destroy = (): void => {
    window.removeEventListener("keydown", onKey);
    disposeCeilOutputArea(body);
    overlay.remove();
  };
  close.addEventListener("click", destroy);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) destroy();
  });
  window.addEventListener("keydown", onKey);
  header.append(title, close);
  panel.append(header, body);
  overlay.append(panel);
  document.body.append(overlay);
}

class CeilCommandWidget extends MeasuredWidget {
  range: CeilCommandRange;
  epoch: number;

  constructor(range: CeilCommandRange) {
    super();
    this.range = range;
    this.epoch = ceilCacheEpoch;
  }

  protected measureKey(): string {
    return `ceilcmd:${this.range.from}:${this.range.argsRaw}:${this.range.idRaw}:${this.epoch}`;
  }

  protected measureGroupKey(): string { return "ceilcmd"; }

  protected estimatedHeightFallback(): number { return 132; }

  eq(other: CeilCommandWidget): boolean {
    return this.range.from === other.range.from
      && this.range.to === other.range.to
      && this.range.argsRaw === other.range.argsRaw
      && this.range.idRaw === other.range.idRaw
      // A cache invalidation (out-of-band script save) bumps the epoch so the
      // widget is treated as changed and toDOM re-reads the hidden source.
      && this.epoch === other.epoch;
  }

  override destroy(dom: HTMLElement): void {
    const cleanup = (dom as HTMLElement & { __ceilRunCleanup?: () => void }).__ceilRunCleanup;
    if (cleanup) cleanup();
    disposeCeilOutputTree(dom);
    super.destroy(dom);
  }

  toDOM(view: EditorView): HTMLElement {
    const file = currentNoteFile();
    const meta = parseCeilCommandForState(view.state, this.range, file);
    const leanRuntime = isLeanCeilRuntime(meta.language, meta.kernel);
    if (meta.changed) scheduleCeilCommandLineUpdate(view, this.range.from, formatCeilCommand(meta));

    const block = document.createElement("div");
    block.className = "cm-ceil-cell-widget cm-ceil-command-widget";
    setSourceRange(block, this.range.from, this.range.to);

    const header = document.createElement("div");
    header.className = "cm-ceil-header";

    const label = document.createElement("span");
    label.className = "cm-ceil-label";
    label.textContent = "CELL";

    const languageInput = document.createElement("input");
    languageInput.className = "cm-ceil-language";
    languageInput.type = "text";
    languageInput.value = meta.language;
    languageInput.spellcheck = false;
    languageInput.setAttribute("aria-label", "Language");

    const kernelSelect = document.createElement("select");
    kernelSelect.className = "cm-ceil-kernel";
    kernelSelect.setAttribute("aria-label", "Kernel");
    kernelSelect.hidden = leanRuntime;
    populateCeilKernelSelect(
      kernelSelect,
      ceilKernelsCache.get(file)?.kernels ?? fallbackCeilKernels(meta.kernel),
      meta.kernel,
    );
    const loadKernels = (): void => {
      void loadCeilKernels(file, meta.kernel).then((kernels) => {
        if (!kernelSelect.isConnected) return;
        populateCeilKernelSelect(kernelSelect, kernels, kernelSelect.value || meta.kernel);
      });
    };
    kernelSelect.addEventListener("pointerdown", loadKernels);
    kernelSelect.addEventListener("focus", loadKernels);

    const sessionInput = document.createElement("input");
    sessionInput.className = "cm-ceil-session";
    sessionInput.type = "text";
    sessionInput.value = meta.session;
    sessionInput.spellcheck = false;
    sessionInput.autocomplete = "off";
    sessionInput.setAttribute("aria-label", "Session");
    sessionInput.title = "Session";
    // A native <input list=datalist> was tried here, but WebKit's datalist
    // support (this editor runs inside xwidget-webkit) is unreliable enough
    // that it was swallowing keystrokes — typing into the field had no
    // effect. Hand-rolled suggestion dropdown instead.
    const sessionSuggestions = ceilSessionSuggestions(view.state, meta, file);
    const sessionWrap = document.createElement("span");
    sessionWrap.className = "cm-ceil-session-wrap";
    const sessionDropdown = document.createElement("div");
    sessionDropdown.className = "cm-ceil-session-suggestions";
    sessionDropdown.hidden = true;
    const renderSessionSuggestions = (): void => {
      const query = sessionInput.value.trim().toLowerCase();
      const matches = sessionSuggestions.filter((session) => !query || session.toLowerCase().includes(query)).slice(0, 8);
      if (matches.length === 0) {
        sessionDropdown.hidden = true;
        return;
      }
      sessionDropdown.replaceChildren(...matches.map((session) => {
        const item = document.createElement("div");
        item.className = "cm-ceil-session-suggestion";
        item.textContent = session;
        // mousedown (not click) fires before the input's blur, so the value
        // is committed before writeCommandLine() runs on blur.
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          sessionInput.value = session;
          sessionDropdown.hidden = true;
          writeCommandLine();
          view.focus();
        });
        return item;
      }));
      sessionDropdown.hidden = false;
    };
    sessionInput.addEventListener("focus", renderSessionSuggestions);
    sessionInput.addEventListener("input", renderSessionSuggestions);
    sessionInput.addEventListener("blur", () => { sessionDropdown.hidden = true; });
    sessionWrap.append(sessionInput, sessionDropdown);

    const status = document.createElement("span");
    status.className = "cm-ceil-status";
    status.textContent = meta.id;

    const buttonBar = document.createElement("div");
    buttonBar.className = "cm-ceil-actions";
    const source = document.createElement("div");
    source.className = "cm-ceil-source cm-ceil-source-compact";
    const sourceKey = ceilSourceKey(file, meta);
    const cachedCode = file ? ceilSourceCache.get(sourceKey) : undefined;
    if (cachedCode != null) {
      source.replaceChildren(highlightedCeilCode(cachedCode, meta.language));
      if (!cachedCode.trim()) source.dataset.empty = "true";
    } else {
      source.textContent = file ? "Loading source..." : "Save note first";
    }
    const outputWrap = document.createElement("div");
    outputWrap.className = "cm-ceil-output-wrap";
    outputWrap.hidden = leanRuntime;
    const outputHeader = document.createElement("div");
    outputHeader.className = "cm-ceil-output-toolbar";
    const outputTitle = document.createElement("span");
    outputTitle.textContent = "Output";
    const outputTools = document.createElement("div");
    outputTools.className = "cm-ceil-output-tools";
    const output = document.createElement("div");
    output.className = "cm-ceil-output cm-ceil-output-limited";
    const cacheKey = ceilOutputKey(file, meta, `script:${meta.id}`);
    let lastResult = ceilOutputCache.get(cacheKey) ?? null;
    status.textContent = ceilResultStatusLabel(meta, lastResult);
    const uiState = ceilOutputUi(lastResult);
    outputWrap.classList.toggle("is-folded", Boolean(uiState.outputFolded));
    outputWrap.classList.toggle("is-expanded", Boolean(uiState.outputExpanded));
    renderCeilOutputs(output, lastResult, Boolean(uiState.outputExpanded), view);
    const setStatus = (text: string, preserveScroll = true): void => {
      runCeilDomUpdate(view, preserveScroll, () => {
        status.textContent = text;
      });
    };

    const makeButton = (text: string, title: string, run: () => Promise<void> | void): HTMLButtonElement => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.title = title;
      button.addEventListener("mousedown", stopEditorPropagation);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void run();
      });
      return button;
    };

    const currentOutputUi = (): NonNullable<CeilExecutionResult["ui"]> => ({
      outputFolded: outputWrap.classList.contains("is-folded"),
      outputExpanded: outputWrap.classList.contains("is-expanded"),
    });

    const preserveCurrentOutputUi = (result: CeilExecutionResult): CeilExecutionResult => patchCeilOutputUi(result, currentOutputUi());

    const saveOutputUi = (patch: NonNullable<CeilExecutionResult["ui"]>): void => {
      lastResult = patchCeilOutputUi(lastResult, patch);
      setBoundedMap(ceilOutputCache, cacheKey, lastResult);
      if (!file) return;
      void api.jupyterCell.saveScriptCellOutputUi({
        file,
        cellId: meta.id,
        kernel: meta.kernel,
        session: meta.session,
        language: meta.language,
        ...ceilOutputUi(lastResult),
      }).then((result) => {
        const saved = result.output && typeof result.output === "object" ? result.output as CeilExecutionResult : null;
        if (!saved) return;
        const merged = mergeCeilOutputFromServer(saved, lastResult);
        if (!merged) return;
        lastResult = merged;
        setBoundedMap(ceilOutputCache, cacheKey, merged);
        setStatus(ceilResultStatusLabel(meta, lastResult));
      }).catch(() => {});
    };

    const refreshSource = async (options: { preserveScroll?: boolean } = {}): Promise<void> => {
      if (!file) {
        runCeilDomUpdate(view, options.preserveScroll === true, () => {
          source.textContent = "Save note first";
        });
        return;
      }
      try {
        const result = await api.jupyterCell.readScriptCell({
          file,
          cellId: meta.id,
          kernel: meta.kernel,
          session: meta.session,
          language: meta.language,
        });
        const code = String(result.code ?? "");
        setBoundedMap(ceilSourceCache, sourceKey, code);
        runCeilDomUpdate(view, options.preserveScroll === true, () => {
          source.replaceChildren(code.trim() ? highlightedCeilCode(code, meta.language) : highlightedCeilCode("", meta.language));
          if (!code.trim()) source.dataset.empty = "true";
          else delete source.dataset.empty;
        });
        const savedOutput = result.output && typeof result.output === "object" ? result.output as CeilExecutionResult : null;
        const cachedLive = ceilOutputCache.get(cacheKey);
        lastResult = mergeCeilOutputFromServer(savedOutput, cachedLive ?? null);
        const ui = ceilOutputUi(lastResult);
        runCeilDomUpdate(view, options.preserveScroll === true, () => {
          outputWrap.classList.toggle("is-folded", Boolean(ui.outputFolded));
          outputWrap.classList.toggle("is-expanded", Boolean(ui.outputExpanded));
        });
        const expanded = Boolean(ui.outputExpanded);
        foldButton.textContent = ui.outputFolded ? "Show" : "Fold";
        expandButton.textContent = ui.outputExpanded ? "Collapse" : "Expand";
        setStatus(ceilResultStatusLabel(meta, lastResult), options.preserveScroll === true);
        renderCeilOutputs(output, lastResult, expanded, view, { preserveScroll: options.preserveScroll });
        if (lastResult) setBoundedMap(ceilOutputCache, cacheKey, lastResult);
        if (options.preserveScroll) requestMeasurePreservingCeilScroll(view);
        else view.requestMeasure();
      } catch (err) {
        runCeilDomUpdate(view, options.preserveScroll === true, () => {
          source.textContent = err instanceof Error ? err.message : String(err);
        });
      }
    };

    const writeCommandLine = (): void => {
      const requestedLanguage = languageInput.value.trim();
      const nextKernel = isLeanCeilRuntime(languageInput.value, kernelSelect.value)
        ? "lean4"
        : /^(?:bash|sh|shell|zsh)$/i.test(requestedLanguage) ? "bash"
        : (kernelSelect.value || DEFAULT_CEIL_KERNEL);
      const nextLanguage = isLeanCeilRuntime(languageInput.value, nextKernel)
        ? "lean4"
        : (requestedLanguage || ceilLanguageForKernel(nextKernel));
      preserveCeilScroll(view, () => {
        replaceCeilCommandLine(view, this.range.from, formatCeilCommand({
          ...meta,
          kernel: nextKernel,
          session: sessionInput.value.trim() || DEFAULT_CEIL_SESSION,
          language: ceilLanguageForKernel(nextKernel, nextLanguage),
          changed: false,
        }));
      });
    };

    languageInput.addEventListener("blur", writeCommandLine);
    languageInput.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        writeCommandLine();
        view.focus();
      }
    });
    languageInput.addEventListener("input", () => {
      const nextLean = isLeanCeilRuntime(languageInput.value, kernelSelect.value);
      kernelSelect.hidden = nextLean;
      outputWrap.hidden = nextLean;
    });
    kernelSelect.addEventListener("change", (event) => {
      event.stopPropagation();
      languageInput.value = ceilLanguageForKernel(kernelSelect.value || DEFAULT_CEIL_KERNEL);
      writeCommandLine();
    });
    sessionInput.addEventListener("blur", writeCommandLine);
    sessionInput.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        sessionDropdown.hidden = true;
        writeCommandLine();
        view.focus();
      } else if (event.key === "Escape") {
        sessionDropdown.hidden = true;
      }
    });

    const setBusy = (busy: boolean, preserveScroll = true): void => {
      runCeilDomUpdate(view, preserveScroll, () => {
        for (const button of buttonBar.querySelectorAll<HTMLButtonElement>("button")) {
          if (button.dataset.ceilInterrupt === "true") continue;
          button.disabled = busy;
        }
        languageInput.disabled = busy;
        kernelSelect.disabled = busy;
        sessionInput.disabled = busy;
      });
    };

    const editButton = makeButton("Edit", "Open hidden source script", async () => {
      if (!file) {
        setStatus("Save note first");
        return;
      }
      setBusy(true);
      setStatus("Opening...");
      try {
        await api.jupyterCell.openScript({
          file,
          cellId: meta.id,
          kernel: meta.kernel,
          session: meta.session,
          language: meta.language,
          storage: "ipynb",
          cells: ceilCommandCellsForContext(view.state, meta, file),
        });
        setStatus(meta.id);
        await refreshSource({ preserveScroll: true });
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    });

    const contextEntries = (): CeilCellContextEntry[] => ceilCommandEntriesForContext(view.state, meta, file);
    const currentEntry = (): CeilCellContextEntry => (
      contextEntries().find((entry) => entry.id === meta.id) ?? {
        ...meta,
        from: this.range.from,
        to: this.range.to,
        cellId: meta.id,
        code: "",
      }
    );
    const executeEntries = async (
      selectedEntries: CeilCellContextEntry[],
      mode: "current" | "selected",
      entries: CeilCellContextEntry[],
    ): Promise<CeilExecutionResult> => (
      await api.jupyterCell.executeScriptCell({
        file,
        cellId: meta.id,
        kernel: meta.kernel,
        session: meta.session,
        language: meta.language,
        mode,
        selectedCellIds: selectedEntries.map((entry) => entry.id),
        cells: entries,
      }) as CeilExecutionResult
    );
    const publishEntryResult = (entry: CeilCellContextEntry, result: CeilExecutionResult): void => {
      const key = ceilOutputKey(file, entry, `script:${entry.id}`);
      const merged = mergeCeilOutputUi(result, ceilOutputCache.get(key) ?? null) ?? result;
      setBoundedMap(ceilOutputCache, key, merged);
      window.AaronnotePublishJupyterCellResult?.({
        file,
        cellId: entry.id,
        kernel: entry.kernel,
        session: entry.session,
        result: merged,
      });
    };
    const renderCurrentError = (err: unknown): void => {
      const message = err instanceof Error ? err.message : String(err);
      lastResult = preserveCurrentOutputUi({
        ok: false,
        status: "error",
        live: true,
        message,
        // Transport/host errors are not kernel error messages. Keeping this
        // empty makes renderCeilOutputs show the actionable message directly
        // instead of handing an incomplete error record to JupyterLab.
        outputs: [],
      });
      if (!leanRuntime) renderCeilOutputs(output, lastResult, outputWrap.classList.contains("is-expanded"), view, { preserveScroll: true });
      setStatus(message || "Error");
    };
    const runEntries = async (entriesToRun: CeilCellContextEntry[], emptyMessage: string): Promise<void> => {
      if (!file) {
        setStatus("Save note first");
        return;
      }
      const entries = contextEntries();
      if (entriesToRun.length === 0) {
        setStatus(emptyMessage);
        return;
      }
      setBusy(true);
      let ranCurrent = false;
      try {
        const currentMode = entriesToRun.length === 1 && entriesToRun[0]?.id === meta.id;
        setStatus(entriesToRun.length === 1 ? "Running..." : `Running ${entriesToRun.length}`);
        if (currentMode && !leanRuntime) {
          preserveCeilScroll(view, () => {
            output.textContent = "Running...";
          });
        }
        const result = await executeEntries(entriesToRun, currentMode ? "current" : "selected", entries);
        const published = new Set<string>();
        if (Array.isArray(result.results)) {
          for (const item of result.results) {
            const itemId = String(item?.cellId || "");
            const itemEntry = entries.find((candidate) => candidate.id === itemId);
            if (!itemId || !itemEntry || published.has(itemId)) continue;
            publishEntryResult(itemEntry, item);
            published.add(itemId);
          }
        }
        const currentWasRequested = entriesToRun.some((entry) => entry.id === meta.id);
        const currentResult = currentWasRequested ? preserveCurrentOutputUi(result) : result;
        if (!published.has(meta.id) && currentWasRequested) publishEntryResult(currentEntry(), currentResult);
        if (currentWasRequested) {
          ranCurrent = true;
          lastResult = currentResult;
          setBoundedMap(ceilOutputCache, cacheKey, currentResult);
          setStatus(leanRuntime
            ? "Synced"
            : currentResult.status === "error" && currentResult.stoppedAt ? `Stopped at ${currentResult.stoppedAt}` : ceilResultStatusLabel(meta, currentResult));
          if (!leanRuntime) renderCeilOutputs(output, currentResult, outputWrap.classList.contains("is-expanded"), view, { preserveScroll: true });
        } else {
          setStatus(result.status === "error" && result.stoppedAt ? `Stopped at ${result.stoppedAt}` : "Ran above");
        }
        if (ranCurrent) await refreshSource({ preserveScroll: true });
      } catch (err) {
        renderCurrentError(err);
      } finally {
        setBusy(false);
        requestMeasurePreservingCeilScroll(view);
      }
    };

    const runButton = makeButton(leanRuntime ? "Sync" : "Run", leanRuntime ? "Sync this Lean cell source file" : "Run only this Cell (JupyterLab semantics)", async () => {
      await runEntries([currentEntry()], "No cell");
    });
    // Live output: paint iopub as it arrives instead of waiting for the
    // execute response. The response stays authoritative — `runEntries` still
    // renders `currentResult` when it lands — so this only affects what the
    // cell shows *during* a run, and a dropped frame costs nothing.
    let liveRunId = "";
    let liveOutputs: Array<Record<string, unknown>> = [];
    let stdinRow: HTMLElement | null = null;

    const closeStdinPrompt = (): void => {
      stdinRow?.remove();
      stdinRow = null;
    };

    /**
     * The cell is blocked in input()/getpass(). Show a prompt inline, the way
     * a notebook does. Cancelling is a first-class action: the server answers
     * the kernel with EOF, so the cell fails with EOFError instead of leaving
     * the kernel — and every other cell sharing it — stuck on a read.
     */
    const openStdinPrompt = (runId: string, prompt: string, password: boolean): void => {
      closeStdinPrompt();
      const row = document.createElement("form");
      row.className = "cm-ceil-stdin";
      const label = document.createElement("label");
      label.className = "cm-ceil-stdin-prompt";
      label.textContent = prompt || (password ? "Password:" : "Input:");
      const field = document.createElement("input");
      field.className = "cm-ceil-stdin-input";
      field.type = password ? "password" : "text";
      field.autocomplete = "off";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "cm-ceil-stdin-cancel";
      cancel.textContent = "Cancel";
      row.append(label, field, cancel);

      let answered = false;
      const answer = (body: Record<string, unknown>): void => {
        if (answered) return;
        answered = true;
        closeStdinPrompt();
        void api.jupyterCell.inputReply({ runId, ...body }).catch(() => {});
      };
      row.addEventListener("submit", (event) => {
        event.preventDefault();
        answer({ value: field.value });
      });
      cancel.addEventListener("click", () => answer({ cancel: true }));
      field.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          answer({ cancel: true });
        }
      });

      stdinRow = row;
      outputWrap.append(row);
      field.focus();
    };
    const stopLive = leanRuntime ? () => {} : registerCeilLiveHandler(meta.id, (detail) => {
      if (detail.kernel !== meta.kernel || detail.session !== meta.session) return;
      if (detail.phase === "start") {
        liveRunId = String(detail.runId || "");
        liveOutputs = [];
        return;
      }
      if (!liveRunId || detail.runId !== liveRunId) return;
      if (detail.phase === "end") {
        liveRunId = "";
        closeStdinPrompt();
        return;
      }
      if (detail.phase === "stdin") {
        openStdinPrompt(detail.runId ?? "", String(detail.prompt ?? ""), Boolean(detail.password));
        return;
      }
      if (detail.phase === "stdin-done") {
        closeStdinPrompt();
        return;
      }
      for (const event of detail.events ?? []) {
        if (event.kind === "status") {
          setStatus(event.state === "busy" ? "Running..." : ceilResultStatusLabel(meta, lastResult));
          continue;
        }
        liveOutputs = applyCeilLiveEvent(liveOutputs, event);
      }
      if (liveOutputs.length === 0) return;
      renderCeilOutputs(
        output,
        { ok: true, status: "ok", live: true, outputs: liveOutputs },
        outputWrap.classList.contains("is-expanded"),
        view,
        { preserveScroll: true },
      );
    });

    const stopRun = registerCeilRunHandler(meta.id, async () => {
      await runEntries([currentEntry()], "No cell");
    });
    (block as HTMLElement & { __ceilRunCleanup?: () => void }).__ceilRunCleanup = () => {
      stopRun();
      stopLive();
      closeStdinPrompt();
    };
    const runAboveButton = makeButton("Above", "Run cells above this one in the same session", async () => {
      await runEntries(contextEntries().filter((entry) => entry.from < this.range.from), "No cells above");
    });
    const runAllButton = makeButton("All", "Run all cells in this session", async () => {
      await runEntries(contextEntries(), "No cells");
    });

    const interruptButton = makeButton("Interrupt", "Interrupt this kernel session", async () => {
      if (!file) return;
      setStatus("Interrupting...");
      try {
        await api.jupyterCell.interrupt({ file, kernel: meta.kernel, session: meta.session });
        setStatus(meta.id);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    });
    interruptButton.dataset.ceilInterrupt = "true";

    const variablesButton = makeButton("Vars", "Show variables in this kernel's namespace", () => {
      if (!file) return;
      openCeilVariablesPopup(() => ({ file, kernel: meta.kernel, session: meta.session, language: meta.language }));
    });

    const restartButton = makeButton("Restart", "Restart this kernel session", async () => {
      if (!file) return;
      setStatus("Restarting...");
      try {
        await api.jupyterCell.restart({ file, kernel: meta.kernel, session: meta.session });
        if (lastResult) {
          lastResult = { ...lastResult, live: false, widgetRuntime: undefined };
          setBoundedMap(ceilOutputCache, cacheKey, lastResult);
          renderCeilOutputs(output, lastResult, outputWrap.classList.contains("is-expanded"), view, { preserveScroll: true });
        }
        setStatus(meta.id);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    });

    const clearButton = makeButton("Clear", "Clear output", () => {
      lastResult = null;
      ceilOutputCache.delete(cacheKey);
      renderCeilOutputs(output, null, false, view, { preserveScroll: true });
      if (file) {
        void api.jupyterCell.clearScriptCellOutput({
          file,
          cellId: meta.id,
          kernel: meta.kernel,
          session: meta.session,
          language: meta.language,
        }).catch(() => {});
      }
      requestMeasurePreservingCeilScroll(view);
    });
    const refreshButton = makeButton("Refresh", "Reload source and saved output", async () => {
      setStatus("Refreshing...");
      await refreshSource({ preserveScroll: true });
      setStatus(meta.id);
    });
    const foldButton = makeButton("Fold", "Fold output", () => {
      const folded = !outputWrap.classList.contains("is-folded");
      preserveCeilScroll(view, () => {
        outputWrap.classList.toggle("is-folded", folded);
      });
      foldButton.textContent = folded ? "Show" : "Fold";
      saveOutputUi({ outputFolded: folded });
      requestMeasurePreservingCeilScroll(view);
    });
    const expandButton = makeButton("Expand", "Expand output inline", () => {
      const expanded = !outputWrap.classList.contains("is-expanded");
      preserveCeilScroll(view, () => {
        outputWrap.classList.toggle("is-expanded", expanded);
        if (expanded) outputWrap.classList.remove("is-folded");
      });
      expandButton.textContent = expanded ? "Collapse" : "Expand";
      foldButton.textContent = "Fold";
      renderCeilOutputs(output, lastResult, expanded, view, { preserveScroll: true });
      saveOutputUi({ outputExpanded: expanded, ...(expanded ? { outputFolded: false } : {}) });
      requestMeasurePreservingCeilScroll(view);
    });
    const popoutButton = makeButton("Popout", "Show output in a separate panel", () => openCeilOutputPopup(lastResult));

    if (hostMode() === "server") {
      const reason = "Jupyter execution and Cell editing are unavailable in reader mode";
      for (const control of [
        editButton,
        runButton,
        runAboveButton,
        runAllButton,
        interruptButton,
        variablesButton,
        restartButton,
        clearButton,
      ]) {
        control.disabled = true;
        control.title = reason;
      }
      languageInput.disabled = true;
      kernelSelect.disabled = true;
      sessionInput.disabled = true;
      languageInput.title = reason;
      kernelSelect.title = reason;
      sessionInput.title = reason;
    }

    buttonBar.append(editButton, runButton, runAboveButton, runAllButton);
    const isAttachedKernel = meta.kernel.startsWith("attach:");
    if (!leanRuntime) {
      buttonBar.append(interruptButton, variablesButton);
      // An attached kernel is owned by whatever process created it; Noema
      // never restarts (or force-kills) one it didn't launch.
      if (!isAttachedKernel) buttonBar.append(restartButton);
      buttonBar.append(clearButton);
    }
    foldButton.textContent = outputWrap.classList.contains("is-folded") ? "Show" : "Fold";
    expandButton.textContent = outputWrap.classList.contains("is-expanded") ? "Collapse" : "Expand";
    outputTools.append(refreshButton, foldButton, expandButton, popoutButton);
    outputHeader.append(outputTitle, outputTools);
    outputWrap.append(outputHeader, output);
    header.append(label, languageInput, kernelSelect, sessionWrap, status, buttonBar);
    block.append(header, source, outputWrap);
    stopInteractiveWidgetEvents(block);
    // Only hit the backend when we have nothing cached for this cell. Rebuilds
    // triggered by ordinary typing repaint from ceilSourceCache above, so this
    // fires once per cell (or after an explicit refresh/invalidation), not on
    // every keystroke.
    if (cachedCode == null && file) void refreshSource();
    return this.registerMeasured(block, view);
  }

  ignoreEvent(): boolean { return false; }
}

class MetaWidget extends MeasuredWidget {
  body: string;
  from: number;
  to: number;
  bibliographyVersion: number;

  constructor(body: string, from: number, to: number) {
    super();
    this.body = body;
    this.from = from;
    this.to = to;
    this.bibliographyVersion = window.AaronnoteBibliography?.version?.() ?? 0;
  }

  protected measureKey(): string { return "meta:" + shortHash(this.body); }

  protected measureGroupKey(): string {
    return /(^|\n)[ \t]*#\+\s*begin\s+summary(?:\s|$)/i.test(this.body) ? "meta:abstract" : "meta";
  }

  protected estimatedHeightFallback(): number {
    return /(^|\n)[ \t]*#\+\s*begin\s+summary(?:\s|$)/i.test(this.body) ? 520 : 270;
  }

  eq(other: MetaWidget): boolean {
    return this.body === other.body
      && this.from === other.from
      && this.to === other.to
      && this.bibliographyVersion === other.bibliographyVersion;
  }

  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-org-env-block org-env-block";
    setSourceRange(div, this.from, this.to);
    div.setAttribute("data-kind", "meta");
    div.dataset.label = envLabel("meta");
    const blockSource = view.state.doc.sliceString(this.from, this.to);
    const firstBreak = blockSource.indexOf("\n");
    const relativeBodyFrom = firstBreak < 0
      ? 0
      : Math.max(firstBreak + 1, blockSource.indexOf(this.body, firstBreak + 1));
    renderMetaWidget(div, this.body, view, this.from + relativeBodyFrom);
    return this.registerMeasured(div, view);
  }

  ignoreEvent(): boolean { return true; }
}

class CommentWidget extends MeasuredWidget {
  title: string;
  body: string;
  from: number;
  to: number;
  depth: number;

  constructor(title: string, body: string, from: number, to: number, depth: number) {
    super();
    this.title = title;
    this.body = body;
    this.from = from;
    this.to = to;
    this.depth = depth;
  }

  protected measureKey(): string { return "cmnt:" + shortHash(this.title + ":" + this.body); }

  protected measureGroupKey(): string {
    return `cmnt:lines:${Math.min(8, Math.ceil(this.body.split(/\n/).length / 5))}`;
  }

  protected estimatedHeightFallback(): number {
    return 54 + this.body.split(/\n/).length * 22;
  }

  eq(other: CommentWidget): boolean {
    return this.title === other.title
      && this.body === other.body
      && this.from === other.from
      && this.to === other.to
      && this.depth === other.depth;
  }

  toDOM(view: EditorView): HTMLElement {
    const block = document.createElement("org-env-block");
    block.className = "cm-org-env-comment-widget org-env-block";
    setSourceRange(block, this.from, this.to);
    block.dataset.cmOpenSource = "true";
    block.setAttribute("data-kind", "comment");
    block.setAttribute("data-title", this.title);
    block.setAttribute("data-label", envLabel("comment"));
    block.setAttribute("data-comment-open", "false");
    block.style.setProperty("--org-env-depth", String(this.depth));

    const button = document.createElement("button");
    button.type = "button";
    button.className = "org-env-comment-button";
    button.setAttribute("aria-expanded", "false");
    const label = document.createElement("span");
    label.className = "org-env-comment-label";
    label.innerHTML = this.title.trim() ? renderMarkdownInlineHTML(this.title.trim()) : "comment";
    const state = document.createElement("span");
    state.className = "org-env-comment-state";
    state.textContent = "show";
    button.append(label, state);
    button.addEventListener("mousedown", stopEditorPropagation);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = content.hidden === true;
      content.hidden = !open;
      block.classList.toggle("org-env-comment-open", open);
      block.setAttribute("data-comment-open", open ? "true" : "false");
      button.setAttribute("aria-expanded", open ? "true" : "false");
      state.textContent = open ? "hide" : "show";
      if (block.isConnected) view.requestMeasure();
    });

    const content = document.createElement("div");
    content.className = "org-env-content";
    content.hidden = true;
    content.innerHTML = renderMarkdownHTML(this.body.trim());
    enhanceRenderedMarkdown(content);
    stopInteractiveWidgetEvents(content);

    block.append(button, content);
    return this.registerMeasured(block, view);
  }

  ignoreEvent(): boolean { return false; }
}

class FoldWidget extends MeasuredWidget {
  title: string;
  body: string;
  from: number;
  to: number;
  depth: number;

  constructor(title: string, body: string, from: number, to: number, depth: number) {
    super();
    this.title = title;
    this.body = body;
    this.from = from;
    this.to = to;
    this.depth = depth;
  }

  protected measureKey(): string { return "fold:" + shortHash(this.title + ":" + this.body); }

  protected measureGroupKey(): string {
    return `fold:lines:${Math.min(8, Math.ceil(this.body.split(/\n/).length / 5))}`;
  }

  protected estimatedHeightFallback(): number { return 46; }

  eq(other: FoldWidget): boolean {
    return this.title === other.title
      && this.body === other.body
      && this.from === other.from
      && this.to === other.to
      && this.depth === other.depth;
  }

  toDOM(view: EditorView): HTMLElement {
    const block = document.createElement("org-env-block");
    block.className = "cm-org-env-fold-widget org-env-block";
    setSourceRange(block, this.from, this.to);
    block.dataset.cmOpenSource = "true";
    block.setAttribute("data-kind", "fold");
    block.setAttribute("data-title", this.title);
    block.setAttribute("data-label", envLabel("fold"));
    block.setAttribute("data-fold-open", "false");
    block.style.setProperty("--org-env-depth", String(this.depth));

    const button = document.createElement("button");
    button.type = "button";
    button.className = "org-env-fold-summary";
    button.setAttribute("aria-expanded", "false");

    const marker = document.createElement("span");
    marker.className = "org-env-fold-marker";
    marker.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "org-env-fold-title";
    title.innerHTML = renderMarkdownInlineHTML(this.title.trim() || "Details");
    button.append(marker, title);
    button.addEventListener("mousedown", stopEditorPropagation);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = content.hidden === true;
      content.hidden = !open;
      block.classList.toggle("org-env-fold-open", open);
      block.setAttribute("data-fold-open", open ? "true" : "false");
      button.setAttribute("aria-expanded", open ? "true" : "false");
      if (block.isConnected) view.requestMeasure();
    });

    const content = document.createElement("div");
    content.className = "org-env-fold-content org-env-content";
    content.hidden = true;
    content.innerHTML = renderMarkdownHTML(this.body.trim());
    enhanceRenderedMarkdown(content);
    stopInteractiveWidgetEvents(content);

    block.append(button, content);
    return this.registerMeasured(block, view);
  }

  ignoreEvent(): boolean { return false; }
}

class HtmlWidget extends MeasuredWidget {
  body: string;
  from: number;
  to: number;

  constructor(body: string, from: number, to: number) {
    super();
    this.body = body;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string { return "html:" + shortHash(this.body); }

  protected measureGroupKey(): string {
    return `html:lines:${Math.min(8, Math.ceil(this.body.split(/\n/).length / 6))}`;
  }

  protected estimatedHeightFallback(): number {
    return Math.max(48, this.body.split(/\n/).length * 24);
  }

  eq(other: HtmlWidget): boolean {
    return this.body === other.body && this.from === other.from && this.to === other.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-html-env-widget";
    setSourceRange(div, this.from, this.to);
    div.innerHTML = renderMarkdownHTML(buildOrgEnvSource("html", "", this.body));
    stopInteractiveWidgetEvents(div);
    return this.registerMeasured(div, view);
  }

  ignoreEvent(): boolean { return true; }
}

class TikzWidget extends MeasuredWidget {
  title: string;
  body: string;
  from: number;
  to: number;
  dirty: boolean;

  constructor(title: string, body: string, from: number, to: number, dirty: boolean) {
    super();
    this.title = title;
    this.body = body;
    this.from = from;
    this.to = to;
    this.dirty = dirty;
  }

  protected measureKey(): string { return "tikz:" + this.title; }

  protected measureGroupKey(): string { return "tikz"; }

  protected estimatedHeightFallback(): number { return 260; }

  eq(other: TikzWidget): boolean {
    return this.title === other.title && this.body === other.body && this.from === other.from && this.to === other.to && this.dirty === other.dirty;
  }

  toDOM(view: EditorView): HTMLElement {
    const figure = document.createElement("figure");
    figure.className = "cm-image-widget cm-visual-attachment cm-visual-attachment-html cm-tikz-env-widget aaronnote-tikz";
    setSourceRange(figure, this.from, this.to);
    figure.dataset.cmOpenSource = "true";

    const card = document.createElement("div");
    card.className = "cm-image-render cm-visual-file-card cm-visual-file-card-html cm-tikz-env-card";
    figure.append(card);

    const meta = completeTikzTitle(this.title);
    applyImageLayout(figure, meta.layout);
    const file = currentNoteFile();
    if (meta.changed) {
      card.textContent = "Preparing TikZ...";
      scheduleTikzOpenLineUpdate(view, this.from, (info) => {
        const current = completeTikzTitle(info.title);
        return current.changed ? `${current.id} ${current.timestamp}${current.attrsRaw ? ` ${current.attrsRaw}` : ""}` : null;
      });
      stopInteractiveWidgetEvents(figure);
      return this.registerMeasured(figure, view);
    }
    if (!file) {
      card.textContent = "TikZ render needs a saved note file";
      stopInteractiveWidgetEvents(figure);
      return this.registerMeasured(figure, view);
    }

    const sourceCacheKey = tikzSourceCacheKey(file, meta.id);
    const previousRenderedSource = tikzRenderedSourceByAsset.get(sourceCacheKey);
    const pendingSource = tikzPendingSourceByAsset.get(sourceCacheKey);
    const bodyChanged = this.dirty || (previousRenderedSource !== undefined && previousRenderedSource !== this.body);
    if (bodyChanged && pendingSource !== this.body) {
      card.textContent = "Updating TikZ...";
      setBoundedMap(tikzPendingSourceByAsset, sourceCacheKey, this.body);
      scheduleTikzOpenLineUpdate(view, this.from, (info) => {
        const current = completeTikzTitle(info.title);
        if (current.changed) return `${current.id} ${current.timestamp}${current.attrsRaw ? ` ${current.attrsRaw}` : ""}`;
        const timestamp = nextTikzTimestamp(current.timestamp);
        return `${current.id} ${timestamp}${current.attrsRaw ? ` ${current.attrsRaw}` : ""}`;
      }, [clearTikzDirtyEffect.of(meta.id)]);
      stopInteractiveWidgetEvents(figure);
      return this.registerMeasured(figure, view);
    }

    card.textContent = "Rendering TikZ...";
    void ensureTikzAsset(file, meta.id, meta.timestamp, this.body).then((result) => {
      if (!figure.isConnected) return;
      if (!result.ok || !result.markdownPath) {
        tikzPendingSourceByAsset.delete(sourceCacheKey);
        card.textContent = result.message || "TikZ render failed";
        view.requestMeasure();
        return;
      }
      setBoundedMap(tikzRenderedSourceByAsset, sourceCacheKey, this.body);
      tikzPendingSourceByAsset.delete(sourceCacheKey);
      const img = document.createElement("img");
      img.className = "cm-image-render cm-tikz-env-image";
      img.src = resolveAssetSrc(result.markdownPath);
      img.alt = `TikZ ${meta.id}`;
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("load", () => { if (figure.isConnected) view.requestMeasure(); });
      img.addEventListener("error", () => { if (figure.isConnected) view.requestMeasure(); });
      figure.replaceChildren(img);
      view.requestMeasure();
    });

    stopInteractiveWidgetEvents(figure);
    return this.registerMeasured(figure, view);
  }

  ignoreEvent(): boolean { return false; }
}

function renderMetaWidget(
  root: HTMLElement,
  body: string,
  view: EditorView,
  bodyFrom: number,
): void {
  const meta = document.createElement("div");
  meta.className = "org-env-meta aaronnote-meta-cover";
  const { entries, summary } = parseOrgMetaDocument(body);
  if (summary) meta.dataset.hasAbstract = "true";
  if (!metaRoamIndexed(entries)) {
    const badge = document.createElement("span");
    badge.className = "aaronnote-meta-roam-badge";
    badge.title = "Not in roam database";
    badge.setAttribute("aria-label", "Not in roam database");
    badge.textContent = "🔕";
    meta.append(badge);
  }

  if (entries.length === 0 && !summary) {
    const empty = document.createElement("span");
    empty.className = "org-env-meta-empty";
    empty.textContent = "No metadata";
    meta.append(empty);
    renderMetaProperties(meta, body, view, bodyFrom);
    root.append(meta);
    return;
  }

  const byKey = metaEntryMap(entries);
  const masthead = document.createElement("header");
  masthead.className = "aaronnote-meta-masthead";
  const title = document.createElement("h1");
  title.className = "aaronnote-meta-title";
  title.textContent = byKey.get("title") || "Untitled";
  masthead.append(title);

  const dateValue = byKey.get("date") || "";
  if (dateValue) {
    const date = document.createElement("p");
    date.className = "aaronnote-meta-date";
    date.textContent = dateValue;
    masthead.append(date);
  }

  const tagValues = metaTags(byKey.get("tags") || "");
  const visibleTagValues = tagValues.filter(showMetaTag);
  if (visibleTagValues.length > 0) {
    const tags = document.createElement("nav");
    tags.className = "aaronnote-meta-tags";
    tags.setAttribute("aria-label", "Tags");
    for (const tagValue of visibleTagValues) {
      const tag = document.createElement("button");
      tag.type = "button";
      tag.className = "aaronnote-meta-tag";
      tag.textContent = `#${tagValue}`;
      tag.addEventListener("mousedown", stopEditorPropagation);
      tag.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        document.dispatchEvent(new CustomEvent("knowledge:apply-tag", { detail: { tag: tagValue } }));
      });
      tags.append(tag);
    }
    masthead.append(tags);
  }
  meta.append(masthead);

  if (summary) {
    const abstract = document.createElement("section");
    abstract.className = "aaronnote-meta-abstract";
    const heading = document.createElement("div");
    heading.className = "aaronnote-meta-abstract-heading";
    const abstractTitle = document.createElement("span");
    abstractTitle.className = "aaronnote-meta-abstract-title";
    abstractTitle.textContent = summary.title || "Abstract";
    heading.append(abstractTitle);
    const content = document.createElement("div");
    content.className = "aaronnote-meta-abstract-content";
    if (summary.body.trim()) {
      content.innerHTML = renderMarkdownHTML(summary.body);
      hydrateMetaSummaryCitations(content, summary, bodyFrom);
      wireRenderedMarkdownLinks(content);
    }
    abstract.append(heading, content);
    meta.append(abstract);
  }

  renderMetaProperties(meta, body, view, bodyFrom);

  root.append(meta);
}

function wireRenderedMarkdownLinks(root: HTMLElement): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = anchor.getAttribute("href")?.trim() || "";
    if (!href) continue;
    const open = (event: MouseEvent): void => {
      if (!isMarkdownLinkOpenEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      anchor.dispatchEvent(new CustomEvent("aaronnote:open-url", {
        bubbles: true,
        cancelable: true,
        detail: { href, newWindow: markdownLinkOpensNewWindow(href, event) },
      }));
    };
    anchor.addEventListener("mousedown", (event) => {
      if (event.button === 0) open(event);
    });
    anchor.addEventListener("auxclick", (event) => {
      if (event.button === 1) open(event);
    });
    // The source-backed editor opens links on Mod+mousedown. Prevent the real
    // anchor from introducing a second, browser-native click path.
    anchor.addEventListener("click", (event) => event.preventDefault());
  }
}

function hydrateMetaSummaryCitations(
  root: HTMLElement,
  summary: MetaSummary,
  metaBodyFrom: number,
): void {
  const protectedRanges = protectedCitationRanges(summary.body) as Array<{ from: number; to: number }>;
  const commands = scanInlineCommands(summary.body, "cite")
    .filter((command) => !protectedRanges.some((range) => command.fullFrom >= range.from && command.fullFrom < range.to));
  const rendered = [...root.querySelectorAll<HTMLElement>(".inline-cite-widget[data-cite-state]")];
  const absoluteOffset = metaBodyFrom + summary.bodyFrom;
  for (let index = 0; index < Math.min(commands.length, rendered.length); index += 1) {
    const command = commands[index]!;
    rendered[index]!.replaceWith(createInteractiveCiteElement({
      ...command,
      fullFrom: absoluteOffset + command.fullFrom,
      fullTo: absoluteOffset + command.fullTo,
      contextFrom: absoluteOffset + command.contextFrom,
      contextTo: absoluteOffset + command.contextTo,
    }));
  }
}

const META_WIDGET_MAX_BODY = 256 * 1024;
const META_WIDGET_MAX_FIELDS = 256;
const META_WIDGET_MAX_VALUE = 64 * 1024;

function stopMetaControlEvent(event: Event): void {
  event.stopPropagation();
}

function dispatchMetaPatch(
  view: EditorView,
  bodyFrom: number,
  from: number,
  to: number,
  insert: string,
): void {
  view.dispatch({
    changes: { from: bodyFrom + from, to: bodyFrom + to, insert },
    scrollIntoView: false,
  });
  view.requestMeasure();
}

function editableMetaValueControl(
  key: string,
  value: string,
  commit: (value: string) => void,
): HTMLInputElement {
  const lower = key.toLowerCase();
  const input = document.createElement("input");
  input.className = "aaronnote-meta-property-value";
  input.value = value;
  input.maxLength = META_WIDGET_MAX_VALUE;
  input.spellcheck = !["tags", "aliases", "css", "bib", "extend", "id"].includes(lower);

  const booleanValue = /^(?:true|false)$/i.test(value.trim());
  const dateValue = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const timeValue = /^\d{2}:\d{2}(?::\d{2})?$/.test(value.trim());
  const dateTimeValue = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value.trim());
  const progressValue = /^(?:100|\d{1,2})%$/.test(value.trim()) || lower === "progress";
  const numberValue = /^-?(?:\d+|\d*\.\d+)$/.test(value.trim());

  if (booleanValue) {
    input.type = "checkbox";
    input.checked = value.trim().toLowerCase() === "true";
    input.value = input.checked ? "true" : "false";
    input.addEventListener("change", () => commit(input.checked ? "true" : "false"));
  } else if (dateTimeValue) {
    input.type = "datetime-local";
  } else if (dateValue) {
    input.type = "date";
  } else if (timeValue) {
    input.type = "time";
  } else if (progressValue) {
    input.type = "number";
    input.min = "0";
    input.max = "100";
    input.value = value.replace(/%$/, "");
    input.dataset.metaSuffix = "%";
  } else if (numberValue) {
    input.type = "number";
    input.step = "any";
  } else {
    input.type = "text";
  }

  if (!booleanValue) {
    const finish = (): void => {
      const suffix = input.dataset.metaSuffix ?? "";
      commit(`${input.value}${suffix}`);
    };
    input.addEventListener("blur", finish);
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        input.value = value.replace(/%$/, "");
        input.blur();
      }
    });
  }
  input.addEventListener("mousedown", stopMetaControlEvent);
  input.addEventListener("click", stopMetaControlEvent);
  return input;
}

function swapMetaEntryLines(
  body: string,
  first: ReturnType<typeof editableMetaEntries>[number],
  second: ReturnType<typeof editableMetaEntries>[number],
): { from: number; to: number; insert: string } {
  const a = first.lineFrom <= second.lineFrom ? first : second;
  const b = a === first ? second : first;
  return {
    from: a.lineFrom,
    to: b.lineTo,
    insert: body.slice(b.lineFrom, b.lineTo)
      + body.slice(a.lineTo, b.lineFrom)
      + body.slice(a.lineFrom, a.lineTo),
  };
}

function metaToolButton(label: string, title: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  });
  return button;
}

function renderMetaProperties(
  meta: HTMLElement,
  body: string,
  view: EditorView,
  bodyFrom: number,
): void {
  const details = document.createElement("details");
  details.className = "aaronnote-meta-properties";
  const summaryControl = document.createElement("summary");
  const entries = editableMetaEntries(body);
  summaryControl.textContent = `Properties (${entries.length})`;
  details.append(summaryControl);

  if (body.length > META_WIDGET_MAX_BODY || entries.length > META_WIDGET_MAX_FIELDS) {
    const warning = document.createElement("p");
    warning.className = "aaronnote-meta-properties-limit";
    warning.textContent = "Metadata is too large for visual editing. Use Source view.";
    details.append(warning);
    meta.append(details);
    return;
  }

  const table = document.createElement("div");
  table.className = "aaronnote-meta-properties-table";
  entries.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "aaronnote-meta-property-row";
    const key = document.createElement("input");
    key.className = "aaronnote-meta-property-key";
    key.value = entry.key;
    key.maxLength = 128;
    key.spellcheck = false;
    key.setAttribute("aria-label", `Property ${entry.key} name`);
    const commitKey = (): void => {
      const next = key.value.trim().replace(/[^A-Za-z0-9_-]/g, "");
      if (next && next !== entry.key) dispatchMetaPatch(view, bodyFrom, entry.keyFrom, entry.keyTo, next);
    };
    key.addEventListener("blur", commitKey);
    key.addEventListener("mousedown", stopMetaControlEvent);
    key.addEventListener("click", stopMetaControlEvent);
    key.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); key.blur(); }
      else if (event.key === "Escape") { event.preventDefault(); key.value = entry.key; key.blur(); }
    });

    const value = editableMetaValueControl(entry.key, entry.value, (next) => {
      if (next !== entry.value) dispatchMetaPatch(view, bodyFrom, entry.valueFrom, entry.valueTo, next);
    });
    value.setAttribute("aria-label", `Property ${entry.key} value`);

    const tools = document.createElement("span");
    tools.className = "aaronnote-meta-property-tools";
    const up = metaToolButton("↑", `Move ${entry.key} up`, () => {
      if (index <= 0) return;
      const patch = swapMetaEntryLines(body, entries[index - 1]!, entry);
      dispatchMetaPatch(view, bodyFrom, patch.from, patch.to, patch.insert);
    });
    up.disabled = index <= 0;
    const down = metaToolButton("↓", `Move ${entry.key} down`, () => {
      if (index >= entries.length - 1) return;
      const patch = swapMetaEntryLines(body, entry, entries[index + 1]!);
      dispatchMetaPatch(view, bodyFrom, patch.from, patch.to, patch.insert);
    });
    down.disabled = index >= entries.length - 1;
    const remove = metaToolButton("×", `Delete ${entry.key}`, () => {
      dispatchMetaPatch(view, bodyFrom, entry.lineFrom, entry.fullTo, "");
    });
    tools.append(up, down, remove);
    row.append(key, value, tools);
    table.append(row);
  });
  details.append(table);

  const actions = document.createElement("div");
  actions.className = "aaronnote-meta-property-actions";
  actions.append(metaToolButton("+ Property", "Add metadata property", () => {
    const used = new Set(entries.map((entry) => entry.key.toLowerCase()));
    let key = "property";
    for (let suffix = 2; used.has(key.toLowerCase()); suffix += 1) key = `property${suffix}`;
    const summaryRange = orgMetaSummarySourceRange(body);
    const insertAt = summaryRange?.from ?? body.length;
    const before = insertAt > 0 && body[insertAt - 1] !== "\n" ? "\n" : "";
    dispatchMetaPatch(view, bodyFrom, insertAt, insertAt, `${before}${key}: \n`);
  }));
  details.append(actions);

  if (orgMetaSummarySourceRange(body)) {
    const summaryEditor = document.createElement("div");
    summaryEditor.className = "aaronnote-meta-summary-editor";
    summaryEditor.dataset.aaronnoteVim = "native";
    const parsed = parseOrgMetaDocument(body).summary;
    const title = document.createElement("input");
    title.value = parsed?.title ?? "";
    title.placeholder = "Summary title";
    title.setAttribute("aria-label", "Summary title");
    const text = document.createElement("textarea");
    text.value = parsed?.body ?? "";
    text.rows = Math.min(12, Math.max(3, text.value.split(/\r?\n/).length));
    text.setAttribute("aria-label", "Summary Markdown");
    const commit = (): void => {
      const range = orgMetaSummarySourceRange(body);
      if (!range) return;
      const heading = title.value.trim();
      const next = `#+begin summary${heading ? ` ${heading}` : ""}\n${text.value.replace(/\s+$/, "")}\n#+end summary`;
      if (next !== body.slice(range.from, range.to).replace(/\n$/, "")) {
        const trailing = body.slice(range.from, range.to).endsWith("\n") ? "\n" : "";
        dispatchMetaPatch(view, bodyFrom, range.from, range.to, next + trailing);
      }
    };
    for (const control of [title, text]) {
      control.addEventListener("mousedown", stopMetaControlEvent);
      control.addEventListener("click", stopMetaControlEvent);
      control.addEventListener("blur", commit);
      control.addEventListener("keydown", (event) => event.stopPropagation());
    }
    summaryEditor.append(title, text);
    details.append(summaryEditor);
  }

  details.addEventListener("mousedown", stopMetaControlEvent);
  details.addEventListener("click", stopMetaControlEvent);
  meta.append(details);
}

class FrontMatterWidget extends MeasuredWidget {
  body: string;
  from: number;
  to: number;

  constructor(body: string, from: number, to: number) {
    super();
    this.body = body;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string { return "fm:" + shortHash(this.body); }

  protected measureGroupKey(): string {
    return `fm:lines:${Math.min(5, Math.ceil(this.body.split(/\n/).length / 4))}`;
  }

  protected estimatedHeightFallback(): number {
    return 36 + this.body.split(/\n/).length * 18;
  }

  eq(other: FrontMatterWidget): boolean {
    return this.body === other.body && this.from === other.from && this.to === other.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-front-matter-block";
    setSourceRange(div, this.from, this.to);
    const label = document.createElement("span");
    label.className = "cm-front-matter-label";
    label.textContent = "YAML";
    const content = document.createElement("div");
    content.className = "cm-front-matter-content";
    const parsed = parseSimpleFrontmatter(`---\n${this.body}\n---\n`);
    for (const [key, value] of parsed?.fields ?? []) {
      const row = document.createElement("div");
      row.className = "cm-front-matter-row";
      const name = document.createElement("span");
      name.className = "cm-front-matter-key";
      name.textContent = key;
      const shown = document.createElement("span");
      shown.className = "cm-front-matter-value";
      shown.textContent = Array.isArray(value) ? value.join(", ") : value;
      row.append(name, shown);
      content.append(row);
    }
    if (!content.childElementCount) content.textContent = this.body.trim();
    if (parsed?.unsupported) {
      const sourceOnly = document.createElement("span");
      sourceOnly.className = "cm-front-matter-source-only";
      sourceOnly.textContent = "Complex YAML · source only";
      content.append(sourceOnly);
    }
    div.append(label, content);
    return this.registerMeasured(div, view);
  }

  ignoreEvent(): boolean { return false; }
}

class HorizontalRuleWidget extends MeasuredWidget {
  from: number;
  to: number;

  constructor(from: number, to: number) {
    super();
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string { return "hr"; }

  protected measureGroupKey(): string { return "hr"; }

  protected estimatedHeightFallback(): number { return 46; }

  eq(other: HorizontalRuleWidget): boolean {
    return this.from === other.from && this.to === other.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const hr = document.createElement("hr");
    hr.className = "cm-horizontal-rule";
    setSourceRange(hr, this.from, this.to);
    return this.registerMeasured(hr, view);
  }

  ignoreEvent(): boolean { return false; }
}

function selectionTouchesRange(state: EditorState, from: number, to: number): boolean {
  const sel = state.selection.main;
  if (sel.empty) return sel.from >= from && sel.from <= to;
  return sel.from < to && sel.to > from;
}

function orgEnvCloseBoundaryActive(state: EditorState, block: OrgEnvBlock): boolean {
  return selectionTouchesRange(state, block.closeFrom, block.closeTo)
    && state.selection.main.from > block.closeFrom;
}

function addOrgEnvBoundaryDecos(
  decos: CMRange<Decoration>[],
  state: EditorState,
  block: OrgEnvBlock,
): void {
  const openActive = selectionTouchesRange(state, block.openFrom, block.openTo);
  const closeActive = orgEnvCloseBoundaryActive(state, block);

  if (!openActive) {
    decos.push(
      Decoration.replace({
        widget: new OrgEnvOpenWidget(block.kind, block.title, block.blockId, block.titleAnchor, block.depth),
        block: true,
      }).range(block.openFrom, block.openTo),
    );
  } else {
    decos.push(Decoration.mark({ class: "syntax-hint" }).range(block.openFrom, block.openTo));
  }

  if (!closeActive) {
    decos.push(
      Decoration.replace({
        widget: new OrgEnvEndWidget(block.kind, block.depth),
        block: true,
      }).range(block.closeFrom, block.closeTo),
    );
  } else {
    decos.push(Decoration.mark({ class: "syntax-hint" }).range(block.closeFrom, block.closeTo));
  }
}

interface OrgEnvRailMeasure {
  kind: string;
  depth: number;
  top: number;
  height: number;
  left: number;
}

const orgEnvBlocksField = StateField.define<readonly OrgEnvBlock[]>({
  create: (state) => scanOrgEnvBlocks(state.doc.toString(), 0, 0, blockExtraExcludedRanges(state)),
  update(blocks, tr) {
    if (!tr.docChanged) return blocks;
    if (!canMapOrgEnvBlocks(tr.startState.doc, blocks, tr.changes)) {
      return patchOrgEnvBlocksForTitleChange(tr.startState.doc, tr.state.doc, blocks, tr.changes)?.blocks
        ?? scanOrgEnvBlocks(tr.state.doc.toString(), 0, 0, blockExtraExcludedRanges(tr.state));
    }
    return mapOrgEnvBlocks(blocks, tr.changes, tr.state.doc);
  },
});

const dirtyTikzBlocksField = StateField.define<ReadonlySet<string>>({
  create: () => new Set<string>(),
  update(value, tr) {
    let next: Set<string> | null = null;
    for (const effect of tr.effects) {
      if (!effect.is(clearTikzDirtyEffect)) continue;
      if (!next) next = new Set(value);
      next.delete(effect.value);
    }
    if (!tr.docChanged) return next ?? value;
    const blocks = tr.startState.field(orgEnvBlocksField, false) ?? [];
    for (const block of blocks) {
      if (block.kind !== "tikz") continue;
      const key = tikzDirtyKeyFromTitle(block.title);
      if (!key) continue;
      if (!changesTouchRange(tr.changes, block.bodyFrom, block.bodyTo)) continue;
      if (!next) next = new Set(value);
      next.add(key);
    }
    return next ?? value;
  },
});

function orgEnvBlocksFromState(state: EditorState): readonly OrgEnvBlock[] {
  return state.field(orgEnvBlocksField, false) ?? scanOrgEnvBlocks(state.doc.toString(), 0, 0, blockExtraExcludedRanges(state));
}

export type OrgEnvBlockIdentity = {
  id: string;
  kind: string;
  title: string;
  from: number;
  to: number;
};

const orgEnvBlockIdentityCache = new WeakMap<readonly OrgEnvBlock[], readonly OrgEnvBlockIdentity[]>();

/** Block identities already maintained by the incremental org-environment state field. */
export function getOrgEnvBlockIdentities(state: EditorState): readonly OrgEnvBlockIdentity[] {
  const blocks = orgEnvBlocksFromState(state);
  const cached = orgEnvBlockIdentityCache.get(blocks);
  if (cached) return cached;
  const identities = blocks
    .filter((block) => Boolean(block.blockId))
    .map((block) => ({ id: block.blockId, kind: block.kind, title: block.title, from: block.openFrom, to: block.to }));
  orgEnvBlockIdentityCache.set(blocks, identities);
  return identities;
}

export function orgEnvBlockIdentityAtPosition(state: EditorState, position: number): OrgEnvBlockIdentity | null {
  return getOrgEnvBlockIdentities(state)
    .filter((block) => block.from <= position && position <= block.to)
    .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0] ?? null;
}

export function orgEnvBlockIdentityPosition(state: EditorState, blockId: string): number | null {
  const clean = String(blockId || "").trim().toLowerCase();
  if (!clean) return null;
  return getOrgEnvBlockIdentities(state).find((block) => block.id.toLowerCase() === clean)?.from ?? null;
}

export interface OrgEnvHeadingRange {
  from: number;
  to: number;
  anchor: number;
}

const orgEnvHeadingRangeCache = new WeakMap<readonly OrgEnvBlock[], readonly OrgEnvHeadingRange[]>();

/** Cached source ranges for org-environment headings replaced in Visual mode. */
export function getOrgEnvHeadingRanges(state: EditorState): readonly OrgEnvHeadingRange[] {
  const blocks = state.field(orgEnvBlocksField, false);
  if (!blocks) return [];
  const cached = orgEnvHeadingRangeCache.get(blocks);
  if (cached) return cached;
  const ranges = blocks
    .filter((block) => !["meta", "html", "tikz", "comment", "fold"].includes(block.kind))
    .map((block) => ({
      from: block.openFrom,
      to: block.openTo,
      anchor: block.titleAnchor,
    }));
  orgEnvHeadingRangeCache.set(blocks, ranges);
  return ranges;
}

function canMapOrgEnvBlocks(doc: Text, blocks: readonly OrgEnvBlock[], changes: ChangeSet): boolean {
  if (changesMightAffectFencedCodeRanges(doc, changes)) return false;
  let canMap = true;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!canMap) return;
    const removed = doc.sliceString(fromA, toA);
    const added = inserted.toString();
    if (/^\s*#\+(?:begin|end)\b/im.test(removed) || /^\s*#\+(?:begin|end)\b/im.test(added)) {
      canMap = false;
      return;
    }
    if (blocks.some((block) => (
      (fromA <= block.openTo && toA >= block.openFrom)
      || (fromA <= block.closeTo && toA >= block.closeFrom)
    ))) {
      canMap = false;
      return;
    }
    if (blocks.some((block) => block.kind === "meta" && fromA <= block.to && toA >= block.from)) {
      canMap = false;
    }
  });
  return canMap;
}

function mapOrgEnvBlock(block: OrgEnvBlock, changes: ChangeSet, doc: Text): OrgEnvBlock {
  const bodyFrom = changes.mapPos(block.bodyFrom);
  const bodyTo = changes.mapPos(block.bodyTo);
  return {
    ...block,
    from: changes.mapPos(block.from),
    to: changes.mapPos(block.to),
    openFrom: changes.mapPos(block.openFrom),
    openTo: changes.mapPos(block.openTo),
    bodyFrom,
    bodyTo,
    closeFrom: changes.mapPos(block.closeFrom),
    closeTo: changes.mapPos(block.closeTo),
    body: changes.touchesRange(block.bodyFrom, block.bodyTo)
      ? doc.sliceString(bodyFrom, bodyTo)
      : block.body,
    titleAnchor: changes.mapPos(block.titleAnchor),
    blockIdFrom: block.blockIdFrom >= 0 ? changes.mapPos(block.blockIdFrom) : -1,
  };
}

function firstChangedPosition(changes: ChangeSet): number {
  let first = Number.POSITIVE_INFINITY;
  changes.iterChanges((fromA) => {
    first = Math.min(first, fromA);
  });
  return first;
}

function mapOrgEnvBlocks(blocks: readonly OrgEnvBlock[], changes: ChangeSet, doc: Text): readonly OrgEnvBlock[] {
  const firstChanged = firstChangedPosition(changes);
  return blocks.map((block) => block.to < firstChanged ? block : mapOrgEnvBlock(block, changes, doc));
}

function patchOrgEnvBlocksForTitleChange(
  oldDoc: Text,
  newDoc: Text,
  blocks: readonly OrgEnvBlock[],
  changes: ChangeSet,
): OrgEnvTitlePatch | null {
  let changeCount = 0;
  let fromA = 0;
  let toA = 0;
  let insertedText = "";
  changes.iterChanges((changeFromA, changeToA, _nextFrom, _nextTo, inserted) => {
    changeCount++;
    fromA = changeFromA;
    toA = changeToA;
    insertedText = inserted.toString();
  });
  if (changeCount !== 1) return null;

  const removed = oldDoc.sliceString(fromA, toA);
  if (removed.includes("\n") || insertedText.includes("\n")) return null;
  if (/^\s*#\+(?:begin|end)\b/im.test(removed) || /^\s*#\+(?:begin|end)\b/im.test(insertedText)) {
    return null;
  }

  const touchedBlocks = blocks.filter((block) => (
    block.kind !== "meta"
    && fromA <= block.openTo
    && toA >= block.openFrom
  ));
  if (touchedBlocks.length !== 1) return null;

  const oldBlock = touchedBlocks[0]!;
  const oldLine = oldDoc.lineAt(oldBlock.openFrom);
  if (oldLine.from !== oldBlock.openFrom || oldLine.to !== oldBlock.openTo) return null;
  const oldInfo = parseOrgEnvOpenLine(oldLine.text);
  if (!oldInfo || oldInfo.kind !== oldBlock.kind) return null;

  const changeLine = oldDoc.lineAt(Math.min(fromA, oldDoc.length));
  const changeEndLine = oldDoc.lineAt(Math.min(Math.max(fromA, toA), oldDoc.length));
  if (changeLine.number !== oldLine.number || changeEndLine.number !== oldLine.number) return null;

  if (oldBlock.title.length > 0) {
    if (fromA < oldBlock.titleAnchor || toA > oldBlock.openTo) return null;
  } else if (fromA !== oldBlock.openTo || !/^[ \t]/.test(insertedText)) {
    return null;
  }

  const mappedBlocks = mapOrgEnvBlocks(blocks, changes, newDoc);
  const touchedIndex = blocks.indexOf(oldBlock);
  const mappedBlock = mappedBlocks[touchedIndex]!;
  const newLine = newDoc.lineAt(mappedBlock.openFrom);
  if (newLine.from !== mappedBlock.openFrom) return null;
  const newInfo = parseOrgEnvOpenLine(newLine.text);
  if (!newInfo || newInfo.kind !== oldBlock.kind) return null;

  const newBlock: OrgEnvBlock = {
    ...mappedBlock,
    openFrom: newLine.from,
    openTo: newLine.to,
    bodyFrom: Math.min(newLine.to + 1, newDoc.length),
    kind: newInfo.kind,
    title: newInfo.title,
    blockId: newInfo.blockId,
    blockIdFrom: newInfo.blockIdFrom >= 0 ? newLine.from + newInfo.blockIdFrom : -1,
    titleAnchor: newLine.from + newInfo.titleAnchor,
  };
  const nextBlocks = mappedBlocks.map((block, index) => index === touchedIndex ? newBlock : block);
  return { blocks: nextBlocks, newBlock };
}

class OrgEnvRailPlugin {
  layer: HTMLElement;

  constructor(view: EditorView) {
    this.layer = document.createElement("div");
    this.layer.className = "cm-org-env-rail-layer";
    view.dom.append(this.layer);
    this.schedule(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      this.schedule(update.view);
    }
  }

  destroy(): void {
    this.layer.remove();
  }

  private schedule(view: EditorView): void {
    view.requestMeasure({
      read: () => measureOrgEnvRails(view),
      write: (rails) => this.writeRails(rails),
    });
  }

  private writeRails(rails: OrgEnvRailMeasure[]): void {
    const next = document.createDocumentFragment();
    for (const rail of rails) {
      if (rail.height <= 0) continue;
      // Blank lines around semantic environments are intentionally absorbed
      // by the typography engine.  Inset the overlay itself so neighbouring
      // blocks remain visually distinct without putting those blank lines
      // (and their scroll cost) back into CodeMirror's height map.
      const verticalInset = Math.min(6, rail.height / 4);
      const div = document.createElement("div");
      div.className = "cm-org-env-rail";
      div.dataset.orgEnvKind = rail.kind;
      div.dataset.orgEnvDepth = String(rail.depth);
      div.style.left = `${rail.left}px`;
      div.style.top = `${rail.top + verticalInset}px`;
      div.style.height = `${Math.max(1, rail.height - verticalInset * 2)}px`;
      next.append(div);
    }
    this.layer.replaceChildren(next);
  }
}

function buildOrgEnvBodyLineDecoRanges(
  state: EditorState,
  startLine = 1,
  endLine = state.doc.lines,
): CMRange<Decoration>[] {
  const decos: CMRange<Decoration>[] = [];
  const lineBlocks = new Map<number, OrgEnvBlock>();
  const doc = state.doc;
  const firstLine = Math.max(1, startLine);
  const lastLine = Math.min(doc.lines, endLine);
  if (firstLine > lastLine) return decos;
  const windowFrom = doc.line(firstLine).from;
  const windowTo = doc.line(lastLine).to;

  for (const block of orgEnvBlocksFromState(state)) {
    if (block.kind === "meta") continue;
    if (block.kind === "fold" && !selectionTouchesRange(state, block.from, block.to)) continue;
    if (block.bodyTo < windowFrom || block.bodyFrom > windowTo) continue;
    const fromLine = doc.lineAt(Math.max(block.bodyFrom, windowFrom));
    const toLine = doc.lineAt(Math.min(block.bodyTo, windowTo));
    for (let lineNum = fromLine.number; lineNum <= toLine.number; lineNum++) {
      const line = doc.line(lineNum);
      if (line.from >= block.closeFrom) break;
      if (line.to < block.bodyFrom) continue;
      const current = lineBlocks.get(line.from);
      if (!current || block.depth >= current.depth) {
        lineBlocks.set(line.from, block);
      }
    }
  }

  for (const [lineFrom, block] of lineBlocks) {
    decos.push(
      Decoration.line({
        attributes: {
          class: "cm-org-env-line cm-org-env-body-line",
          "data-org-env-kind": block.kind,
          "data-org-env-depth": String(block.depth),
          style: `--org-env-depth: ${block.depth};`,
        },
      }).range(lineFrom),
    );
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return decos;
}

function buildOrgEnvBodyLineDecos(state: EditorState): DecorationSet {
  return Decoration.set(buildOrgEnvBodyLineDecoRanges(state), true);
}

const orgEnvBodyLineDecorations = StateField.define<DecorationSet>({
  create: (state) => buildOrgEnvBodyLineDecos(state),
  update(value, tr) {
    if (tr.docChanged) {
      const blocks = tr.startState.field(orgEnvBlocksField, false) ?? orgEnvBlocksFromState(tr.startState);
      if (
        canMapOrgEnvBlocks(tr.startState.doc, blocks, tr.changes)
        || patchOrgEnvBlocksForTitleChange(tr.startState.doc, tr.state.doc, blocks, tr.changes)
      ) {
        const mapped = value.map(tr.changes);
        return changesContainNewline(tr.startState.doc, tr.changes)
          ? patchOrgEnvBodyLineDecosNearChanges(tr.state, mapped, tr.changes)
          : mapped;
      }
      return buildOrgEnvBodyLineDecos(tr.state);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function patchOrgEnvBodyLineDecosNearChanges(
  state: EditorState,
  mapped: DecorationSet,
  changes: ChangeSet,
): DecorationSet {
  let fromB = Number.POSITIVE_INFINITY;
  let toB = 0;
  changes.iterChanges((_fromA, _toA, nextFrom, nextTo) => {
    fromB = Math.min(fromB, nextFrom);
    toB = Math.max(toB, nextTo);
  });
  if (!Number.isFinite(fromB)) return mapped;
  const centerFrom = state.doc.lineAt(Math.min(fromB, state.doc.length)).number;
  const centerTo = state.doc.lineAt(Math.min(toB, state.doc.length)).number;
  const startLine = Math.max(1, centerFrom - 1);
  const endLine = Math.min(state.doc.lines, centerTo + 1);
  const affectedFrom = state.doc.line(startLine).from;
  const affectedTo = state.doc.line(endLine).to;
  return mapped
    .update({ filterFrom: affectedFrom, filterTo: affectedTo, filter: () => false })
    .update({ add: buildOrgEnvBodyLineDecoRanges(state, startLine, endLine), sort: true });
}

function measureOrgEnvRails(view: EditorView): OrgEnvRailMeasure[] {
  const viewportBlocks = view.viewportLineBlocks;
  if (viewportBlocks.length === 0) return [];

  const viewRect = view.dom.getBoundingClientRect();
  const contentRect = view.contentDOM.getBoundingClientRect();
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const depthStep = rootFontSize * 1.1;
  const baseLeft = contentRect.left - viewRect.left;
  const docTop = view.documentTop - viewRect.top;
  const visibleFrom = Math.min(...view.visibleRanges.map((range) => range.from));
  const visibleTo = Math.max(...view.visibleRanges.map((range) => range.to));
  const visibleTop = docTop + viewportBlocks[0]!.top;
  const visibleBottom = docTop + viewportBlocks[viewportBlocks.length - 1]!.bottom;

  return orgEnvBlocksFromState(view.state)
    .filter((block) => (
      block.kind !== "meta"
      && block.kind !== "comment"
      && block.kind !== "fold"
      && block.kind !== "html"
      && block.kind !== "tikz"
      && block.openFrom <= visibleTo
      && block.closeTo >= visibleFrom
    ))
    .map((block) => {
      const openVisible = block.openFrom >= visibleFrom && block.openFrom <= visibleTo;
      const closeVisible = block.closeTo >= visibleFrom && block.closeTo <= visibleTo;
      const top = openVisible ? docTop + view.lineBlockAt(block.openFrom).top : visibleTop;
      const bottom = closeVisible
        ? docTop + view.lineBlockAt(block.closeFrom).bottom
        : visibleBottom;
      return {
        kind: block.kind,
        depth: block.depth,
        top,
        height: Math.max(0, bottom - top),
        left: baseLeft + block.depth * depthStep,
      };
    });
}

// ---------------------------------------------------------------------------
// Decoration builder (full-doc scan — these constructs are sparse)
// ---------------------------------------------------------------------------

function addOrgEnvBlockExtraDecos(
  decos: CMRange<Decoration>[],
  occupied: Array<[number, number]> | null,
  state: EditorState,
  block: OrgEnvBlock,
): void {
  if (block.kind === "meta") {
    decos.push(
      Decoration.replace({
        widget: new MetaWidget(block.body, block.from, block.to),
        block: true,
      }).range(block.from, block.to),
    );
    occupied?.push([block.from, block.to]);
    return;
  }
  if (block.kind === "html") {
    decos.push(
      Decoration.replace({
        widget: new HtmlWidget(block.body, block.from, block.to),
        block: true,
      }).range(block.from, block.to),
    );
    occupied?.push([block.from, block.to]);
    return;
  }
  if (block.kind === "tikz") {
    const dirtyTikzBlocks = state.field(dirtyTikzBlocksField, false);
    const dirtyKey = tikzDirtyKeyFromTitle(block.title);
    decos.push(
      Decoration.replace({
        widget: new TikzWidget(block.title, block.body, block.from, block.to, Boolean(dirtyKey && dirtyTikzBlocks?.has(dirtyKey))),
        block: true,
      }).range(block.from, block.to),
    );
    occupied?.push([block.from, block.to]);
    return;
  }
  if (block.kind === "comment" && !selectionTouchesRange(state, block.from, block.to)) {
    decos.push(
      Decoration.replace({
        widget: new CommentWidget(block.title, block.body, block.from, block.to, block.depth),
        block: true,
      }).range(block.from, block.to),
    );
    occupied?.push([block.from, block.to]);
    return;
  }
  if (block.kind === "fold" && !selectionTouchesRange(state, block.from, block.to)) {
    decos.push(
      Decoration.replace({
        widget: new FoldWidget(block.title, block.body, block.from, block.to, block.depth),
        block: true,
      }).range(block.from, block.to),
    );
    occupied?.push([block.from, block.to]);
    return;
  }
  addOrgEnvBoundaryDecos(decos, state, block);
}

function buildBlockExtraDecoRanges(
  state: EditorState,
  windowFrom = 0,
  windowTo = state.doc.length,
): CMRange<Decoration>[] {
  const decos: CMRange<Decoration>[] = [];
  const occupied: Array<[number, number]> = [];
  const sel = state.selection.main;
  const excludedRanges = blockExtraExcludedRanges(state);
  const headings = tocHeadingsFromState(state);
  const ranges = state.field(blockExtraRangesField, false) ?? scanBlockExtraRanges(state.doc, excludedRanges);
  const foldState = state.field(tocFoldField, false) ?? new Map<string, boolean>();

  // ── [toc] ──────────────────────────────────────────────────────────────
  for (const range of ranges.toc) {
    if (range.to < windowFrom || range.from > windowTo) continue;
    if (rangeOverlapsAny(range.from, range.to, excludedRanges)) continue;
    if (!(sel.from <= range.to && sel.to >= range.from)) {
      decos.push(
        Decoration.replace({ widget: new TocWidget(headings, foldState), block: true }).range(range.from, range.to),
      );
      occupied.push([range.from, range.to]);
    }
  }

  // ── @@part / @@section semantic headings ──────────────────────────────
  for (const range of ranges.semanticHeadings) {
    if (range.to < windowFrom || range.from > windowTo) continue;
    if (rangeOverlapsAny(range.from, range.to, excludedRanges)) continue;
    if (occupied.some(([from, to]) => range.from < to && range.to > from)) continue;
    if (sel.from >= range.from && sel.from <= range.to) {
      decos.push(Decoration.mark({ class: "syntax-hint" }).range(range.from, range.to));
      continue;
    }
    decos.push(
      Decoration.replace({ widget: new SemanticHeadingWidget(range.outline, range.from, range.to), block: true }).range(range.from, range.to),
    );
    occupied.push([range.from, range.to]);
  }

  // ── @@cell(...) [id] Jupyter cells ────────────────────────────────────
  for (const range of ranges.ceilCommands) {
    if (range.to < windowFrom || range.from > windowTo) continue;
    if (rangeOverlapsAny(range.from, range.to, excludedRanges)) continue;
    if (occupied.some(([from, to]) => range.from < to && range.to > from)) continue;
    decos.push(
      Decoration.replace({ widget: new CeilCommandWidget(range), block: true }).range(range.from, range.to),
    );
    occupied.push([range.from, range.to]);
  }

  // ── org-env #+begin … #+end ────────────────────────────────────────────
  // Most org-env bodies remain normal CM6 markdown. Specialized blocks such as
  // meta/html/tikz replace the whole source region with purpose-built UI.
  const orgEnvBlocks = orgEnvBlocksFromState(state);
  for (const block of orgEnvBlocks) {
    if (block.to < windowFrom || block.from > windowTo) continue;
    addOrgEnvBlockExtraDecos(decos, occupied, state, block);
  }

  // ── YAML front matter (only at offset 0) ───────────────────────────────
  const frontMatter = ranges.frontMatter;
  if (frontMatter) {
    const { from, to, body } = frontMatter;
    if (to >= windowFrom && from <= windowTo && !rangeOverlapsAny(from, to, excludedRanges) && !(sel.from < to && sel.to > from)) {
      decos.push(
        Decoration.replace({ widget: new FrontMatterWidget(body, from, to), block: true }).range(from, to),
      );
      occupied.push([from, to]);
    }
  }

  // ── Horizontal rule ────────────────────────────────────────────────────
  for (const range of ranges.hrs) {
    if (range.to < windowFrom || range.from > windowTo) continue;
    if (rangeOverlapsAny(range.from, range.to, excludedRanges)) continue;
    if (occupied.some(([from, to]) => range.from < to && range.to > from)) continue;
    if (sel.from >= range.from && sel.from <= range.to) {
      decos.push(Decoration.mark({ class: "syntax-hint" }).range(range.from, range.to));
      continue;
    }
    decos.push(
      Decoration.replace({ widget: new HorizontalRuleWidget(range.from, range.to), block: true }).range(range.from, range.to),
    );
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return decos;
}

function buildBlockExtraDecos(state: EditorState): DecorationSet {
  const decos = buildBlockExtraDecoRanges(state);
  return Decoration.set(decos, true);
}

function buildTocWidgetDecoRanges(
  state: EditorState,
  ranges = state.field(blockExtraRangesField, false)?.toc ?? [],
): CMRange<Decoration>[] {
  if (ranges.length === 0) return [];
  const decos: CMRange<Decoration>[] = [];
  const sel = state.selection.main;
  const excludedRanges = blockExtraExcludedRanges(state);
  const headings = tocHeadingsFromState(state);
  const foldState = state.field(tocFoldField, false) ?? new Map<string, boolean>();
  for (const range of ranges) {
    if (rangeOverlapsAny(range.from, range.to, excludedRanges)) continue;
    if (sel.from <= range.to && sel.to >= range.from) continue;
    decos.push(
      Decoration.replace({ widget: new TocWidget(headings, foldState), block: true }).range(range.from, range.to),
    );
  }
  return decos;
}

function changesContainNewline(doc: Text, changes: ChangeSet): boolean {
  let found = false;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (found) return;
    found = doc.sliceString(fromA, toA).includes("\n") || inserted.toString().includes("\n");
  });
  return found;
}

function changesTouchRange(changes: ChangeSet, from: number, to: number): boolean {
  let touched = false;
  changes.iterChanges((fromA, toA) => {
    if (touched) return;
    touched = fromA <= to && toA >= from;
  });
  return touched;
}

function activeBlockExtraKey(state: EditorState): string {
  const sel = state.selection.main;
  const parts: string[] = [];
  const ranges = state.field(blockExtraRangesField, false) ?? scanBlockExtraRanges(state.doc, blockExtraExcludedRanges(state));
  const blocks = orgEnvBlocksFromState(state);

  for (const range of ranges.toc) {
    if (sel.from <= range.to && sel.to >= range.from) parts.push(`toc:${range.from}:${range.to}`);
  }
  for (const range of ranges.semanticHeadings) {
    if (sel.from <= range.to && sel.to >= range.from) parts.push(`semantic:${range.from}:${range.to}`);
  }
  for (const range of ranges.ceilCommands) {
    if (sel.from <= range.to && sel.to >= range.from) parts.push(`ceilcmd:${range.from}:${range.to}`);
  }
  if (ranges.frontMatter && sel.from < ranges.frontMatter.to && sel.to > ranges.frontMatter.from) {
    parts.push(`front:${ranges.frontMatter.from}:${ranges.frontMatter.to}`);
  }
  for (const range of ranges.hrs) {
    if (sel.from >= range.from && sel.from <= range.to) parts.push(`hr:${range.from}:${range.to}`);
  }
  for (const block of blocks) {
    if ((block.kind === "comment" || block.kind === "fold") && selectionTouchesRange(state, block.from, block.to)) {
      parts.push(`${block.kind}:${block.from}:${block.to}`);
      continue;
    }
    if (selectionTouchesRange(state, block.openFrom, block.openTo)) {
      parts.push(`org-open:${block.openFrom}:${block.openTo}:${block.from}:${block.to}`);
    }
    if (orgEnvCloseBoundaryActive(state, block)) {
      parts.push(`org-close:${block.closeFrom}:${block.closeTo}:${block.from}:${block.to}`);
    }
  }
  return parts.join("|");
}

function blockExtraPatchRangesFromKey(key: string): Array<{ from: number; to: number }> {
  if (!key) return [];
  return key.split("|")
    .map((part) => {
      const pieces = part.split(":");
      const from = Number(pieces[pieces.length - 2]);
      const to = Number(pieces[pieces.length - 1]);
      return Number.isFinite(from) && Number.isFinite(to) && from <= to ? { from, to } : null;
    })
    .filter((range): range is { from: number; to: number } => Boolean(range));
}

function mergeBlockExtraPatchRanges(ranges: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const sorted = ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function patchBlockExtraDecosForSelectionChange(
  state: EditorState,
  current: DecorationSet,
  oldKey: string,
  newKey: string,
): DecorationSet {
  const ranges = mergeBlockExtraPatchRanges([
    ...blockExtraPatchRangesFromKey(oldKey),
    ...blockExtraPatchRangesFromKey(newKey),
  ]);
  if (ranges.length === 0) return current;

  let next = current;
  const add: CMRange<Decoration>[] = [];
  for (const range of ranges) {
    next = next.update({ filterFrom: range.from, filterTo: range.to, filter: () => false });
    add.push(...buildBlockExtraDecoRanges(state, range.from, range.to));
  }
  return next.update({ add, sort: true });
}

function canMapBlockExtraDecos(state: EditorState, changes: ChangeSet): boolean {
  const ranges = state.field(blockExtraRangesField, false) ?? scanBlockExtraRanges(state.doc, blockExtraExcludedRanges(state));
  const blocks = state.field(orgEnvBlocksField, false) ?? orgEnvBlocksFromState(state);

  if (!canMapBlockExtraRanges(state.doc, changes, ranges)) return false;
  if (!canMapOrgEnvBlocks(state.doc, blocks, changes)) return false;

  if (ranges.toc.some((range) => changesTouchRange(changes, range.from, range.to))) return false;
  if (ranges.semanticHeadings.some((range) => changesTouchRange(changes, range.from, range.to))) return false;
  if (ranges.ceilCommands.some((range) => changesTouchRange(changes, range.from, range.to))) return false;
  if (ranges.hrs.some((range) => changesTouchRange(changes, range.from, range.to))) return false;
  if (ranges.frontMatter && changesTouchRange(changes, ranges.frontMatter.from, ranges.frontMatter.to)) return false;
  if (blocks.some((block) => (
    (block.kind === "meta" || block.kind === "comment" || block.kind === "fold" || block.kind === "html" || block.kind === "tikz")
    && changesTouchRange(changes, block.from, block.to)
  ))) {
    return false;
  }

  return true;
}

function canPatchBlockExtraDecosNearChanges(state: EditorState, changes: ChangeSet): boolean {
  const ranges = state.field(blockExtraRangesField, false)
    ?? scanBlockExtraRanges(state.doc, blockExtraExcludedRanges(state));
  const blocks = state.field(orgEnvBlocksField, false) ?? orgEnvBlocksFromState(state);
  if (!canPatchBlockExtraRangesNearChanges(state.doc, changes, ranges)) return false;
  // A boundary edit can alter nesting beyond the local line window.
  if (!canMapOrgEnvBlocks(state.doc, blocks, changes)) return false;
  // Whole-block widgets own their body source. Rebuild them only when touched;
  // ordinary prose and line-owned commands can stay on the bounded path.
  return !blocks.some((block) => (
    (block.kind === "meta" || block.kind === "comment" || block.kind === "fold" || block.kind === "html" || block.kind === "tikz")
    && changesTouchRange(changes, block.from, block.to)
  ));
}

function patchBlockExtraDecosNearChanges(
  state: EditorState,
  mapped: DecorationSet,
  changes: ChangeSet,
): DecorationSet {
  let fromB = Number.POSITIVE_INFINITY;
  let toB = 0;
  changes.iterChanges((_fromA, _toA, nextFrom, nextTo) => {
    fromB = Math.min(fromB, nextFrom);
    toB = Math.max(toB, nextTo);
  });
  if (!Number.isFinite(fromB)) return mapped;
  const startLine = Math.max(1, state.doc.lineAt(Math.min(fromB, state.doc.length)).number - 1);
  const endLine = Math.min(state.doc.lines, state.doc.lineAt(Math.min(toB, state.doc.length)).number + 1);
  const affectedFrom = state.doc.line(startLine).from;
  const affectedTo = state.doc.line(endLine).to;
  const add = buildBlockExtraDecoRanges(state, affectedFrom, affectedTo)
    // A normal org environment can span the local window while its boundary
    // decorations live far outside it. Keep those already-mapped decorations
    // instead of adding duplicates beyond the filtered patch range.
    .filter((range) => range.from >= affectedFrom && range.to <= affectedTo);
  return mapped
    .update({ filterFrom: affectedFrom, filterTo: affectedTo, filter: () => false })
    .update({ add, sort: true });
}

function patchBlockExtraDecosForOrgEnvTitleChange(
  state: EditorState,
  mapped: DecorationSet,
  block: OrgEnvBlock,
): DecorationSet {
  const decos: CMRange<Decoration>[] = [];
  addOrgEnvBlockExtraDecos(decos, null, state, block);
  decos.sort((a, b) => a.from - b.from || a.to - b.to);

  const fullBlockWidgetActive = block.kind === "meta"
    || block.kind === "html"
    || block.kind === "tikz"
    || ((block.kind === "comment" || block.kind === "fold") && !selectionTouchesRange(state, block.from, block.to));
  let next = fullBlockWidgetActive
    ? mapped.update({ filterFrom: block.from, filterTo: block.to, filter: () => false })
    : mapped
        .update({ filterFrom: block.openFrom, filterTo: block.openTo, filter: () => false })
        .update({ filterFrom: block.closeFrom, filterTo: block.closeTo, filter: () => false });
  next = next.update({ add: decos, sort: true });
  return next;
}

function patchTocWidgetDecos(
  state: EditorState,
  current: DecorationSet,
): DecorationSet {
  const ranges = state.field(blockExtraRangesField, false)?.toc ?? [];
  if (ranges.length === 0) return current;
  let next = current;
  for (const range of ranges) {
    next = next.update({ filterFrom: range.from, filterTo: range.to, filter: () => false });
  }
  const add = buildTocWidgetDecoRanges(state, ranges);
  return next.update({ add, sort: true });
}

function scanFrontMatter(doc: Text): { from: number; to: number; body: string } | null {
  if (doc.lines < 2 || doc.line(1).text.trim() !== "---") return null;
  const bodyLines: string[] = [];
  const lastLine = Math.min(doc.lines, 1_024);
  let bytes = doc.line(1).length + 1;
  for (let lineNum = 2; lineNum <= lastLine && bytes <= 256 * 1024; lineNum++) {
    const line = doc.line(lineNum);
    if (line.text.trim() === "---") {
      return { from: 0, to: line.to, body: bodyLines.join("\n") };
    }
    bodyLines.push(line.text);
    bytes += line.length + 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// StateField export
// ---------------------------------------------------------------------------

const blockExtrasDecorations = StateField.define<DecorationSet>({
  create: (state) => buildBlockExtraDecos(state),
  update(value, tr) {
    if (tr.effects.some((effect) => effect.is(tocFoldEffect))) {
      return patchTocWidgetDecos(tr.state, value);
    }
    if (tr.effects.some((effect) => effect.is(ceilRefreshEffect))) {
      // Epoch already bumped by the reload hook; rebuilding makes eq() fail for
      // @@cell widgets so their toDOM re-reads the (now invalidated) source.
      return buildBlockExtraDecos(tr.state);
    }
    if (tr.effects.some((effect) => effect.is(refreshViewportDecorations))) {
      // Meta summaries may contain server-backed citation widgets. Rebuilding
      // creates a new MetaWidget bibliography epoch while eq() preserves all
      // unrelated block widgets.
      return buildBlockExtraDecos(tr.state);
    }
    if (tr.docChanged) {
      if (canMapBlockExtraDecos(tr.startState, tr.changes)) {
        const mapped = value.map(tr.changes);
        return (tr.state.field(blockExtraRangesField, false)?.toc.length ?? 0) > 0
          && tocContentSignature(tr.startState) !== tocContentSignature(tr.state)
          ? patchTocWidgetDecos(tr.state, mapped)
          : mapped;
      }
      if (canPatchBlockExtraDecosNearChanges(tr.startState, tr.changes)) {
        const patched = patchBlockExtraDecosNearChanges(tr.state, value.map(tr.changes), tr.changes);
        return (tr.state.field(blockExtraRangesField, false)?.toc.length ?? 0) > 0
          && tocContentSignature(tr.startState) !== tocContentSignature(tr.state)
          ? patchTocWidgetDecos(tr.state, patched)
          : patched;
      }
      const blocks = tr.startState.field(orgEnvBlocksField, false) ?? orgEnvBlocksFromState(tr.startState);
      const titlePatch = patchOrgEnvBlocksForTitleChange(tr.startState.doc, tr.state.doc, blocks, tr.changes);
      return titlePatch
        ? patchBlockExtraDecosForOrgEnvTitleChange(tr.state, value.map(tr.changes), titlePatch.newBlock)
        : buildBlockExtraDecos(tr.state);
    }
    if (tr.selection != null) {
      const oldKey = activeBlockExtraKey(tr.startState);
      const newKey = activeBlockExtraKey(tr.state);
      if (oldKey !== newKey) return patchBlockExtraDecosForSelectionChange(tr.state, value, oldKey, newKey);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const orgEnvRailExtension = ViewPlugin.fromClass(OrgEnvRailPlugin);

// Publishes window.AaronnoteReloadCeilCells so the app shell can force @@cell
// widgets to re-read their hidden source after an out-of-band edit (Emacs saved
// the script buffer). Invalidates caches, bumps the epoch, and dispatches the
// refresh effect on this view.
class CeilCellReloadPlugin {
  private readonly view: EditorView;
  private readonly handler: (file?: string) => void;
  private readonly resultHandler: NonNullable<Window["AaronnotePublishJupyterCellResult"]>;

  constructor(view: EditorView) {
    this.view = view;
    this.handler = (file?: string): void => {
      ceilCacheEpoch += 1;
      clearCeilCachesForFile(file || "");
      preserveCeilScroll(this.view, () => {
        this.view.dispatch({ effects: ceilRefreshEffect.of(file || "") });
      });
    };
    this.resultHandler = ({ file, cellId, kernel, session, result }): void => {
      const key = ceilOutputKey(file, { id: cellId, kernel, session }, `script:${cellId}`);
      const merged = mergeCeilOutputUi(result, ceilOutputCache.get(key) ?? null) ?? result;
      setBoundedMap(ceilOutputCache, key, merged);
      ceilCacheEpoch += 1;
      preserveCeilScroll(this.view, () => {
        this.view.dispatch({ effects: ceilRefreshEffect.of(file) });
      });
    };
    window.AaronnoteReloadCeilCells = this.handler;
    window.AaronnotePublishJupyterCellResult = this.resultHandler;
  }

  destroy(): void {
    if (window.AaronnoteReloadCeilCells === this.handler) {
      window.AaronnoteReloadCeilCells = undefined;
    }
    if (window.AaronnotePublishJupyterCellResult === this.resultHandler) {
      window.AaronnotePublishJupyterCellResult = undefined;
    }
  }
}

const ceilCellReloadExtension = ViewPlugin.fromClass(CeilCellReloadPlugin);

export const blockExtrasExtension: Extension = [
  fencedCodeRangesExtension,
  blockExtraRangesField,
  tocFoldField,
  orgEnvBlocksField,
  dirtyTikzBlocksField,
  blockExtrasDecorations,
  orgEnvBodyLineDecorations,
  orgEnvRailExtension,
  ceilCellReloadExtension,
];
