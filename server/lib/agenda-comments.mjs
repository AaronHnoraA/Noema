// Comments as Agenda items (C77).
//
// An open comment thread of a note is a task of that note's Agenda scope.  Its
// first message is the title and may end in planning attributes written as in
// the DSL (`Prove the bound {ddl: fri, prio: A}`), so a comment is found,
// filtered, sorted and scheduled like any `@@todo`.  Marking it done resolves
// the thread; setting it back to todo reopens it.  Nothing is written into the
// note: the thread lives in the folder journal (C70).

import { createHash } from "node:crypto";
import { scanCommentAnchors } from "../../shared/comment-anchors.mjs";

const failure = (message, statusCode = 422) => Object.assign(new Error(message), { statusCode });
const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Return {id: line} of the comment anchors in a note's CONTENT. */
export function commentAnchorLines(content) {
  const text = String(content ?? "");
  const lines = {};
  let line = 1, at = 0;
  for (const anchor of scanCommentAnchors(text)) {
    for (; at < anchor.from; at++) if (text.charCodeAt(at) === 10) line++;
    lines[anchor.id] ??= line;
  }
  return lines;
}

/** Split a comment's first message into a one-line title and DSL attributes. */
export function commentTitle(text) {
  const first = String(text ?? "").trim().split("\n")[0].trim();
  const match = first.match(/^(.*?)\s*(\{[^{}]*\})\s*$/);
  const title = (match ? match[1] : first).replace(/\[/g, "(").replace(/\]/g, ")").trim() || "Comment";
  return { title, attrs: match ? match[2] : "" };
}

/** Return the Agenda todos of FILE's open THREADS.
 * EXTRACT is the Markdown planning parser, NOTE its note record, and LINES
 * the anchor lines of the note's current text. */
export function commentTodos(file, threads, { extract, note, lines = {} }) {
  const todos = [];
  for (const thread of threads) {
    if (thread.status === "resolved" || thread.archived || thread.author?.kind === "agent") continue;
    const { title, attrs } = commentTitle(thread.messages?.[0]?.text);
    const source = `@@todo(todo) [${title}]${attrs ? " " + attrs : ""}`;
    const [todo] = extract(`${source}\n`, note, 0).todos || [];
    if (!todo) continue;
    const line = lines[thread.id] ?? 1;
    const replies = Math.max(0, (thread.messages?.length || 1) - 1);
    todos.push({
      ...todo,
      id: `#${thread.id}`, commentId: thread.id, sourceKind: "comment",
      line, column: 1, context: thread.quote ? `«${thread.quote}»` : todo.context,
      quote: thread.quote || "", assignee: thread.assignee?.name || "", replies,
      inlineTags: [...(todo.inlineTags || []), "comment"],
      updatedAt: Date.parse(thread.messages?.at(-1)?.at || thread.createdAt || "") || 0,
      sourceRevision: hash(JSON.stringify([thread.status, thread.messages])),
    });
  }
  return todos;
}

/** Return "resolve" or "reopen" for an Agenda PATCH of a comment, or throw. */
export function commentPatchAction(patch = {}) {
  const keys = Object.keys(patch);
  if (keys.length === 1 && keys[0] === "op" && patch.op === "complete") return "resolve";
  if (keys.length === 1 && keys[0] === "status") {
    if (["done", "cancelled"].includes(patch.status)) return "resolve";
    if (["todo", "doing"].includes(patch.status)) return "reopen";
  }
  throw failure("A comment is marked done or reopened from Agenda; edit its text in the note's comments");
}
