/*
 * Adapted from Overleaf:
 * services/web/frontend/js/features/source-editor/utils/tree-operations/projection.ts
 * upstream commit 28ad3b03b71cb4311decdcb55c36b33ec10d72db
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState, Transaction } from "@codemirror/state";
import { IterMode, type SyntaxNodeRef } from "@lezer/common";

const UPDATE_PARSE_BUDGET_MS = 20;
const INITIAL_PARSE_BUDGET_MS = 500;

export abstract class ProjectionItem {
  readonly from = 0;
  readonly to = 0;
  readonly line = 0;
  readonly toLine = 0;
}

export const ProjectionStatus = {
  Pending: "pending",
  Partial: "partial",
  Complete: "complete",
} as const;

export type ProjectionStatus = typeof ProjectionStatus[keyof typeof ProjectionStatus];

export interface ProjectionResult<T extends ProjectionItem> {
  items: T[];
  status: ProjectionStatus;
}

export type NodeIntersectsChange = (node: SyntaxNodeRef) => boolean;

export type EnterProjectionNode<T extends ProjectionItem> = (
  state: EditorState,
  node: SyntaxNodeRef,
  items: T[],
  nodeIntersectsChange: NodeIntersectsChange,
) => boolean | void;

function intersects(fromA: number, toA: number, fromB: number, toB: number): boolean {
  return !(toA < fromB || fromA > toB);
}

export function updateProjectionPosition<T extends ProjectionItem>(
  item: T,
  transaction?: Transaction,
): T {
  if (!transaction) return item;

  const from = transaction.changes.mapPos(item.from);
  const to = transaction.changes.mapPos(item.to);
  const line = transaction.state.doc.lineAt(from).number;
  const toLine = transaction.state.doc.lineAt(to).number;
  if (from === item.from && to === item.to && line === item.line && toLine === item.toLine) {
    return item;
  }
  return { ...item, from, to, line, toLine };
}

export function updateProjection<T extends ProjectionItem>(
  state: EditorState,
  oldFrom: number,
  oldTo: number,
  newFrom: number,
  newTo: number,
  initialParse: boolean,
  enterNode: EnterProjectionNode<T>,
  transaction?: Transaction,
  previous: ProjectionResult<T> = { items: [], status: ProjectionStatus.Pending },
): ProjectionResult<T> {
  const items = previous.status === ProjectionStatus.Complete
    ? previous.items
      .filter((item) => !intersects(item.from, item.to, oldFrom, oldTo))
      .map((item) => updateProjectionPosition(item, transaction))
    : [];

  // Partial projections cannot safely be patched: retry the whole requested
  // document projection while retaining the old result if the parser is still
  // unavailable. This is intentionally not used by viewport decorations,
  // which keep Noema's existing 8ms + overscan budget.
  if (previous.status !== ProjectionStatus.Complete) {
    newFrom = 0;
    newTo = state.doc.length;
  }

  const tree = ensureSyntaxTree(
    state,
    newTo,
    initialParse ? INITIAL_PARSE_BUDGET_MS : UPDATE_PARSE_BUDGET_MS,
  );
  if (!tree) {
    return previous.status === ProjectionStatus.Pending
      ? { items: [], status: ProjectionStatus.Pending }
      : { items: previous.items, status: ProjectionStatus.Partial };
  }

  tree.iterate({
    from: newFrom,
    to: newTo,
    mode: IterMode.IgnoreMounts | IterMode.IgnoreOverlays,
    enter(node) {
      return enterNode(
        state,
        node,
        items,
        (candidate) => intersects(candidate.from, candidate.to, newFrom, newTo),
      );
    },
  });

  items.sort((a, b) => a.from - b.from || a.to - b.to);
  return { items, status: ProjectionStatus.Complete };
}
