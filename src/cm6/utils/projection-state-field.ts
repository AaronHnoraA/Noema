/*
 * Adapted from Overleaf:
 * services/web/frontend/js/features/source-editor/utils/projection-state-field.ts
 * upstream commit 28ad3b03b71cb4311decdcb55c36b33ec10d72db
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { StateField, type ChangeSet, type EditorState } from "@codemirror/state";
import {
  ProjectionItem,
  ProjectionStatus,
  type EnterProjectionNode,
  type ProjectionResult,
  updateProjection,
} from "./projection.ts";

export type MergedChangeRanges = {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
};

export function mergeChangeRanges(changes: ChangeSet): MergedChangeRanges | null {
  let oldFrom = Number.POSITIVE_INFINITY;
  let oldTo = Number.NEGATIVE_INFINITY;
  let newFrom = Number.POSITIVE_INFINITY;
  let newTo = Number.NEGATIVE_INFINITY;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    oldFrom = Math.min(oldFrom, fromA);
    oldTo = Math.max(oldTo, toA);
    newFrom = Math.min(newFrom, fromB);
    newTo = Math.max(newTo, toB);
  });
  return Number.isFinite(oldFrom) ? { oldFrom, oldTo, newFrom, newTo } : null;
}

export function makeProjectionStateField<T extends ProjectionItem>(
  enterNode: EnterProjectionNode<T>,
): StateField<ProjectionResult<T>> {
  const initialize = (state: EditorState): ProjectionResult<T> => updateProjection(
    state,
    0,
    state.doc.length,
    0,
    state.doc.length,
    true,
    enterNode,
  );

  return StateField.define<ProjectionResult<T>>({
    create: initialize,
    update(current, transaction) {
      if (!transaction.docChanged && current.status === ProjectionStatus.Complete) return current;
      const changed = mergeChangeRanges(transaction.changes);
      if (!changed) {
        return updateProjection(
          transaction.state,
          0,
          transaction.startState.doc.length,
          0,
          transaction.state.doc.length,
          false,
          enterNode,
          transaction,
          current,
        );
      }
      return updateProjection(
        transaction.state,
        changed.oldFrom,
        changed.oldTo,
        changed.newFrom,
        changed.newTo,
        false,
        enterNode,
        transaction,
        current,
      );
    },
  });
}

