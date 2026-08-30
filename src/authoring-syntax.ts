/** Native Noema authoring templates shared by commands and snippets. */

import { DEFAULT_REVISION_KIND, revisionKindOf, revisionKinds } from "./revision-kinds.ts";

export type AaronnoteSnippetContext = "prose" | "org-meta" | "markdown";

export type AaronnoteBuiltinSnippet = {
  key: string;
  name: string;
  body: string;
  context: AaronnoteSnippetContext;
};

export const AARONNOTE_AUTHORING_SNIPPETS: readonly AaronnoteBuiltinSnippet[] = [
  {
    key: "meta",
    name: "Noema metadata",
    body: "#+begin meta\ntitle: ${1:Title}\ntags: ${2:}\n#+end meta\n\n$0",
    context: "markdown",
  },
  { key: "metafield", name: "Metadata property", body: "${1:key}: ${2:value}$0", context: "org-meta" },
  {
    key: "summary",
    name: "Metadata summary",
    body: "#+begin summary ${1:Abstract}\n${2:Summary.}\n#+end summary\n$0",
    context: "org-meta",
  },
  {
    key: "rev",
    name: "Revision suggestion",
    body: `@@revision(\${1|${revisionKinds.map((kind) => kind.id).join(",")}|}) [\${2:original}] {advice: "\${3:replacement}"; reason: "\${4:reason}"}$0`,
    context: "prose",
  },
  { key: "sup", name: "Superscript", body: "^${1:text}^$0", context: "prose" },
  { key: "sub", name: "Subscript", body: "~${1:text}~$0", context: "prose" },
  { key: "fnref", name: "Footnote reference", body: "[^${1:id}]$0", context: "prose" },
  { key: "fndef", name: "Footnote definition", body: "[^${1:id}]: ${2:definition}$0", context: "markdown" },
] as const;

export type RevisionSourceOptions = {
  advice: string;
  reason?: string;
  style?: string;
};

function escapeRevisionAttribute(value: string): string {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

function escapeRevisionContext(value: string): string {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\]/g, "\\]").replace(/\r?\n/g, " ");
}

/**
 * Inverses of the escapers above, matching the exporter exactly.
 *
 * The command parser already unescapes `\"` inside a quoted attribute but leaves
 * `\\` alone, and it never unescapes the `\]` that only the bracketed context
 * needs. Decoding an attribute as if it were a context would corrupt a
 * suggestion that legitimately contains `\]`.
 */
export function decodeRevisionContext(value: string): string {
  return String(value || "").replace(/\\\]/g, "]").replace(/\\\\/g, "\\");
}

export function decodeRevisionAttribute(value: string): string {
  return String(value || "").replace(/\\\\/g, "\\");
}

export function revisionSource(original: string, options: RevisionSourceOptions): string {
  // Legacy colour spellings normalize to the review kind that already carried
  // that hue, so rewriting an old revision never changes how it renders.
  const kind = revisionKindOf(String(options.style || DEFAULT_REVISION_KIND)).id;
  const attrs = [`advice: "${escapeRevisionAttribute(options.advice)}"`];
  if (options.reason?.trim()) attrs.push(`reason: "${escapeRevisionAttribute(options.reason)}"`);
  return `@@revision(${kind}) [${escapeRevisionContext(original)}] {${attrs.join("; ")}}`;
}

/**
 * Span of the `advice` value inside a source produced by `revisionSource`.
 *
 * The suggestion is the field an author actually came to write, and it lives
 * inside a quoted attribute that is awkward to reach by hand. Callers use this
 * to land the selection on it.
 */
export function revisionAdviceRange(source: string): { from: number; to: number } | null {
  const marker = 'advice: "';
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const from = start + marker.length;
  for (let index = from; index < source.length; index += 1) {
    if (source[index] === "\\") { index += 1; continue; }
    if (source[index] === '"') return { from, to: index };
  }
  return null;
}
