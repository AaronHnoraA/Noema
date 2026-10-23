import { scanBlockPropertyDefinitions } from "../shared/block-properties.mjs";

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

/**
 * Resolve a block location against the live CM6 source. UUIDv7 definitions
 * may have moved since the kernel snapshot when the current note has unsaved
 * edits, so prefer the portable source anchor and retain the kernel line as a
 * compatibility fallback for timestamp-shaped SiYuan IDs.
 */
export function markdownBlockSourceOffset(markdown: string, id: string, lineNumber: number): number {
  const canonicalId = String(id || "").trim().toLowerCase();
  const projection = scanBlockPropertyDefinitions(markdown);
  if (!projection.duplicateDefinitionIds.includes(canonicalId)) {
    const definition = projection.definitions.find((item) => item.canonicalId === canonicalId);
    if (definition) return markdownLineStartOffset(markdown, definition.line);
  }
  return markdownLineStartOffset(markdown, lineNumber);
}
