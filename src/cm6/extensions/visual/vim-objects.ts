import type { EditorView } from "@codemirror/view";

/** Keep a whitelisted widget rendered during Vim navigation and selection. */
export function vimKeepsRenderedObjects(view: EditorView): boolean {
  const mode = view.dom.dataset.vimMode;
  return mode === "normal" || mode === "visual" || mode === "visual-line";
}
