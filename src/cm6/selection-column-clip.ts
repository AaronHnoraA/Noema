/**
 * Keeps the painted selection inside the text column.
 *
 * `drawSelection` sizes the full-line pieces of a selection from the content
 * box. The page margins here are padding on that box (and a gutter sits
 * before it), so those pieces reached into both margins while the first and
 * last rows followed the text: one selection drawn in two shapes. The layer
 * is clipped to the column instead (`.cm-selectionLayer` in `widgets.css`);
 * this plugin measures the column and publishes it as CSS variables.
 */

import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

type ColumnInsets = { left: number; right: number };

function measureColumn(view: EditorView): ColumnInsets | null {
  const scroller = view.scrollDOM.getBoundingClientRect();
  const content = view.contentDOM.getBoundingClientRect();
  if (scroller.width <= 0 || content.width <= 0) return null;
  const style = getComputedStyle(view.contentDOM);
  return {
    left: Math.max(0, content.left - scroller.left + (Number.parseFloat(style.paddingLeft) || 0)),
    right: Math.max(0, scroller.right - content.right + (Number.parseFloat(style.paddingRight) || 0)),
  };
}

export const selectionColumnClip = ViewPlugin.fromClass(class {
  private left = -1;
  private right = -1;
  private readonly view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.schedule();
  }

  update(update: ViewUpdate): void {
    // The margin follows the page width through CSS, which no update
    // announces, so measure again whenever a selection is about to be drawn.
    // A caret has no layer to clip and costs nothing here.
    const drawn = update.selectionSet && update.state.selection.ranges.some((range) => !range.empty);
    if (drawn || update.geometryChanged || update.viewportChanged) this.schedule();
  }

  private schedule(): void {
    this.view.requestMeasure({
      key: this,
      read: measureColumn,
      write: (insets) => {
        if (!insets || (insets.left === this.left && insets.right === this.right)) return;
        this.left = insets.left;
        this.right = insets.right;
        // On the scroller, the layer's parent: the editor element's inline
        // style is rewritten whole by `editorAttributes`.
        this.view.scrollDOM.style.setProperty("--noema-selection-inset-left", `${insets.left}px`);
        this.view.scrollDOM.style.setProperty("--noema-selection-inset-right", `${insets.right}px`);
      },
    });
  }

  destroy(): void {
    this.view.scrollDOM.style.removeProperty("--noema-selection-inset-left");
    this.view.scrollDOM.style.removeProperty("--noema-selection-inset-right");
  }
});
