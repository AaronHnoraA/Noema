/** Native Noema authoring templates shared by commands and snippets. */

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
    body: '@@revision(${1|indigo,teal,red,green,yellow|}) [${2:original}] {advice: "${3:replacement}"; reason: "${4:reason}"}$0',
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

export function revisionSource(original: string, options: RevisionSourceOptions): string {
  const allowed = new Set(["indigo", "teal", "red", "green", "yellow"]);
  const style = allowed.has(String(options.style || "").toLowerCase())
    ? String(options.style).toLowerCase()
    : "indigo";
  const attrs = [`advice: "${escapeRevisionAttribute(options.advice)}"`];
  if (options.reason?.trim()) attrs.push(`reason: "${escapeRevisionAttribute(options.reason)}"`);
  return `@@revision(${style}) [${escapeRevisionContext(original)}] {${attrs.join("; ")}}`;
}
