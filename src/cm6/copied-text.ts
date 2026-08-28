import type { EditorState } from "@codemirror/state";

/**
 * The text a copy or cut takes from STATE, matching CodeMirror's own rule.
 *
 * Non-empty ranges are joined with the document line break. When every range is
 * empty, CodeMirror copies whole lines instead, deduplicated by line number, so
 * a bare Cmd-C with no selection still yields the cursor's line.
 */
export function copiedText(state: EditorState): string {
  const parts: string[] = [];
  for (const range of state.selection.ranges) {
    if (!range.empty) parts.push(state.sliceDoc(range.from, range.to));
  }
  if (parts.length > 0) return parts.join(state.lineBreak);

  let previousLine = -1;
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.from);
    if (line.number > previousLine) parts.push(line.text);
    previousLine = line.number;
  }
  return parts.join(state.lineBreak);
}
