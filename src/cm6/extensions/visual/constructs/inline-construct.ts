/**
 * Inline construct families: a construct that lives within one line of text,
 * matched from that line alone (a footnote reference, a block reference, a
 * block identity badge).
 *
 * A family only describes what it matches and what it draws. This module owns
 * everything the families used to repeat: skipping code and math, the reveal
 * policy and Vim pinning, when to rebuild (typing bursts, pointer drags,
 * selection moves that change nothing), the cache that survives the plugin
 * being recreated, and the family's entry in the construct registry.
 */

import type { EditorState, Extension, Line, Range } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate, type WidgetType } from "@codemirror/view";
import { rangeInsideAny } from "../../../math-ranges.ts";
import { hasViewportDecorationRefresh } from "../../../viewport-refresh.ts";
import { isPointerSelecting, updateHasPointerSelectionEffect } from "../selection.ts";
import { isCoalescedVisualTyping } from "../typing-burst.ts";
import { rememberPersistentVisualPluginState, restorePersistentVisualPluginState } from "../visual-mode.ts";
import { literalRangesOnLine } from "./literal-ranges.ts";
import { renderedConstructsPinned, transactionChangesPinning } from "./mode.ts";
import { constructSources, type ConstructSource, type RenderedConstruct } from "./registry.ts";
import { revealProbeOffsets, selectionOpensSource, type ConstructRole, type RevealPolicy } from "./reveal.ts";

export type InlineConstructMatch = {
  from: number;
  to: number;
  /** The widget drawn over [from, to); created only when it is drawn. */
  widget: () => WidgetType;
  /** The region whose selection opens the construct, when wider than [from, to). */
  revealRegion?: { from: number; to: number };
};

export interface InlineConstructSpec {
  kind: string;
  reveal: RevealPolicy;
  /** Default `object`: Vim keeps it rendered. `structure` is syntax Vim edits as text (an `@@` command). */
  role?: ConstructRole;
  /** Cap on constructs drawn in one viewport. */
  maxPerViewport: number;
  /** The family's constructs on LINE in source order. Literal code and math are filtered out afterwards. */
  match(line: Line, state: EditorState): Iterable<InlineConstructMatch>;
  /** Per-view work the family needs while mounted (a subscription); returns its teardown. */
  setup?(view: EditorView): () => void;
}

/** An inline construct family: its decorations, and its source in the construct registry. */
export function inlineConstruct(spec: InlineConstructSpec): Extension {
  const role: ConstructRole = spec.role ?? "object";
  const byState = new WeakMap<EditorState, Map<number, readonly InlineConstructMatch[]>>();

  const matchesOn = (state: EditorState, line: Line): readonly InlineConstructMatch[] => {
    let byLine = byState.get(state);
    if (!byLine) byState.set(state, byLine = new Map());
    let matches = byLine.get(line.from);
    if (!matches) {
      const raw = [...spec.match(line, state)];
      if (raw.length === 0) matches = raw;
      else {
        const literal = literalRangesOnLine(state, line);
        matches = literal.length === 0 ? raw : raw.filter((match) => !rangeInsideAny(match.from, match.to, literal));
      }
      byLine.set(line.from, matches);
    }
    return matches;
  };

  const toConstruct = (match: InlineConstructMatch): RenderedConstruct => ({
    from: match.from, to: match.to, block: false, kind: spec.kind, reveal: spec.reveal, role,
    revealRegion: match.revealRegion,
  });

  const opens = (state: EditorState, match: InlineConstructMatch): boolean => {
    const region = match.revealRegion ?? match;
    return selectionOpensSource(state, region.from, region.to, spec.reveal, role);
  };

  const source: ConstructSource = {
    kind: spec.kind,
    at(state, pos) {
      return matchesOn(state, state.doc.lineAt(pos))
        .filter((match) => match.from <= pos && pos < match.to)
        .map(toConstruct);
    },
  };

  /**
   * The constructs the selection currently opens. Only the lines of its ends
   * can hold one: a reveal region never extends past its construct's line.
   */
  const revealKey = (state: EditorState): string => {
    if (role === "object" && renderedConstructsPinned(state)) return "pinned";
    const opened: string[] = [];
    const seen = new Set<number>();
    for (const offset of revealProbeOffsets(state)) {
      const line = state.doc.lineAt(offset);
      if (seen.has(line.from)) continue;
      seen.add(line.from);
      for (const match of matchesOn(state, line)) {
        if (opens(state, match)) opened.push(`${match.from}:${match.to}`);
      }
    }
    return opened.join(",");
  };

  const build = (view: EditorView): DecorationSet => {
    const state = view.state;
    const decorations: Range<Decoration>[] = [];
    let previousLine = -1;
    for (const visible of view.visibleRanges) {
      for (let pos = visible.from; pos <= visible.to && decorations.length < spec.maxPerViewport;) {
        const line = state.doc.lineAt(pos);
        if (line.number > previousLine) {
          previousLine = line.number;
          for (const match of matchesOn(state, line)) {
            if (decorations.length >= spec.maxPerViewport) break;
            if (opens(state, match)) continue;
            decorations.push(Decoration.replace({ widget: match.widget() }).range(match.from, match.to));
          }
        }
        pos = line.to + 1;
      }
    }
    return Decoration.set(decorations, true);
  };

  type Snapshot = { decorations: DecorationSet; revealKey: string };
  const cacheKey = {};

  class InlineConstructPlugin {
    decorations: DecorationSet;
    private revealKey: string;
    private readonly view: EditorView;
    private readonly teardown: () => void;

    constructor(view: EditorView) {
      this.view = view;
      this.teardown = spec.setup?.(view) ?? (() => {});
      const cached = restorePersistentVisualPluginState<Snapshot>(view.state, cacheKey);
      this.decorations = cached?.decorations ?? build(view);
      this.revealKey = cached?.revealKey ?? revealKey(view.state);
    }

    update(update: ViewUpdate): void {
      const selectionOnly = update.selectionSet && !update.docChanged && !update.viewportChanged;
      if (selectionOnly && update.view.compositionStarted) return;
      if (isCoalescedVisualTyping(update)) {
        this.decorations = this.decorations.map(update.changes);
        return;
      }
      // A pointer drag settles once, when the button is released.
      if (selectionOnly && isPointerSelecting(update.state)) return;
      const settled = updateHasPointerSelectionEffect(update) && !isPointerSelecting(update.state);
      const nextKey = update.selectionSet || update.docChanged || settled
        || update.transactions.some(transactionChangesPinning)
        ? revealKey(update.state)
        : this.revealKey;
      if (update.docChanged || update.viewportChanged || nextKey !== this.revealKey
          || hasViewportDecorationRefresh(update)) {
        this.decorations = build(update.view);
      }
      this.revealKey = nextKey;
    }

    destroy(): void {
      rememberPersistentVisualPluginState<Snapshot>(this.view, cacheKey, {
        decorations: this.decorations,
        revealKey: this.revealKey,
      });
      this.teardown();
    }
  }

  return [
    constructSources.of(source),
    ViewPlugin.fromClass(InlineConstructPlugin, { decorations: (plugin) => plugin.decorations }),
  ];
}
