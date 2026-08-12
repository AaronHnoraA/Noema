import { StateEffect, StateField, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { EditorPasteTarget } from "../paste.ts";
import { beforeChangeDocumentEffect } from "./extensions/document-lifecycle.ts";

type TrackedPasteRange = {
  from: number;
  to: number;
};

type TrackedPasteTarget = {
  ranges: readonly TrackedPasteRange[];
  expectedAnchor: number;
  expectedHead: number;
  expectedRanges: readonly { anchor: number; head: number }[];
  fragments?: readonly string[];
  clipboardText?: string;
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
        ...target,
        ranges: target.ranges.map((range) => ({
          from: transaction.changes.mapPos(range.from, -1),
          to: transaction.changes.mapPos(range.to, 1),
        })),
        expectedAnchor: transaction.changes.mapPos(target.expectedAnchor, -1),
        expectedHead: transaction.changes.mapPos(target.expectedHead, 1),
        expectedRanges: target.expectedRanges.map((range) => ({
          anchor: transaction.changes.mapPos(range.anchor, -1),
          head: transaction.changes.mapPos(range.head, 1),
        })),
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
  range: { from: number; to: number } | readonly { from: number; to: number }[] = view.state.selection.main,
  register?: { fragments: readonly string[]; clipboardText: string },
): EditorPasteTarget {
  const token: EditorPasteTarget = { id: nextPasteTargetId++, owner: view };
  const selection = view.state.selection.main;
  const ranges = Array.isArray(range) ? range : [range];
  view.dispatch({
    effects: addPasteTarget.of({
      token,
      value: {
        ranges: ranges.map(({ from, to }) => ({ from, to })),
        expectedAnchor: selection.anchor,
        expectedHead: selection.head,
        expectedRanges: view.state.selection.ranges.map(({ anchor, head }) => ({ anchor, head })),
        ...(register ? {
          fragments: [...register.fragments],
          clipboardText: register.clipboardText,
        } : {}),
      },
    }),
  });
  return token;
}

export function resolveEditorPasteTarget(
  view: EditorView,
  token: EditorPasteTarget,
): ({
  from: number;
  to: number;
  ranges: readonly TrackedPasteRange[];
  ownsSelection: boolean;
  fragments?: readonly string[];
  clipboardText?: string;
} | null) {
  if (token.owner !== view) return null;
  const value = view.state.field(pasteTargets, false)?.get(token.id);
  if (!value) return null;
  const selection = view.state.selection;
  const ownsSelection = selection.ranges.length === value.expectedRanges.length
    && selection.ranges.every((range, index) => (
      range.anchor === value.expectedRanges[index]?.anchor
      && range.head === value.expectedRanges[index]?.head
    ));
  const main = value.ranges[Math.min(selection.mainIndex, value.ranges.length - 1)]
    ?? value.ranges[0]
    ?? { from: selection.main.from, to: selection.main.to };
  return {
    from: main.from,
    to: main.to,
    ranges: value.ranges,
    ownsSelection,
    fragments: value.fragments,
    clipboardText: value.clipboardText,
  };
}

export function releaseEditorPasteTarget(view: EditorView, token: EditorPasteTarget): void {
  if (token.owner !== view || !view.state.field(pasteTargets, false)?.has(token.id)) return;
  view.dispatch({ effects: removePasteTarget.of(token.id) });
}
