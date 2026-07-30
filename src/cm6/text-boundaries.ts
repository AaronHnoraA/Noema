import { findClusterBreak, type Text } from "@codemirror/state";

/** Move to the start of the previous grapheme, crossing a line break as one unit. */
export function previousGraphemePosition(text: Text, pos: number): number {
  const cursor = Math.max(0, Math.min(pos, text.length));
  if (cursor === 0) return 0;
  const line = text.lineAt(cursor);
  if (cursor <= line.from) return cursor - 1;
  return line.from + findClusterBreak(line.text, cursor - line.from, false);
}

/** End of the grapheme at POS, without crossing the current line break. */
export function graphemeEndPosition(text: Text, pos: number): number {
  const cursor = Math.max(0, Math.min(pos, text.length));
  const line = text.lineAt(cursor);
  if (cursor >= line.to) return line.to;
  return line.from + findClusterBreak(line.text, cursor - line.from, true);
}

/** Move past the next grapheme, treating a line break as one deletable unit. */
export function nextGraphemePosition(text: Text, pos: number): number {
  const cursor = Math.max(0, Math.min(pos, text.length));
  const end = graphemeEndPosition(text, cursor);
  if (end > cursor) return end;
  return cursor < text.length ? cursor + 1 : cursor;
}
