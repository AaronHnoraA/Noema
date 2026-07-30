/**
 * Standard Markdown footnote preview: `[^id]` and `[^id]: definition`.
 *
 * The visual pass is viewport-only and never rewrites source.  A definition
 * index is built lazily only when a reference is clicked, then cached by CM6's
 * immutable Text identity.  Both decoration and click-time scans have caps.
 */

import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Range, Text } from "@codemirror/state";
import { blockMathRangesOverlapping, mergeOverlappingRanges, rangeInsideAny } from "../../../math-ranges.ts";
import { scanInlineMathRanges } from "../../../../inline-math.ts";
import { hasViewportDecorationRefresh } from "../../../viewport-refresh.ts";

const FOOTNOTE_RE = /\[\^([^\]\n]{1,128})\]/g;
const FOOTNOTE_DEFINITION_RE = /^\s*\[\^([^\]\n]{1,128})\]:/;
const MAX_VIEWPORT_FOOTNOTES = 2_000;
const MAX_INDEXED_DEFINITIONS = 4_096;
const MAX_INDEXED_LINES = 50_000;

const definitionIndexCache = new WeakMap<object, ReadonlyMap<string, number>>();
const referenceIndexCache = new WeakMap<object, ReadonlyMap<string, readonly number[]>>();
const lastReferenceByView = new WeakMap<EditorView, Map<string, number>>();

function definitionIndex(doc: Text): ReadonlyMap<string, number> {
  const key = doc as unknown as object;
  const cached = definitionIndexCache.get(key);
  if (cached) return cached;
  const index = new Map<string, number>();
  const lastLine = Math.min(doc.lines, MAX_INDEXED_LINES);
  for (let lineNumber = 1; lineNumber <= lastLine && index.size < MAX_INDEXED_DEFINITIONS; lineNumber++) {
    const line = doc.line(lineNumber);
    const match = FOOTNOTE_DEFINITION_RE.exec(line.text);
    if (match && !index.has(match[1]!)) index.set(match[1]!, line.from);
  }
  definitionIndexCache.set(key, index);
  return index;
}

function referenceIndex(doc: Text): ReadonlyMap<string, readonly number[]> {
  const key = doc as unknown as object;
  const cached = referenceIndexCache.get(key);
  if (cached) return cached;
  const index = new Map<string, number[]>();
  const lastLine = Math.min(doc.lines, MAX_INDEXED_LINES);
  for (let lineNumber = 1; lineNumber <= lastLine; lineNumber++) {
    const line = doc.line(lineNumber);
    const definition = FOOTNOTE_DEFINITION_RE.exec(line.text);
    const definitionEnd = definition?.[0].length ?? 0;
    FOOTNOTE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FOOTNOTE_RE.exec(line.text)) !== null) {
      if (definition && match.index < definitionEnd) continue;
      const values = index.get(match[1]!) ?? [];
      if (values.length < 256) values.push(line.from + match.index);
      index.set(match[1]!, values);
    }
  }
  referenceIndexCache.set(key, index);
  return index;
}

class FootnoteReferenceWidget extends WidgetType {
  readonly label: string;
  readonly from: number;
  constructor(label: string, from: number) {
    super();
    this.label = label;
    this.from = from;
  }

  eq(other: FootnoteReferenceWidget): boolean { return this.label === other.label && this.from === other.from; }

  toDOM(view: EditorView): HTMLElement {
    const sup = document.createElement("sup");
    sup.className = "cm-footnote-reference";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = this.label;
    button.title = `Jump to footnote ${this.label}`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const position = definitionIndex(view.state.doc).get(this.label);
      if (position == null) return;
      const remembered = lastReferenceByView.get(view) ?? new Map<string, number>();
      remembered.set(this.label, this.from);
      lastReferenceByView.set(view, remembered);
      view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
      view.focus();
    });
    sup.append(button);
    return sup;
  }

  ignoreEvent(): boolean { return true; }
}

class FootnoteDefinitionWidget extends WidgetType {
  readonly label: string;
  constructor(label: string) {
    super();
    this.label = label;
  }

  eq(other: FootnoteDefinitionWidget): boolean { return this.label === other.label; }

  toDOM(view: EditorView): HTMLElement {
    const badge = document.createElement("sup");
    badge.className = "cm-footnote-definition-label";
    badge.title = `Footnote ${this.label}`;
    const label = document.createElement("span");
    label.textContent = this.label;
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "↩";
    back.title = `Back to footnote reference ${this.label}`;
    back.setAttribute("aria-label", back.title);
    back.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
    back.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const remembered = lastReferenceByView.get(view)?.get(this.label);
      const target = remembered ?? referenceIndex(view.state.doc).get(this.label)?.[0];
      if (target == null) return;
      view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
      view.focus();
    });
    badge.append(label, back);
    return badge;
  }

  ignoreEvent(): boolean { return true; }
}

function excludedRanges(view: EditorView): Array<{ from: number; to: number }> {
  const ranges = blockMathRangesOverlapping(view.state, view.visibleRanges)
    .map(({ from, to }) => ({ from, to }));
  for (const visible of view.visibleRanges) {
    ranges.push(...scanInlineMathRanges(view.state.doc.sliceString(visible.from, visible.to), visible.from));
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (["FencedCode", "CodeBlock", "IndentedCode", "InlineCode"].includes(node.name)) {
          ranges.push({ from: node.from, to: node.to });
          return false;
        }
        return true;
      },
    });
  }
  return mergeOverlappingRanges(ranges);
}

function selectionTouches(view: EditorView, from: number, to: number): boolean {
  const selection = view.state.selection.main;
  return selection.empty
    ? selection.from >= from && selection.from <= to
    : selection.from < to && selection.to > from;
}

function activeFootnoteSourceKey(view: EditorView): string {
  const selection = view.state.selection.main;
  const firstLine = view.state.doc.lineAt(selection.from).number;
  const lastLine = view.state.doc.lineAt(selection.to).number;
  // Large selections already expose Markdown source. Avoid scanning an
  // unbounded selection merely to decide whether decorations need refreshing.
  if (lastLine - firstLine > 64) return `wide:${selection.from}:${selection.to}`;
  const touched: string[] = [];
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
    const line = view.state.doc.line(lineNumber);
    FOOTNOTE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FOOTNOTE_RE.exec(line.text)) !== null) {
      const from = line.from + match.index;
      const to = from + match[0].length;
      if (selection.empty
        ? selection.from >= from && selection.from <= to
        : selection.from < to && selection.to > from) {
        touched.push(`${from}:${to}`);
      }
    }
  }
  return touched.join(",");
}

function buildFootnoteDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const excluded = excludedRanges(view);
  const seenLines = new Set<number>();
  let count = 0;

  for (const visible of view.visibleRanges) {
    const first = view.state.doc.lineAt(visible.from).number;
    const last = view.state.doc.lineAt(Math.min(visible.to, view.state.doc.length)).number;
    for (let lineNumber = first; lineNumber <= last && count < MAX_VIEWPORT_FOOTNOTES; lineNumber++) {
      if (seenLines.has(lineNumber)) continue;
      seenLines.add(lineNumber);
      const line = view.state.doc.line(lineNumber);
      const definition = FOOTNOTE_DEFINITION_RE.exec(line.text);
      const definitionEnd = definition ? (definition[0]?.length ?? 0) : 0;
      if (definition && definitionEnd > 0) {
        const from = line.from + definition[0]!.indexOf("[^");
        const to = line.from + definitionEnd;
        if (!rangeInsideAny(from, to, excluded) && !selectionTouches(view, from, to)) {
          decorations.push(Decoration.replace({
            widget: new FootnoteDefinitionWidget(definition[1]!),
          }).range(from, to));
          count++;
        }
      }

      FOOTNOTE_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while (count < MAX_VIEWPORT_FOOTNOTES && (match = FOOTNOTE_RE.exec(line.text)) !== null) {
        if (definition && match.index < definitionEnd) continue;
        const from = line.from + match.index;
        const to = from + match[0].length;
        if (rangeInsideAny(from, to, excluded) || selectionTouches(view, from, to)) continue;
        decorations.push(Decoration.replace({
          widget: new FootnoteReferenceWidget(match[1]!, from),
        }).range(from, to));
        count++;
      }
    }
  }

  decorations.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decorations, true);
}

class FootnotePlugin {
  decorations: DecorationSet;
  activeSourceKey: string;

  constructor(view: EditorView) {
    this.decorations = buildFootnoteDecorations(view);
    this.activeSourceKey = activeFootnoteSourceKey(view);
  }

  update(update: ViewUpdate): void {
    if (update.view.compositionStarted && update.selectionSet && !update.docChanged && !update.viewportChanged) return;
    const nextSourceKey = update.selectionSet || update.docChanged
      ? activeFootnoteSourceKey(update.view)
      : this.activeSourceKey;
    if (update.docChanged
      || update.viewportChanged
      || nextSourceKey !== this.activeSourceKey
      || hasViewportDecorationRefresh(update)) {
      this.decorations = buildFootnoteDecorations(update.view);
    }
    this.activeSourceKey = nextSourceKey;
  }
}

export const footnoteExtension = ViewPlugin.fromClass(FootnotePlugin, {
  decorations: (plugin) => plugin.decorations,
});
