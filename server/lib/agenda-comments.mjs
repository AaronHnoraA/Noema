// Comments as Agenda items (C77, C79).
//
// An open `@@comment` of a note is a task of that note's Agenda scope.  Its
// text may end in planning attributes written as in the DSL
// (`Prove the bound {ddl: fri; prio: A}`), so a comment is found, filtered,
// sorted and scheduled like any `@@todo`.  Marking it done writes
// `@@comment(done)` into the note; setting it back to todo removes it.

import { createHash } from "node:crypto";
import { newCommentId, scanComments, commentEdit } from "../../shared/comments.mjs";

const failure = (message, statusCode = 422) => Object.assign(new Error(message), { statusCode });
const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Split a comment into a one-line title and trailing DSL attributes. */
export function commentTitle(text) {
  const first = String(text ?? "").trim().split("\n")[0].trim();
  const match = first.match(/^(.*?)\s*(\{[^{}]*\})\s*$/);
  const title = (match ? match[1] : first).replace(/\[/g, "(").replace(/\]/g, ")").trim() || "Comment";
  return { title, attrs: match ? match[2] : "" };
}

/** Return the Agenda todos of the open comments in a note's CONTENT.
 * EXTRACT is the Markdown planning parser and NOTE its note record. */
export function commentTodos(content, { extract, note }) {
  const todos = [];
  scanComments(content).forEach((comment, index) => {
    if (comment.done) return;
    const { title, attrs } = commentTitle(comment.text);
    const source = `@@todo(todo) [${title}]${attrs ? " " + attrs : ""}`;
    const [todo] = extract(`${source}\n`, note, 0).todos || [];
    if (!todo) return;
    // An id-less comment is named by its place until it becomes a task.
    const key = comment.id || `@${index}`;
    todos.push({
      ...todo,
      id: `#${key}`, commentId: comment.id, commentIndex: index, commentSource: comment.source,
      sourceKind: "comment", line: comment.line, column: 1,
      context: comment.quote ? `«${comment.quote}»` : todo.context, quote: comment.quote,
      inlineTags: [...(todo.inlineTags || []), "comment"],
      sourceRevision: hash(comment.source),
    });
  });
  return todos;
}

/** Return true to resolve or false to reopen for an Agenda PATCH, or throw. */
export function commentPatchDone(patch = {}) {
  const keys = Object.keys(patch);
  if (keys.length === 1 && keys[0] === "op" && patch.op === "complete") return true;
  if (keys.length === 1 && keys[0] === "status") {
    if (["done", "cancelled"].includes(patch.status)) return true;
    if (["todo", "doing"].includes(patch.status)) return false;
  }
  throw failure("A comment is marked done or reopened from Agenda; edit its text in the note");
}

/** Return the edit setting TODO's comment to DONE in SOURCE, or throw when it moved. */
export function commentStatusEdit(source, todo, done) {
  const comment = scanComments(source).find((item, index) =>
    todo.commentId ? item.id === todo.commentId : index === todo.commentIndex && item.source === todo.commentSource);
  if (!comment) throw failure("The comment changed; refresh Agenda", 409);
  return commentEdit(comment, { done, id: comment.id || newCommentId() });
}
