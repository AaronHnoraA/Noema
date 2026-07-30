/**
 * Auto-renumber ordered Markdown lists whenever the document changes.
 *
 * Ported from ZenNotes cm-ordered-list-renumber, adapted for aaronnote:
 * - `getReadyTree` is bounded to changed ranges + 4 KB slack instead of
 *   ensureSyntaxTree(state, state.doc.length) to avoid full-document parses.
 *   Lists extending past the slack window are best-effort (renumbered on the
 *   next edit inside them).
 * - Wires into aaronnote's buildExtensions.
 *
 * Marker punctuation (`.` vs `)`) is preserved per-list from the first item.
 * Starting number: kept when only later items are touched; reset to 1 when the
 * first item is part of a multi-line edit (move, paste, delete-first).
 *
 * The renumber appends to the same transaction (sequential: true), so move +
 * renumber land as one undo step.
 *
 * Opt-out paths:
 *   - programmatic loads: annotate with skipOrderedListRenumber.of(true)
 *   - undo/redo: detected via tr.isUserEvent("undo"/"redo")
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Annotation, EditorState, type ChangeSpec, type Extension } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";

export const skipOrderedListRenumber = Annotation.define<boolean>();

const ORDERED_MARK_RE = /^(\d{1,9})([.)])$/;

type Range = readonly [number, number];

function rangesOverlap(a: Range, b: Range): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

// Bounded tree ensure — only parses up to the changed region + 4 KB slack.
// This prevents full-document re-parses on each keystroke while still covering
// the vast majority of list edits. Best-effort for lists extending beyond.
function getReadyTree(state: EditorState, upto: number): Tree {
  const target = Math.min(state.doc.length, upto + 4096);
  return ensureSyntaxTree(state, target, 20) ?? syntaxTree(state);
}

function collectOrderedLists(state: EditorState, ranges: ReadonlyArray<Range>, upto: number): SyntaxNode[] {
  const tree = getReadyTree(state, upto);
  const found = new Map<string, SyntaxNode>();

  const record = (node: SyntaxNode): void => {
    if (node.name !== "OrderedList") return;
    const key = `${node.from}:${node.to}`;
    if (!found.has(key)) found.set(key, node);
  };

  for (const [from, to] of ranges) {
    let cur: SyntaxNode | null = tree.resolveInner(from, 1);
    while (cur) { record(cur); cur = cur.parent; }
    tree.iterate({ from, to, enter: (node) => { if (node.name === "OrderedList") record(node.node); } });
  }

  return [...found.values()];
}

function appendRenumberChanges(
  state: EditorState,
  list: SyntaxNode,
  multiLineRanges: ReadonlyArray<Range>,
  out: ChangeSpec[],
): void {
  let firstNumber: number | null = null;
  let punctuation: "." | ")" = ".";
  let index = 0;

  for (let child = list.firstChild; child; child = child.nextSibling) {
    if (child.name !== "ListItem") continue;
    const mark = child.firstChild;
    if (!mark || mark.name !== "ListMark") continue;
    const text = state.doc.sliceString(mark.from, mark.to);
    const match = ORDERED_MARK_RE.exec(text);
    if (!match) continue;

    if (firstNumber == null) {
      const markRange: Range = [mark.from, mark.to];
      const touchedByMultiLine = multiLineRanges.some((r) => rangesOverlap(r, markRange));
      firstNumber = touchedByMultiLine ? 1 : Number(match[1]);
      punctuation = match[2] as "." | ")";
      const expected = `${firstNumber}${punctuation}`;
      if (text !== expected) out.push({ from: mark.from, to: mark.to, insert: expected });
    } else {
      const expected = `${firstNumber + index}${punctuation}`;
      if (text !== expected) out.push({ from: mark.from, to: mark.to, insert: expected });
    }
    index++;
  }
}

export const orderedListRenumber: Extension = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (tr.annotation(skipOrderedListRenumber)) return tr;
  if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return tr;

  const oldDoc = tr.startState.doc;
  const newDoc = tr.state.doc;
  const ranges: Range[] = [];
  const multiLineRanges: Range[] = [];
  let maxTo = 0;

  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    ranges.push([fromB, toB]);
    if (toB > maxTo) maxTo = toB;
    const crossedLineInOld = oldDoc.lineAt(fromA).number !== oldDoc.lineAt(toA).number;
    const crossedLineInNew = newDoc.lineAt(fromB).number !== newDoc.lineAt(toB).number;
    if (crossedLineInOld || crossedLineInNew) multiLineRanges.push([fromB, toB]);
  });

  if (ranges.length === 0) return tr;

  const lists = collectOrderedLists(tr.state, ranges, maxTo);
  if (lists.length === 0) return tr;

  const changes: ChangeSpec[] = [];
  for (const list of lists) appendRenumberChanges(tr.state, list, multiLineRanges, changes);
  if (changes.length === 0) return tr;

  return [tr, { changes, sequential: true, annotations: skipOrderedListRenumber.of(true) }];
});
