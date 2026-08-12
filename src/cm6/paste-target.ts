import { StateEffect, StateField, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { EditorPasteTarget } from "../paste.ts";
import { beforeChangeDocumentEffect } from "./extensions/document-lifecycle.ts";

type TrackedPasteTarget = {
  from: number;
  to: number;
  expectedAnchor: number;
  expectedHead: number;
};

const addPasteTarget = StateEffect.define<{ token: EditorPasteTarget; value: TrackedPasteTarget }>();
const removePasteTarget = StateEffect.define<number>();

const pasteTargets = StateField.define<ReadonlyMap<number, TrackedPasteTarget>>({
  create: () => new Map(),
  update(value, transaction) {
    if (transaction.effects.some((effect) => effect.is(beforeChangeDocumentEffect))) return new Map();
    const next = new Map<number, TrackedPasteTarget>();
    for (const [id, target] of value) {
      next.set(id, {
        from: transaction.changes.mapPos(target.from, -1),
        to: transaction.changes.mapPos(target.to, 1),
        expectedAnchor: transaction.changes.mapPos(target.expectedAnchor, -1),
        expectedHead: transaction.changes.mapPos(target.expectedHead, 1),
      });
    }
    for (const effect of transaction.effects) {
      if (effect.is(addPasteTarget)) next.set(effect.value.token.id, effect.value.value);
      if (effect.is(removePasteTarget)) next.delete(effect.value);
    }
    return next;
  },
});

let nextPasteTargetId = 1;

export const pasteTargetExtension: Extension = pasteTargets;

/**
 * Capture the command location before an asynchronous clipboard read.  The
 * range maps through ordinary document changes, while document replacement
 * invalidates it rather than pasting at an unrelated current caret.
 */
export function captureEditorPasteTarget(
  view: EditorView,
  range: { from: number; to: number } = view.state.selection.main,
): EditorPasteTarget {
  const token: EditorPasteTarget = { id: nextPasteTargetId++, owner: view };
  const selection = view.state.selection.main;
  view.dispatch({
    effects: addPasteTarget.of({
      token,
      value: {
        from: range.from,
        to: range.to,
        expectedAnchor: selection.anchor,
        expectedHead: selection.head,
      },
    }),
  });
  return token;
}

export function resolveEditorPasteTarget(
  view: EditorView,
  token: EditorPasteTarget,
): ({ from: number; to: number; ownsSelection: boolean } | null) {
  if (token.owner !== view) return null;
  const value = view.state.field(pasteTargets, false)?.get(token.id);
  if (!value) return null;
  const selection = view.state.selection;
  return {
    from: value.from,
    to: value.to,
    ownsSelection: selection.ranges.length === 1
      && selection.main.anchor === value.expectedAnchor
      && selection.main.head === value.expectedHead,
  };
}

export function releaseEditorPasteTarget(view: EditorView, token: EditorPasteTarget): void {
  if (token.owner !== view || !view.state.field(pasteTargets, false)?.has(token.id)) return;
  view.dispatch({ effects: removePasteTarget.of(token.id) });
}
