import type {
  StateEffect,
  StateEffectType,
  Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

type ViewportSnapshot = {
  anchorPos: number;
  anchorOffset: number | null;
  scrollTop: number;
  scrollLeft: number;
  interaction: number;
};

type PrivateStateEffect = StateEffect<unknown> & {
  // StateEffect deliberately keeps its type private. CodeMirror exposes no
  // public predicate for scroll effects, so retain the type from one public
  // scrollIntoView effect and use StateEffect.is() below.
  type: StateEffectType<unknown>;
};

const scrollIntoViewEffectType = (
  EditorView.scrollIntoView(0) as PrivateStateEffect
).type;

const viewportStabilizers = new WeakMap<EditorView, EditorViewportStabilizer>();

export function preserveEditorViewport<T>(view: EditorView, update: () => T): T {
  return viewportStabilizers.get(view)?.preserve(update) ?? update();
}

function transactionMovesViewport(transaction: Transaction): boolean {
  return transaction.scrollIntoView
    || transaction.effects.some((effect) => effect.is(scrollIntoViewEffectType));
}

function transactionMayRelayout(transaction: Transaction): boolean {
  return transaction.docChanged
    || transaction.selection != null
    || transaction.effects.length > 0
    || transaction.reconfigured;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string, prefix: number): number {
  const limit = Math.min(left.length, right.length) - prefix;
  let length = 0;
  while (length < limit
      && left.charCodeAt(left.length - length - 1) === right.charCodeAt(right.length - length - 1)) {
    length += 1;
  }
  return length;
}

function closestContextMatch(
  source: string,
  target: string,
  position: number,
  expected: number,
): number | null {
  const available = Math.min(256, source.length);
  for (const requested of [available, 192, 128, 96, 64, 48, 32, 24, 16]) {
    const length = Math.min(requested, source.length);
    if (length < 12) continue;
    let from = Math.max(0, position - Math.floor(length / 2));
    from = Math.min(from, source.length - length);
    const context = source.slice(from, from + length);
    if (!context.trim()) continue;

    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let match = target.indexOf(context);
    while (match >= 0) {
      const mapped = match + (position - from);
      const distance = Math.abs(mapped - expected);
      if (distance < bestDistance) {
        best = mapped;
        bestDistance = distance;
      }
      match = target.indexOf(context, match + 1);
    }
    if (best >= 0) return best;
  }
  return null;
}

/**
 * Map a logical source position across an externally supplied document.
 *
 * A common prefix/suffix handles the normal single-edit case in O(n). When a
 * save contains several distant edits, the broad changed span can cover the
 * viewport even though its text did not change. In that case an exact local
 * context relocates the cursor/viewport instead of mapping it to an edge of
 * the replacement.
 */
export function mapPositionAcrossText(
  source: string,
  target: string,
  rawPosition: number,
  assoc = 1,
): number {
  const position = Math.max(0, Math.min(rawPosition, source.length));
  if (source === target) return Math.min(position, target.length);

  const prefix = commonPrefixLength(source, target);
  const suffix = commonSuffixLength(source, target, prefix);
  const sourceChangeEnd = source.length - suffix;
  const targetChangeEnd = target.length - suffix;

  if (position < prefix || (position === prefix && assoc < 0)) return position;
  if (position > sourceChangeEnd || (position === sourceChangeEnd && assoc > 0)) {
    return Math.max(0, Math.min(target.length, targetChangeEnd + position - sourceChangeEnd));
  }

  const sourceSpan = Math.max(1, sourceChangeEnd - prefix);
  const targetSpan = Math.max(0, targetChangeEnd - prefix);
  const expected = Math.max(0, Math.min(
    target.length,
    prefix + Math.round(((position - prefix) / sourceSpan) * targetSpan),
  ));
  const contextual = closestContextMatch(source, target, position, expected);
  return contextual == null ? expected : contextual;
}

/** Return the smallest contiguous CM6 change that produces `target`. */
export function minimalDocumentChange(
  source: string,
  target: string,
): { from: number; to: number; insert: string } | null {
  if (source === target) return null;
  const prefix = commonPrefixLength(source, target);
  const suffix = commonSuffixLength(source, target, prefix);
  return {
    from: prefix,
    to: source.length - suffix,
    insert: target.slice(prefix, target.length - suffix),
  };
}

/**
 * Owns viewport stability at the CM6 boundary.
 *
 * Noema scrolls the editor's outer host rather than CM6's `.cm-scroller`, so
 * EditorView.scrollSnapshot() cannot protect this viewport. This controller
 * captures the first visible document block and keeps that block at the same
 * screen offset across transactions and later widget/font/image remeasurement.
 */
export class EditorViewportStabilizer {
  private readonly view: EditorView;
  private readonly scrollHost: HTMLElement;
  private readonly win: Window;
  private readonly abort = new AbortController();
  private readonly resizeObserver: ResizeObserver | null;
  private interaction = 0;
  private generation = 0;
  private forcedDepth = 0;
  private forcedSnapshot: ViewportSnapshot | null = null;
  private stableSnapshot: ViewportSnapshot | null = null;
  private baselineFrame = 0;
  private readonly previousOverflowAnchor: string;

  constructor(view: EditorView, scrollHost: HTMLElement) {
    this.view = view;
    this.scrollHost = scrollHost;
    this.win = view.dom.ownerDocument.defaultView ?? window;
    viewportStabilizers.set(view, this);
    this.previousOverflowAnchor = scrollHost.style.overflowAnchor;
    // Browser scroll anchoring chooses arbitrary descendants when CM6 swaps
    // replacement widgets. The document-position anchor below is deterministic.
    scrollHost.style.overflowAnchor = "none";

    const cancelForInteraction = (): void => {
      this.interaction += 1;
      this.generation += 1;
      this.scheduleBaselineCapture();
    };
    const listenerOptions = { capture: true, passive: true, signal: this.abort.signal } as const;
    scrollHost.addEventListener("pointerdown", cancelForInteraction, listenerOptions);
    scrollHost.addEventListener("wheel", cancelForInteraction, listenerOptions);
    scrollHost.addEventListener("touchmove", cancelForInteraction, listenerOptions);
    scrollHost.addEventListener("scroll", () => this.scheduleBaselineCapture(), {
      passive: true,
      signal: this.abort.signal,
    });
    scrollHost.ownerDocument.addEventListener("keydown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-aaronnote-vim='native']")) return;
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) {
        cancelForInteraction();
      }
    }, {
      capture: true,
      signal: this.abort.signal,
    });

    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          const snapshot = this.stableSnapshot;
          if (!snapshot || snapshot.interaction !== this.interaction || this.forcedDepth > 0) return;
          this.scheduleRestore(snapshot);
        });
    this.resizeObserver?.observe(view.contentDOM);
    this.scheduleBaselineCapture();
  }

  update(transactions: readonly Transaction[]): void {
    const forced = this.forcedSnapshot;
    const automatic = !forced
      && transactions.some(transactionMayRelayout)
      && !transactions.some(transactionMovesViewport);
    const snapshot = forced ?? (automatic ? this.capture() : null);
    if (snapshot) this.mapSnapshot(snapshot, transactions);

    this.view.update(transactions);

    if (forced) return;
    if (snapshot) this.scheduleRestore(snapshot);
    else this.resetBaseline();
  }

  preserve<T>(update: () => T, mapAnchor?: (position: number) => number): T {
    const outermost = this.forcedDepth === 0;
    if (outermost) this.forcedSnapshot = this.capture();
    const originalAnchor = outermost ? this.forcedSnapshot?.anchorPos ?? 0 : 0;
    this.forcedDepth += 1;
    try {
      return update();
    } finally {
      this.forcedDepth -= 1;
      if (outermost) {
        const snapshot = this.forcedSnapshot;
        this.forcedSnapshot = null;
        if (snapshot) {
          if (mapAnchor) {
            snapshot.anchorPos = Math.max(
              0,
              Math.min(this.view.state.doc.length, mapAnchor(originalAnchor)),
            );
          }
          this.scheduleRestore(snapshot);
        } else {
          this.resetBaseline();
        }
      }
    }
  }

  resetBaseline(): void {
    this.generation += 1;
    this.stableSnapshot = null;
    this.scheduleBaselineCapture();
  }

  destroy(): void {
    this.generation += 1;
    this.abort.abort();
    this.resizeObserver?.disconnect();
    viewportStabilizers.delete(this.view);
    if (this.baselineFrame) this.win.cancelAnimationFrame(this.baselineFrame);
    this.scrollHost.style.overflowAnchor = this.previousOverflowAnchor;
  }

  private capture(): ViewportSnapshot | null {
    if (!this.view.dom.isConnected || !this.scrollHost.isConnected) return null;
    const scrollTop = this.scrollHost.scrollTop;
    const scrollLeft = this.scrollHost.scrollLeft;
    let anchorPos = Math.max(0, Math.min(this.view.viewport.from, this.view.state.doc.length));
    let anchorOffset: number | null = null;
    try {
      const hostTop = this.scrollHost.getBoundingClientRect().top;
      const documentTop = this.view.documentTop;
      const relativeHeight = Math.max(0, (hostTop - documentTop) / Math.max(0.0001, this.view.scaleY));
      const block = this.view.lineBlockAtHeight(relativeHeight);
      anchorPos = Math.max(0, Math.min(block.from, this.view.state.doc.length));
      anchorOffset = documentTop + block.top * this.view.scaleY - hostTop;
      if (!Number.isFinite(anchorOffset)) anchorOffset = null;
    } catch {
      // A view can be between mount and its first measure. Absolute offsets
      // remain a safe fallback until the next animation frame captures a block.
    }
    return {
      anchorPos,
      anchorOffset,
      scrollTop,
      scrollLeft,
      interaction: this.interaction,
    };
  }

  private mapSnapshot(snapshot: ViewportSnapshot, transactions: readonly Transaction[]): void {
    let position = snapshot.anchorPos;
    for (const transaction of transactions) position = transaction.changes.mapPos(position, 1);
    snapshot.anchorPos = Math.max(0, Math.min(position, transactions.at(-1)?.state.doc.length ?? position));
  }

  private restore(snapshot: ViewportSnapshot, generation: number): void {
    if (generation !== this.generation
        || snapshot.interaction !== this.interaction
        || !this.view.dom.isConnected
        || !this.scrollHost.isConnected) return;

    this.scrollHost.scrollTop = snapshot.scrollTop;
    this.scrollHost.scrollLeft = snapshot.scrollLeft;
    if (snapshot.anchorOffset != null) {
      try {
        const hostTop = this.scrollHost.getBoundingClientRect().top;
        const block = this.view.lineBlockAt(Math.min(snapshot.anchorPos, this.view.state.doc.length));
        const currentOffset = this.view.documentTop + block.top * this.view.scaleY - hostTop;
        const correction = currentOffset - snapshot.anchorOffset;
        if (Number.isFinite(correction) && Math.abs(correction) > 0.5) {
          this.scrollHost.scrollTop += correction;
        }
      } catch {
        // Keep the absolute fallback and retry after CM6's scheduled measure.
      }
    }
    snapshot.scrollTop = this.scrollHost.scrollTop;
    snapshot.scrollLeft = this.scrollHost.scrollLeft;
    this.stableSnapshot = snapshot;
  }

  private scheduleRestore(snapshot: ViewportSnapshot): void {
    if (snapshot.interaction !== this.interaction) return;
    const generation = ++this.generation;
    this.restore(snapshot, generation);
    this.view.requestMeasure({
      read: () => snapshot,
      write: (measured) => this.restore(measured, generation),
    });
    this.win.requestAnimationFrame(() => {
      this.restore(snapshot, generation);
      this.win.requestAnimationFrame(() => {
        this.restore(snapshot, generation);
        if (generation === this.generation) this.stableSnapshot = snapshot;
      });
    });
  }

  private scheduleBaselineCapture(): void {
    if (this.baselineFrame) this.win.cancelAnimationFrame(this.baselineFrame);
    this.baselineFrame = this.win.requestAnimationFrame(() => {
      this.baselineFrame = this.win.requestAnimationFrame(() => {
        this.baselineFrame = 0;
        if (this.forcedDepth === 0) this.stableSnapshot = this.capture();
      });
    });
  }
}
