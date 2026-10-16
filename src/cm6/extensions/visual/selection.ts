/*
 * Adapted from Overleaf:
 * services/web/frontend/js/features/source-editor/extensions/visual/selection.ts
 * upstream commit 28ad3b03b71cb4311decdcb55c36b33ec10d72db
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type Line,
  type Text,
  type Transaction,
} from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { updateHasEffect } from "../../utils/effects.ts";

export const selectionIntersects = (
  selection: EditorSelection,
  extents: { from: number; to: number },
): boolean => selection.ranges.some((range) => (
  (extents.from <= range.from && extents.to >= range.from)
  || (extents.from <= range.to && extents.to >= range.to)
));

export const extendBackwardsOverEmptyLines = (
  doc: Text,
  line: Line,
  limit = Number.POSITIVE_INFINITY,
): number => {
  const { number } = line;
  let { from } = line;
  for (let lineNumber = number - 1; lineNumber > 0 && number - lineNumber <= limit; lineNumber--) {
    const previous = doc.line(lineNumber);
    if (previous.text.trim().length > 0) break;
    from = previous.from;
  }
  return from;
};

export const extendForwardsOverEmptyLines = (
  doc: Text,
  line: Line,
  limit = Number.POSITIVE_INFINITY,
): number => {
  const { number } = line;
  let { to } = line;
  for (let lineNumber = number + 1; lineNumber <= doc.lines && lineNumber - number <= limit; lineNumber++) {
    const next = doc.line(lineNumber);
    if (next.text.trim().length > 0) break;
    to = next.to;
  }
  return to;
};

export const pointerSelectionEffect = StateEffect.define<boolean>();
export const updateHasPointerSelectionEffect = updateHasEffect(pointerSelectionEffect);

/**
 * Whether a pointer drag is still in flight once `transaction` has been applied.
 *
 * State fields cannot read a field that is registered after them, so this is
 * derived from the previous state plus the transaction's own effects rather
 * than from `transaction.state`. View plugins should use `isPointerSelecting`.
 */
export function transactionHasPointerSelection(transaction: Transaction): boolean {
  let selecting = transaction.startState.field(pointerSelectionField, false) ?? false;
  for (const effect of transaction.effects) {
    if (effect.is(pointerSelectionEffect)) selecting = effect.value;
  }
  return selecting;
}

const pointerSelectionField = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(pointerSelectionEffect)) value = effect.value;
    }
    return value;
  },
});

const mousedownSelectionField = StateField.define<EditorSelection | undefined>({
  create: () => undefined,
  update(value, transaction) {
    if (value && transaction.docChanged) value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(pointerSelectionEffect)) {
        value = effect.value ? transaction.startState.selection : undefined;
      }
    }
    return value;
  },
});

const pointerSelectionGeneration = new WeakMap<EditorView, number>();
const pointerSelectionEndCleanup = new WeakMap<EditorView, () => void>();

function stopWatchingPointerSelectionEnd(view: EditorView): void {
  const cleanup = pointerSelectionEndCleanup.get(view);
  if (!cleanup) return;
  pointerSelectionEndCleanup.delete(view);
  cleanup();
}

function invalidatePointerSelectionLifecycle(view: EditorView): number {
  stopWatchingPointerSelectionEnd(view);
  const generation = (pointerSelectionGeneration.get(view) ?? 0) + 1;
  pointerSelectionGeneration.set(view, generation);
  return generation;
}

function watchPointerSelectionEnd(view: EditorView): void {
  const ownerDocument = view.dom.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const finish = (): void => finishPointerSelection(view);
  const finishFromKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" || (event.ctrlKey && event.key === "[")) finish();
  };

  ownerDocument.addEventListener("mouseup", finish, true);
  ownerDocument.addEventListener("pointercancel", finish, true);
  ownerDocument.addEventListener("keydown", finishFromKey, true);
  ownerWindow?.addEventListener("blur", finish, true);
  pointerSelectionEndCleanup.set(view, () => {
    ownerDocument.removeEventListener("mouseup", finish, true);
    ownerDocument.removeEventListener("pointercancel", finish, true);
    ownerDocument.removeEventListener("keydown", finishFromKey, true);
    ownerWindow?.removeEventListener("blur", finish, true);
  });
}

function finishPointerSelection(view: EditorView): void {
  const generation = pointerSelectionGeneration.get(view) ?? 0;
  stopWatchingPointerSelectionEnd(view);
  globalThis.setTimeout(() => {
    if (pointerSelectionGeneration.get(view) !== generation) return;
    if (view.dom.isConnected && isPointerSelecting(view.state)) {
      const selection = view.state.selection;
      // A click that replaces a drag can leave CM6 with an empty main cursor
      // plus a non-empty secondary range. Vim correctly follows the main
      // cursor, but drawSelection would keep painting the orphaned range as a
      // full-line highlight. Normalize only this inconsistent shape; ordinary
      // drag selections and multiple empty cursors remain intact.
      const hasOrphanedRange = selection.main.empty
        && selection.ranges.some((range) => !range.empty);
      view.dispatch({
        effects: pointerSelectionEffect.of(false),
        ...(hasOrphanedRange ? { selection: { anchor: selection.main.head } } : {}),
      });
    }
  });
}

export function cancelPointerSelection(view: EditorView, collapseAt?: number): void {
  invalidatePointerSelectionLifecycle(view);
  const pointerSelecting = isPointerSelecting(view.state);
  const position = collapseAt == null
    ? null
    : Math.max(0, Math.min(view.state.doc.length, collapseAt));
  const selectionNeedsCollapse = position != null && (
    view.state.selection.ranges.length !== 1
    || !view.state.selection.main.empty
    || view.state.selection.main.head !== position
  );
  if (!pointerSelecting && !selectionNeedsCollapse) return;
  view.dispatch({
    ...(pointerSelecting ? { effects: pointerSelectionEffect.of(false) } : {}),
    ...(position != null ? { selection: { anchor: position } } : {}),
  });
}

function beginPointerSelection(view: EditorView): void {
  invalidatePointerSelectionLifecycle(view);
  view.dispatch({ effects: pointerSelectionEffect.of(true) });
  watchPointerSelectionEnd(view);
}

const pointerSelectionListener = EditorView.domEventHandlers({
  mousedown: (_event, view) => {
    beginPointerSelection(view);
    return false;
  },
  contextmenu: (_event, view) => {
    finishPointerSelection(view);
    return false;
  },
  drop: (_event, view) => {
    finishPointerSelection(view);
    return false;
  },
});

const pointerSelectionLifecycle = ViewPlugin.define((view) => ({
  destroy(): void {
    invalidatePointerSelectionLifecycle(view);
  },
}));

export function isPointerSelecting(state: EditorState): boolean {
  return state.field(pointerSelectionField, false) ?? false;
}

export function getMousedownSelection(state: EditorState): EditorSelection | undefined {
  return state.field(mousedownSelectionField, false);
}

export const pointerSelectionExtension = [
  pointerSelectionListener,
  pointerSelectionLifecycle,
  pointerSelectionField,
  mousedownSelectionField,
];
