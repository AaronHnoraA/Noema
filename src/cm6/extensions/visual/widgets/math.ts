/**
 * Phase 3 — Math widgets for the CM6 kernel.
 *
 * CM6 constraint: block decorations (block:true) may NOT come from ViewPlugin —
 * they must be provided by a StateField via EditorView.decorations facet.
 *
 * Split strategy:
 *   mathBlockField   — StateField, incrementally indexes \[…\] fence lines
 *   MathInlinePlugin — ViewPlugin (viewport-only), processes \(…\) inline
 *
 * Both are bundled into `mathExtension = [mathBlockField, mathInlineExtension]`.
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
import {
  EditorSelection,
  StateEffect,
  StateField,
  type ChangeSet,
  type EditorState,
  type Transaction,
} from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { scanInlineMathRanges } from "../../../../inline-math.ts";
import { renderMathHTML } from "../../../../math-render.ts";
import {
  blockMathRangeSpanning,
  getBlockMathRanges,
  rangeOverlapsAny,
  type BlockMathRange,
} from "../../../math-ranges.ts";
import { scanCodeRanges } from "../../../code-ranges.ts";
import { scanTexSource, texTokenClass } from "../../../tex-highlight.ts";
import { orgEnvContextForRange, type OrgEnvContext } from "./block-extras.ts";
import { hasViewportDecorationRefresh } from "../../../viewport-refresh.ts";
import { getKatexMacros } from "../../../../katex-macros.ts";
import {
  mountVisualTexDisplayEditor,
  mountVisualTexInlineEditor,
  normalizeVisualTexLatex,
  type VisualTexInlineEditor,
  type VisualTexInlineEntry,
  type VisualTexInlineMoveDirection,
} from "./visualtex-inline.ts";

function setSourceRange(el: HTMLElement, from: number, to: number, openSource = false): void {
  el.dataset.cmSourceFrom = String(from);
  el.dataset.cmSourceTo = String(to);
  if (openSource) el.dataset.cmOpenSource = "true";
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

function selectionTouchesRange(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((sel) => {
    if (sel.empty) return sel.from > from && sel.from < to;
    return sel.from < to && sel.to > from;
  });
}

function addActiveBlockSourceLineDecos(
  decos: Range<Decoration>[],
  state: EditorState,
  from: number,
  to: number,
): void {
  const doc = state.doc;
  const firstLine = doc.lineAt(from).number;
  const lastLine = doc.lineAt(to).number;
  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    const line = doc.line(lineNum);
    decos.push(
      Decoration.line({ attributes: { class: "cm-math-source-line" } }).range(line.from),
    );
  }
}

// ---------------------------------------------------------------------------
// Widget classes
// ---------------------------------------------------------------------------

class InlineMathWidget extends MeasuredWidget {
  tex: string;
  from: number;
  to: number;

  constructor(tex: string, from: number, to: number) {
    super();
    this.tex = tex;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: InlineMathWidget): boolean {
    return this.tex === other.tex && this.from === other.from && this.to === other.to;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-math-inline";
    setSourceRange(span, this.from, this.to, true);
    span.dataset.cmInlineMath = "static";
    const { html, error } = renderMathHTML(this.tex, { displayMode: false });
    if (error) { span.classList.add("cm-math-error"); span.textContent = error; }
    else span.innerHTML = html;
    return span;
  }

  ignoreEvent(): boolean { return false; }
}

type InlineMathEditSession = {
  id: number;
  from: number;
  to: number;
  original: string;
  draft: string;
  externalDraft: boolean;
  entry: VisualTexInlineEntry;
  editor: VisualTexInlineEditor | null;
  host: HTMLElement | null;
  onDraft: (latex: string) => void;
  onCommit: (direction?: VisualTexInlineMoveDirection) => void;
  onUnavailable: (error: unknown) => void;
};

function snapshotInlineMathDraft(session: InlineMathEditSession): void {
  if (session.externalDraft) return;
  const value = session.editor?.value();
  if (typeof value === "string") session.draft = normalizeVisualTexLatex(value);
}

class InlineMathEditorWidget extends MeasuredWidget {
  private readonly session: InlineMathEditSession;

  constructor(session: InlineMathEditSession) {
    super();
    this.session = session;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: InlineMathEditorWidget): boolean {
    return this.session.id === other.session.id;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-math-inline-editor";
    span.dataset.aaronnoteVim = "native";
    span.dataset.cmInlineMath = "active";
    span.dataset.cmVisualMath = "active";
    setSourceRange(span, this.session.from, this.session.to);
    const fallback = document.createElement("span");
    fallback.className = "cm-math-inline-editor-fallback";
    const rendered = renderMathHTML(this.session.original, { displayMode: false });
    if (rendered.error) fallback.textContent = this.session.original;
    else fallback.innerHTML = rendered.html;
    span.append(fallback);

    // These events keep the widget testable without coupling tests to
    // MathLive's shadow DOM implementation.
    span.addEventListener("aaronnote:inline-math-draft", (event) => {
      const latex = (event as CustomEvent<{ latex?: unknown }>).detail?.latex;
      if (typeof latex === "string") {
        this.session.externalDraft = true;
        this.session.draft = normalizeVisualTexLatex(latex);
      }
    });
    span.addEventListener("aaronnote:inline-math-commit", () => this.session.onCommit("forward"));
    span.addEventListener("aaronnote:inline-math-unavailable", () => {
      this.session.onUnavailable(new Error("Visual formula editor unavailable"));
    });
    span.addEventListener("aaronnote:inline-math-resize", () => {
      // MathLive renders inside a shadow tree, so CM6's mutation observer does
      // not see a taller fraction/root. The outer widget has already received
      // its new stable size; explicitly refresh the line height map.
      if (span.isConnected && view.dom.isConnected) view.requestMeasure();
    });

    this.session.host = span;
    this.session.editor = mountVisualTexInlineEditor(span, {
      latex: this.session.original,
      macros: getKatexMacros(),
      entry: this.session.entry,
      onInput: this.session.onDraft,
      onCommit: this.session.onCommit,
      onUnavailable: this.session.onUnavailable,
    });
    return span;
  }

  destroy(dom: HTMLElement): void {
    if (this.session.host !== dom) return;
    snapshotInlineMathDraft(this.session);
    this.session.editor?.destroy();
    this.session.editor = null;
    this.session.host = null;
  }

  ignoreEvent(): boolean { return true; }
}

type BlockMathEditSession = {
  id: number;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  original: string;
  draft: string;
  externalDraft: boolean;
  entry: VisualTexInlineEntry;
  editor: VisualTexInlineEditor | null;
  host: HTMLElement | null;
};

function snapshotBlockMathDraft(session: BlockMathEditSession): void {
  if (session.externalDraft) return;
  const value = session.editor?.value();
  if (typeof value === "string") session.draft = normalizeVisualTexLatex(value);
}

let nextBlockMathSessionId = 1;

class BlockMathEditorWidget extends MeasuredWidget {
  private readonly session: BlockMathEditSession;
  private readonly orgEnv: OrgEnvContext | null;

  constructor(session: BlockMathEditSession, orgEnv: OrgEnvContext | null) {
    super();
    this.session = session;
    this.orgEnv = orgEnv;
  }

  protected measureKey(): string { return `math-editor:${this.session.id}`; }

  protected estimatedHeightFallback(): number {
    return Math.max(48, 34 + this.session.original.split(/\\\\|\n/).length * 24);
  }

  eq(other: BlockMathEditorWidget): boolean {
    return this.session.id === other.session.id;
  }

  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-math-block-editor";
    div.dataset.aaronnoteVim = "native";
    div.dataset.cmVisualMath = "active";
    setSourceRange(div, this.session.from, this.session.to);
    if (this.orgEnv) {
      div.dataset.orgEnvKind = this.orgEnv.kind;
      div.dataset.orgEnvDepth = String(this.orgEnv.depth);
      div.style.setProperty("--org-env-depth", String(this.orgEnv.depth));
    }

    const fallback = document.createElement("div");
    fallback.className = "cm-math-block-editor-fallback";
    const rendered = renderMathHTML(this.session.original, { displayMode: true });
    if (rendered.error) fallback.textContent = this.session.original;
    else fallback.innerHTML = rendered.html;
    div.append(fallback);

    div.addEventListener("aaronnote:display-math-draft", (event) => {
      const latex = (event as CustomEvent<{ latex?: unknown }>).detail?.latex;
      if (typeof latex === "string") {
        this.session.externalDraft = true;
        this.session.draft = normalizeVisualTexLatex(latex);
      }
    });
    div.addEventListener("aaronnote:display-math-commit", (event) => {
      const direction = (event as CustomEvent<{ direction?: VisualTexInlineMoveDirection }>)
        .detail?.direction;
      commitBlockMathSession(view, this.session, direction ?? "forward");
    });
    div.addEventListener("aaronnote:display-math-unavailable", () => {
      fallbackBlockMathSession(view, this.session, new Error("Visual formula editor unavailable"));
    });

    this.session.host = div;
    this.session.editor = mountVisualTexDisplayEditor(div, {
      latex: this.session.original,
      macros: getKatexMacros(),
      entry: this.session.entry,
      onInput: (latex) => {
        this.session.externalDraft = false;
        this.session.draft = normalizeVisualTexLatex(latex);
      },
      onCommit: (direction) => commitBlockMathSession(view, this.session, direction),
      // A failed dynamic import can settle while CM6 is still reconciling the
      // block replacement. Defer the fallback one task so it never nests a
      // second EditorView update inside that reconciliation.
      onUnavailable: (error) => window.setTimeout(() => {
        if (view.dom.isConnected) fallbackBlockMathSession(view, this.session, error);
      }, 0),
    });
    return this.registerMeasured(div, view);
  }

  destroy(dom: HTMLElement): void {
    if (this.session.host === dom) {
      snapshotBlockMathDraft(this.session);
      this.session.editor?.destroy();
      this.session.editor = null;
      this.session.host = null;
    }
    super.destroy(dom);
  }

  ignoreEvent(): boolean { return true; }
}

class BlockMathWidget extends MeasuredWidget {
  tex: string;
  from: number;
  to: number;
  orgEnv: OrgEnvContext | null;

  constructor(tex: string, from: number, to: number, orgEnv: OrgEnvContext | null) {
    super();
    this.tex = tex;
    this.from = from;
    this.to = to;
    this.orgEnv = orgEnv;
  }

  protected measureKey(): string { return "math:" + shortHash(this.tex); }

  protected measureGroupKey(): string {
    return `math:lines:${Math.min(8, Math.ceil(this.tex.split(/\n/).length / 4))}`;
  }

  protected estimatedHeightFallback(): number {
    return Math.max(36, 26 + this.tex.split(/\n/).length * 14);
  }

  eq(other: BlockMathWidget): boolean {
    // `from`/`to` are deliberately excluded. They only feed the widget's
    // debugging dataset — clicks resolve the live decoration position instead —
    // and including them meant any edit earlier in the note made every visible
    // formula unequal, so CodeMirror destroyed and re-rendered all of them.
    return this.tex === other.tex
      && this.orgEnv?.kind === other.orgEnv?.kind
      && this.orgEnv?.depth === other.orgEnv?.depth;
  }

  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-math-block";
    setSourceRange(div, this.from, this.to);
    div.dataset.cmMathBlock = "true";
    if (this.orgEnv) {
      div.dataset.orgEnvKind = this.orgEnv.kind;
      div.dataset.orgEnvDepth = String(this.orgEnv.depth);
      div.style.setProperty("--org-env-depth", String(this.orgEnv.depth));
    }
    const { html, error } = renderMathHTML(this.tex, { displayMode: true });
    if (error) { div.classList.add("cm-math-error"); div.textContent = error; }
    else div.innerHTML = html;
    return this.registerMeasured(div, view);
  }

  ignoreEvent(): boolean { return false; }
}

// ---------------------------------------------------------------------------
// Block math — StateField (incremental fence index, allows block:true decorations)
// ---------------------------------------------------------------------------

type BlockMathFieldValue = {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
  active: BlockMathEditSession | null;
  suppressedKey: string;
};

const finishBlockMathSessionEffect = StateEffect.define<number>();
const fallbackBlockMathSessionEffect = StateEffect.define<number>();
const revealBlockMathSourceEffect = StateEffect.define<{
  id: number;
  from: number;
  to: number;
}>();
const startBlockMathSessionEffect = StateEffect.define<{
  from: number;
  to: number;
  entry: VisualTexInlineEntry;
}>();

function blockMathKey(range: { from: number; to: number }): string {
  return `${range.from}:${range.to}`;
}

function blockMathAtSelection(state: EditorState): BlockMathRange | null {
  // A range selection that crosses a collapsed formula is selecting the visual
  // object, not asking to open MathLive and expose its source character by
  // character. Explicit clicks and cursor entry still use an empty selection.
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return null;
  // Binary search, not a linear scan: this runs on every selection change.
  const range = blockMathRangeSpanning(state, state.selection.main.from);
  return range && rangeContainsSelection(state, range) ? range : null;
}

function blockSelectionEntry(state: EditorState, range: BlockMathRange): VisualTexInlineEntry {
  const selection = state.selection.main;
  if (!selection.empty) return { kind: "all" };
  const midpoint = range.contentFrom + Math.max(0, range.contentTo - range.contentFrom) / 2;
  return selection.from <= midpoint ? { kind: "start" } : { kind: "end" };
}

function createBlockMathSession(state: EditorState, range: BlockMathRange): BlockMathEditSession {
  return {
    id: nextBlockMathSessionId++,
    from: range.from,
    to: range.to,
    contentFrom: range.contentFrom,
    contentTo: range.contentTo,
    original: range.tex,
    draft: normalizeVisualTexLatex(range.tex),
    externalDraft: false,
    entry: blockSelectionEntry(state, range),
    editor: null,
    host: null,
  };
}

let texHighlightScans = 0;

/**
 * How many formulas have been tokenized for highlighting. Only the one formula
 * currently revealed as source is ever scanned, and tests assert that the count
 * does not grow with the number of formulas in the note.
 */
export function texHighlightScanCount(): number {
  return texHighlightScans;
}

/**
 * Syntax highlighting and rainbow brackets for the formula being edited.
 *
 * Deliberately attached here rather than as its own view plugin: this branch is
 * the one place that already knows a formula is showing its TeX source, so the
 * work is bounded to that formula and collapsed formulas never pay for it.
 */
function addTexHighlightDecos(
  decos: Range<Decoration>[],
  state: EditorState,
  from: number,
  to: number,
): void {
  if (to <= from) return;
  texHighlightScans++;
  for (const token of scanTexSource(state.doc.sliceString(from, to), from)) {
    decos.push(Decoration.mark({ class: texTokenClass(token) }).range(token.from, token.to));
  }
}

let blockMathDecoRangeVisits = 0;

/**
 * How many display formulas the decoration builder has looked at. Exposed so
 * tests can assert that a windowed patch stays proportional to the window, not
 * to the number of formulas in the note.
 */
export function blockMathDecoRangeVisitCount(): number {
  return blockMathDecoRangeVisits;
}

function buildBlockMathDecoRanges(
  state: EditorState,
  from = 0,
  to = state.doc.length,
  active: BlockMathEditSession | null = null,
  suppressedKey = "",
): Range<Decoration>[] {
  const decos: Range<Decoration>[] = [];
  const ranges = getBlockMathRanges(state);

  // Binary search to the first formula that can intersect the window. Scanning
  // from index 0 made a one-formula patch cost one iteration per formula in the
  // document, on every caret move.
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ranges[mid]!.to < from) low = mid + 1;
    else high = mid;
  }

  for (let index = low; index < ranges.length; index++) {
    const range = ranges[index]!;
    // Counted before the window test so the metric reflects scan work, not
    // matches: a reintroduced full scan must show up here.
    blockMathDecoRangeVisits++;
    if (range.from > to) break;
    const tex = range.tex;
    const key = blockMathKey(range);
    const cursorInside = rangeContainsSelection(state, range);
    const editing = active?.from === range.from
      && active.to === range.to;
    if (editing) {
      decos.push(
        Decoration.replace({
          widget: new BlockMathEditorWidget(
            active,
            orgEnvContextForRange(state, range.from, range.to),
          ),
          block: true,
        }).range(range.from, range.to),
      );
      continue;
    }
    if (!cursorInside || suppressedKey !== key) {
      decos.push(
        Decoration.replace({
          widget: new BlockMathWidget(tex, range.from, range.to, orgEnvContextForRange(state, range.from, range.to)),
          block: true,
        }).range(range.from, range.to),
      );
      continue;
    }
    addActiveBlockSourceLineDecos(decos, state, range.from, range.to);
    addTexHighlightDecos(decos, state, range.contentFrom, range.contentTo);
    // Visual editor fallback: reveal source with \[ \] syntax hints so the
    // existing floating KaTeX preview can take over.
    const raw = state.doc.sliceString(range.from, range.to);
    const open = raw.indexOf("\\[");
    const close = raw.lastIndexOf("\\]");
    if (open >= 0) {
      decos.push(Decoration.mark({ class: "syntax-hint" }).range(range.from + open, range.from + open + 2));
    }
    if (close >= 0 && close + 2 <= raw.length) {
      decos.push(Decoration.mark({ class: "syntax-hint" }).range(range.from + close, range.from + close + 2));
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return decos;
}

let blockMathFullRebuilds = 0;

/**
 * How many times the whole document's display-math decorations were rebuilt.
 * Exposed so tests can assert that ordinary editing and caret movement stay
 * incremental instead of relying on wall-clock thresholds.
 */
export function blockMathFullRebuildCount(): number {
  return blockMathFullRebuilds;
}

function buildBlockMathDecos(
  state: EditorState,
  active: BlockMathEditSession | null = null,
  suppressedKey = "",
): DecorationSet {
  blockMathFullRebuilds++;
  return Decoration.set(buildBlockMathDecoRanges(state, 0, state.doc.length, active, suppressedKey), true);
}

const blockMathAtomicMark = Decoration.mark({});
let blockMathAtomicFullRebuilds = 0;
let blockMathAtomicRangeVisits = 0;

export function blockMathAtomicFullRebuildCount(): number {
  return blockMathAtomicFullRebuilds;
}

export function blockMathAtomicRangeVisitCount(): number {
  return blockMathAtomicRangeVisits;
}

function buildBlockMathAtomicRangeItems(
  state: EditorState,
  from = 0,
  to = state.doc.length,
  active: BlockMathEditSession | null = null,
  suppressedKey = "",
): Range<Decoration>[] {
  const items: Range<Decoration>[] = [];
  const ranges = getBlockMathRanges(state);
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ranges[mid]!.to < from) low = mid + 1;
    else high = mid;
  }
  for (let index = low; index < ranges.length; index++) {
    const range = ranges[index]!;
    blockMathAtomicRangeVisits++;
    if (range.from > to) break;
    const key = blockMathKey(range);
    if (active?.from === range.from && active.to === range.to) continue;
    if (suppressedKey === key) continue;
    items.push(blockMathAtomicMark.range(range.from, range.to));
  }
  return items;
}

function buildBlockMathAtomicRanges(
  state: EditorState,
  active: BlockMathEditSession | null = null,
  suppressedKey = "",
): DecorationSet {
  blockMathAtomicFullRebuilds++;
  return Decoration.set(
    buildBlockMathAtomicRangeItems(state, 0, state.doc.length, active, suppressedKey),
    true,
  );
}

function activeBlockMathKey(state: EditorState): string {
  // Hot path: a single caret can only touch the formula that spans it, so this
  // stays a binary search. A *range* selection touches every formula it
  // overlaps — including ones it fully encloses, whose endpoints are outside
  // any formula — so it has to scan. Range selections are not on the typing
  // path, unlike caret movement.
  if (state.selection.ranges.length === 1 && state.selection.main.empty) {
    const range = blockMathRangeSpanning(state, state.selection.main.from);
    return range && selectionTouchesRange(state, range.from, range.to)
      ? blockMathKey(range)
      : "";
  }
  for (const range of getBlockMathRanges(state)) {
    if (selectionTouchesRange(state, range.from, range.to)) return blockMathKey(range);
  }
  return "";
}

function rangeFromKey(key: string): { from: number; to: number } | null {
  const [from, to] = key.split(":").map((part) => Number(part));
  return Number.isFinite(from) && Number.isFinite(to) && from <= to ? { from, to } : null;
}

function blockMathWindow(state: EditorState, from: number, to: number): { from: number; to: number } {
  const start = state.doc.lineAt(Math.max(0, Math.min(from, state.doc.length))).from;
  const end = state.doc.lineAt(Math.max(0, Math.min(to, state.doc.length))).to;
  return { from: start, to: end };
}

function mergeWindows(windows: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const sorted = windows
    .filter((range) => range.from <= range.to)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && range.from <= prev.to) {
      prev.to = Math.max(prev.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function patchBlockMathDecosForSelectionChange(
  state: EditorState,
  current: DecorationSet,
  keys: readonly string[],
  active: BlockMathEditSession | null = null,
  suppressedKey = "",
): DecorationSet {
  const windows = mergeWindows(keys
    .filter((key, index) => key && keys.indexOf(key) === index)
    .map(rangeFromKey)
    .filter((range): range is { from: number; to: number } => Boolean(range))
    .map((range) => blockMathWindow(state, range.from, range.to)));
  if (windows.length === 0) return current;

  let next = current;
  const add: Range<Decoration>[] = [];
  for (const range of windows) {
    next = next.update({ filterFrom: range.from, filterTo: range.to, filter: () => false });
    add.push(...buildBlockMathDecoRanges(state, range.from, range.to, active, suppressedKey));
  }
  return next.update({ add, sort: true });
}

function patchBlockMathAtomicRangesForKeys(
  state: EditorState,
  current: DecorationSet,
  keys: readonly string[],
  active: BlockMathEditSession | null = null,
  suppressedKey = "",
): DecorationSet {
  const windows = mergeWindows(keys
    .filter((key, index) => key && keys.indexOf(key) === index)
    .map(rangeFromKey)
    .filter((range): range is { from: number; to: number } => Boolean(range))
    .map((range) => blockMathWindow(state, range.from, range.to)));
  if (windows.length === 0) return current;

  let next = current;
  const add: Range<Decoration>[] = [];
  for (const range of windows) {
    next = next.update({ filterFrom: range.from, filterTo: range.to, filter: () => false });
    add.push(...buildBlockMathAtomicRangeItems(
      state,
      range.from,
      range.to,
      active,
      suppressedKey,
    ));
  }
  return next.update({ add, sort: true });
}

function mapBlockMathKey(key: string, changes: ChangeSet): string {
  const range = rangeFromKey(key);
  return range
    ? `${changes.mapPos(range.from, -1)}:${changes.mapPos(range.to, 1)}`
    : "";
}

function finishBlockMathFieldUpdate(
  value: BlockMathFieldValue,
  tr: Transaction,
  decorations: DecorationSet,
  active: BlockMathEditSession | null,
  suppressedKey: string,
  topologyStable: boolean,
  previousActiveKey: string,
): BlockMathFieldValue {
  let atomicRanges = value.atomicRanges;
  let rebuiltAtomicRanges = false;
  if (tr.docChanged) {
    if (topologyStable) {
      atomicRanges = atomicRanges.map(tr.changes);
    } else {
      atomicRanges = buildBlockMathAtomicRanges(tr.state, active, suppressedKey);
      rebuiltAtomicRanges = true;
    }
  }

  if (!rebuiltAtomicRanges) {
    const mappedPreviousActiveKey = tr.docChanged
      ? mapBlockMathKey(previousActiveKey, tr.changes)
      : previousActiveKey;
    const mappedPreviousSuppressedKey = tr.docChanged
      ? mapBlockMathKey(value.suppressedKey, tr.changes)
      : value.suppressedKey;
    const activeKey = active ? blockMathKey(active) : "";
    if (mappedPreviousActiveKey !== activeKey
      || mappedPreviousSuppressedKey !== suppressedKey) {
      atomicRanges = patchBlockMathAtomicRangesForKeys(
        tr.state,
        atomicRanges,
        [mappedPreviousActiveKey, activeKey, mappedPreviousSuppressedKey, suppressedKey],
        active,
        suppressedKey,
      );
    }
  }

  if (decorations === value.decorations
    && atomicRanges === value.atomicRanges
    && active === value.active
    && suppressedKey === value.suppressedKey) return value;
  return { decorations, atomicRanges, active, suppressedKey };
}

const mathBlockField = StateField.define<BlockMathFieldValue>({
  create(state) {
    return {
      decorations: buildBlockMathDecos(state),
      atomicRanges: buildBlockMathAtomicRanges(state),
      active: null,
      suppressedKey: "",
    };
  },
  update(value, tr) {
    const previousActive = value.active;
    const previousActiveKey = previousActive ? blockMathKey(previousActive) : "";
    let active = previousActive;
    let suppressedKey = value.suppressedKey;
    let finishedByEffect = false;
    let fallbackByEffect = false;
    let startedByEffect = false;

    for (const effect of tr.effects) {
      if (effect.is(startBlockMathSessionEffect) && !tr.state.readOnly) {
        const range = getBlockMathRanges(tr.state).find((candidate) =>
          candidate.from === effect.value.from && candidate.to === effect.value.to);
        if (range) {
          active = createBlockMathSession(tr.state, range);
          active.entry = effect.value.entry;
          suppressedKey = "";
          startedByEffect = true;
        }
      } else if (effect.is(finishBlockMathSessionEffect) && active?.id === effect.value) {
        active = null;
        finishedByEffect = true;
      } else if (effect.is(fallbackBlockMathSessionEffect) && active?.id === effect.value) {
        suppressedKey = blockMathKey(active);
        active = null;
        fallbackByEffect = true;
      } else if (effect.is(revealBlockMathSourceEffect)
        && (!active || effect.value.id === 0 || active.id === effect.value.id)) {
        suppressedKey = blockMathKey(effect.value);
        active = null;
        fallbackByEffect = true;
      }
    }

    if (tr.docChanged && active) {
      let touched = false;
      tr.changes.iterChangedRanges((fromA, toA) => {
        if ((fromA < active!.to && toA > active!.from)
          || (fromA === toA && fromA > active!.from && fromA < active!.to)) touched = true;
      });
      if (touched) {
        active = null;
      } else {
        active.from = tr.changes.mapPos(active.from, -1);
        active.to = tr.changes.mapPos(active.to, 1);
        active.contentFrom = tr.changes.mapPos(active.contentFrom, -1);
        active.contentTo = tr.changes.mapPos(active.contentTo, 1);
        if (active.host) setSourceRange(active.host, active.from, active.to);
      }
    }
    if (tr.docChanged && suppressedKey) {
      const suppressed = rangeFromKey(suppressedKey);
      if (suppressed) {
        suppressedKey = `${tr.changes.mapPos(suppressed.from, -1)}:${tr.changes.mapPos(suppressed.to, 1)}`;
      }
    }

    const selected = blockMathAtSelection(tr.state);
    const selectedKey = selected ? blockMathKey(selected) : "";
    if (suppressedKey && selectedKey !== suppressedKey) {
      const suppressedRange = getBlockMathRanges(tr.state)
        .find((range) => blockMathKey(range) === suppressedKey);
      if (!suppressedRange || !rangeContainsWholeSelection(tr.state, suppressedRange)) {
        suppressedKey = "";
      }
    }
    if (active && !startedByEffect && tr.selection != null) {
      const selection = tr.state.selection.main;
      if (!selection.empty || selection.head !== active.from) active = null;
    }

    const sessionTransition = active !== previousActive
      || suppressedKey !== value.suppressedKey
      || finishedByEffect
      || fallbackByEffect;
    if (tr.docChanged && previousActive && !active && !fallbackByEffect) {
      const ranges = getBlockMathRanges(tr.startState);
      const nextRanges = getBlockMathRanges(tr.state);
      const patchable = canPatchBlockMathDecorations(ranges, nextRanges, tr.changes);
      const decorations = patchable
        ? patchBlockMathDecosNearChanges(
          tr.state,
          value.decorations.map(tr.changes),
          ranges,
          nextRanges,
          tr.changes,
        )
        : buildBlockMathDecos(tr.state, active, suppressedKey);
      return finishBlockMathFieldUpdate(
        value,
        tr,
        decorations,
        active,
        suppressedKey,
        patchable,
        previousActiveKey,
      );
    }
    if (tr.docChanged && suppressedKey && !active) {
      const ranges = getBlockMathRanges(tr.startState);
      const nextRanges = getBlockMathRanges(tr.state);
      // Source editing changes the suppressed range's numeric key on every
      // keystroke. That is not a real session transition and must never rebuild
      // every display-math widget in the document. Map all unaffected widgets
      // and recreate only the formula window touched by this transaction.
      const mappable = canMapBlockMathDecorations(ranges, nextRanges, tr.changes);
      const patchable = !mappable
        && canPatchBlockMathDecorations(ranges, nextRanges, tr.changes);
      const decorations = mappable
        ? value.decorations.map(tr.changes)
        : patchable
          ? patchBlockMathDecosNearChanges(
            tr.state,
            value.decorations.map(tr.changes),
            ranges,
            nextRanges,
            tr.changes,
            active,
            suppressedKey,
          )
          : buildBlockMathDecos(tr.state, active, suppressedKey);
      return finishBlockMathFieldUpdate(
        value,
        tr,
        decorations,
        active,
        suppressedKey,
        mappable || patchable,
        previousActiveKey,
      );
    }
    // A session start/finish genuinely swaps a widget for an editor, so a full
    // rebuild is proportionate there. `value.suppressedKey` used to be part of
    // this condition, which meant that while any formula was revealed as source
    // *every* caret movement rebuilt the decorations for every display formula
    // in the note — the dominant source of typing lag in long documents.
    if (active !== previousActive || finishedByEffect || fallbackByEffect || active !== null) {
      return finishBlockMathFieldUpdate(
        value,
        tr,
        buildBlockMathDecos(tr.state, active, suppressedKey),
        active,
        suppressedKey,
        false,
        previousActiveKey,
      );
    }

    let decorations = value.decorations;
    let topologyStable = !tr.docChanged;
    if (tr.docChanged) {
      const ranges = getBlockMathRanges(tr.startState);
      const nextRanges = getBlockMathRanges(tr.state);
      if (canMapBlockMathDecorations(ranges, nextRanges, tr.changes)) {
        decorations = decorations.map(tr.changes);
        topologyStable = true;
      } else if (canPatchBlockMathDecorations(ranges, nextRanges, tr.changes)) {
        decorations = patchBlockMathDecosNearChanges(
          tr.state,
          decorations.map(tr.changes),
          ranges,
          nextRanges,
          tr.changes,
          active,
          suppressedKey,
        );
        topologyStable = true;
      } else {
        decorations = buildBlockMathDecos(tr.state, active, suppressedKey);
      }
    } else if (tr.selection != null || sessionTransition) {
      // Only the formulas whose rendering actually changed: the one the caret
      // left, the one it entered, and either side of a suppression change. When
      // none of those keys moved there is nothing to repaint — a caret moving
      // within one formula, or anywhere outside every formula, must not cost a
      // filter-and-rebuild pass.
      const oldKey = activeBlockMathKey(tr.startState);
      const newKey = activeBlockMathKey(tr.state);
      if (oldKey !== newKey || value.suppressedKey !== suppressedKey) {
        decorations = patchBlockMathDecosForSelectionChange(
          tr.state,
          decorations,
          [oldKey, newKey, value.suppressedKey, suppressedKey],
          active,
          suppressedKey,
        );
      }
    }
    return finishBlockMathFieldUpdate(
      value,
      tr,
      decorations,
      active,
      suppressedKey,
      topologyStable,
      previousActiveKey,
    );
  },
  provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
});

const mathBlockAtomicExtension = EditorView.atomicRanges.of((view) => {
  const value = view.state.field(mathBlockField, false);
  return value?.atomicRanges ?? Decoration.none;
});

function canMapBlockMathDecorations(
  ranges: readonly { from: number; to: number }[],
  nextRanges: readonly { from: number; to: number }[],
  changes: ChangeSet,
): boolean {
  if (ranges.length !== nextRanges.length) return false;
  let touchesMath = false;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (blockMathRangeIndexWindow(ranges, fromA, toA)
      || blockMathRangeIndexWindow(nextRanges, fromB, toB)) touchesMath = true;
  });
  return !touchesMath;
}

function blockMathRangeIndexWindow(
  ranges: readonly { from: number; to: number }[],
  from: number,
  to: number,
): { from: number; to: number } | null {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ranges[mid]!.to < from) low = mid + 1;
    else high = mid;
  }
  const start = low;
  while (low < ranges.length && ranges[low]!.from <= to) low++;
  return low > start ? { from: start, to: low } : null;
}

function canPatchBlockMathDecorations(
  ranges: readonly { from: number; to: number }[],
  nextRanges: readonly { from: number; to: number }[],
  changes: ChangeSet,
): boolean {
  if (ranges.length !== nextRanges.length) return false;
  let first = ranges.length;
  let last = -1;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const before = blockMathRangeIndexWindow(ranges, fromA, toA);
    const after = blockMathRangeIndexWindow(nextRanges, fromB, toB);
    if (before) {
      first = Math.min(first, before.from);
      last = Math.max(last, before.to - 1);
    }
    if (after) {
      first = Math.min(first, after.from);
      last = Math.max(last, after.to - 1);
    }
  });
  if (last < first) return false;

  // A changed fence can shift array identity past the directly touched range.
  // Checking one sentinel on either side detects that without comparing every
  // formula in a long document.
  first = Math.max(0, first - 1);
  last = Math.min(ranges.length - 1, last + 1);
  for (let index = first; index <= last; index++) {
    const range = ranges[index]!;
    const next = nextRanges[index]!;
    if (changes.mapPos(range.from, -1) !== next.from
      || changes.mapPos(range.to, 1) !== next.to) return false;
  }
  return true;
}

function patchBlockMathDecosNearChanges(
  state: EditorState,
  mapped: DecorationSet,
  oldRanges: readonly { from: number; to: number }[],
  nextRanges: readonly { from: number; to: number }[],
  changes: ChangeSet,
  active: BlockMathEditSession | null = null,
  suppressedKey = "",
): DecorationSet {
  const windows: Array<{ from: number; to: number }> = [];
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const before = blockMathRangeIndexWindow(oldRanges, fromA, toA);
    const after = blockMathRangeIndexWindow(nextRanges, fromB, toB);
    let from = Number.POSITIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    if (before) {
      for (let index = before.from; index < before.to; index++) {
        const range = oldRanges[index]!;
        from = Math.min(from, changes.mapPos(range.from, -1));
        to = Math.max(to, changes.mapPos(range.to, 1));
      }
    }
    if (after) {
      for (let index = after.from; index < after.to; index++) {
        const range = nextRanges[index]!;
        from = Math.min(from, range.from);
        to = Math.max(to, range.to);
      }
    }
    if (Number.isFinite(from) && Number.isFinite(to)) {
      windows.push(blockMathWindow(state, from, to));
    }
  });
  if (windows.length === 0) return mapped;

  let next = mapped;
  for (const window of mergeWindows(windows)) {
    next = next
      .update({ filterFrom: window.from, filterTo: window.to, filter: () => false })
      .update({
        add: buildBlockMathDecoRanges(
          state,
          window.from,
          window.to,
          active,
          suppressedKey,
        ),
        sort: true,
      });
  }
  return next;
}

function dispatchMathEditState(view: EditorView, active: boolean, kind: "inline" | "display"): void {
  view.dom.dispatchEvent(new CustomEvent("aaronnote:inline-math-edit-state", {
    bubbles: true,
    detail: { active, kind },
  }));
}

function formattedBlockMathDraft(state: EditorState, range: BlockMathRange, draft: string): string {
  const rawContent = state.doc.sliceString(range.contentFrom, range.contentTo);
  const contentIndent = rawContent.match(/^[ \t]*/)?.[0];
  const openIndent = state.doc.lineAt(range.from).text.match(/^[ \t]*/)?.[0] ?? "";
  const indent = contentIndent && contentIndent.length > 0 ? contentIndent : openIndent;
  const body = normalizeVisualTexLatex(draft).trim().split("\n").map((line) => `${indent}${line.trim()}`).join("\n");
  return `${body}\n`;
}

function formattedBlockMathSourceOffset(
  state: EditorState,
  range: BlockMathRange,
  draft: string,
  sourceOffset: number,
): number {
  const normalized = normalizeVisualTexLatex(draft).trim();
  const clamped = Math.max(0, Math.min(normalized.length, sourceOffset));
  const rawContent = state.doc.sliceString(range.contentFrom, range.contentTo);
  const contentIndent = rawContent.match(/^[ \t]*/)?.[0];
  const openIndent = state.doc.lineAt(range.from).text.match(/^[ \t]*/)?.[0] ?? "";
  const indent = contentIndent && contentIndent.length > 0 ? contentIndent : openIndent;
  const before = normalized.slice(0, clamped).split("\n");
  return indent.length + before.map((line) => line.trim()).join(`\n${indent}`).length;
}

function commitBlockMathSession(
  view: EditorView,
  session: BlockMathEditSession,
  direction?: VisualTexInlineMoveDirection,
  focusOnExit = direction != null,
): boolean {
  const range = getBlockMathRanges(view.state)
    .find((candidate) => candidate.from === session.from && candidate.to === session.to);
  if (!range) {
    fallbackBlockMathSession(view, session, new Error("Formula source changed while the visual editor was active"));
    return false;
  }

  const empty = session.draft.trim().length === 0;
  const insert = empty ? "" : formattedBlockMathDraft(view.state, range, session.draft);
  const originalContent = view.state.doc.sliceString(range.contentFrom, range.contentTo);
  const changed = empty || insert !== originalContent;
  const nextTo = empty
    ? range.from
    : range.to + insert.length - originalContent.length;
  const forwardAnchor = nextTo + (
    !empty && view.state.doc.sliceString(range.to, Math.min(view.state.doc.length, range.to + 1)) === "\n"
      ? 1
      : 0
  );
  const anchor = direction == null
    ? null
    : empty
      ? range.from
      : direction === "backward" || direction === "upward"
        ? range.from
        : forwardAnchor;

  session.editor?.destroy();
  session.editor = null;
  view.dispatch({
    ...(changed ? {
      changes: empty
        ? { from: range.from, to: range.to, insert: "" }
        : { from: range.contentFrom, to: range.contentTo, insert },
    } : {}),
    ...(anchor == null ? {} : { selection: { anchor } }),
    effects: finishBlockMathSessionEffect.of(session.id),
  });
  if (focusOnExit) window.setTimeout(() => {
    if (view.dom.isConnected) view.focus();
  }, 0);
  return true;
}

function fallbackBlockMathSession(
  view: EditorView,
  session: BlockMathEditSession,
  error: unknown,
): void {
  const active = view.state.field(mathBlockField, false)?.active;
  if (active?.id !== session.id) return;
  session.editor?.destroy();
  session.editor = null;
  view.dispatch({
    selection: { anchor: Math.min(session.contentTo, session.contentFrom) },
    effects: fallbackBlockMathSessionEffect.of(session.id),
  });
  view.dom.dispatchEvent(new CustomEvent("aaronnote:inline-math-edit-error", {
    bubbles: true,
    detail: {
      message: error instanceof Error ? error.message : "Visual formula editor unavailable",
      kind: "display",
    },
  }));
}

function revealBlockMathSessionSource(
  view: EditorView,
  session: BlockMathEditSession,
): boolean {
  const range = getBlockMathRanges(view.state)
    .find((candidate) => candidate.from === session.from && candidate.to === session.to);
  if (!range) return false;
  snapshotBlockMathDraft(session);
  if (!session.draft.trim()) return commitBlockMathSession(view, session, "forward");

  const sourceOffset = session.editor?.sourceOffset() ?? 0;
  const insert = formattedBlockMathDraft(view.state, range, session.draft);
  const originalContent = view.state.doc.sliceString(range.contentFrom, range.contentTo);
  const changed = insert !== originalContent;
  const contentOffset = formattedBlockMathSourceOffset(
    view.state,
    range,
    session.draft,
    sourceOffset,
  );
  session.editor?.destroy();
  session.editor = null;
  view.dispatch({
    ...(changed ? {
      changes: { from: range.contentFrom, to: range.contentTo, insert },
    } : {}),
    selection: {
      anchor: Math.min(range.contentFrom + Math.max(0, insert.length - 1), range.contentFrom + contentOffset),
    },
    effects: revealBlockMathSourceEffect.of({ id: session.id, from: range.from, to: range.to }),
  });
  window.setTimeout(() => {
    if (view.dom.isConnected) view.focus();
  }, 0);
  return true;
}

class MathBlockPlugin {
  private active: BlockMathEditSession | null;
  private pendingActivation = false;

  constructor(view: EditorView) {
    this.active = view.state.field(mathBlockField).active;
    if (this.active) dispatchMathEditState(view, true, "display");
    else this.scheduleSelectionActivation(view);
  }

  update(update: ViewUpdate): void {
    const next = update.state.field(mathBlockField).active;
    if (next === this.active) {
      if (!next && update.selectionSet) this.scheduleSelectionActivation(update.view);
      return;
    }
    const previous = this.active;
    const finished = update.transactions.some((transaction) => transaction.effects.some((effect) => (
      (effect.is(revealBlockMathSourceEffect) && effect.value.id === previous?.id)
      || ((effect.is(finishBlockMathSessionEffect) || effect.is(fallbackBlockMathSessionEffect))
        && effect.value === previous?.id)
    )));
    this.active = next;
    if (previous && !next) {
      dispatchMathEditState(update.view, false, "display");
      if (!finished) queueMicrotask(() => commitBlockMathSession(update.view, previous));
    }
    if (next && next !== previous) dispatchMathEditState(update.view, true, "display");
    if (!next) this.scheduleSelectionActivation(update.view);
  }

  /**
   * Entering a display formula reveals its TeX source, exactly like clicking it
   * and exactly like inline math. It used to mount a full MathLive editor here
   * instead, so arrow-key entry and click entry ran two different lifecycles
   * against the same formula.
   */
  private scheduleSelectionActivation(view: EditorView): void {
    if (this.pendingActivation || view.state.readOnly) return;
    const field = view.state.field(mathBlockField, false);
    const range = blockMathAtSelection(view.state);
    if (!range || field?.suppressedKey === blockMathKey(range)) return;
    this.pendingActivation = true;
    queueMicrotask(() => {
      this.pendingActivation = false;
      if (!view.dom.isConnected || view.state.field(mathBlockField, false)?.active) return;
      const current = blockMathAtSelection(view.state);
      if (!current) return;
      if (view.state.field(mathBlockField, false)?.suppressedKey === blockMathKey(current)) return;
      const cursor = view.state.selection.main.head;
      this.revealRangeSource(
        view,
        current,
        Math.max(0, Math.min(current.contentTo, cursor) - current.contentFrom),
      );
    });
  }

  commit(view: EditorView, direction?: VisualTexInlineMoveDirection): boolean {
    const active = view.state.field(mathBlockField, false)?.active;
    return active ? commitBlockMathSession(view, active, direction) : false;
  }

  finish(view: EditorView): boolean {
    const active = view.state.field(mathBlockField, false)?.active;
    if (!active) return false;
    snapshotBlockMathDraft(active);
    return commitBlockMathSession(view, active, "forward", false);
  }

  revealSource(view: EditorView): boolean {
    const active = view.state.field(mathBlockField, false)?.active;
    return active ? revealBlockMathSessionSource(view, active) : false;
  }

  activateRevealedSource(view: EditorView): boolean {
    const field = view.state.field(mathBlockField, false);
    const range = blockMathAtSelection(view.state);
    if (!range || field?.suppressedKey !== blockMathKey(range)) return false;
    const offset = Math.max(0, Math.min(range.tex.length, view.state.selection.main.head - range.contentFrom));
    return activateBlockMath(view, range.from, range.to, { kind: "source", offset });
  }

  revealSelectedSource(view: EditorView): boolean {
    const range = blockMathAtSelection(view.state);
    if (!range) return false;
    view.dispatch({
      selection: view.state.selection,
      effects: revealBlockMathSourceEffect.of({ id: 0, from: range.from, to: range.to }),
    });
    return true;
  }

  revealRangeSource(view: EditorView, range: BlockMathRange, sourceOffset: number): boolean {
    view.dispatch({
      selection: {
        anchor: Math.min(range.contentTo, range.contentFrom + Math.max(0, sourceOffset)),
      },
      effects: revealBlockMathSourceEffect.of({ id: 0, from: range.from, to: range.to }),
    });
    return true;
  }

  destroy(): void {
    this.active?.editor?.destroy();
    this.active = null;
  }
}

const mathBlockSessionExtension = ViewPlugin.fromClass(MathBlockPlugin);

export function activateBlockMath(
  view: EditorView,
  from: number,
  to: number,
  entry: VisualTexInlineEntry = { kind: "start" },
): boolean {
  if (view.state.readOnly) return false;
  const range = getBlockMathRanges(view.state)
    .find((candidate) => candidate.from === from && candidate.to === to);
  if (!range) return false;
  const sourceOffset = entry.kind === "end"
    ? range.contentTo - range.contentFrom
    : entry.kind === "source"
      ? entry.offset
      : 0;
  return view.plugin(mathBlockSessionExtension)?.revealRangeSource(view, range, sourceOffset) ?? false;
}

// ---------------------------------------------------------------------------
// Inline math — ViewPlugin (viewport-optimized, no block decorations)
// ---------------------------------------------------------------------------

type InlineMathRange = { from: number; to: number; tex: string };

function inlineMathRangesOnSelectionLines(state: EditorState): InlineMathRange[] {
  const selection = state.selection.main;
  const firstLine = state.doc.lineAt(selection.from).number;
  const lastLine = state.doc.lineAt(Math.min(selection.to, state.doc.length)).number;
  if (lastLine - firstLine > 50) return [];
  const from = state.doc.line(firstLine).from;
  const to = state.doc.line(lastLine).to;
  const blockRanges = getBlockMathRanges(state);
  const codeRanges = scanCodeRanges(state, [{ from, to }]);
  const ranges: InlineMathRange[] = [];

  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    const line = state.doc.line(lineNum);
    for (const range of scanInlineMathRanges(line.text, line.from)) {
      if (rangeOverlapsAny(range.from, range.to, blockRanges)) continue;
      if (rangeOverlapsAny(range.from, range.to, codeRanges)) continue;
      ranges.push(range);
    }
  }
  return ranges;
}

function rangeContainsSelection(state: EditorState, range: { from: number; to: number }): boolean {
  const selection = state.selection.main;
  if (selection.empty) return selection.from > range.from && selection.from < range.to;
  return selection.from < range.to && selection.to > range.from;
}

function rangeContainsWholeSelection(state: EditorState, range: { from: number; to: number }): boolean {
  if (state.selection.ranges.length !== 1) return false;
  const selection = state.selection.main;
  return selection.from > range.from && selection.to < range.to;
}

function inlineMathAtSelection(state: EditorState): InlineMathRange | null {
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return null;
  return inlineMathRangesOnSelectionLines(state)
    .find((range) => rangeContainsSelection(state, range)) ?? null;
}

function buildInlineMathDecos(
  view: EditorView,
  active: InlineMathEditSession | null,
  suppressedKey = "",
): { decorations: DecorationSet; atomicRanges: DecorationSet } {
  const decos: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const blockRanges = getBlockMathRanges(view.state);
  // Don't render inline math inside fenced/inline code — Markdown stays literal there.
  const codeRanges = scanCodeRanges(view.state, view.visibleRanges);

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    const text = doc.sliceString(vFrom, vTo);

    for (const { from, to, tex } of scanInlineMathRanges(text, vFrom)) {
      if (rangeOverlapsAny(from, to, blockRanges)) continue;
      if (rangeOverlapsAny(from, to, codeRanges)) continue;

      const selected = rangeContainsSelection(view.state, { from, to });
      const key = `${from}:${to}`;
      if (selected && suppressedKey === key) {
        decos.push(Decoration.mark({ class: "cm-math-inline-source" }).range(from, to));
        addTexHighlightDecos(decos, view.state, from + 2, to - 2);
        continue;
      }
      const editing = active?.from === from
        && active.to === to
        && selected;
      const widget = editing
        ? new InlineMathEditorWidget(active)
        : new InlineMathWidget(tex, from, to);
      decos.push(Decoration.replace({ widget }).range(from, to));
      if (!editing) atomicRanges.push(Decoration.mark({}).range(from, to));
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return {
    decorations: Decoration.set(decos, true),
    atomicRanges: Decoration.set(atomicRanges, true),
  };
}

class MathInlinePlugin {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
  private selectionKey: string;
  private active: InlineMathEditSession | null = null;
  private suppressedKey = "";
  private pendingCommit = false;
  private forceRebuild = false;

  constructor(view: EditorView) {
    const selected = inlineMathAtSelection(view.state);
    this.selectionKey = selected ? `${selected.from}:${selected.to}` : "";
    if (selected && !view.state.readOnly) this.suppressedKey = this.selectionKey;
    ({ decorations: this.decorations, atomicRanges: this.atomicRanges } = buildInlineMathDecos(
      view,
      this.active,
      this.suppressedKey,
    ));
  }

  update(update: ViewUpdate): void {
    if (update.view.compositionStarted && update.selectionSet && !update.docChanged && !update.viewportChanged) return;
    let rebuild = this.forceRebuild
      || update.docChanged
      || update.viewportChanged
      || hasViewportDecorationRefresh(update);
    this.forceRebuild = false;
    let aborted = false;

    if (update.docChanged && this.active) {
      const session = this.active;
      let touched = false;
      update.changes.iterChangedRanges((fromA, toA) => {
        if ((fromA < session.to && toA > session.from)
          || (fromA === toA && fromA > session.from && fromA < session.to)) touched = true;
      });
      if (touched) {
        this.abort(update.view, "Formula source changed while the visual editor was active", false);
        aborted = true;
      } else {
        session.from = update.changes.mapPos(session.from, -1);
        session.to = update.changes.mapPos(session.to, 1);
        if (session.host) setSourceRange(session.host, session.from, session.to);
      }
    }
    if (update.docChanged && this.suppressedKey) {
      const source = rangeFromKey(this.suppressedKey);
      if (source) {
        this.suppressedKey = `${update.changes.mapPos(source.from, -1)}:${update.changes.mapPos(source.to, 1)}`;
      }
    }

    const selected = inlineMathAtSelection(update.view.state);
    const nextSelectionKey = selected ? `${selected.from}:${selected.to}` : "";
    if (this.suppressedKey && nextSelectionKey !== this.suppressedKey) {
      const suppressedRange = inlineMathRangesOnSelectionLines(update.view.state)
        .find((range) => `${range.from}:${range.to}` === this.suppressedKey);
      if (!suppressedRange || !rangeContainsWholeSelection(update.view.state, suppressedRange)) {
        this.suppressedKey = "";
      }
    }

    if (!aborted && this.active) {
      if (!selected || selected.from !== this.active.from || selected.to !== this.active.to) {
        snapshotInlineMathDraft(this.active);
        this.scheduleCommit(update.view);
        rebuild = true;
      }
    } else if (!aborted && selected && !update.view.state.readOnly && nextSelectionKey !== this.suppressedKey) {
      this.suppressedKey = nextSelectionKey;
      rebuild = true;
    }

    if (nextSelectionKey !== this.selectionKey) rebuild = true;
    this.selectionKey = nextSelectionKey;
    if (rebuild) {
      ({ decorations: this.decorations, atomicRanges: this.atomicRanges } = buildInlineMathDecos(
        update.view,
        this.active,
        this.suppressedKey,
      ));
    }
  }

  activate(
    view: EditorView,
    range: InlineMathRange,
    entry: VisualTexInlineEntry,
  ): boolean {
    if (this.active || view.state.readOnly) return false;
    const sourceOffset = entry.kind === "end"
      ? range.tex.length
      : entry.kind === "source"
        ? entry.offset
        : 0;
    return this.revealRangeSource(view, range, sourceOffset);
  }

  private scheduleCommit(view: EditorView): void {
    if (this.pendingCommit) return;
    this.pendingCommit = true;
    queueMicrotask(() => {
      this.pendingCommit = false;
      if (this.active) this.commit(view);
    });
  }

  commit(
    view: EditorView,
    direction?: VisualTexInlineMoveDirection,
    focusOnExit = direction != null,
  ): boolean {
    const session = this.active;
    if (!session) return false;
    const raw = view.state.doc.sliceString(session.from, session.to);
    if (!raw.startsWith("\\(") || !raw.endsWith("\\)")) {
      this.abort(view, "Formula source changed while the visual editor was active", true);
      return false;
    }

    const insert = normalizeVisualTexLatex(session.draft);
    const empty = insert.trim().length === 0;
    this.active = null;
    session.editor?.destroy();
    session.editor = null;
    const bodyChanged = empty || insert !== session.original;
    const nextTo = empty ? session.from : session.from + 4 + insert.length;
    const anchor = direction == null
      ? null
      : empty
        ? session.from
        : direction === "backward" || direction === "upward"
          ? session.from
          : nextTo;
    dispatchMathEditState(view, false, "inline");
    view.dispatch({
      ...(bodyChanged ? {
        changes: empty
          ? { from: session.from, to: session.to, insert: "" }
          : { from: session.from + 2, to: session.to - 2, insert },
      } : {}),
      ...(anchor == null ? {} : { selection: { anchor } }),
    });
    if (focusOnExit) window.setTimeout(() => {
      if (view.dom.isConnected) view.focus();
    }, 0);
    return true;
  }

  finish(view: EditorView): boolean {
    if (!this.active) return false;
    snapshotInlineMathDraft(this.active);
    return this.commit(view, "forward", false);
  }

  revealSource(view: EditorView): boolean {
    const session = this.active;
    if (!session) return false;
    snapshotInlineMathDraft(session);
    if (!session.draft.trim()) return this.commit(view, "forward");
    const insert = normalizeVisualTexLatex(session.draft);
    const sourceOffset = session.editor?.sourceOffset() ?? 0;
    const bodyChanged = insert !== session.original;
    const nextTo = session.from + 4 + insert.length;
    this.active = null;
    this.suppressedKey = `${session.from}:${nextTo}`;
    this.forceRebuild = true;
    session.editor?.destroy();
    session.editor = null;
    dispatchMathEditState(view, false, "inline");
    view.dispatch({
      ...(bodyChanged ? {
        changes: { from: session.from + 2, to: session.to - 2, insert },
      } : {}),
      selection: { anchor: session.from + 2 + Math.min(insert.length, Math.max(0, sourceOffset)) },
    });
    window.setTimeout(() => {
      if (view.dom.isConnected) view.focus();
    }, 0);
    return true;
  }

  activateRevealedSource(view: EditorView): boolean {
    const range = inlineMathAtSelection(view.state);
    if (!range || this.suppressedKey !== `${range.from}:${range.to}`) return false;
    const offset = Math.max(0, Math.min(range.tex.length, view.state.selection.main.head - range.from - 2));
    this.suppressedKey = "";
    this.forceRebuild = true;
    return this.activate(view, range, { kind: "source", offset });
  }

  revealedSourceRange(): { from: number; to: number } | null {
    return rangeFromKey(this.suppressedKey);
  }

  isRevealedSource(range: { from: number; to: number }): boolean {
    return this.suppressedKey === `${range.from}:${range.to}`;
  }

  revealSelectedSource(view: EditorView): boolean {
    const range = inlineMathAtSelection(view.state);
    if (!range) return false;
    this.suppressedKey = `${range.from}:${range.to}`;
    this.forceRebuild = true;
    view.dispatch({ selection: view.state.selection });
    return true;
  }

  revealRangeSource(view: EditorView, range: InlineMathRange, sourceOffset: number): boolean {
    this.suppressedKey = `${range.from}:${range.to}`;
    this.forceRebuild = true;
    view.dispatch({
      selection: { anchor: range.from + 2 + Math.min(range.tex.length, Math.max(0, sourceOffset)) },
    });
    return true;
  }

  private abort(view: EditorView, message: string, dispatch: boolean): void {
    const session = this.active;
    if (!session) return;
    this.active = null;
    this.suppressedKey = `${session.from}:${session.to}`;
    this.forceRebuild = true;
    session.editor?.destroy();
    session.editor = null;
    dispatchMathEditState(view, false, "inline");
    view.dom.dispatchEvent(new CustomEvent("aaronnote:inline-math-edit-error", {
      bubbles: true,
      detail: { message, kind: "inline" },
    }));
    if (dispatch && view.dom.isConnected) {
      view.dispatch({ selection: { anchor: Math.min(session.to - 2, session.from + 2) } });
    }
  }

  destroy(): void {
    this.active?.editor?.destroy();
    this.active = null;
  }
}

const mathInlineExtension = ViewPlugin.fromClass(MathInlinePlugin, {
  decorations: (v) => v.decorations,
});

const mathInlineAtomicExtension = EditorView.atomicRanges.of((view) => (
  view.plugin(mathInlineExtension)?.atomicRanges ?? Decoration.none
));

function activateAdjacentInlineMath(view: EditorView, direction: "forward" | "backward"): boolean {
  if (view.state.readOnly || !view.state.selection.main.empty) return false;
  const position = view.state.selection.main.head;
  const range = inlineMathRangesOnSelectionLines(view.state).find((candidate) =>
    direction === "forward"
      ? position >= candidate.from && position < candidate.to
      : position > candidate.from && position <= candidate.to);
  if (!range) return false;
  const plugin = view.plugin(mathInlineExtension);
  if (plugin?.isRevealedSource(range)) return false;
  view.dispatch({
    selection: { anchor: direction === "forward" ? range.from + 2 : range.to - 2 },
  });
  return true;
}

export function activateInlineMathFromArrow(view: EditorView, key: "ArrowLeft" | "ArrowRight"): boolean {
  return activateAdjacentInlineMath(view, key === "ArrowRight" ? "forward" : "backward");
}

function displayMathCrossedByVerticalMove(
  view: EditorView,
  start: number,
  target: number,
  forward: boolean,
): BlockMathRange | null {
  const ranges = getBlockMathRanges(view.state);
  let low = 0;
  let high = ranges.length;
  if (forward) {
    while (low < high) {
      const middle = (low + high) >> 1;
      if (ranges[middle]!.from <= start) low = middle + 1;
      else high = middle;
    }
    const range = ranges[low];
    return range && target >= range.to && !formulaSourceRangeAtPosition(view, range.from)
      ? range
      : null;
  }
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ranges[middle]!.to < start) low = middle + 1;
    else high = middle;
  }
  const range = ranges[low - 1];
  return range && target <= range.from && !formulaSourceRangeAtPosition(view, range.from)
    ? range
    : null;
}

export type InsertDisplayLineMoveResult = false | "cursor" | "formula";

/** CM6-native vertical motion, treating only display math as an editable row. */
export function moveInsertLineWithDisplayMathEntry(
  view: EditorView,
  forward: boolean,
): InsertDisplayLineMoveResult {
  const selection = view.state.selection;
  if (view.state.readOnly || selection.ranges.length !== 1 || !selection.main.empty) return false;
  const start = selection.main.head;
  let moved = view.moveVertically(selection.main, forward);
  if (moved.head === start) moved = view.moveToLineBoundary(selection.main, forward);

  const display = displayMathCrossedByVerticalMove(view, start, moved.head, forward);
  if (display && activateBlockMath(view, display.from, display.to, { kind: forward ? "start" : "end" })) {
    return "formula";
  }

  const next = EditorSelection.create([moved]);
  if (next.eq(selection, true)) return false;
  view.dispatch(view.state.update({ selection: next, scrollIntoView: true, userEvent: "select" }));
  return "cursor";
}

export function activateInlineMath(
  view: EditorView,
  from: number,
  to: number,
  entry: VisualTexInlineEntry = { kind: "start" },
): boolean {
  const raw = view.state.doc.sliceString(from, to);
  const range = raw.startsWith("\\(") && raw.endsWith("\\)")
    ? { from, to, tex: raw.slice(2, -2) }
    : null;
  const plugin = view.plugin(mathInlineExtension);
  return Boolean(range && plugin?.activate(view, range, entry));
}

export function finishInlineMathEditing(view: EditorView): boolean {
  return view.plugin(mathBlockSessionExtension)?.finish(view)
    || view.plugin(mathInlineExtension)?.finish(view)
    || false;
}

/** The locally revealed TeX source range, if POSITION belongs to it. */
export function formulaSourceRangeAtPosition(
  view: EditorView,
  position: number,
): { from: number; to: number } | null {
  const block = rangeFromKey(view.state.field(mathBlockField, false)?.suppressedKey || "");
  if (block && position >= block.from && position <= block.to) return block;
  const inline = view.plugin(mathInlineExtension)?.revealedSourceRange() ?? null;
  if (inline && position >= inline.from && position <= inline.to) return inline;
  return null;
}

/** Reveal only the formula at the caret as TeX source. */
export function toggleFormulaSourceAtSelection(view: EditorView): boolean {
  const block = view.plugin(mathBlockSessionExtension);
  const inline = view.plugin(mathInlineExtension);
  if (block?.revealSource(view) || inline?.revealSource(view)) return true;
  return Boolean(block?.revealSelectedSource(view) || inline?.revealSelectedSource(view));
}

/** Reveal a known formula as source without first activating its CM6 editor. */
export type FormulaWidgetRange = {
  display: boolean;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
};

/**
 * Resolve the formula a math widget currently stands for from its live document
 * position.
 *
 * Widgets cache `data-cm-source-from/to` at `toDOM()` time, but the decoration
 * set is deliberately *mapped* rather than rebuilt when an edit does not touch
 * math — so those attributes go stale after any edit earlier in the note, and
 * looking a formula up by them silently found nothing, making clicks on it do
 * nothing at all.
 */
export function formulaRangeAtWidgetPosition(
  state: EditorState,
  position: number,
): FormulaWidgetRange | null {
  const block = blockMathRangeSpanning(state, position);
  if (block) {
    return {
      display: true,
      from: block.from,
      to: block.to,
      contentFrom: block.contentFrom,
      contentTo: block.contentTo,
    };
  }
  const line = state.doc.lineAt(Math.max(0, Math.min(position, state.doc.length)));
  const inline = scanInlineMathRanges(line.text, line.from)
    .find((range) => position >= range.from && position <= range.to);
  if (!inline) return null;
  return {
    display: false,
    from: inline.from,
    to: inline.to,
    contentFrom: inline.from + 2,
    contentTo: inline.to - 2,
  };
}

export function revealFormulaSource(
  view: EditorView,
  from: number,
  to: number,
  sourceOffset = 0,
): boolean {
  const blockRange = getBlockMathRanges(view.state)
    .find((range) => range.from === from && range.to === to);
  if (blockRange) {
    return view.plugin(mathBlockSessionExtension)?.revealRangeSource(view, blockRange, sourceOffset) ?? false;
  }
  const raw = view.state.doc.sliceString(from, to);
  if (!raw.startsWith("\\(") || !raw.endsWith("\\)")) return false;
  return view.plugin(mathInlineExtension)?.revealRangeSource(
    view,
    { from, to, tex: raw.slice(2, -2) },
    sourceOffset,
  ) ?? false;
}

// ---------------------------------------------------------------------------
// Public export — both parts together
// ---------------------------------------------------------------------------

export const mathExtension = [
  mathBlockField,
  mathBlockAtomicExtension,
  mathBlockSessionExtension,
  mathInlineExtension,
  mathInlineAtomicExtension,
];
