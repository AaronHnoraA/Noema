/**
 * Phase 4 — Fenced code block widget for the CM6 kernel.
 *
 * CM6 constraint: block decorations must come from StateField, not ViewPlugin.
 *
 * Split strategy:
 *   FencedCodePlugin (ViewPlugin) — fence fold, lang badge, syntax highlight.
 *                                    Skips mermaid blocks entirely.
 *   mermaidField     (StateField) — mermaid replace/preview (block:true).
 *
 * Both exported together as `fencedCodeExtension = [mermaidField, fencedCodeViewPlugin]`.
 *
 * Lezer FencedCode child nodes:
 *   CodeInfo  — the language tag on the opening fence line
 *   CodeText  — the code body between the two fence lines
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
import { StateEffect, StateField, type ChangeSet, type EditorState, type Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { highlightCodeForEditor, onCodeHighlightReady } from "../../../../code-highlight-async.ts";
import { supportedDiagramLang } from "../../../../diagram-langs.ts";
import { getBlockMathRanges, rangeInsideAny, rangeOverlapsAny } from "../../../math-ranges.ts";
import { applyLayoutAttrs, layoutFromAttrs, readLayoutAttrsLine, type LayoutAttrs } from "../../../../layout-attrs.ts";
import { hasViewportDecorationRefresh } from "../../../viewport-refresh.ts";

function setSourceRange(el: HTMLElement, from: number, to: number, anchor?: number, openSource = false): void {
  el.dataset.cmSourceFrom = String(from);
  el.dataset.cmSourceTo = String(to);
  if (anchor != null) el.dataset.cmSourceAnchor = String(anchor);
  if (openSource) el.dataset.cmOpenSource = "true";
}

// ---------------------------------------------------------------------------
// Lang badge widget
// ---------------------------------------------------------------------------

class LangBadgeWidget extends MeasuredWidget {
  lang: string;
  from: number;
  to: number;

  constructor(lang: string, from: number, to: number) {
    super();
    this.lang = lang;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: LangBadgeWidget): boolean {
    return this.lang === other.lang && this.from === other.from && this.to === other.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-code-lang-badge cm-code-lang-editor";
    span.textContent = this.lang || "lang";
    span.title = "Click to edit code language";
    span.tabIndex = 0;
    const edit = (): void => {
      if (span.querySelector("input")) return;
      const input = document.createElement("input");
      input.className = "cm-code-lang-input";
      input.value = this.lang;
      input.maxLength = 48;
      input.spellcheck = false;
      input.setAttribute("aria-label", "Code language");
      span.textContent = "";
      span.append(input);
      const commit = (): void => {
        const next = input.value.trim().replace(/[^A-Za-z0-9_+.-]/g, "").slice(0, 48);
        if (next !== this.lang) {
          view.dispatch({ changes: { from: this.from, to: this.to, insert: next } });
          view.requestMeasure();
        } else {
          span.textContent = this.lang || "lang";
        }
      };
      input.addEventListener("mousedown", (event) => event.stopPropagation());
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("blur", commit, { once: true });
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          input.value = this.lang;
          input.blur();
        }
      });
      input.focus();
      input.select();
    };
    span.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    span.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      edit();
    });
    span.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        edit();
      }
    });
    return span;
  }

  ignoreEvent(): boolean { return true; }
}

class CodeCopyButtonWidget extends MeasuredWidget {
  source: string;

  constructor(source: string) {
    super();
    this.source = source;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: CodeCopyButtonWidget): boolean {
    return this.source === other.source;
  }

  toDOM(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-code-copy-button";
    button.textContent = "Copy";
    button.title = "Copy code";
    button.setAttribute("aria-label", "Copy code");
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copyText(this.source).then((ok) => {
        if (!button.isConnected) return;
        button.textContent = ok ? "Copied" : "Copy";
        if (ok) window.setTimeout(() => {
          if (button.isConnected) button.textContent = "Copy";
        }, 1100);
      });
    });
    return button;
  }

  ignoreEvent(): boolean { return true; }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API may be blocked; fall through to the textarea fallback below.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

type CodeFold = { key: string; from: number; to: number; lines: number };
type CodeFoldState = { folds: readonly CodeFold[]; decorations: DecorationSet };
const MAX_CODE_FOLDS = 128;

const toggleCodeFoldEffect = StateEffect.define<CodeFold>();

class CodeFoldPlaceholderWidget extends MeasuredWidget {
  readonly lines: number;
  constructor(lines: number) {
    super();
    this.lines = lines;
  }
  protected measureKey(): string { return `code-fold:${this.lines}`; }
  protected measureGroupKey(): string { return "code-fold"; }
  protected estimatedHeightFallback(): number { return 30; }
  eq(other: CodeFoldPlaceholderWidget): boolean { return this.lines === other.lines; }
  toDOM(view: EditorView): HTMLElement {
    const block = document.createElement("div");
    block.className = "cm-code-fold-placeholder";
    block.textContent = `${this.lines} ${this.lines === 1 ? "line" : "lines"} collapsed`;
    return this.registerMeasured(block, view);
  }
  ignoreEvent(): boolean { return true; }
}

function codeFoldDecorations(state: EditorState, folds: readonly CodeFold[]): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  for (const fold of folds) {
    const from = state.doc.lineAt(Math.max(0, Math.min(fold.from, state.doc.length))).from;
    const endPosition = Math.max(from, Math.min(Math.max(fold.from, fold.to - 1), state.doc.length));
    const to = state.doc.lineAt(endPosition).to;
    if (from >= to) continue;
    decorations.push(Decoration.replace({
      widget: new CodeFoldPlaceholderWidget(fold.lines),
      block: true,
    }).range(from, to));
  }
  return Decoration.set(decorations, true);
}

const codeFoldField = StateField.define<CodeFoldState>({
  create: () => ({ folds: [], decorations: Decoration.none }),
  update(value, transaction) {
    let folds: CodeFold[] = [];
    if (transaction.docChanged) {
      const tree = syntaxTree(transaction.state);
      for (const fold of value.folds.slice(0, MAX_CODE_FOLDS)) {
        const mappedFrom = transaction.changes.mapPos(fold.from, -1);
        let node = tree.resolve(Math.max(0, Math.min(mappedFrom, transaction.newDoc.length)), 1);
        while (node.parent && node.name !== "FencedCode") node = node.parent;
        if (node.name !== "FencedCode") continue;
        const textNode = node.getChild("CodeText");
        if (!textNode || textNode.from >= textNode.to) continue;
        const source = transaction.newDoc.sliceString(textNode.from, textNode.to);
        folds.push({
          key: `code:${textNode.from}`,
          from: textNode.from,
          to: textNode.to,
          lines: Math.max(1, source.split(/\r?\n/).length),
        });
      }
    } else {
      folds = Array.from(value.folds);
    }
    let changed = transaction.docChanged;
    for (const effect of transaction.effects) {
      if (!effect.is(toggleCodeFoldEffect)) continue;
      changed = true;
      const existing = folds.findIndex((fold) => fold.key === effect.value.key);
      if (existing >= 0) folds.splice(existing, 1);
      else if (folds.length < MAX_CODE_FOLDS) folds.push(effect.value);
    }
    return changed
      ? { folds, decorations: codeFoldDecorations(transaction.state, folds) }
      : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

class CodeFoldButtonWidget extends MeasuredWidget {
  readonly fold: CodeFold;
  readonly folded: boolean;
  constructor(fold: CodeFold, folded: boolean) {
    super();
    this.fold = fold;
    this.folded = folded;
  }
  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }
  eq(other: CodeFoldButtonWidget): boolean {
    return this.fold.key === other.fold.key && this.folded === other.folded;
  }
  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-code-fold-button";
    button.textContent = this.folded ? "Show" : "Fold";
    button.title = this.folded ? "Expand code block" : "Collapse code block";
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ effects: toggleCodeFoldEffect.of(this.fold) });
      view.requestMeasure();
    });
    return button;
  }
  ignoreEvent(): boolean { return true; }
}

// ---------------------------------------------------------------------------
// Mermaid widgets
// ---------------------------------------------------------------------------

class MermaidWidget extends MeasuredWidget {
  source: string;
  lang: string;
  from: number;
  to: number;
  sourceFrom: number;
  layout: LayoutAttrs;

  constructor(source: string, lang: string, from: number, to: number, sourceFrom: number, layout: LayoutAttrs) {
    super();
    this.source = source;
    this.lang = lang;
    this.from = from;
    this.to = to;
    this.sourceFrom = sourceFrom;
    this.layout = layout;
  }

  protected measureKey(): string { return "mermaid:" + shortHash(this.lang + "\n" + this.source); }

  protected measureGroupKey(): string {
    const bucket = Math.min(8, Math.ceil(this.source.split(/\n/).length / 8));
    return ["mermaid", this.lang, this.layout.align, this.layout.wrap ? "wrap" : "block", bucket].join(":");
  }

  protected estimatedHeightFallback(): number {
    if (this.layout.wrap) return 0;
    const explicitHeight = Number.parseFloat(this.layout.height);
    if (Number.isFinite(explicitHeight) && explicitHeight > 0) return explicitHeight + 24;
    return Math.max(190, Math.min(460, 120 + this.source.split(/\n/).length * 18));
  }

  eq(other: MermaidWidget): boolean {
    return this.source === other.source &&
      this.lang === other.lang &&
      this.from === other.from &&
      this.to === other.to &&
      this.sourceFrom === other.sourceFrom &&
      this.layout.align === other.layout.align &&
      this.layout.wrap === other.layout.wrap &&
      this.layout.width === other.layout.width &&
      this.layout.height === other.layout.height;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("figure");
    wrap.className = "cm-mermaid-widget";
    if (this.layout.wrap) {
      wrap.classList.add("aaronnote-diagram-wrap", `aaronnote-diagram-align-${this.layout.align}`);
    }
    setSourceRange(wrap, this.from, this.to, this.sourceFrom, true);

    const div = document.createElement("div");
    div.className = "cm-mermaid-block";
    applyLayoutAttrs(div, "diagram", this.layout);
    wrap.append(div);
    renderMermaidWidget(this.source, this.lang, div, () => view.requestMeasure());
    return this.registerMeasured(wrap, view);
  }

  ignoreEvent(): boolean { return true; }
}

class MermaidPreviewWidget extends MeasuredWidget {
  source: string;
  lang: string;
  layout: LayoutAttrs;

  constructor(source: string, lang: string, layout: LayoutAttrs) {
    super();
    this.source = source;
    this.lang = lang;
    this.layout = layout;
  }

  protected measureKey(): string { return "mermp:" + shortHash(this.lang + "\n" + this.source); }

  protected measureGroupKey(): string {
    const bucket = Math.min(8, Math.ceil(this.source.split(/\n/).length / 8));
    return ["mermp", this.lang, this.layout.align, this.layout.wrap ? "wrap" : "block", bucket].join(":");
  }

  protected estimatedHeightFallback(): number {
    if (this.layout.wrap) return 0;
    const explicitHeight = Number.parseFloat(this.layout.height);
    if (Number.isFinite(explicitHeight) && explicitHeight > 0) return explicitHeight + 24;
    return Math.max(190, Math.min(460, 120 + this.source.split(/\n/).length * 18));
  }

  eq(other: MermaidPreviewWidget): boolean {
    return this.source === other.source &&
      this.lang === other.lang &&
      this.layout.align === other.layout.align &&
      this.layout.wrap === other.layout.wrap &&
      this.layout.width === other.layout.width &&
      this.layout.height === other.layout.height;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("figure");
    wrap.className = "cm-mermaid-widget cm-mermaid-widget-preview";
    if (this.layout.wrap) {
      wrap.classList.add("aaronnote-diagram-wrap", `aaronnote-diagram-align-${this.layout.align}`);
    }

    const div = document.createElement("div");
    div.className = "cm-mermaid-block-preview";
    applyLayoutAttrs(div, "diagram", this.layout);
    wrap.append(div);
    renderMermaidWidget(this.source, this.lang, div, () => view.requestMeasure());
    return this.registerMeasured(wrap, view);
  }

  ignoreEvent(): boolean { return true; }
}

function renderMermaidWidget(source: string, lang: string, div: HTMLElement, onRender?: () => void): void {
  const key = `mermaid\n${lang}\n${source.trim()}`;
  div.dataset.diagramRenderKey = key;
  div.textContent = "Loading diagram renderer...";
  void import("../../../../diagram-render.ts")
    .then(({ renderMermaidLazy }) => {
      if (div.dataset.diagramRenderKey !== key) return;
      renderMermaidLazy(source, div, (err) => {
        div.classList.add("cm-diagram-error");
        div.textContent = err;
      }, { lang, onRender });
    })
    .catch((err: unknown) => {
      if (div.dataset.diagramRenderKey !== key) return;
      div.classList.add("cm-diagram-error");
      div.textContent = err instanceof Error ? err.message : String(err);
      onRender?.();
    });
}

// ---------------------------------------------------------------------------
// Mermaid — StateField (full-doc Lezer scan, allows block:true)
// ---------------------------------------------------------------------------

interface MermaidBlock {
  from: number;
  to: number;
  lang: string;
  sourceFrom: number;
  sourceTo: number;
  source: string;
  layout: LayoutAttrs;
}

function nextLayoutAttrsLine(doc: Text, sourceTo: number): { to: number; layout: LayoutAttrs } | null {
  const currentLine = doc.lineAt(sourceTo);
  if (currentLine.number >= doc.lines) return null;
  const nextLine = doc.line(currentLine.number + 1);
  const attrs = readLayoutAttrsLine(nextLine.text);
  if (!attrs) return null;
  return { to: nextLine.to, layout: layoutFromAttrs(attrs.attrs) };
}

function collectMermaidBlocks(state: EditorState): readonly MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  const doc = state.doc;
  const blockMathRanges = getBlockMathRanges(state);

  syntaxTree(state).iterate({
    enter(node) {
      if (rangeInsideAny(node.from, node.to, blockMathRanges)) return false;
      if (node.name !== "FencedCode") return;
      if (rangeOverlapsAny(node.from, node.to, blockMathRanges)) return false;

      const infoNode = node.node.getChild("CodeInfo");
      const textNode = node.node.getChild("CodeText");
      const lang = infoNode ? doc.sliceString(infoNode.from, infoNode.to).trim() : "";

      if (!supportedDiagramLang(lang)) return; // handled by ViewPlugin
      const trailing = nextLayoutAttrsLine(doc, node.to);

      blocks.push({
        from: node.from,
        to: trailing?.to ?? node.to,
        lang,
        sourceFrom: textNode ? textNode.from : node.to,
        sourceTo: textNode ? textNode.to : node.to,
        source: textNode ? doc.sliceString(textNode.from, textNode.to) : "",
        layout: trailing?.layout ?? layoutFromAttrs({}),
      });
      return false; // skip children
    },
  });
  return blocks;
}

const DIAGRAM_FENCE_OPENER_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})\s*(?:mermaid|mindmap|marmind|markmind)\b/i;

function changedLinesHaveDiagramFence(doc: Text, changes: ChangeSet): boolean {
  let found = false;
  changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (found) return;
    const startLine = doc.lineAt(Math.min(fromB, doc.length)).number;
    const endLine = doc.lineAt(Math.min(Math.max(fromB, toB), doc.length)).number;
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
      if (DIAGRAM_FENCE_OPENER_RE.test(doc.line(lineNumber).text)) {
        found = true;
        return;
      }
    }
  });
  return found;
}

const mermaidBlocksField = StateField.define<readonly MermaidBlock[]>({
  create: collectMermaidBlocks,
  update(blocks, tr) {
    if (tr.docChanged) {
      if (!canMapMermaidBlocks(tr.startState.doc, blocks, tr.changes)) {
        if (blocks.length === 0 && !changedLinesHaveDiagramFence(tr.state.doc, tr.changes)) return blocks;
        return collectMermaidBlocks(tr.state);
      }
      return blocks.map((block) => mapMermaidBlock(block, tr.changes, tr.state.doc));
    }
    return blocks;
  },
});

function mapMermaidBlock(block: MermaidBlock, changes: ChangeSet, doc: Text): MermaidBlock {
  const sourceFrom = changes.mapPos(block.sourceFrom, -1);
  const sourceTo = changes.mapPos(block.sourceTo, 1);
  return {
    ...block,
    from: changes.mapPos(block.from, -1),
    to: changes.mapPos(block.to, 1),
    sourceFrom,
    sourceTo,
    source: doc.sliceString(sourceFrom, sourceTo),
  };
}

function canMapMermaidBlocks(
  doc: Text,
  blocks: readonly MermaidBlock[],
  changes: ChangeSet,
): boolean {
  let canMap = true;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!canMap) return;
    const removed = doc.sliceString(fromA, toA);
    const added = inserted.toString();
    if (/[`~\n]/.test(removed) || /[`~\n]/.test(added)) {
      canMap = false;
      return;
    }
    const touched = blocks.find((block) => fromA <= block.to && toA >= block.from);
    if (touched && (fromA < touched.sourceFrom || toA > touched.sourceTo)) {
      canMap = false;
    }
  });
  return canMap;
}

function changesTouchMermaidSource(blocks: readonly MermaidBlock[], changes: ChangeSet): boolean {
  let touches = false;
  changes.iterChanges((fromA, toA) => {
    if (touches) return;
    touches = blocks.some((block) => fromA <= block.sourceTo && toA >= block.sourceFrom);
  });
  return touches;
}

function buildMermaidDecoRanges(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): Range<Decoration>[] {
  const decos: Range<Decoration>[] = [];
  const sel = state.selection.main;
  const blocks = state.field(mermaidBlocksField, false) ?? collectMermaidBlocks(state);

  for (const block of blocks) {
    if (block.to < from || block.from > to) continue;
    const cursorInBlock = sel.from < block.to && sel.to > block.from;
    if (!cursorInBlock) {
      decos.push(
        Decoration.replace({
          widget: new MermaidWidget(block.source, block.lang, block.from, block.to, block.sourceFrom, block.layout),
          block: true,
        }).range(block.from, block.to),
      );
    } else {
      decos.push(
        Decoration.widget({
          widget: new MermaidPreviewWidget(block.source, block.lang, block.layout),
          block: true,
          side: 1,
        }).range(block.to),
      );
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return decos;
}

function buildMermaidDecos(state: EditorState): DecorationSet {
  return Decoration.set(buildMermaidDecoRanges(state), true);
}

function activeMermaidBlockKey(state: EditorState): string {
  const sel = state.selection.main;
  const blocks = state.field(mermaidBlocksField, false) ?? collectMermaidBlocks(state);
  for (const block of blocks) {
    if (sel.from < block.to && sel.to > block.from) return `${block.from}:${block.to}`;
  }
  return "";
}

function mermaidRangeFromKey(key: string): { from: number; to: number } | null {
  const [from, to] = key.split(":").map((part) => Number(part));
  return Number.isFinite(from) && Number.isFinite(to) && from <= to ? { from, to } : null;
}

function mergeMermaidWindows(windows: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
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

function patchMermaidDecosForSelectionChange(
  state: EditorState,
  current: DecorationSet,
  oldKey: string,
  newKey: string,
): DecorationSet {
  const windows = mergeMermaidWindows([oldKey, newKey]
    .map(mermaidRangeFromKey)
    .filter((range): range is { from: number; to: number } => Boolean(range)));
  if (windows.length === 0) return current;

  let next = current;
  const add: Range<Decoration>[] = [];
  for (const range of windows) {
    next = next.update({ filterFrom: range.from, filterTo: range.to, filter: () => false });
    add.push(...buildMermaidDecoRanges(state, range.from, range.to));
  }
  return next.update({ add, sort: true });
}

const mermaidField = StateField.define<DecorationSet>({
  create: (state) => buildMermaidDecos(state),
  update(value, tr) {
    if (tr.docChanged) {
      const blocks = tr.startState.field(mermaidBlocksField, false) ?? collectMermaidBlocks(tr.startState);
      if (canMapMermaidBlocks(tr.startState.doc, blocks, tr.changes)) {
        return changesTouchMermaidSource(blocks, tr.changes)
          ? patchMermaidDecosNearChanges(tr.state, value.map(tr.changes), blocks, tr.changes)
          : value.map(tr.changes);
      }
      return buildMermaidDecos(tr.state);
    }
    if (tr.selection != null) {
      const oldKey = activeMermaidBlockKey(tr.startState);
      const newKey = activeMermaidBlockKey(tr.state);
      if (oldKey !== newKey) return patchMermaidDecosForSelectionChange(tr.state, value, oldKey, newKey);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function patchMermaidDecosNearChanges(
  state: EditorState,
  mapped: DecorationSet,
  oldBlocks: readonly MermaidBlock[],
  changes: ChangeSet,
): DecorationSet {
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  changes.iterChanges((fromA, toA) => {
    for (const block of oldBlocks) {
      if (fromA > block.sourceTo || toA < block.sourceFrom) continue;
      from = Math.min(from, changes.mapPos(block.from, -1));
      to = Math.max(to, changes.mapPos(block.to, 1));
    }
  });
  if (!Number.isFinite(from)) return mapped;
  const blocks = state.field(mermaidBlocksField, false) ?? collectMermaidBlocks(state);
  for (const block of blocks) {
    if (block.from > to || block.to < from) continue;
    from = Math.min(from, block.from);
    to = Math.max(to, block.to);
  }
  return mapped
    .update({ filterFrom: from, filterTo: to, filter: () => false })
    .update({ add: buildMermaidDecoRanges(state, from, to), sort: true });
}

// ---------------------------------------------------------------------------
// Fenced code — ViewPlugin (viewport-only, inline marks + lang badge only)
// ---------------------------------------------------------------------------

function buildFencedCodeDecos(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  const cursorLine = doc.lineAt(sel.from).number;
  const blockMathRanges = getBlockMathRanges(view.state);
  const fenceExcludedRanges = blockMathRanges;

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: vFrom,
      to: vTo,
      enter(node) {
        if (rangeInsideAny(node.from, node.to, fenceExcludedRanges)) return false;
        if (node.name !== "FencedCode") return;
        if (rangeOverlapsAny(node.from, node.to, fenceExcludedRanges)) return false;

        const infoNode = node.node.getChild("CodeInfo");
        const textNode = node.node.getChild("CodeText");

        const lang = infoNode
          ? doc.sliceString(infoNode.from, infoNode.to).trim()
          : "";

        // Mermaid is handled by the StateField above — skip here
        if (supportedDiagramLang(lang)) return false;

        const codeBody = textNode
          ? doc.sliceString(textNode.from, textNode.to)
          : "";
        const foldKey = `code:${textNode?.from ?? node.from}`;
        const fold = textNode ? {
          key: foldKey,
          from: textNode.from,
          to: textNode.to,
          lines: Math.max(1, codeBody.split(/\r?\n/).length),
        } : null;
        const folded = Boolean(fold && view.state.field(codeFoldField, false)?.folds
          .some((entry) => entry.key === foldKey));

        const openFenceLine = doc.lineAt(node.from);
        const openFenceLineNum = openFenceLine.number;
        const closeFenceLine = node.to > openFenceLine.to
          ? doc.lineAt(node.to - 1)
          : openFenceLine;
        const closeFenceLineNum = closeFenceLine.number;

        // Opening fence fold
        const onOpenFence = cursorLine === openFenceLineNum;
        const fenceMarkEnd = infoNode ? infoNode.from : openFenceLine.to;
        pushMark(decos, openFenceLine.from, fenceMarkEnd, onOpenFence ? "syntax-hint" : "syntax-hidden");

        // Editable language badge, shown even for an unlabelled fence.
        decos.push(
          Decoration.widget({
            widget: new LangBadgeWidget(
              lang,
              infoNode?.from ?? fenceMarkEnd,
              infoNode?.to ?? fenceMarkEnd,
            ),
            side: 1,
          }).range(fenceMarkEnd),
        );
        if (textNode) {
          decos.push(
            Decoration.widget({ widget: new CodeCopyButtonWidget(codeBody), side: 2 }).range(fenceMarkEnd),
          );
        }
        if (fold) {
          decos.push(
            Decoration.widget({
              widget: new CodeFoldButtonWidget(fold, folded),
              side: 3,
            }).range(fenceMarkEnd),
          );
        }

        // Hide lang text when not on opening fence
        if (infoNode) {
          pushMark(decos, infoNode.from, infoNode.to, onOpenFence ? "syntax-hint" : "syntax-hidden");
        }

        // Closing fence fold
        if (closeFenceLine.number !== openFenceLine.number) {
          const onCloseFence = cursorLine === closeFenceLineNum;
          pushMark(decos, closeFenceLine.from, closeFenceLine.to, onCloseFence ? "syntax-hint" : "syntax-hidden");
        }

        // Syntax highlighting
        if (textNode && lang && codeBody && !folded) {
          const ranges = highlightCodeForEditor(lang, codeBody);
          for (const r of ranges) {
            const from = textNode.from + r.from;
            const to = textNode.from + r.to;
            if (from < to) {
              decos.push(Decoration.mark({ class: r.className }).range(from, to));
            }
          }
        }

        return false;
      },
    });
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decos, true);
}

const FENCE_CHROME_LINE_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})/;

function activeFenceChromeLineKey(view: EditorView): string {
  const line = view.state.doc.lineAt(view.state.selection.main.from);
  return FENCE_CHROME_LINE_RE.test(line.text) ? String(line.number) : "";
}

function pushMark(
  decos: Range<Decoration>[],
  from: number,
  to: number,
  cls: string,
): void {
  if (from >= to) return;
  decos.push(Decoration.mark({ class: cls }).range(from, to));
}

class FencedCodePlugin {
  decorations: DecorationSet;
  private readonly view: EditorView;
  private readonly unsubscribeHighlightReady: () => void;
  private activeLineKey: string;

  constructor(view: EditorView) {
    this.view = view;
    this.activeLineKey = activeFenceChromeLineKey(view);
    this.decorations = buildFencedCodeDecos(view);
    this.unsubscribeHighlightReady = onCodeHighlightReady(() => {
      if (!this.view.dom.isConnected) return;
      this.decorations = buildFencedCodeDecos(this.view);
      this.view.dispatch({});
    });
  }

  update(update: ViewUpdate): void {
    if (update.view.compositionStarted && update.selectionSet && !update.docChanged && !update.viewportChanged) return;
    const foldToggled = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(toggleCodeFoldEffect)));
    if (update.docChanged || update.viewportChanged || foldToggled || hasViewportDecorationRefresh(update)) {
      this.activeLineKey = activeFenceChromeLineKey(update.view);
      this.decorations = buildFencedCodeDecos(update.view);
    } else if (update.selectionSet) {
      const nextLineKey = activeFenceChromeLineKey(update.view);
      if (nextLineKey === this.activeLineKey) return;
      this.activeLineKey = nextLineKey;
      this.decorations = buildFencedCodeDecos(update.view);
    }
  }

  destroy(): void {
    this.unsubscribeHighlightReady();
  }
}

const fencedCodeViewPlugin = ViewPlugin.fromClass(FencedCodePlugin, {
  decorations: (v) => v.decorations,
});

// ---------------------------------------------------------------------------
// Public export — both parts together
// ---------------------------------------------------------------------------

export const fencedCodeExtension = [
  mermaidBlocksField,
  mermaidField,
  codeFoldField,
  fencedCodeViewPlugin,
];
