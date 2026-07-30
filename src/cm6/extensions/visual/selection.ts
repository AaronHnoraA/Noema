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
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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

function finishPointerSelection(view: EditorView): void {
  window.setTimeout(() => {
    if (view.dom.isConnected) view.dispatch({ effects: pointerSelectionEffect.of(false) });
  });
}

const pointerSelectionListener = EditorView.domEventHandlers({
  mousedown: (_event, view) => {
    view.dispatch({ effects: pointerSelectionEffect.of(true) });
    return false;
  },
  mouseup: (_event, view) => {
    finishPointerSelection(view);
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

export function isPointerSelecting(state: EditorState): boolean {
  return state.field(pointerSelectionField, false) ?? false;
}

export function getMousedownSelection(state: EditorState): EditorSelection | undefined {
  return state.field(mousedownSelectionField, false);
}

export const pointerSelectionExtension = [
  pointerSelectionListener,
  pointerSelectionField,
  mousedownSelectionField,
];
