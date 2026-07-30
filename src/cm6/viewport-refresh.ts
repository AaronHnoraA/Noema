import { StateEffect, type Transaction } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";

export type ViewportRefreshRange = { from: number; to: number };
export const refreshViewportDecorations = StateEffect.define<readonly ViewportRefreshRange[]>();

// Active rAF handle per view (for cancellation).
const scheduledRefreshFrames = new WeakMap<EditorView, number>();
// Generation counter lets an in-flight refresh detect that it was superseded.
const viewGenerations = new WeakMap<EditorView, number>();

const VIEWPORT_PARSE_BUDGET_MS = 8;
const VIEWPORT_OVERSCAN_CHARS = 16 * 1024;

function refreshRanges(view: EditorView): ViewportRefreshRange[] {
  return view.visibleRanges.map((range) => ({
    from: Math.max(0, range.from - VIEWPORT_OVERSCAN_CHARS),
    to: Math.min(view.state.doc.length, range.to + VIEWPORT_OVERSCAN_CHARS),
  }));
}

function dispatchRefresh(view: EditorView, ranges: readonly ViewportRefreshRange[]): void {
  if (view.dom.isConnected) view.dispatch({ effects: refreshViewportDecorations.of(ranges) });
}

function cancelPendingRefresh(view: EditorView): void {
  const handle = scheduledRefreshFrames.get(view);
  if (handle !== undefined) {
    window.cancelAnimationFrame(handle);
    scheduledRefreshFrames.delete(view);
  }
}

// Model-backed widgets (for example citations) already have a parsed editor
// state. Dispatch their refresh immediately so an unrelated selection/layout
// transaction cannot cancel the update between animation frames.
export function refreshViewportDecorationsNow(view: EditorView): void {
  cancelPendingRefresh(view);
  viewGenerations.set(view, (viewGenerations.get(view) ?? 0) + 1);
  dispatchRefresh(view, refreshRanges(view));
}

export function scheduleViewportDecorationRefresh(view: EditorView): void {
  cancelPendingRefresh(view);
  const gen = (viewGenerations.get(view) ?? 0) + 1;
  viewGenerations.set(view, gen);
  const scheduledState = view.state;

  const frame = window.requestAnimationFrame(() => {
    if (viewGenerations.get(view) !== gen) return;
    scheduledRefreshFrames.delete(view);
    if (!view.dom.isConnected || view.state !== scheduledState) return;
    view.requestMeasure();

    const afterMeasure = window.requestAnimationFrame(() => {
      if (viewGenerations.get(view) !== gen) return;
      scheduledRefreshFrames.delete(view);
      if (!view.dom.isConnected || view.state !== scheduledState) return;

      const ranges = refreshRanges(view);
      const parseTo = ranges.reduce((maximum, range) => Math.max(maximum, range.to), 0);
      ensureSyntaxTree(view.state, parseTo, VIEWPORT_PARSE_BUDGET_MS);
      dispatchRefresh(view, ranges);
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
