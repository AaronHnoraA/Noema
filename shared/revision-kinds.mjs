/**
 * Canonical `@@revision(kind)` vocabulary.
 *
 * The switch used to name one of five arbitrary colours, which changed nothing
 * but a two-pixel underline in the editor and was dropped entirely by the LaTeX
 * exporter. Each entry now names a review intent that every renderer — editor
 * decoration, HTML export, and LaTeX export — presents distinctly.
 *
 * `legacy` keeps notes written against the old colour names rendering exactly
 * as they did: each colour maps to the intent that already carried its hue.
 */

export const REVISION_KINDS = [
  { id: "suggest", label: "Suggest", latexLabel: "REV", color: "#8f82ff", latexColor: "6558D3", legacy: "indigo" },
  { id: "question", label: "Question", latexLabel: "Q", color: "#d4b34f", latexColor: "A8791F", legacy: "yellow" },
  { id: "error", label: "Error", latexLabel: "ERR", color: "#ef6f7b", latexColor: "C0392B", legacy: "red" },
  { id: "ok", label: "Resolved", latexLabel: "OK", color: "#69c786", latexColor: "2E7D4F", legacy: "green" },
  { id: "note", label: "Note", latexLabel: "NOTE", color: "#3cc9bb", latexColor: "17807A", legacy: "teal" },
];

export const DEFAULT_REVISION_KIND = "suggest";

const BY_NAME = new Map();
for (const kind of REVISION_KINDS) {
  BY_NAME.set(kind.id, kind);
  BY_NAME.set(kind.legacy, kind);
}

/** Normalize an authored switch value to a canonical kind id. */
export function revisionKindId(value) {
  return (BY_NAME.get(String(value || "").trim().toLowerCase()) || BY_NAME.get(DEFAULT_REVISION_KIND)).id;
}

/** The full descriptor for an authored switch value. */
export function revisionKind(value) {
  return BY_NAME.get(String(value || "").trim().toLowerCase()) || BY_NAME.get(DEFAULT_REVISION_KIND);
}
