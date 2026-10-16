/**
 * The registry of rendered constructs.
 *
 * A rendered construct here is an OBJECT (see `reveal.ts`): a source range the
 * visual editor draws as something other than its text and that Vim moves over
 * as one character — a footnote chip, a block reference, a formula, an image.
 * Each construct family contributes one `ConstructSource`; everything that has
 * to know what is drawn where — Vim motions, caret movement, selection — asks
 * this registry rather than rescanning Markdown or reading decorations.
 *
 * Sources answer from editor state, so the registry is correct for text that is
 * scrolled out of view as well as for the viewport.
 */

import { Facet, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { selectionOpensSource, type RevealPolicy } from "./reveal.ts";

export type RenderedConstruct = {
  from: number;
  to: number;
  /** Drawn as a block of its own rather than within a line of text. */
  block: boolean;
  /** The contributing source's `kind`. */
  kind: string;
  reveal: RevealPolicy;
  /** The region whose selection opens the construct, when wider than [from, to). */
  revealRegion?: { from: number; to: number };
};

export interface ConstructSource {
  /** A short name for the construct family, e.g. `footnote`. */
  readonly kind: string;
  /** Constructs whose source range contains POS (`from <= pos < to`). */
  at(state: EditorState, pos: number): readonly RenderedConstruct[];
  /**
   * Whether CONSTRUCT shows its source in VIEW. Defaults to the construct's
   * reveal policy against the main selection; a family whose source is opened
   * explicitly (a formula editing session) overrides it.
   */
  revealed?(view: EditorView, construct: RenderedConstruct): boolean;
}

export const constructSources = Facet.define<ConstructSource>();

/** Whether CONSTRUCT shows its source under the selection, by its reveal policy. */
export function constructRevealedBySelection(state: EditorState, construct: RenderedConstruct): boolean {
  const region = construct.revealRegion ?? construct;
  return selectionOpensSource(state, region.from, region.to, construct.reveal, "object");
}

function defaultRevealed(view: EditorView, construct: RenderedConstruct): boolean {
  return constructRevealedBySelection(view.state, construct);
}

/**
 * The rendered construct containing POS, or null when POS is plain text or the
 * construct there currently shows its source. Of nested constructs the widest
 * wins: it is the one drawn.
 */
export function renderedConstructAt(view: EditorView, pos: number): RenderedConstruct | null {
  const state = view.state;
  const safe = Math.max(0, Math.min(pos, state.doc.length));
  let found: RenderedConstruct | null = null;
  for (const source of state.facet(constructSources)) {
    for (const construct of source.at(state, safe)) {
      if (found && construct.to - construct.from <= found.to - found.from) continue;
      if ((source.revealed ?? defaultRevealed)(view, construct)) continue;
      found = construct;
    }
  }
  return found;
}
