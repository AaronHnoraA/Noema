// Comments as tasks (C79).
//
// A comment lives in the note, standing on its own (it is not a side
// comment, `@@scomment`):
//
//   … the passage it is about @@comment [the comment] {id: k3x9qa}
//   … @@comment(done) [the comment] {id: k3x9qa}             finished
//
// The body is the comment, `done` (the planning word) marks it finished, and
// `id` (six base36 characters, like a planning id) names it to the task
// record and to agents.  `@@comment(true)` keeps its old meaning, a comment
// shown open.  A comment without an id is still a comment; it is given one the
// first time it becomes a task.  The browser, the host, Agenda and Emacs read
// comments only through this module (Emacs mirrors `scanComments`, pinned by
// `comment-fixtures.json`).

import { scanInlineCommands } from "./command-syntax.mjs";

const ID_RE = /^[a-z0-9]{4,32}$/;

/** Return a fresh comment id: six base36 characters. */
export function newCommentId(random = Math.random) {
  return random().toString(36).slice(2, 8).padEnd(6, "0");
}

/** Escape TEXT for a command body: `\` and `]` are escaped, newlines are spaces. */
export function escapeCommentBody(text) {
  return String(text ?? "").replace(/\s*\n\s*/g, " ").replace(/\\/g, "\\\\").replace(/\]/g, "\\]").trim();
}

function unescapeBody(text) {
  return String(text ?? "").replace(/\\([\\\]])/g, "$1");
}

/** Return SOURCE with code fences, code spans and HTML comments blanked,
 * offsets kept: nothing inside them is a Noema form. */
function maskLiterals(source) {
  const chars = source.split("");
  const blank = (from, to) => { for (let i = from; i < to; i++) if (chars[i] !== "\n") chars[i] = " "; };
  let fence = null, offset = 0;
  for (const line of source.split("\n")) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (fence ? marker && marker[0] === fence[0] && marker.length >= fence.length : marker) {
      blank(offset, offset + line.length);
      fence = fence ? null : marker;
    } else if (fence) blank(offset, offset + line.length);
    offset += line.length + 1;
  }
  const masked = chars.join("");
  for (const match of masked.matchAll(/<!--[\s\S]*?-->|(`+)[^`\n]*?\1/g)) blank(match.index, match.index + match[0].length);
  return chars.join("");
}

/** Return the comments of SOURCE, in order:
 * {id, done, text, from, to, line, source, quote}.  QUOTE is the text just
 * before the comment on its line: what it is about. */
export function scanComments(source) {
  const text = String(source ?? "");
  const comments = [];
  let line = 1, at = 0;
  for (const command of scanInlineCommands(maskLiterals(text), "comment")) {
    if (command.name !== "comment") continue;
    for (; at < command.fullFrom; at++) if (text.charCodeAt(at) === 10) line++;
    const id = String(command.args?.id ?? "").trim().toLowerCase();
    const lineStart = text.lastIndexOf("\n", command.fullFrom - 1) + 1;
    comments.push({
      id: ID_RE.test(id) ? id : "",
      done: String(command.switchValue || "").trim().toLowerCase() === "done",
      text: unescapeBody(text.slice(command.contextFrom, command.contextTo)),
      from: command.fullFrom, to: command.fullTo, line,
      source: text.slice(command.fullFrom, command.fullTo),
      quote: text.slice(lineStart, command.fullFrom).trim().slice(-160),
    });
  }
  return comments;
}

/** Return the source of a comment with TEXT, ID and DONE. */
export function commentSource({ text, id, done = false }) {
  return `@@comment${done ? "(done)" : ""} [${escapeCommentBody(text)}] {id: ${id}}`;
}

/** Return the edit {oldText, newText} that sets COMMENT's state; it also
 * gives an id-less comment ID.  Only the head and the attributes change: the
 * comment's text stays exactly as written. */
export function commentEdit(comment, { done = comment.done, id = comment.id } = {}) {
  if (!id) throw new Error("A comment task needs an id");
  let next = comment.source.replace(/^@@comment(?:\([^)\n]*\))?/, done ? "@@comment(done)" : "@@comment");
  if (!comment.id) {
    next = /\}\s*$/.test(next) && /\]\s*\{[^]*\}\s*$/.test(next)
      ? next.replace(/\{\s*(?=[^{]*\}\s*$)/, (open) => `${open.trimEnd()}id: ${id}; `)
      : `${next} {id: ${id}}`;
  }
  return { oldText: comment.source, newText: next };
}

/** Return SOURCE's comment ID, or null. */
export function findComment(source, id) {
  return scanComments(source).find((comment) => comment.id === String(id).toLowerCase()) ?? null;
}
