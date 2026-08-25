/** Convert a kernel 1-based source line into the CM6 Markdown offset. */
export function markdownLineStartOffset(markdown: string, lineNumber: number): number {
  if (lineNumber <= 1) return 0;
  let line = 1;
  for (let offset = 0; offset < markdown.length; offset++) {
    if (markdown.charCodeAt(offset) !== 10) continue;
    line++;
    if (line === lineNumber) return offset + 1;
  }
  return markdown.length;
}
