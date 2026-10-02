/**
 * "Type / for commands" on the empty line under the caret, as MarkText's
 * paragraph placeholder ("Type / to insert...") makes its quick-insert menu
 * discoverable. At most one line decoration, rebuilt only when the caret,
 * the document or focus changes; the hint is CSS-drawn and never measured.
 */

import { RangeSetBuilder, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

const CODE_NODES = new Set(["FencedCode", "CodeBlock", "IndentedCode", "CodeText", "HTMLBlock"]);

export const EMPTY_LINE_HINT = "Type / for commands";

/** The empty line that should carry the hint, or null. */
export function emptyLineHintLine(state: EditorState, focused: boolean): number | null {
  if (!focused || state.readOnly || state.selection.ranges.length !== 1) return null;
  const range = state.selection.main;
  if (!range.empty) return null;
  const line = state.doc.lineAt(range.head);
  if (line.length !== 0) return null;
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(line.from, 1); node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return null;
  }
  return line.from;
}

function hintDecorations(view: EditorView): DecorationSet {
  const at = emptyLineHintLine(view.state, view.hasFocus);
  const builder = new RangeSetBuilder<Decoration>();
  if (at != null) {
    builder.add(at, at, Decoration.line({ class: "cm-empty-line-hint", attributes: { "data-hint": EMPTY_LINE_HINT } }));
  }
  return builder.finish();
}

export const emptyLineHintExtension = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = hintDecorations(view); }
  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.focusChanged) this.decorations = hintDecorations(update.view);
  }
}, { decorations: (plugin) => plugin.decorations });
