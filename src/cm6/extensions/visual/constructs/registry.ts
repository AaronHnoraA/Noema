/**
 * The registry of rendered constructs.
 *
 * A rendered construct is a source range the visual editor draws as something
 * other than its text — a footnote chip, a formula, a table, a block heading.
 * Every family that draws over source registers here, so the registry and the
 * screen agree (`tests/architecture-constructs.test.ts` checks both ways).
 * While drawn, an object is one character to Vim; structure opens where the
 * caret lands and is edited as text (see `reveal.ts`).
 * Each construct family contributes one `ConstructSource`; everything that has
 * to know what is drawn where — Vim motions, caret movement, selection — asks
 * this registry rather than rescanning Markdown or reading decorations.
 *
 * Sources answer from editor state, so the registry is correct for text that is
 * scrolled out of view as well as for the viewport.
 */

import { Facet, type EditorState } from "@codemirror/state";
import type { DecorationSet, EditorView } from "@codemirror/view";
import { selectionOpensSource, type ConstructRole, type RevealPolicy } from "./reveal.ts";

export type RenderedConstruct = {
  from: number;
  to: number;
  /** Drawn as a block of its own rather than within a line of text. */
  block: boolean;
  /** What it is, e.g. `footnote`; a source may report several kinds (`code-fold`, `diagram`). */
  kind: string;
  reveal: RevealPolicy;
  /** Object (Vim moves over it, pinned outside Insert) or structure (Vim edits it as text). Default object. */
  role?: ConstructRole;
  /** The region whose selection opens the construct, when wider than [from, to). */
  revealRegion?: { from: number; to: number };
};

export interface ConstructSource {
  /** A short name for the construct family, e.g. `footnote`. */
  readonly kind: string;
  /**
   * Constructs whose source range contains POS (`from <= pos < to`), from
   * editor state — correct off screen too. A family drawn by a viewport
   * plugin answers from VIEW instead (see `drawnConstructSource`).
   */
  at(state: EditorState, pos: number, view?: EditorView): readonly RenderedConstruct[];
  /**
   * Whether CONSTRUCT shows its source in VIEW. Defaults to the construct's
   * reveal policy against the main selection; a family whose source is opened
   * explicitly (a formula editing session) overrides it.
   */
  revealed?(view: EditorView, construct: RenderedConstruct): boolean;
}

export const constructSources = Facet.define<ConstructSource>();

/**
 * A construct source read off what a family draws: every widget its
 * decorations put over source at POS. The drawing already reflects the reveal
 * rule, so such constructs are never "revealed"; the registry and the screen
 * agree by construction. DECORATIONS returns the family's current set, or
 * null when it has none (the visual mode is off).
 */
export function drawnConstructSource(
  kind: string,
  role: ConstructRole,
  decorations: (state: EditorState, view?: EditorView) => DecorationSet | null | undefined,
): ConstructSource {
  return {
    kind,
    at(state, pos, view) {
      const found: RenderedConstruct[] = [];
      decorations(state, view)?.between(pos, pos + 1, (from, to, value) => {
        if (from <= pos && pos < to && (value.spec as { widget?: unknown }).widget) {
          found.push({ from, to, block: Boolean(value.spec.block), kind, reveal: "never", role });
        }
      });
      return found;
    },
    revealed: () => false,
  };
}

/** Whether CONSTRUCT shows its source under the selection, by its reveal policy. */
export function constructRevealedBySelection(state: EditorState, construct: RenderedConstruct): boolean {
  const region = construct.revealRegion ?? construct;
  return selectionOpensSource(state, region.from, region.to, construct.reveal, construct.role ?? "object");
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
    for (const construct of source.at(state, safe, view)) {
      if (found && construct.to - construct.from <= found.to - found.from) continue;
      if ((source.revealed ?? defaultRevealed)(view, construct)) continue;
      found = construct;
    }
  }
  return found;
}
