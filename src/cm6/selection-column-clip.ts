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
  private readonly resizeObserver: ResizeObserver | null;
  private measuredWidth = -1;
  private measuredContentWidth = -1;

  constructor(view: EditorView) {
    this.view = view;
    this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      const width = view.scrollDOM.clientWidth;
      const contentWidth = view.contentDOM.clientWidth;
      if (width === this.measuredWidth && contentWidth === this.measuredContentWidth) return;
      this.schedule();
    });
    this.resizeObserver?.observe(view.scrollDOM);
    this.resizeObserver?.observe(view.contentDOM);
    this.schedule();
  }

  update(update: ViewUpdate): void {
    // Selection motion does not change column width. Measuring its rects on
    // every drag step forces WebKit to lay out the selection before painting
    // it. The observer covers CSS/page width changes outside CM6 updates.
    // Older webviews without ResizeObserver still get CM6's geometry signal.
    if (!this.resizeObserver && update.geometryChanged) this.schedule();
  }

  private schedule(): void {
    this.view.requestMeasure({
      key: this,
      read: measureColumn,
      write: (insets) => {
        this.measuredWidth = this.view.scrollDOM.clientWidth;
        this.measuredContentWidth = this.view.contentDOM.clientWidth;
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
    this.resizeObserver?.disconnect();
    this.view.scrollDOM.style.removeProperty("--noema-selection-inset-left");
    this.view.scrollDOM.style.removeProperty("--noema-selection-inset-right");
  }
});
