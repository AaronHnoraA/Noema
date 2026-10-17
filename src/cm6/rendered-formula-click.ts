import type { EditorView } from "@codemirror/view";
import { revealFormulaSource, type FormulaWidgetRange } from "./extensions/visual/widgets/math.ts";
import { preserveEditorViewport } from "./viewport-stability.ts";

/** The pointer's position within a rendered formula, shared by prose and tables. */
export function renderedFormulaClickRatio(source: Element, event: MouseEvent): number {
  const rect = source.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

/** Open the document formula at the clicked source offset, wherever it is drawn. */
export function openRenderedFormulaSource(
  view: EditorView,
  formula: FormulaWidgetRange,
  clickRatio = 0,
  viewportAnchor = formula.from,
): boolean {
  const length = formula.contentTo - formula.contentFrom;
  const offset = Math.round(length * clickRatio);
  return preserveEditorViewport(view, () => {
    if (!revealFormulaSource(view, formula.from, formula.to, offset)) return false;
    // CM6 must sync its new source selection before taking focus back from a
    // widget; focusing contentDOM directly lets WebKit replay the old caret.
    if (!formula.display) view.focus();
    return true;
  }, viewportAnchor);
}
