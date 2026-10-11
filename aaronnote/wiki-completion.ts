// Which page a typed `[[` means, and how the link to it is written, is the
// kernel's answer (kernel/noema/wikisearch, mode "references").  This module
// only recognises that a Wiki link is being typed at the cursor.

export type WikiLinkCompletionContext = {
  prefix: string;
  hasClosingDelimiter: boolean;
};

/**
 * Find the Wiki target containing the cursor. This deliberately supports both
 * `[[partial|` and the common "type the pair first" form `[[partial|]]`.
 */
export function wikiLinkCompletionContext(before: string, after = ""): WikiLinkCompletionContext | null {
  const line = String(before || "").slice(String(before || "").lastIndexOf("\n") + 1);
  const open = line.lastIndexOf("[[");
  if (open < 0 || line.lastIndexOf("]]" ) > open) return null;
  const prefix = line.slice(open + 2);
  if (prefix.includes("[[") || prefix.includes("|") || /[\r\n]/.test(prefix)) return null;
  return { prefix, hasClosingDelimiter: String(after || "").startsWith("]]" ) };
}
