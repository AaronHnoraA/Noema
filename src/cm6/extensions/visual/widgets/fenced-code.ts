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
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { MeasuredWidget } from "./measured-widget.ts";
import { observeWidget, shortHash, unobserveWidget } from "./measured-observer.ts";
import { MapMode, StateEffect, StateField, Transaction, type ChangeSet, type EditorState, type Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { highlightCodeForEditor, onCodeHighlightReady } from "../../../../code-highlight-async.ts";
import { supportedDiagramLang } from "../../../../diagram-langs.ts";
import { parseCodeInfo, type CodeInfo } from "../../../../code-info.ts";
import { codeHighlightSource, codeRowClasses, codeRows, codeWhitespaceMarks, codeWordMarks, enhancedCode, type CodeRow } from "../../../../code-annotation.ts";
import { indexCodeTails } from "../../../../render-html.ts";
import { writeSystemClipboard } from "../../../../system-clipboard.ts";
import { getBlockMathRanges, rangeAtPosition, rangeInsideAny, rangeOverlapsAny } from "../../../math-ranges.ts";
import { applyLayoutAttrs, layoutFromAttrs, layoutIsDefault, readLayoutAttrsLine, type LayoutAttrs } from "../../../../layout-attrs.ts";
import { scheduleViewportDecorationRefresh } from "../../../viewport-refresh.ts";
import { preserveEditorViewport } from "../../../viewport-stability.ts";
import { figureHeightHandle, figureLayoutToolbar, figureResizeHandle } from "../../../figure-layout-menu.ts";
import {
  dispatchConstructEdit,  constructSources,
  constructViewPlugin,
  rebuildDecorations,
  rebuildForRevealChange,
  selectionOpensSource,
  transactionChangesPinning,
  type ConstructSource,
  type RenderedConstruct,
} from "../constructs/index.ts";
import { persistentVisualStateField } from "../visual-mode.ts";
import { pointerSelectionEffect, visualSelection } from "../selection.ts";

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
  fileTitle: string;

  constructor(lang: string, from: number, to: number, fileTitle = "") {
    super();
    this.lang = lang;
    this.from = from;
    this.to = to;
    this.fileTitle = fileTitle;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: LangBadgeWidget): boolean {
    return this.lang === other.lang && this.from === other.from && this.to === other.to
      && this.fileTitle === other.fileTitle;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-code-lang-badge cm-code-lang-editor";
    span.textContent = this.lang || "lang";
    span.title = "Click to edit code language";
    span.tabIndex = 0;
    this.wireLangEditor(span, view);
    if (!this.fileTitle) return span;
    // The file name sits before the language, as a code card's caption.
    const caption = document.createElement("span");
    caption.className = "cm-code-file-title";
    caption.textContent = this.fileTitle;
    const group = document.createElement("span");
    group.className = "cm-code-caption";
    group.append(caption, span);
    return group;
  }

  private wireLangEditor(span: HTMLElement, view: EditorView): void {
    if (view.state.readOnly) {
      // A reader sees the language; nothing in a read-only page opens an editor.
      span.classList.remove("cm-code-lang-editor");
      span.removeAttribute("title");
      span.removeAttribute("tabindex");
      return;
    }
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
          dispatchConstructEdit(view, { changes: { from: this.from, to: this.to, insert: next } });
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
      input.focus({ preventScroll: true });
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
  return writeSystemClipboard(text);
}

type CodeFold = { key: string; from: number; to: number; lines: number; opener?: number };
type CodeTextSegment = { from: number; to: number; offset: number };

function readFenceCode(doc: Text, node: SyntaxNode): { body: string; segments: CodeTextSegment[] } {
  const segments: CodeTextSegment[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const part of node.getChildren("CodeText")) {
    segments.push({ from: part.from, to: part.to, offset });
    parts.push(doc.sliceString(part.from, part.to));
    offset += part.to - part.from;
  }
  return { body: parts.join(""), segments };
}
type CodeFoldState = {
  folds: readonly CodeFold[];
  manual: readonly CodeFold[];
  tails: readonly CodeFold[];
  expanded: ReadonlySet<number>;
  decorations: DecorationSet;
};
const MAX_CODE_FOLDS = 128;

const toggleCodeFoldEffect = StateEffect.define<CodeFold>();
const toggleCodeTailEffect = StateEffect.define<number>();

function toggleCodeTail(view: EditorView, opener: number): void {
  preserveEditorViewport(view, () => view.dispatch({
    effects: toggleCodeTailEffect.of(opener),
    annotations: Transaction.addToHistory.of(false),
  }), opener);
}

class CodeFoldPlaceholderWidget extends MeasuredWidget {
  readonly lines: number;
  readonly tail: boolean;
  constructor(lines: number, tail: boolean) {
    super();
    this.lines = lines;
    this.tail = tail;
  }
  protected measureKey(): string { return `code-fold:${this.lines}`; }
  protected measureGroupKey(): string { return "code-fold"; }
  protected estimatedHeightFallback(): number { return 30; }
  eq(other: CodeFoldPlaceholderWidget): boolean { return this.lines === other.lines && this.tail === other.tail; }
  toDOM(view: EditorView): HTMLElement {
    const block = document.createElement("div");
    block.className = "cm-code-fold-placeholder";
    const description = `${this.lines} ${this.lines === 1 ? "line" : "lines"}`;
    if (this.tail) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Show ${description} ▾`;
      button.setAttribute("aria-expanded", "false");
      button.addEventListener("mousedown", (event) => event.stopPropagation());
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const position = view.posAtDOM(block, -1);
        const tail = view.state.field(codeFoldField).tails.find((entry) => entry.from === position);
        if (tail?.opener === undefined) return;
        toggleCodeTail(view, tail.opener);
        const header = view.domAtPos(tail.opener).node.parentElement?.closest(".cm-line");
        header?.querySelector<HTMLElement>(".cm-code-fold-button")?.focus({ preventScroll: true });
      });
      block.append(button);
    } else block.textContent = `${description} collapsed`;
    return this.registerMeasured(block, view);
  }
  ignoreEvent(): boolean { return true; }
}

function codeFoldDecorations(state: EditorState, folds: readonly CodeFold[]): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  for (const fold of folds) {
    const { from, to } = codeFoldRange(state, fold);
    if (from >= to) {
      if (fold.opener !== undefined) {
        decorations.push(Decoration.widget({ widget: new CodeFoldPlaceholderWidget(fold.lines, true), block: true, side: -1 }).range(from));
      }
      continue;
    }
    decorations.push(Decoration.replace({
      widget: new CodeFoldPlaceholderWidget(fold.lines, fold.opener !== undefined),
      block: true,
    }).range(from, to));
  }
  return Decoration.set(decorations, true);
}

function indexedCodeTails(state: EditorState): CodeFold[] {
  const doc = state.doc;
  const excluded = getBlockMathRanges(state);
  return indexCodeTails(doc.toString()).flatMap((entry) => {
    const opener = doc.line(entry.opener + 1).from;
    const to = doc.line(entry.to + 1).to;
    if (rangeOverlapsAny(opener, to, excluded)) return [];
    return [{ key: `code-tail:${opener}`, opener, from: entry.lines ? doc.line(entry.from + 1).from : to, to, lines: entry.lines }];
  });
}

function assembleCodeFolds(state: EditorState, manual: readonly CodeFold[], tails: readonly CodeFold[], expanded: ReadonlySet<number>): CodeFoldState {
  const folds = [...manual, ...tails.filter((entry) => entry.lines && !expanded.has(entry.opener!))];
  return { folds, manual, tails, expanded, decorations: codeFoldDecorations(state, folds) };
}

function createCodeFoldState(state: EditorState): CodeFoldState {
  return assembleCodeFolds(state, [], indexedCodeTails(state), new Set());
}

function codeTailsNeedRescan(previous: EditorState, changed: EditorState, changes: ChangeSet, hasTails: boolean): boolean {
  let rescan = false;
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (rescan) return;
    const before = previous.doc.sliceString(previous.doc.lineAt(fromA).from, previous.doc.lineAt(toA).to);
    const after = changed.doc.sliceString(changed.doc.lineAt(fromB).from, changed.doc.lineAt(toB).to);
    if (before.includes("collapsed-lines") || after.includes("collapsed-lines")) rescan = true;
    else if (hasTails) {
      const removed = previous.doc.sliceString(fromA, toA);
      rescan ||= /[\n`~>]/.test(removed) || /[\n`~>]/.test(inserted.toString())
        || /^\s*(?:[-+*]|\d+[.)])[ \t]/.test(before) || /^\s*(?:[-+*]|\d+[.)])[ \t]/.test(after);
    }
  });
  return rescan;
}

const codeFoldField = StateField.define<CodeFoldState>({
  create: createCodeFoldState,
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.effects.some((effect) => effect.is(toggleCodeFoldEffect) || effect.is(toggleCodeTailEffect))) return value;
    let manual: CodeFold[] = [];
    let tails = value.tails;
    const expanded = new Set<number>();
    if (transaction.docChanged) {
      const tree = syntaxTree(transaction.state);
      for (const fold of value.manual) {
        const mappedFrom = transaction.changes.mapPos(fold.from, -1);
        let node = tree.resolve(Math.max(0, Math.min(mappedFrom, transaction.newDoc.length)), 1);
        while (node.parent && node.name !== "FencedCode") node = node.parent;
        if (node.name !== "FencedCode") continue;
        const { body, segments } = readFenceCode(transaction.newDoc, node);
        const from = segments[0]?.from;
        if (from === undefined || !body.length) continue;
        manual.push({
          key: `code:${from}`,
          from,
          to: segments.at(-1)!.to,
          lines: body.split("\n").length,
        });
      }
      for (const opener of value.expanded) {
        const position = transaction.changes.mapPos(opener, 1, MapMode.TrackDel);
        if (position !== null) expanded.add(transaction.newDoc.lineAt(position).from);
      }
      if (codeTailsNeedRescan(transaction.startState, transaction.state, transaction.changes, tails.length > 0)) {
        tails = indexedCodeTails(transaction.state);
        const current = new Set(tails.map((entry) => entry.opener));
        for (const opener of expanded) if (!current.has(opener)) expanded.delete(opener);
        const foldable = new Set(tails.filter((entry) => entry.lines > 0).map((entry) => entry.opener));
        manual = manual.filter((entry) => {
          const bodyLine = transaction.newDoc.lineAt(entry.from).number;
          return bodyLine <= 1 || !foldable.has(transaction.newDoc.line(bodyLine - 1).from);
        });
      } else if (tails.length > 0) {
        tails = tails.map((entry) => {
          const opener = transaction.changes.mapPos(entry.opener!, 1);
          return { ...entry, key: `code-tail:${opener}`, opener,
            from: transaction.changes.mapPos(entry.from, -1), to: transaction.changes.mapPos(entry.to, 1) };
        });
      }
    } else {
      manual = [...value.manual];
      for (const opener of value.expanded) expanded.add(opener);
    }
    for (const effect of transaction.effects) {
      if (effect.is(toggleCodeFoldEffect)) {
        const existing = manual.findIndex((fold) => fold.key === effect.value.key);
        if (existing >= 0) manual.splice(existing, 1);
        else if (manual.length < MAX_CODE_FOLDS) manual.push(effect.value);
      } else if (effect.is(toggleCodeTailEffect)) {
        if (expanded.has(effect.value)) expanded.delete(effect.value);
        else expanded.add(effect.value);
      }
    }
    return assembleCodeFolds(transaction.state, manual, tails, expanded);
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
    return this.fold.key === other.fold.key && this.fold.lines === other.fold.lines && this.folded === other.folded;
  }
  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-code-fold-button";
    const tail = this.fold.opener !== undefined;
    button.textContent = tail ? (this.folded ? "More" : "Less") : (this.folded ? "Show" : "Fold");
    button.title = tail ? (this.folded ? `Show ${this.fold.lines} more lines of code` : "Collapse extra lines")
      : (this.folded ? "Expand code block" : "Collapse code block");
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(!this.folded));
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (tail) {
        const position = view.posAtDOM(button, -1);
        const opener = view.state.doc.lineAt(position).from;
        toggleCodeTail(view, opener);
        view.domAtPos(opener).node.parentElement?.closest(".cm-line")
          ?.querySelector<HTMLElement>(".cm-code-fold-button")?.focus({ preventScroll: true });
      } else {
        view.dispatch({ effects: toggleCodeFoldEffect.of(this.fold) });
        view.requestMeasure();
      }
    });
    return button;
  }
  ignoreEvent(): boolean { return true; }
}

// ---------------------------------------------------------------------------
// Mermaid widgets
// ---------------------------------------------------------------------------

function diagramMeasureKey(prefix: string, source: string, lang: string, layout: LayoutAttrs): string {
  const key = prefix + shortHash(lang + "\n" + source);
  return layoutIsDefault(layout) ? key : key + ":" + JSON.stringify(layout);
}

class MermaidWidget extends MeasuredWidget {
  source: string;
  lang: string;
  from: number;
  to: number;
  sourceFrom: number;
  layout: LayoutAttrs;
  private disposeRender: () => void = () => {};

  constructor(source: string, lang: string, from: number, to: number, sourceFrom: number, layout: LayoutAttrs) {
    super();
    this.source = source;
    this.lang = lang;
    this.from = from;
    this.to = to;
    this.sourceFrom = sourceFrom;
    this.layout = layout;
  }

  protected get measuredBlock(): boolean { return !this.layout.wrap; }
  protected get floatedBlock(): boolean { return this.layout.wrap; }
  protected get observeSize(): boolean { return true; }
  protected measureKey(): string { return diagramMeasureKey("mermaid:", this.source, this.lang, this.layout); }

  protected measureGroupKey(): string {
    const bucket = Math.min(8, Math.ceil(this.source.split(/\n/).length / 8));
    return ["mermaid", this.lang, this.layout.align, this.layout.wrap ? "wrap" : "block", bucket,
      this.layout.width, this.layout.height].join(":");
  }

  protected estimatedHeightFallback(): number {
    if (this.layout.wrap) return 0;
    const explicitHeight = Number.parseFloat(this.layout.height);
    if (Number.isFinite(explicitHeight) && explicitHeight > 0) return explicitHeight + 24;
    return Math.max(190, Math.min(460, 120 + this.source.split(/\n/).length * 18));
  }

  eq(other: MermaidWidget): boolean {
    return this.sameDiagram(other) && this.from === other.from &&
      this.to === other.to &&
      this.sourceFrom === other.sourceFrom;
  }

  private sameDiagram(other: MermaidWidget): boolean {
    return this.source === other.source && this.lang === other.lang &&
      this.layout.align === other.layout.align &&
      this.layout.wrap === other.layout.wrap &&
      this.layout.width === other.layout.width &&
      this.layout.height === other.layout.height;
  }

  updateDOM(dom: HTMLElement, _view: EditorView, previous: MermaidWidget): boolean {
    if (!this.sameDiagram(previous)) return false;
    this.disposeRender = previous.disposeRender;
    const figure = this.layout.wrap ? dom.firstElementChild as HTMLElement : dom;
    setSourceRange(figure, this.from, this.to, this.sourceFrom, true);
    return true;
  }

  destroy(dom: HTMLElement): void {
    this.disposeRender();
    super.destroy(dom);
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("figure");
    wrap.className = "cm-mermaid-widget";
    applyLayoutAttrs(wrap, "diagram", this.layout);
    setSourceRange(wrap, this.from, this.to, this.sourceFrom, true);

    const div = document.createElement("div");
    div.className = "cm-mermaid-block";
    applyLayoutAttrs(div, "diagram", this.layout);
    wrap.append(div);
    if (!view.state.readOnly) {
      wrap.append(
        figureLayoutToolbar(view, wrap, this.layout, { preservesAspect: false }),
        figureResizeHandle(view, wrap, "diagram", wrap, { preservesAspect: false }),
        figureHeightHandle(view, wrap, "diagram", div),
      );
    }
    this.disposeRender = renderMermaidWidget(this.source, this.lang, div, wrap, this.estimatedHeight, view);
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

  protected get measuredBlock(): boolean { return !this.layout.wrap; }
  protected get floatedBlock(): boolean { return this.layout.wrap; }
  protected get observeSize(): boolean { return true; }
  protected measureKey(): string { return diagramMeasureKey("mermp:", this.source, this.lang, this.layout); }

  protected measureGroupKey(): string {
    const bucket = Math.min(8, Math.ceil(this.source.split(/\n/).length / 8));
    return ["mermp", this.lang, this.layout.align, this.layout.wrap ? "wrap" : "block", bucket,
      this.layout.width, this.layout.height].join(":");
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
    applyLayoutAttrs(wrap, "diagram", this.layout);

    const div = document.createElement("div");
    div.className = "cm-mermaid-block-preview";
    applyLayoutAttrs(div, "diagram", this.layout);
    wrap.append(div);
    previewRenders.set(wrap, renderMermaidWidget(this.source, this.lang, div, wrap, this.estimatedHeight, view, true));
    return this.registerMeasured(wrap, view);
  }

  /**
   * Typing in the source gives a new widget per keystroke. Reuse the figure so
   * the last drawing stays on screen until the next one is ready.
   */
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const div = dom.querySelector<HTMLElement>(":scope > .cm-mermaid-block-preview");
    if (!div || this.layout.wrap || dom.classList.contains("noema-diagram-wrap")) return false;
    previewRenders.get(dom)?.();
    applyLayoutAttrs(div, "diagram", this.layout);
    dom.dataset.cmMeasureKey = this.measureKey();
    previewRenders.set(dom, renderMermaidWidget(this.source, this.lang, div, dom, this.estimatedHeight, view, true));
    return true;
  }

  ignoreEvent(): boolean { return true; }

  destroy(dom: HTMLElement): void {
    previewRenders.get(dom)?.();
    previewRenders.delete(dom);
    super.destroy(dom);
  }
}

/** The running render of each live-preview figure, owned by its DOM, not by one widget instance. */
const previewRenders = new WeakMap<HTMLElement, () => void>();

/**
 * While the source of a live preview is being typed, an unfinished diagram
 * does not replace the last one that rendered: it stays, dimmed, with the
 * error on one line over its bottom edge, so the block keeps its height.
 */
export function showPreviewError(div: HTMLElement, wrap: HTMLElement, message: string): boolean {
  if (!div.querySelector("svg")) return false;
  wrap.classList.add("cm-diagram-stale");
  let line = wrap.querySelector<HTMLElement>(":scope > .cm-diagram-error-line");
  if (!line) {
    line = document.createElement("div");
    line.className = "cm-diagram-error-line";
    wrap.append(line);
  }
  const summary = message.split("\n").filter((part) => part.trim());
  line.textContent = summary.length > 1 ? `${summary[0]} ${summary[summary.length - 1]}` : (summary[0] ?? message);
  line.title = message;
  return true;
}

export function clearPreviewError(wrap: HTMLElement): void {
  wrap.classList.remove("cm-diagram-stale");
  wrap.querySelector(":scope > .cm-diagram-error-line")?.remove();
}

function renderMermaidWidget(
  source: string, lang: string, div: HTMLElement, wrap: HTMLElement,
  estimatedHeight: number, view: EditorView, keepPrevious = false,
): () => void {
  let disposed = false;
  let disposeInteraction = () => {};
  const floating = wrap.classList.contains("noema-diagram-wrap");
  // The outer float anchor has no height. Observe the actual floated content
  // so later SVG/font changes still invalidate the surrounding text layout.
  if (floating) observeWidget(div, view);
  const key = `mermaid\n${lang}\n${source.trim()}`;
  div.dataset.diagramRenderKey = key;
  // Even a cached SVG crosses an async import when a virtualized widget mounts
  // again. Keep its measured space until then, rather than briefly measuring
  // the much shorter loading label and moving the surrounding text twice.
  wrap.setAttribute("aria-busy", "true");
  const keeps = keepPrevious && Boolean(div.querySelector("svg"));
  // A kept drawing already holds the block's height.
  if (!keeps && estimatedHeight > 0 && !wrap.classList.contains("noema-diagram-wrap")) {
    wrap.style.minHeight = `${estimatedHeight}px`;
  }
  const finish = () => {
    if (disposed) return;
    wrap.removeAttribute("aria-busy");
    wrap.style.removeProperty("min-height");
    if (wrap.isConnected) view.requestMeasure();
  };
  if (!keeps) div.textContent = "Loading diagram renderer...";
  void import("../../../../diagram-render.ts")
    .then(({ renderMermaidLazy, disposeDiagramInteraction }) => {
      if (disposed || div.dataset.diagramRenderKey !== key) return;
      disposeInteraction = () => disposeDiagramInteraction(div);
      let failed = false;
      renderMermaidLazy(source, div, (err) => {
        failed = true;
        if (keepPrevious && showPreviewError(div, wrap, err)) return;
        div.classList.add("cm-diagram-error");
        div.textContent = err;
      }, { lang, keepPrevious, onRender: () => {
        if (!failed) {
          div.classList.remove("cm-diagram-error");
          clearPreviewError(wrap);
        }
        finish();
      } });
    })
    .catch((err: unknown) => {
      if (disposed || div.dataset.diagramRenderKey !== key) return;
      div.classList.add("cm-diagram-error");
      div.textContent = err instanceof Error ? err.message : String(err);
      finish();
    });
  return () => {
    disposed = true;
    div.removeAttribute("data-diagram-render-key");
    disposeInteraction();
    if (floating) unobserveWidget(div);
  };
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
  const blocks = state.field(mermaidBlocksField, false) ?? collectMermaidBlocks(state);

  for (const block of blocks) {
    if (block.to < from || block.from > to) continue;
    // Only a caret opens a diagram's source; a range keeps it rendered, as
    // `activeMermaidBlockKey` assumes when it ignores range selections.
    if (!diagramOpened(state, block)) {
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

/** A diagram is an object: it opens for a caret strictly inside, outside Vim's Normal and Visual modes. */
function diagramOpened(state: EditorState, block: { from: number; to: number }): boolean {
  return selectionOpensSource(state, block.from, block.to, "caret-interior", "object");
}

function activeMermaidBlockKey(state: EditorState): string {
  const sel = visualSelection(state).main;
  if (!sel.empty) return "";
  const block = rangeAtPosition(sel.head, state.field(mermaidBlocksField, false) ?? collectMermaidBlocks(state));
  return block && diagramOpened(state, block) ? `${block.from}:${block.to}` : "";
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
    if (tr.selection != null || transactionChangesPinning(tr)
        || tr.effects.some((effect) => effect.is(pointerSelectionEffect) && !effect.value)) {
      const oldKey = activeMermaidBlockKey(tr.startState);
      const newKey = activeMermaidBlockKey(tr.state);
      return rebuildForRevealChange(value, oldKey, newKey, (from, to) => buildMermaidDecoRanges(tr.state, from, to));
    }
    return value;
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
  return rebuildDecorations(mapped, [{ from, to }], (start, end) => buildMermaidDecoRanges(state, start, end));
}

// ---------------------------------------------------------------------------
// Fenced code — ViewPlugin (viewport-only, inline marks + lang badge only)
// ---------------------------------------------------------------------------

function decorateCodeRows(view: EditorView, decos: Range<Decoration>[], info: CodeInfo, rows: readonly CodeRow[], segments: readonly CodeTextSegment[], stop: number): void {
  const doc = view.state.doc;
  const cursor = doc.lineAt(visualSelection(view.state).main.head).number;
  const numberWidth = info.numbers === null ? 0 : String(info.numbers + rows.length - 1).length;
  const highlighted = new Set(info.highlight);
  const visible = view.visibleRanges;
  let range = 0;
  let part = 0;
  for (let index = 0; index < stop && range < visible.length; index++) {
    const row = rows[index]!;
    while (segments[part + 1] && segments[part + 1]!.offset <= row.from) part++;
    const segment = segments[part]!;
    const from = segment.from + row.from - segment.offset;
    const end = from + row.text.length;
    while (visible[range] && from > visible[range]!.to) range++;
    const line = doc.lineAt(from);
    if (!visible[range] || line.to < visible[range]!.from) continue;
    const number = info.numbers === null ? undefined : { "data-code-number": String(info.numbers + index), style: `--code-number-width:${numberWidth}ch` };
    const classes = codeRowClasses(row, highlighted.has(index + 1));
    if (classes || info.numbers !== null) decos.push(Decoration.line({ class: classes, attributes: number }).range(line.from));
    if (row.markerLength) pushMark(decos, end, end + row.markerLength, cursor === line.number ? "syntax-hint" : "syntax-hidden");
    for (const mark of [...codeWhitespaceMarks(row.text, info), ...codeWordMarks(row.text, [...info.words, ...row.words])]) {
      pushMark(decos, from + mark.from, from + mark.to, mark.className);
    }
  }
}

function addCodeSyntax(decos: Range<Decoration>[], language: string, text: string, segments: readonly CodeTextSegment[]): void {
  const highlights = highlightCodeForEditor(language, text);
  let part = 0;
  for (const mark of highlights) {
    while (segments[part + 1] && segments[part + 1]!.offset <= mark.from) part++;
    for (let index = part; index < segments.length; index++) {
      const segment = segments[index]!;
      if (segment.offset >= mark.to) break;
      const shift = segment.from - segment.offset;
      pushMark(decos, Math.max(segment.from, mark.from + shift), Math.min(segment.to, mark.to + shift), mark.className);
    }
  }
}

function buildFencedCodeDecos(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const sel = visualSelection(view.state).main;
  const doc = view.state.doc;
  const cursorLine = doc.lineAt(sel.from).number;
  const blockMathRanges = getBlockMathRanges(view.state);
  const fenceExcludedRanges = blockMathRanges;
  const folds = view.state.field(codeFoldField, false);
  const visited = new Set<number>();

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: vFrom,
      to: vTo,
      enter(node) {
        if (rangeInsideAny(node.from, node.to, fenceExcludedRanges)) return false;
        if (node.name !== "FencedCode") return;
        if (rangeOverlapsAny(node.from, node.to, fenceExcludedRanges)) return false;
        if (visited.has(node.from)) return false;
        visited.add(node.from);

        const infoNode = node.node.getChild("CodeInfo");
        const infoText = infoNode ? doc.sliceString(infoNode.from, infoNode.to) : "";
        const info = parseCodeInfo(infoText);
        const lang = info.lang;

        // Mermaid is handled by the StateField above — skip here
        if (supportedDiagramLang(infoText.trim())) return false;

        const { body: codeBody, segments } = readFenceCode(doc, node.node);
        const bodyStart = segments[0]?.from;
        const openFenceLine = doc.lineAt(node.from);
        const tail = folds?.tails.find((entry) => entry.opener === openFenceLine.from && entry.lines > 0);
        const fold = tail ?? (bodyStart !== undefined ? {
          key: `code:${bodyStart}`,
          from: bodyStart,
          to: segments.at(-1)!.to,
          lines: codeBody.split("\n").length,
        } : null);
        const folded = Boolean(fold && folds?.folds.some((entry) => entry.key === fold.key));
        const bodyVisible = !folded || Boolean(tail);
        const rows = bodyStart !== undefined && bodyVisible && enhancedCode(info, codeBody) ? codeRows(codeBody, true) : null;

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
        // The badge edits only the language word, so title and line marks survive.
        decos.push(
          Decoration.widget({
            widget: new LangBadgeWidget(
              lang,
              infoNode ? infoNode.from + info.langFrom : fenceMarkEnd,
              infoNode ? infoNode.from + info.langTo : fenceMarkEnd,
              info.title,
            ),
            side: 1,
          }).range(fenceMarkEnd),
        );
        if (rows) {
          decorateCodeRows(view, decos, info, rows, segments, folded && tail ? Math.max(0, rows.length - tail.lines) : rows.length);
        } else if (bodyStart !== undefined && info.highlight.length > 0 && bodyVisible) {
          const firstBodyLine = doc.lineAt(bodyStart).number;
          const lastBodyLine = doc.lineAt(segments.at(-1)!.to).number;
          for (const n of info.highlight) {
            const lineNumber = firstBodyLine + n - 1;
            if (lineNumber > lastBodyLine) break;
            decos.push(Decoration.line({ class: "cm-code-line-highlight" }).range(doc.line(lineNumber).from));
          }
        }
        if (bodyStart !== undefined) {
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
        if (lang && codeBody && bodyVisible) addCodeSyntax(decos, lang, rows ? codeHighlightSource(codeBody, rows) : codeBody, segments);

        return false;
      },
    });
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decos, true);
}

const FENCE_CHROME_LINE_RE = /`{3,}|~{3,}/;

function activeFenceChromeLineKey(view: EditorView): string {
  const line = view.state.doc.lineAt(visualSelection(view.state).main.head);
  return FENCE_CHROME_LINE_RE.test(line.text) || line.text.includes("[!code") ? String(line.number) : "";
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

/**
 * The persistent block field often maps its decorations without creating new
 * widgets; keep diagram menus' and source clicks' metadata current through it.
 */
function mapDiagramSourceRanges(update: ViewUpdate): void {
  if (!update.docChanged || !update.startState.field(mermaidBlocksField, false)?.length) return;
  for (const figure of update.view.dom.querySelectorAll<HTMLElement>(".cm-mermaid-widget[data-cm-source-from]")) {
    setSourceRange(figure,
      update.changes.mapPos(Number(figure.dataset.cmSourceFrom), 1),
      update.changes.mapPos(Number(figure.dataset.cmSourceTo), -1),
      update.changes.mapPos(Number(figure.dataset.cmSourceAnchor), -1), true);
  }
}

const fencedCodeViewPlugin = constructViewPlugin({
  build: buildFencedCodeDecos,
  revealKey: activeFenceChromeLineKey,
  invalidates: (update) => update.transactions.some((transaction) =>
    transaction.effects.some((effect) => effect.is(toggleCodeFoldEffect) || effect.is(toggleCodeTailEffect))),
  beforeUpdate: mapDiagramSourceRanges,
  // Code drawn before its highlighter loaded is drawn again once it has.
  setup: (view) => onCodeHighlightReady(() => {
    if (view.dom.isConnected) scheduleViewportDecorationRefresh(view);
  }),
});

// ---------------------------------------------------------------------------
// Public export — both parts together
// ---------------------------------------------------------------------------

/** The source range a code fold hides: whole lines, as its placeholder replaces them. */
function codeFoldRange(state: EditorState, fold: CodeFold): { from: number; to: number } {
  if (fold.opener !== undefined) return { from: fold.from, to: fold.to };
  const from = state.doc.lineAt(Math.max(0, Math.min(fold.from, state.doc.length))).from;
  const end = Math.max(from, Math.min(Math.max(fold.from, fold.to - 1), state.doc.length));
  return { from, to: state.doc.lineAt(end).to };
}

/** Diagrams and folded code blocks as rendered constructs. A fold opens only by its toggle. */
const fencedCodeConstructSource: ConstructSource = {
  kind: "fenced-code",
  at(state, pos) {
    const found: RenderedConstruct[] = [];
    for (const fold of state.field(codeFoldField, false)?.folds ?? []) {
      const range = codeFoldRange(state, fold);
      if (range.from <= pos && pos < range.to) found.push({ ...range, block: true, kind: "code-fold", reveal: "never" });
    }
    const diagram = rangeAtPosition(pos, state.field(mermaidBlocksField, false) ?? []);
    if (diagram) found.push({ from: diagram.from, to: diagram.to, block: true, kind: "diagram", reveal: "caret-interior" });
    return found;
  },
};

export const fencedCodeExtension = [
  constructSources.of(fencedCodeConstructSource),
  persistentVisualStateField(mermaidBlocksField, collectMermaidBlocks),
  persistentVisualStateField(mermaidField, buildMermaidDecos),
  persistentVisualStateField(codeFoldField, createCodeFoldState),
  fencedCodeViewPlugin,
];
