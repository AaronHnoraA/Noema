/**
 * Phase 3 — Math widgets for the CM6 kernel.
 *
 * CM6 constraint: block decorations (block:true) may NOT come from ViewPlugin —
 * they must be provided by a StateField via EditorView.decorations facet.
 *
 * Split strategy:
 *   mathBlockField   — StateField, processes full doc for \[…\]
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
import { StateEffect, StateField, type ChangeSet, type EditorState } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { scanInlineMathRanges } from "../../../../inline-math.ts";
import { renderMathHTML } from "../../../../math-render.ts";
import {
  getBlockMathRanges,
  rangeOverlapsAny,
  type BlockMathRange,
} from "../../../math-ranges.ts";
import { scanCodeRanges } from "../../../code-ranges.ts";
import { orgEnvContextForRange, type OrgEnvContext } from "./block-extras.ts";
import { hasViewportDecorationRefresh } from "../../../viewport-refresh.ts";
import { getKatexMacros } from "../../../../katex-macros.ts";
import {
  mountVisualTexDisplayEditor,
  mountVisualTexInlineEditor,
  normalizeVisualTexLatex,
  preloadVisualTexInlineEditor,
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

type InlineMathMetrics = { width: number; height: number };

type InlineMathEditSession = {
  id: number;
  from: number;
  to: number;
  original: string;
  draft: string;
  externalDraft: boolean;
  entry: VisualTexInlineEntry;
  metrics: InlineMathMetrics | null;
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
    div.addEventListener("aaronnote:display-math-commit", () => {
      commitBlockMathSession(view, this.session, "forward");
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
    return this.tex === other.tex
      && this.from === other.from
      && this.to === other.to
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
// Block math — StateField (full-doc scan, allows block:true decorations)
// ---------------------------------------------------------------------------

type BlockMathFieldValue = {
  decorations: DecorationSet;
  active: BlockMathEditSession | null;
  suppressedKey: string;
};

const finishBlockMathSessionEffect = StateEffect.define<number>();
const fallbackBlockMathSessionEffect = StateEffect.define<number>();
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
  return getBlockMathRanges(state).find((range) => rangeContainsSelection(state, range)) ?? null;
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

function buildBlockMathDecoRanges(
  state: EditorState,
  from = 0,
  to = state.doc.length,
  active: BlockMathEditSession | null = null,
  suppressedKey = "",
): Range<Decoration>[] {
  const decos: Range<Decoration>[] = [];

  for (const range of getBlockMathRanges(state)) {
    if (range.to < from || range.from > to) continue;
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

function buildBlockMathDecos(
  state: EditorState,
  active: BlockMathEditSession | null = null,
  suppressedKey = "",
): DecorationSet {
  return Decoration.set(buildBlockMathDecoRanges(state, 0, state.doc.length, active, suppressedKey), true);
}

function activeBlockMathKey(state: EditorState): string {
  for (const range of getBlockMathRanges(state)) {
    if (selectionTouchesRange(state, range.from, range.to)) return `${range.from}:${range.to}`;
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
  oldKey: string,
  newKey: string,
): DecorationSet {
  const windows = mergeWindows([oldKey, newKey]
    .map(rangeFromKey)
    .filter((range): range is { from: number; to: number } => Boolean(range))
    .map((range) => blockMathWindow(state, range.from, range.to)));
  if (windows.length === 0) return current;

  let next = current;
  const add: Range<Decoration>[] = [];
  for (const range of windows) {
    next = next.update({ filterFrom: range.from, filterTo: range.to, filter: () => false });
    add.push(...buildBlockMathDecoRanges(state, range.from, range.to));
  }
  return next.update({ add, sort: true });
}

const mathBlockField = StateField.define<BlockMathFieldValue>({
  create(state) {
    return { decorations: buildBlockMathDecos(state), active: null, suppressedKey: "" };
  },
  update(value, tr) {
    const previousActive = value.active;
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
    if (suppressedKey && selectedKey !== suppressedKey) suppressedKey = "";
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
      const decorations = canPatchBlockMathDecorations(tr.startState, ranges, tr.changes)
        ? patchBlockMathDecosNearChanges(
          tr.state,
          value.decorations.map(tr.changes),
          ranges,
          tr.changes,
        )
        : buildBlockMathDecos(tr.state, active, suppressedKey);
      return { decorations, active, suppressedKey };
    }
    if (sessionTransition || value.suppressedKey || active) {
      return {
        decorations: buildBlockMathDecos(tr.state, active, suppressedKey),
        active,
        suppressedKey,
      };
    }

    let decorations = value.decorations;
    if (tr.docChanged) {
      const ranges = getBlockMathRanges(tr.startState);
      if (canMapBlockMathDecorations(tr.startState, ranges, tr.changes)) {
        decorations = decorations.map(tr.changes);
      } else if (canPatchBlockMathDecorations(tr.startState, ranges, tr.changes)) {
        decorations = patchBlockMathDecosNearChanges(
          tr.state,
          decorations.map(tr.changes),
          ranges,
          tr.changes,
        );
      } else {
        decorations = buildBlockMathDecos(tr.state);
      }
    } else if (tr.selection != null) {
      const oldKey = activeBlockMathKey(tr.startState);
      const newKey = activeBlockMathKey(tr.state);
      if (oldKey !== newKey) {
        decorations = patchBlockMathDecosForSelectionChange(tr.state, decorations, oldKey, newKey);
      }
    }
    return { decorations, active, suppressedKey };
  },
  provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
});

const mathBlockAtomicExtension = EditorView.atomicRanges.of((view) => {
  const value = view.state.field(mathBlockField, false);
  if (!value) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const range of getBlockMathRanges(view.state)) {
    const key = blockMathKey(range);
    if (value.active?.from === range.from && value.active.to === range.to) continue;
    if (value.suppressedKey === key) continue;
    ranges.push(Decoration.mark({}).range(range.from, range.to));
  }
  return Decoration.set(ranges, true);
});

function canMapBlockMathDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  changes: ChangeSet,
): boolean {
  let canMap = true;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!canMap) return;
    const removed = state.doc.sliceString(fromA, toA);
    const added = inserted.toString();
    if (
      removed.includes("\\[") || added.includes("\\[") ||
      removed.includes("\\]") || added.includes("\\]")
    ) {
      canMap = false;
      return;
    }
    if (ranges.some((range) => fromA <= range.to && toA >= range.from)) {
      canMap = false;
    }
  });
  return canMap;
}

function canPatchBlockMathDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  changes: ChangeSet,
): boolean {
  let canPatch = true;
  let touchedBlock = false;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!canPatch) return;
    const removed = state.doc.sliceString(fromA, toA);
    const added = inserted.toString();
    if (
      removed.includes("\\[") || added.includes("\\[") ||
      removed.includes("\\]") || added.includes("\\]")
    ) {
      canPatch = false;
      return;
    }
    if (ranges.some((range) => fromA <= range.to && toA >= range.from)) touchedBlock = true;
  });
  return canPatch && touchedBlock;
}

function patchBlockMathDecosNearChanges(
  state: EditorState,
  mapped: DecorationSet,
  oldRanges: readonly { from: number; to: number }[],
  changes: ChangeSet,
): DecorationSet {
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  changes.iterChanges((fromA, toA) => {
    for (const range of oldRanges) {
      if (fromA > range.to || toA < range.from) continue;
      from = Math.min(from, changes.mapPos(range.from, -1));
      to = Math.max(to, changes.mapPos(range.to, 1));
    }
  });
  if (!Number.isFinite(from)) return mapped;
  for (const range of getBlockMathRanges(state)) {
    if (range.from > to || range.to < from) continue;
    from = Math.min(from, range.from);
    to = Math.max(to, range.to);
  }
  return mapped
    .update({ filterFrom: from, filterTo: to, filter: () => false })
    .update({ add: buildBlockMathDecoRanges(state, from, to), sort: true });
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
      : direction === "backward"
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

class MathBlockPlugin {
  private active: BlockMathEditSession | null;
  private pendingActivation = false;

  constructor(view: EditorView) {
    preloadVisualTexInlineEditor();
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
    const finished = update.transactions.some((transaction) => transaction.effects.some((effect) =>
      (effect.is(finishBlockMathSessionEffect) || effect.is(fallbackBlockMathSessionEffect))
      && effect.value === previous?.id));
    this.active = next;
    if (previous && !next) {
      dispatchMathEditState(update.view, false, "display");
      if (!finished) queueMicrotask(() => commitBlockMathSession(update.view, previous));
    }
    if (next && next !== previous) dispatchMathEditState(update.view, true, "display");
    if (!next) this.scheduleSelectionActivation(update.view);
  }

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
      if (current) activateBlockMath(view, current.from, current.to, blockSelectionEntry(view.state, current));
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
  view.dispatch({
    selection: { anchor: range.from },
    effects: startBlockMathSessionEffect.of({ from: range.from, to: range.to, entry }),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Inline math — ViewPlugin (viewport-optimized, no block decorations)
// ---------------------------------------------------------------------------

type InlineMathRange = { from: number; to: number; tex: string };

let nextInlineMathSessionId = 1;

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

function inlineMathAtSelection(state: EditorState): InlineMathRange | null {
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return null;
  return inlineMathRangesOnSelectionLines(state)
    .find((range) => rangeContainsSelection(state, range)) ?? null;
}

function selectionEntry(state: EditorState, range: InlineMathRange): VisualTexInlineEntry {
  const selection = state.selection.main;
  if (!selection.empty) return { kind: "all" };
  if (selection.from <= range.from + 2) return { kind: "start" };
  return { kind: "end" };
}

function staticInlineMathRect(view: EditorView, from: number, to: number): InlineMathMetrics | null {
  const widgets = view.contentDOM.querySelectorAll<HTMLElement>(".cm-math-inline[data-cm-inline-math='static']");
  for (const widget of widgets) {
    if (Number(widget.dataset.cmSourceFrom) !== from || Number(widget.dataset.cmSourceTo) !== to) continue;
    const rect = widget.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };
  }
  return null;
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
      if (selected && suppressedKey === key) continue;
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
  private pendingEntry: { key: string; entry: VisualTexInlineEntry } | null = null;

  constructor(view: EditorView) {
    preloadVisualTexInlineEditor();
    const selected = inlineMathAtSelection(view.state);
    this.selectionKey = selected ? `${selected.from}:${selected.to}` : "";
    if (selected && !view.state.readOnly) this.start(view, selected);
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

    const selected = inlineMathAtSelection(update.view.state);
    const nextSelectionKey = selected ? `${selected.from}:${selected.to}` : "";
    if (this.suppressedKey && nextSelectionKey !== this.suppressedKey) this.suppressedKey = "";

    if (!aborted && this.active) {
      if (!selected || selected.from !== this.active.from || selected.to !== this.active.to) {
        snapshotInlineMathDraft(this.active);
        this.scheduleCommit(update.view);
        rebuild = true;
      }
    } else if (!aborted && selected && !update.view.state.readOnly && nextSelectionKey !== this.suppressedKey) {
      this.start(update.view, selected);
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

  private start(view: EditorView, range: InlineMathRange): void {
    if (this.active) return;
    const raw = view.state.doc.sliceString(range.from, range.to);
    if (!raw.startsWith("\\(") || !raw.endsWith("\\)")) return;
    const key = `${range.from}:${range.to}`;
    const pendingEntry = this.pendingEntry?.key === key ? this.pendingEntry.entry : null;
    this.pendingEntry = null;
    const session: InlineMathEditSession = {
      id: nextInlineMathSessionId++,
      from: range.from,
      to: range.to,
      original: raw.slice(2, -2),
      draft: normalizeVisualTexLatex(raw.slice(2, -2)),
      externalDraft: false,
      entry: pendingEntry ?? selectionEntry(view.state, range),
      metrics: staticInlineMathRect(view, range.from, range.to),
      editor: null,
      host: null,
      onDraft: (latex) => {
        if (this.active === session) {
          session.externalDraft = false;
          session.draft = normalizeVisualTexLatex(latex);
        }
      },
      onCommit: (direction) => this.commit(view, direction),
      onUnavailable: (error) => this.abort(
        view,
        error instanceof Error ? error.message : "Visual formula editor unavailable",
        true,
      ),
    };
    this.active = session;
    dispatchMathEditState(view, true, "inline");
  }

  activate(
    view: EditorView,
    range: InlineMathRange,
    entry: VisualTexInlineEntry,
  ): boolean {
    if (this.active || view.state.readOnly) return false;
    this.pendingEntry = { key: `${range.from}:${range.to}`, entry };
    view.dispatch({ selection: { anchor: range.from + 2 } });
    return true;
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
        : direction === "backward"
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
  view.dispatch({
    selection: { anchor: direction === "forward" ? range.from + 2 : range.to - 2 },
  });
  return true;
}

export function activateInlineMathFromArrow(view: EditorView, key: "ArrowLeft" | "ArrowRight"): boolean {
  return activateAdjacentInlineMath(view, key === "ArrowRight" ? "forward" : "backward");
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
