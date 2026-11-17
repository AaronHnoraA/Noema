// Comment anchors in Markdown (Google Docs-style comments, C70).
//
//   {==the commented text==}{>>#c-20261117-ab12<<}
//
// The CriticMarkup highlight marks what a comment is about and the comment
// mark carries only the thread id; the conversation lives in the folder's
// `.noema-comments.jsonl`.  Every reader that is not the editor sees the
// commented text alone: export, the Wiki index and plain previews strip the
// markers.  One anchor stays on one line and anchors do not nest.

export const COMMENT_ID_RE = /^c-[A-Za-z0-9_-]{4,64}$/;
const ANCHOR_RE = /\{==([^\n]*?)==\}\{>>#(c-[A-Za-z0-9_-]{4,64})<<\}/g;

/** Return every anchor of SOURCE as {from, to, textFrom, textTo, text, id}. */
export function scanCommentAnchors(source) {
  const text = String(source ?? "");
  const anchors = [];
  for (const match of text.matchAll(ANCHOR_RE)) {
    const from = match.index;
    const textFrom = from + 3;
    const textTo = textFrom + match[1].length;
    anchors.push({ from, to: from + match[0].length, textFrom, textTo, text: match[1], id: match[2] });
  }
  return anchors;
}

/** Return SOURCE with each anchor replaced by its commented text. */
export function stripCommentAnchors(source) {
  return String(source ?? "").replace(ANCHOR_RE, "$1");
}

/** Return the source that wraps TEXT in an anchor for thread ID. */
export function commentAnchor(text, id) {
  if (!COMMENT_ID_RE.test(id)) throw new Error("Invalid comment id");
  if (/\n/.test(text)) throw new Error("A comment anchor stays on one line");
  if (/==\}|\{==/.test(text)) throw new Error("Comment anchors do not nest");
  return `{==${text}==}{>>#${id}<<}`;
}

/** Return a fresh comment thread id. */
export function newCommentId(now = new Date(), random = Math.random) {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `c-${stamp}-${Math.floor(random() * 0xffffff).toString(16).padStart(6, "0")}`;
}
