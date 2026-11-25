import { StateField, type EditorState, type Extension, type Text, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { indexQuotedCallouts, renderEditorWidgetHTML, type MarkdownDocumentReferences } from "../../../../render-html.ts";
import { disconnectDocumentTableViews } from "../../../../document-table-view.ts";
import { preserveEditorViewport } from "../../../viewport-stability.ts";
import { drawnConstructSource, constructSources, selectionOpensSource, transactionChangesPinning } from "../constructs/index.ts";
import { persistentVisualStateField } from "../visual-mode.ts";
import { passiveReaderFacet, pointerSelectionEffect } from "../selection.ts";
import { renderedDocumentReferences } from "../document-references.ts";
import { blockExtraReplacesRange, enhanceRenderedMarkdown } from "./block-extras.ts";
import { MeasuredWidget } from "./measured-widget.ts";
import { shortHash } from "./measured-observer.ts";

const marker = /^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)*>[ \t>]*\[!/m;
type CalloutRange = { from: number; to: number };
type CalloutState = { candidates: boolean; ranges: readonly CalloutRange[]; decorations: DecorationSet };

function markerNear(doc: Text, from: number, to: number): boolean {
  return marker.test(doc.sliceString(doc.lineAt(from).from, doc.lineAt(to).to));
}

class QuotedCalloutWidget extends MeasuredWidget {
  readonly source: string;
  readonly from: number;
  readonly to: number;
  readonly references: MarkdownDocumentReferences | null | undefined;

  constructor(source: string, from: number, to: number, references?: MarkdownDocumentReferences | null) {
    super();
    this.source = source;
    this.from = from;
    this.to = to;
    this.references = references;
  }

  protected measureKey(): string { return "quoted-callout:" + shortHash(this.source); }
  protected estimatedHeightFallback(): number { return 80; }
  eq(other: QuotedCalloutWidget): boolean { return this.source === other.source && this.references === other.references; }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "noema-callout-widget";
    root.dataset.cmSourceFrom = String(this.from);
    root.dataset.cmSourceTo = String(this.to);
    root.dataset.cmOpenSource = "true";
    root.innerHTML = renderEditorWidgetHTML(this.source, undefined, this.references);
    enhanceRenderedMarkdown(root, view);
    const position = () => view.posAtDOM(root, -1);
    if (root.querySelector("details.callout") && !view.state.readOnly && !view.state.facet(passiveReaderFacet)) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "noema-disclosure-edit";
      edit.textContent = "</>";
      edit.title = "Edit source";
      edit.setAttribute("aria-label", "Edit source");
      edit.addEventListener("click", () => {
        const from = position();
        preserveEditorViewport(view, () => {
          view.dispatch({ selection: { anchor: from } });
          view.focus();
        }, from);
      });
      root.append(edit);
    }
    return this.registerMeasured(root, view);
  }

  ignoreEvent(event: Event): boolean {
    return event.target instanceof Element && !!event.target.closest("a[href], summary, button");
  }

  override destroy(dom: HTMLElement): void {
    disconnectDocumentTableViews(dom);
    super.destroy(dom);
  }
}

function displaysQuotedCallout(state: EditorState, { from, to }: CalloutRange): boolean {
  return !selectionOpensSource(state, from, to, "caret-edge", "structure") && !blockExtraReplacesRange(state, from, to);
}

function renderRanges(state: EditorState, ranges: readonly CalloutRange[]): DecorationSet {
  return Decoration.set(ranges.filter((range) => displaysQuotedCallout(state, range)).map(({ from, to }) =>
    Decoration.replace({ block: true, widget: new QuotedCalloutWidget(
      state.doc.sliceString(from, to), from, to, state.field(renderedDocumentReferences, false),
    ) }).range(from, to)));
}

function createQuotedCallouts(state: EditorState): CalloutState {
  const markdown = state.doc.toString();
  const candidates = marker.test(markdown);
  const ranges = candidates ? indexQuotedCallouts(markdown).ranges : [];
  return { candidates, ranges, decorations: renderRanges(state, ranges) };
}

function needsRescan(tr: Transaction): boolean {
  let changed = false;
  tr.changes.iterChanges((from, to, nextFrom, nextTo, inserted) => {
    if (changed) return;
    const doc = tr.startState.doc;
    const next = tr.state.doc;
    const oldLine = doc.lineAt(from);
    const newLine = next.lineAt(nextFrom);
    // Plain typing after the block prefixes cannot change where the quote
    // or list item starts. Structural edits reparse against the HTML grammar.
    changed = !/^[\p{L}\p{N} ]*$/u.test(doc.sliceString(from, to))
      || !/^[\p{L}\p{N} ]*$/u.test(inserted.toString())
      || from <= oldLine.from + (oldLine.text.match(/^\s*/)?.[0].length ?? 0)
      || nextFrom <= newLine.from + (newLine.text.match(/^\s*/)?.[0].length ?? 0)
      || markerNear(doc, from, to) || markerNear(next, nextFrom, nextTo);
  });
  return changed;
}

const quotedCalloutField = StateField.define<CalloutState>({
  create: createQuotedCallouts,
  update(previous, tr) {
    if (tr.docChanged) {
      let candidates = previous.candidates;
      if (!candidates) tr.changes.iterChangedRanges((_from, _to, from, to) => {
        if (!candidates) candidates = markerNear(tr.state.doc, from, to);
      });
      if (!candidates) return previous;
      if (!previous.candidates || needsRescan(tr)) return createQuotedCallouts(tr.state);
      const ranges = previous.ranges.map(({ from, to }) => ({ from: tr.changes.mapPos(from, 1), to: tr.changes.mapPos(to, 1) }));
      return { ...previous, ranges, decorations: renderRanges(tr.state, ranges) };
    }
    if (!previous.candidates) return previous;
    if (tr.selection || tr.effects.some((effect) => effect.is(pointerSelectionEffect)) || transactionChangesPinning(tr)) {
      if (previous.ranges.some((range) => displaysQuotedCallout(tr.startState, range) !== displaysQuotedCallout(tr.state, range))) {
        return { ...previous, decorations: renderRanges(tr.state, previous.ranges) };
      }
    }
    return previous;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export const quotedCalloutExtension: Extension = [
  persistentVisualStateField(quotedCalloutField, createQuotedCallouts),
  constructSources.of(drawnConstructSource("quoted-callout", "structure", (state) => state.field(quotedCalloutField, false)?.decorations)),
];
