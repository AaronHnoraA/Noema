/**
 * Word-sized undo steps.
 *
 * CodeMirror joins adjacent typing (and deleting) into one history event while
 * keystrokes keep coming within `newGroupDelay`, so a sentence typed without a
 * pause undid all at once, and a word typed then corrected undid together with
 * the correction. MarkText's history (`muya/src/history/index.ts`,
 * `shouldBreakUndoGroup`) starts a fresh entry at a typed whitespace and when
 * input switches between inserting and deleting; this restates those two rules
 * through CodeMirror's `joinToEvent` hook.
 */

import { StateField, type Transaction } from "@codemirror/state";

type EditKind = "insert" | "delete";

function editKind(tr: Transaction): EditKind | null {
  if (!tr.docChanged) return null;
  if (tr.isUserEvent("delete")) return "delete";
  if (tr.isUserEvent("input.type")) return "insert";
  return null;
}

/** The kind of the last document edit, read back by `joinTypingEvent`. */
export const lastEditKindField = StateField.define<EditKind | null>({
  create: () => null,
  update(value, tr) {
    return tr.docChanged ? editKind(tr) : value;
  },
});

function insertsWhitespace(tr: Transaction): boolean {
  let whitespace = false;
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (inserted.length > 0 && /^\s+$/u.test(inserted.toString())) whitespace = true;
  });
  return whitespace;
}

/** `history({ joinToEvent })`: join adjacent edits except at word and kind boundaries. */
export function joinTypingEvent(tr: Transaction, isAdjacent: boolean): boolean {
  if (!isAdjacent) return false;
  const kind = editKind(tr);
  const previous = tr.startState.field(lastEditKindField, false) ?? null;
  if (kind && previous && kind !== previous) return false;
  if (kind === "insert" && insertsWhitespace(tr)) return false;
  return true;
}
