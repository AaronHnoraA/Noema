/**
 * Standard Markdown footnote preview: `[^id]` and `[^id]: definition`.
 *
 * The visual pass is viewport-only and never rewrites source. It uses the
 * document's Markdown definition index for both native and rendered blocks.
 */

import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { MapMode, StateEffect, StateField, type Range, type Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { inlineConstruct } from "../constructs/index.ts";
import { literalRangesOnLine } from "../constructs/literal-ranges.ts";
import { constructViewPlugin } from "../constructs/view-plugin.ts";
import { documentReferencesForText, renderedDocumentReferences } from "../document-references.ts";
import { getFencedCodeRanges } from "../../../code-ranges.ts";
import { rangeInsideAny } from "../../../math-ranges.ts";
import { isEscapedCommandStart, scanInlineCommands } from "../../../../command-syntax.ts";

const FOOTNOTE_RE = /\[\^([^\]\n]{1,128})\]/g;
const FOOTNOTE_DEFINITION_RE = /^\s*\[\^([^\]\n]{1,128})\]:/;
const MAX_VIEWPORT_FOOTNOTES = 2_000;
const MAX_INDEXED_LINES = 50_000;
const nonReferencingCommands = new Set(["hidden", "todo", "itodo", "comment", "scomment"]);

const referenceIndexCache = new WeakMap<Text, ReadonlyMap<string, readonly number[]>>();
const rememberReference = StateEffect.define<{ label: string; position: number }>();
const footnoteReturnPositions = StateField.define<ReadonlyMap<string, number>>({
  create: () => new Map(),
  update(previous, transaction) {
    const remembered = transaction.effects.find((effect) => effect.is(rememberReference))?.value;
    if (!remembered && (!transaction.docChanged || !previous.size)) return previous;
    const positions = new Map<string, number>();
    for (const [label, from] of previous) {
      const position = transaction.changes.mapPos(from, 1, MapMode.TrackAfter);
      if (position !== null) positions.set(label, position);
    }
    if (remembered) positions.set(remembered.label, remembered.position);
    return positions;
  },
});

function excludedCommands(text: string): { from: number; to: number }[] {
  return scanInlineCommands(text).filter((command) => nonReferencingCommands.has(command.name))
    .map((command) => ({ from: command.fullFrom, to: command.fullTo }));
}

/**
 * The text of footnote LABEL's definition, for the reference's tooltip: the
 * definition line after `[^label]:` and its indented continuation lines,
 * capped. MarkText's footnote tool and GitHub show the note on the reference.
 */
export function footnoteDefinitionPreview(doc: Text, label: string, limit = 400): string | null {
  const definition = documentReferencesForText(doc)?.footnotes.get(label);
  if (!definition) return null;
  const parts = definition.body.split("\n", 9).map((line) => line.trim());
  const preview = parts.filter(Boolean).join(" ");
  return preview.length > limit ? `${preview.slice(0, limit - 1)}…` : preview;
}

function referenceIndex(view: EditorView): ReadonlyMap<string, readonly number[]> {
  const { doc } = view.state;
  const cached = referenceIndexCache.get(doc);
  if (cached) return cached;
  const index = new Map<string, number[]>();
  const fenced = getFencedCodeRanges(view.state);
  let fence = 0;
  const lastLine = Math.min(doc.lines, MAX_INDEXED_LINES);
  for (let lineNumber = 1; lineNumber <= lastLine; lineNumber++) {
    const line = doc.line(lineNumber);
    if (!line.text.includes("[^")) continue;
    const definition = FOOTNOTE_DEFINITION_RE.exec(line.text);
    while (fenced[fence] && fenced[fence]!.to <= line.from) fence++;
    if (fenced[fence] && fenced[fence]!.from <= line.from) continue;
    const literal = literalRangesOnLine(view.state, line);
    const excluded = excludedCommands(line.text);
    const definitionEnd = definition?.[0].length ?? 0;
    FOOTNOTE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FOOTNOTE_RE.exec(line.text)) !== null) {
      if (definition && match.index < definitionEnd) continue;
      if (isEscapedCommandStart(line.text, match.index)) continue;
      if (rangeInsideAny(match.index, match.index + match[0].length, excluded)) continue;
      const from = line.from + match.index;
      if (rangeInsideAny(from, from + match[0].length, literal)) continue;
      const values = index.get(match[1]!) ?? [];
      if (values.length < 256) values.push(from);
      index.set(match[1]!, values);
    }
  }
  referenceIndexCache.set(doc, index);
  return index;
}

export function jumpToFootnoteDefinition(view: EditorView, label: string, from: number, to = from, occurrence = 0): boolean {
  const { doc } = view.state;
  const definition = documentReferencesForText(doc)?.footnotes.get(label);
  if (!definition) return false;
  const positions = to === from ? [] : referenceIndex(view).get(label)?.filter((position) => position >= from && position <= to) ?? [];
  view.dispatch({
    selection: { anchor: doc.line(definition.line + 1).from },
    effects: rememberReference.of({ label, position: positions[occurrence] ?? positions[0] ?? from }),
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

export function jumpBackFromFootnote(view: EditorView, label: string): boolean {
  const previous = view.state.field(footnoteReturnPositions, false)?.get(label);
  const references = referenceIndex(view).get(label);
  const target = previous !== undefined && references?.includes(previous) ? previous : references?.[0];
  if (target == null) return false;
  view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
  view.focus();
  return true;
}

class FootnoteReferenceWidget extends WidgetType {
  readonly label: string;
  readonly from: number;
  readonly number: number | undefined;
  constructor(label: string, from: number, number: number | undefined) {
    super();
    this.label = label;
    this.from = from;
    this.number = number;
  }

  eq(other: FootnoteReferenceWidget): boolean {
    return this.label === other.label && this.from === other.from && this.number === other.number;
  }

  toDOM(view: EditorView): HTMLElement {
    const sup = document.createElement("sup");
    sup.className = "cm-footnote-reference";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(this.number ?? this.label);
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
      jumpToFootnoteDefinition(view, this.label, this.from);
    });
    sup.append(button);
    return sup;
  }

  ignoreEvent(): boolean { return true; }
}

class FootnoteDefinitionWidget extends WidgetType {
  readonly label: string;
  readonly number: number | undefined;
  constructor(label: string, number: number | undefined) {
    super();
    this.label = label;
    this.number = number;
  }

  eq(other: FootnoteDefinitionWidget): boolean { return this.label === other.label && this.number === other.number; }

  toDOM(): HTMLElement {
    const badge = document.createElement("span");
    badge.className = "cm-footnote-definition-label";
    badge.title = `Footnote ${this.label}`;
    badge.textContent = this.number == null ? this.label : `${this.number}.`;
    return badge;
  }

  ignoreEvent(): boolean { return true; }
}

class FootnoteReturnWidget extends WidgetType {
  readonly label: string;
  constructor(label: string) {
    super();
    this.label = label;
  }

  eq(other: FootnoteReturnWidget): boolean { return this.label === other.label; }

  toDOM(view: EditorView): HTMLElement {
    const back = document.createElement("button");
    back.className = "cm-footnote-return";
    back.type = "button";
    back.textContent = "↩";
    back.title = `Back to footnote reference ${this.label}`;
    back.setAttribute("aria-label", back.title);
    back.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
    back.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      jumpBackFromFootnote(view, this.label);
    });
    return back;
  }

  ignoreEvent(): boolean { return true; }
}

const footnoteReturns = constructViewPlugin({
  build(view) {
    const { state } = view;
    if (!state.field(renderedDocumentReferences, false)?.footnotes.size) return Decoration.none;
    const ranges: Range<Decoration>[] = [];
    const visited = new Set<number>();
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from, to,
        enter(node) {
          if (node.name !== "FootnoteDefinition" || node.to > to || visited.has(node.from)) return;
          visited.add(node.from);
          const label = FOOTNOTE_DEFINITION_RE.exec(state.doc.lineAt(node.from).text)?.[1];
          if (label) ranges.push(Decoration.widget({ widget: new FootnoteReturnWidget(label), side: 1 }).range(node.to));
        },
      });
    }
    return Decoration.set(ranges, true);
  },
});

export const footnoteExtension = [footnoteReturnPositions, footnoteReturns, inlineConstruct({
  kind: "footnote",
  reveal: "edge",
  maxPerViewport: MAX_VIEWPORT_FOOTNOTES,
  *match(line, state) {
    if (!line.text.includes("[^")) return;
    const footnotes = state.field(renderedDocumentReferences, false)?.footnotes;
    const definition = FOOTNOTE_DEFINITION_RE.exec(line.text);
    const definitionEnd = definition ? definition[0].length : 0;
    if (definition && definitionEnd > 0) {
      const label = definition[1]!;
      yield {
        from: line.from + definition[0].indexOf("[^"),
        to: line.from + definitionEnd,
        widget: () => new FootnoteDefinitionWidget(label, footnotes?.get(label)?.number),
      };
    }
    FOOTNOTE_RE.lastIndex = 0;
    const excluded = excludedCommands(line.text);
    for (let match = FOOTNOTE_RE.exec(line.text); match; match = FOOTNOTE_RE.exec(line.text)) {
      // The definition's own `[^label]` is part of the definition construct.
      if (match.index < definitionEnd || isEscapedCommandStart(line.text, match.index)) continue;
      if (rangeInsideAny(match.index, match.index + match[0].length, excluded)) continue;
      const from = line.from + match.index;
      const label = match[1]!;
      yield { from, to: from + match[0].length, widget: () => new FootnoteReferenceWidget(label, from, footnotes?.get(label)?.number) };
    }
  },
})];
