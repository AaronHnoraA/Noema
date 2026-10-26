/**
 * When a rendered construct shows its Markdown source instead.
 *
 * Every construct the visual editor draws over its source — a footnote chip,
 * a block reference, a formula, a callout — answers the same question: does
 * the selection open it? This module is the single answer; a construct only
 * picks a policy.
 *
 * - `edge`: a caret inside the construct or touching either edge opens it.
 *   Typing right after a reference edits the reference.
 * - `interior`: only a caret strictly inside opens it. At either edge it stays
 *   rendered, so the arrow keys first step onto a formula and then into it.
 * - `caret-edge` / `caret-interior`: the same for a caret, but no range opens
 *   the construct. An image or a diagram is replaced by a large block of
 *   source; a drag that ends on one must not reflow the page under the mouse.
 * - `never`: the selection never opens it; it is opened explicitly (a folded
 *   code block is unfolded by its toggle).
 *
 * A range selection opens an `edge` or `interior` construct only when one of
 * its ends falls strictly inside: those ends are what the author is placing. A
 * range that merely crosses a construct keeps it rendered, so Select All or a
 * paragraph drag does not turn every widget it passes back into source.
 *
 * A construct may open for a region wider than itself: a task checkbox opens
 * when the caret is anywhere on its line.
 *
 * Constructs come in two roles. An OBJECT (a reference chip, a formula, a
 * picture) is something Vim's Normal and Visual modes move over as one
 * character, so there it stays rendered under the caret. STRUCTURE (a block
 * heading, a rule, the TOC) is syntax Vim edits as text, so it opens in every
 * mode.
 */

import type { EditorSelection, EditorState, SelectionRange } from "@codemirror/state";
import { renderedConstructsPinned } from "./mode.ts";
import { visualSelection } from "../selection.ts";

export type RevealPolicy = "edge" | "interior" | "caret-edge" | "caret-interior" | "never";

export type ConstructRole = "object" | "structure";

type RangeLike = Pick<SelectionRange, "from" | "to" | "empty">;

/** Whether one selection range opens the source of [FROM, TO]. */
export function rangeRevealsSource(range: RangeLike, from: number, to: number, policy: RevealPolicy): boolean {
  if (policy === "never") return false;
  if (range.empty) {
    return policy === "edge" || policy === "caret-edge"
      ? range.from >= from && range.from <= to
      : range.from > from && range.from < to;
  }
  if (policy === "caret-edge" || policy === "caret-interior") return false;
  return (range.from > from && range.from < to) || (range.to > from && range.to < to);
}

/** Whether the main selection range opens the source of [FROM, TO]. */
export function selectionRevealsSource(
  selection: EditorSelection,
  from: number,
  to: number,
  policy: RevealPolicy,
): boolean {
  return rangeRevealsSource(selection.main, from, to, policy);
}

/** Whether any selection range opens the source of [FROM, TO]. */
export function anySelectionRevealsSource(
  selection: EditorSelection,
  from: number,
  to: number,
  policy: RevealPolicy,
): boolean {
  return selection.ranges.some((range) => rangeRevealsSource(range, from, to, policy));
}

/** Whether the main selection opens the source of [FROM, TO] in STATE, for a construct in ROLE. */
export function selectionOpensSource(
  state: EditorState,
  from: number,
  to: number,
  policy: RevealPolicy,
  role: ConstructRole,
): boolean {
  if (role === "object" && renderedConstructsPinned(state)) return false;
  return rangeRevealsSource(visualSelection(state).main, from, to, policy);
}

/**
 * The offsets whose surrounding constructs a selection can open: the ends of
 * the main range. A construct away from both ends stays rendered under every
 * policy, so a caller only has to examine the lines holding these offsets.
 */
export function revealProbeOffsets(state: EditorState): readonly number[] {
  const { from, to } = visualSelection(state).main;
  return from === to ? [from] : [from, to];
}

/** The ends of every selection range: for constructs that open for any range, not just the main one. */
export function selectionProbeOffsets(selection: EditorSelection): readonly number[] {
  return selection.ranges.flatMap(({ from, to }) => (from === to ? [from] : [from, to]));
}
