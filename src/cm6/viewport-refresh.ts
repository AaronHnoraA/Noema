import { StateEffect, type Transaction } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { waitForParser } from "./extensions/parser-watcher.ts";

export type ViewportRefreshRange = { from: number; to: number };
export const refreshViewportDecorations = StateEffect.define<readonly ViewportRefreshRange[]>();

// Active rAF handle per view (for cancellation).
const scheduledRefreshFrames = new WeakMap<EditorView, number>();
// Sets make the weakly keyed schedules enumerable while a page is paused or
// destroyed. They never grow beyond the live editor views in this renderer.
const scheduledViews = new Set<EditorView>();
const pausedDirtyViews = new Set<EditorView>();
// Generation counter lets an in-flight refresh detect that it was superseded.
const viewGenerations = new WeakMap<EditorView, number>();
// At most one background-parser continuation may exist for a live view.
const parserWaitViews = new WeakSet<EditorView>();
let viewportRefreshPaused = false;

const VIEWPORT_PARSE_BUDGET_MS = 8;
const VIEWPORT_OVERSCAN_CHARS = 16 * 1024;

function refreshRanges(view: EditorView): ViewportRefreshRange[] {
  return view.visibleRanges.map((range) => ({
    from: Math.max(0, range.from - VIEWPORT_OVERSCAN_CHARS),
    to: Math.min(view.state.doc.length, range.to + VIEWPORT_OVERSCAN_CHARS),
  }));
}

function viewportParseTarget(view: EditorView): number {
  return refreshRanges(view).reduce((maximum, range) => Math.max(maximum, range.to), 0);
}

function dispatchRefresh(view: EditorView, ranges: readonly ViewportRefreshRange[]): void {
  if (view.dom.isConnected) view.dispatch({ effects: refreshViewportDecorations.of(ranges) });
}

function advanceGeneration(view: EditorView): number {
  const generation = (viewGenerations.get(view) ?? 0) + 1;
  viewGenerations.set(view, generation);
  return generation;
}

function cancelPendingRefresh(view: EditorView): void {
  const handle = scheduledRefreshFrames.get(view);
  if (handle !== undefined) {
    window.cancelAnimationFrame(handle);
    scheduledRefreshFrames.delete(view);
  }
  scheduledViews.delete(view);
}

function restartRefreshForLatestState(view: EditorView): void {
  scheduledRefreshFrames.delete(view);
  scheduledViews.delete(view);
  if (view.dom.isConnected) scheduleViewportDecorationRefresh(view);
}

function refreshWhenParserReady(view: EditorView): void {
  if (parserWaitViews.has(view)) return;
  parserWaitViews.add(view);
  try {
    void waitForParser(view, (currentView) => viewportParseTarget(currentView)).then(() => {
      parserWaitViews.delete(view);
      if (view.dom.isConnected) scheduleViewportDecorationRefresh(view);
    });
  } catch {
    // Lightweight test/embedding views may intentionally omit parserWatcher.
    // The initial bounded refresh has still run; never replace a missing
    // parser with an animation-frame retry loop.
    parserWaitViews.delete(view);
  }
}

function deferPausedRefresh(view: EditorView): void {
  cancelPendingRefresh(view);
  advanceGeneration(view);
  if (view.dom.isConnected) pausedDirtyViews.add(view);
  else pausedDirtyViews.delete(view);
}

/**
 * Freeze decoration parsing/rebuild work for a background renderer.
 *
 * Calls made while paused collapse to one dirty bit per view. Resuming queues
 * exactly one normal refresh, preserving correctness without an idle rAF loop.
 */
export function setViewportDecorationRefreshPaused(paused: boolean): void {
  if (viewportRefreshPaused === paused) return;
  viewportRefreshPaused = paused;
  if (paused) {
    for (const view of [...scheduledViews]) deferPausedRefresh(view);
    return;
  }
  const dirtyViews = [...pausedDirtyViews];
  pausedDirtyViews.clear();
  for (const view of dirtyViews) scheduleViewportDecorationRefresh(view);
}

/** Remove any strong scheduler reference before an editor view is destroyed. */
export function forgetViewportDecorationRefresh(view: EditorView): void {
  cancelPendingRefresh(view);
  advanceGeneration(view);
  pausedDirtyViews.delete(view);
}

// Model-backed widgets (for example citations) already have a parsed editor
// state. Dispatch their refresh immediately so an unrelated selection/layout
// transaction cannot cancel the update between animation frames.
export function refreshViewportDecorationsNow(view: EditorView): void {
  if (viewportRefreshPaused) {
    deferPausedRefresh(view);
    return;
  }
  cancelPendingRefresh(view);
  advanceGeneration(view);
  pausedDirtyViews.delete(view);
  dispatchRefresh(view, refreshRanges(view));
}

export function scheduleViewportDecorationRefresh(view: EditorView): void {
  if (viewportRefreshPaused) {
    deferPausedRefresh(view);
    return;
  }
  cancelPendingRefresh(view);
  pausedDirtyViews.delete(view);
  const gen = advanceGeneration(view);
  const scheduledState = view.state;
  scheduledViews.add(view);

  const frame = window.requestAnimationFrame(() => {
    if (viewGenerations.get(view) !== gen) return;
    scheduledRefreshFrames.delete(view);
    if (!view.dom.isConnected) {
      scheduledViews.delete(view);
      return;
    }
    // Opening a note is followed by selection restore, host configuration and
    // focus transactions. The previous implementation discarded the only
    // initial viewport refresh when any of those replaced EditorState between
    // these two frames. Toggling source mode rebuilt every visual compartment
    // later, which is why Cmd+/ twice appeared to "finish" the first render.
    if (view.state !== scheduledState) {
      restartRefreshForLatestState(view);
      return;
    }
    if (viewportRefreshPaused) {
      scheduledViews.delete(view);
      pausedDirtyViews.add(view);
      return;
    }
    view.requestMeasure();

    const afterMeasure = window.requestAnimationFrame(() => {
      if (viewGenerations.get(view) !== gen) return;
      scheduledRefreshFrames.delete(view);
      scheduledViews.delete(view);
      if (!view.dom.isConnected) return;
      if (view.state !== scheduledState) {
        restartRefreshForLatestState(view);
        return;
      }
      if (viewportRefreshPaused) {
        pausedDirtyViews.add(view);
        return;
      }

      const ranges = refreshRanges(view);
      const parseTo = viewportParseTarget(view);
      const parsed = ensureSyntaxTree(view.state, parseTo, VIEWPORT_PARSE_BUDGET_MS);
      dispatchRefresh(view, ranges);
      // `ensureSyntaxTree` is explicitly budgeted. If it cannot cover the
      // viewport in 8 ms, let CM6's background parser continue and perform one
      // final rebuild when parserWatcher reports that the current viewport is
      // ready. This fixes the incomplete first build without adding a parse or
      // animation-frame loop to large documents.
      if (!parsed && view.dom.isConnected) refreshWhenParserReady(view);
    });
    scheduledRefreshFrames.set(view, afterMeasure);
  });
  scheduledRefreshFrames.set(view, frame);
}

export function hasViewportDecorationRefresh(update: ViewUpdate): boolean {
  return update.transactions.some((tr) =>
    tr.effects.some((effect) => effect.is(refreshViewportDecorations)));
}

export function viewportDecorationRefreshRanges(transaction: Transaction): readonly ViewportRefreshRange[] | null {
  for (const effect of transaction.effects) {
    if (effect.is(refreshViewportDecorations)) return effect.value;
  }
  return null;
}
