/**
 * Standard Markdown footnote preview: `[^id]` and `[^id]: definition`.
 *
 * The visual pass is viewport-only and never rewrites source.  A definition
 * index is built lazily only when a reference is clicked, then cached by CM6's
 * immutable Text identity.  Both decoration and click-time scans have caps.
 */

import { EditorView, WidgetType } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { inlineConstruct } from "../constructs/index.ts";

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

/**
 * The text of footnote LABEL's definition, for the reference's tooltip: the
 * definition line after `[^label]:` and its indented continuation lines,
 * capped. MarkText's footnote tool and GitHub show the note on the reference.
 */
export function footnoteDefinitionPreview(doc: Text, label: string, limit = 400): string | null {
  const position = definitionIndex(doc).get(label);
  if (position == null) return null;
  const first = doc.lineAt(position);
  const parts = [first.text.replace(FOOTNOTE_DEFINITION_RE, "").trim()];
  for (let number = first.number + 1; number <= doc.lines && number - first.number <= 8; number++) {
    const text = doc.line(number).text;
    if (!/^(?: {2,}|\t)\S/u.test(text)) break;
    parts.push(text.trim());
  }
  const preview = parts.filter(Boolean).join(" ");
  return preview.length > limit ? `${preview.slice(0, limit - 1)}…` : preview;
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
    // Read the definition only when the pointer arrives; rendering stays free.
    button.addEventListener("mouseenter", () => {
      const preview = footnoteDefinitionPreview(view.state.doc, this.label);
      button.title = preview == null
        ? `Footnote ${this.label} has no definition`
        : `${preview || `Footnote ${this.label}`}\n— click to jump`;
      button.classList.toggle("cm-footnote-undefined", preview == null);
    });
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

export const footnoteExtension = inlineConstruct({
  kind: "footnote",
  reveal: "edge",
  maxPerViewport: MAX_VIEWPORT_FOOTNOTES,
  *match(line) {
    if (!line.text.includes("[^")) return;
    const definition = FOOTNOTE_DEFINITION_RE.exec(line.text);
    const definitionEnd = definition ? definition[0].length : 0;
    if (definition && definitionEnd > 0) {
      const label = definition[1]!;
      yield {
        from: line.from + definition[0].indexOf("[^"),
        to: line.from + definitionEnd,
        widget: () => new FootnoteDefinitionWidget(label),
      };
    }
    FOOTNOTE_RE.lastIndex = 0;
    for (let match = FOOTNOTE_RE.exec(line.text); match; match = FOOTNOTE_RE.exec(line.text)) {
      // The definition's own `[^label]` is part of the definition construct.
      if (match.index < definitionEnd) continue;
      const from = line.from + match.index;
      const label = match[1]!;
      yield { from, to: from + match[0].length, widget: () => new FootnoteReferenceWidget(label, from) };
    }
  },
});
