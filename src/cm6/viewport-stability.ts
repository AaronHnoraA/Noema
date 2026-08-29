import type {
  StateEffect,
  StateEffectType,
  Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { normalizedEditorKey } from "./focus-quiescence.ts";
import { invalidatePersistentVisualState } from "./extensions/visual/visual-mode.ts";

type ViewportSnapshot = {
  anchorPos: number;
  anchorOffset: number | null;
  preciseAnchor: boolean;
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

export function isViewportScrollKey(
  event: Pick<KeyboardEvent, "key" | "code">,
): boolean {
  return ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "]
    .includes(normalizedEditorKey(event));
}

export function preserveEditorViewport<T>(
  view: EditorView,
  update: () => T,
  preferredAnchorPos?: number,
): T {
  return viewportStabilizers.get(view)?.preserve(
    update,
    undefined,
    preferredAnchorPos,
  ) ?? update();
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
  private scrolling = false;
  private scrollIdleTimer = 0;
  private expectedProgrammaticScrollTop: number | null = null;
  private restoringGeneration = 0;
  private preserveGraceUntil = 0;
  private leasedSnapshot: ViewportSnapshot | null = null;
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

    const beginScrollInteraction = (): void => {
      invalidatePersistentVisualState(this.view);
      this.expectedProgrammaticScrollTop = null;
      this.restoringGeneration = 0;
      this.preserveGraceUntil = 0;
      this.leasedSnapshot = null;
      this.interaction += 1;
      this.generation += 1;
      this.stableSnapshot = null;
      this.scrolling = true;
      if (this.baselineFrame) {
        this.win.cancelAnimationFrame(this.baselineFrame);
        this.baselineFrame = 0;
      }
      this.armScrollIdle();
    };
    const listenerOptions = { capture: true, passive: true, signal: this.abort.signal } as const;
    // Pointer ownership also covers scrollbar dragging and edge auto-scroll
    // during selection. A click that never scrolls only suppresses automatic
    // correction for the short idle window.
    scrollHost.addEventListener("pointerdown", beginScrollInteraction, listenerOptions);
    scrollHost.addEventListener("wheel", beginScrollInteraction, listenerOptions);
    scrollHost.addEventListener("touchmove", beginScrollInteraction, listenerOptions);
    scrollHost.addEventListener("scroll", () => {
      const expected = this.expectedProgrammaticScrollTop;
      if (expected != null) {
        // A write made by restore() emits `scroll` asynchronously. It is an
        // acknowledgement of our own anchor correction, not a new user
        // interaction that should invalidate the remaining measured writes.
        // Keep the target armed: one preserve cycle deliberately writes in
        // the transaction, measure, and two animation-frame phases, and
        // WebKit may emit a separate scroll event for each write.
        if (Math.abs(this.scrollHost.scrollTop - expected) <= 0.5) return;
      }
      // Reconfiguring Preview/Source changes the document height before our
      // measured anchor correction runs. WebKit emits a clamped `scroll`
      // event for that layout change. It is not user intent and must not
      // cancel the remaining transaction/measure/frame restores. Explicit
      // wheel, pointer, touch and scroll keys still call beginScrollInteraction
      // above and therefore win immediately.
      if (this.restoringGeneration === this.generation
          || this.win.performance.now() < this.preserveGraceUntil) {
        const leased = this.activeLeasedSnapshot();
        const snapshot = leased ?? this.stableSnapshot;
        if (this.restoringGeneration === 0
            && snapshot
            && snapshot.interaction === this.interaction) {
          this.scheduleRestore({ ...snapshot }, Boolean(leased));
        }
        return;
      }
      if (this.scrolling) this.armScrollIdle();
      // A slow frame can outlive the idle threshold, and scrollbar/programmatic
      // movement may not have a preceding wheel event. A new scroll event is
      // itself authoritative evidence that viewport movement resumed.
      else beginScrollInteraction();
    }, {
      passive: true,
      signal: this.abort.signal,
    });
    scrollHost.ownerDocument.addEventListener("keydown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-aaronnote-vim='native']")) return;
      if (isViewportScrollKey(event)) {
        beginScrollInteraction();
      }
    }, {
      capture: true,
      signal: this.abort.signal,
    });

    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        const leased = this.activeLeasedSnapshot();
        const snapshot = leased ?? this.stableSnapshot;
        if (this.scrolling
            || !snapshot
            || snapshot.interaction !== this.interaction
            || this.forcedDepth > 0) return;
        this.scheduleRestore({ ...snapshot }, Boolean(leased));
      });
    this.resizeObserver?.observe(view.contentDOM);
    this.scheduleBaselineCapture();
  }

  /**
   * Repair the outer viewport after CM6 has atomically applied transactions.
   *
   * This must never run before EditorView.update(). Geometry reads can be
   * re-entrant in WebKit/xwidget (for example, they may flush a pending focus
   * transaction). If that advances the view first, CM6 correctly rejects the
   * original transaction as starting from an older EditorState.
   */
  afterUpdate(transactions: readonly Transaction[]): void {
    const forced = this.forcedSnapshot;
    const leased = forced ? null : this.activeLeasedSnapshot();
    const automatic = !forced
      && !leased
      && !this.scrolling
      && transactions.some(transactionMayRelayout)
      && !transactions.some(transactionMovesViewport);
    // Explicit preserve() calls own a fresh pre-update snapshot. Automatic
    // stabilization uses the last asynchronously captured baseline so this
    // post-update hook never has to read layout before applying a transaction.
    const snapshot = forced ?? leased ?? (automatic && this.stableSnapshot
      ? { ...this.stableSnapshot }
      : null);
    if (snapshot) this.mapSnapshot(snapshot, transactions);
    if (leased && snapshot) this.leasedSnapshot = { ...snapshot };

    if (forced) return;
    if (snapshot) this.scheduleRestore(snapshot, Boolean(leased));
    else this.resetBaseline();
  }

  preserve<T>(
    update: () => T,
    mapAnchor?: (position: number) => number,
    preferredAnchorPos?: number,
  ): T {
    const outermost = this.forcedDepth === 0;
    if (outermost && this.scrollIdleTimer) {
      // The command establishes a new atomic viewport boundary. An idle timer
      // from scrolling *before* the command must not advance generation in the
      // middle of its measured restore. New input after this point creates a
      // fresh interaction and still cancels the restore immediately.
      this.win.clearTimeout(this.scrollIdleTimer);
      this.scrollIdleTimer = 0;
      this.scrolling = false;
    }
    // preserve() is an explicit atomic relayout request. Unlike automatic
    // stabilization it must capture the current geometry even inside the
    // short scroll-idle window; Cmd-/ commonly follows a reveal/selection
    // scroll and previously lost its viewport for exactly that reason.
    if (outermost) this.forcedSnapshot = this.capture(preferredAnchorPos);
    if (outermost) {
      // Fonts, formula widgets and WebKit's height map can settle well after
      // the first two animation frames. During this bounded lease, an
      // unaccompanied scroll is treated as layout clamping and re-anchored.
      // Real input events revoke the lease synchronously above.
      this.preserveGraceUntil = this.win.performance.now() + 1_000;
    }
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
          this.leasedSnapshot = { ...snapshot };
          this.scheduleRestore(snapshot, true);
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
    if (this.scrollIdleTimer) this.win.clearTimeout(this.scrollIdleTimer);
    this.scrollHost.style.overflowAnchor = this.previousOverflowAnchor;
  }

  private armScrollIdle(): void {
    if (this.scrollIdleTimer) this.win.clearTimeout(this.scrollIdleTimer);
    this.scrollIdleTimer = this.win.setTimeout(() => {
      this.scrollIdleTimer = 0;
      this.scrolling = false;
      this.generation += 1;
      this.stableSnapshot = null;
      this.scheduleBaselineCapture();
    }, 140);
  }

  private activeLeasedSnapshot(): ViewportSnapshot | null {
    if (this.win.performance.now() < this.preserveGraceUntil) {
      return this.leasedSnapshot;
    }
    this.leasedSnapshot = null;
    return null;
  }

  private capture(preferredAnchorPos?: number): ViewportSnapshot | null {
    if (!this.view.dom.isConnected || !this.scrollHost.isConnected) return null;
    const scrollTop = this.scrollHost.scrollTop;
    const scrollLeft = this.scrollHost.scrollLeft;
    let anchorPos = Math.max(0, Math.min(
      preferredAnchorPos ?? this.view.viewport.from,
      this.view.state.doc.length,
    ));
    let anchorOffset: number | null = null;
    let preciseAnchor = false;
    let anchorCaptured = false;
    try {
      const hostTop = this.scrollHost.getBoundingClientRect().top;
      if (preferredAnchorPos != null) {
        const captureCoordinates = (): void => {
          const coordinates = this.view.coordsAtPos?.(anchorPos);
          if (!coordinates) return;
          anchorOffset = coordinates.top - hostTop;
          preciseAnchor = true;
          anchorCaptured = true;
        };
        if (anchorPos >= this.view.viewport.from && anchorPos <= this.view.viewport.to) {
          try {
            const block = this.view.lineBlockAt(anchorPos);
            anchorOffset = this.view.documentTop + block.top * this.view.scaleY - hostTop;
            anchorCaptured = true;
          } catch {
            captureCoordinates();
          }
        } else {
          captureCoordinates();
        }
      }
      if (!anchorCaptured) {
        const documentTop = this.view.documentTop;
        const relativeHeight = Math.max(0, (hostTop - documentTop) / Math.max(0.0001, this.view.scaleY));
        const block = preferredAnchorPos == null
          ? this.view.lineBlockAtHeight(relativeHeight)
          : this.view.lineBlockAt(anchorPos);
        anchorOffset = documentTop + block.top * this.view.scaleY - hostTop;
        if (!Number.isFinite(anchorOffset)) anchorOffset = null;
      }
      if (preferredAnchorPos == null) {
        const documentTop = this.view.documentTop;
        const relativeHeight = Math.max(0, (hostTop - documentTop) / Math.max(0.0001, this.view.scaleY));
        const block = this.view.lineBlockAtHeight(relativeHeight);
        anchorPos = Math.max(0, Math.min(block.from, this.view.state.doc.length));
      }
      // At the upper boundary, scrollTop=0 is the authoritative anchor. A
      // source/preview layout may move the first source position vertically;
      // correcting that offset would push the host away from the document top
      // and cannot be reversed while the other mode is clamped at zero.
      if (scrollTop <= 0.5) anchorOffset = null;
    } catch {
      // A view can be between mount and its first measure. Absolute offsets
      // remain a safe fallback until the next animation frame captures a block.
    }
    return {
      anchorPos,
      anchorOffset,
      preciseAnchor,
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

    this.writeScrollTop(snapshot.scrollTop);
    this.scrollHost.scrollLeft = snapshot.scrollLeft;
    if (snapshot.anchorOffset != null) {
      try {
        const hostTop = this.scrollHost.getBoundingClientRect().top;
        const position = Math.min(snapshot.anchorPos, this.view.state.doc.length);
        const coordinates = snapshot.preciseAnchor
          ? this.view.coordsAtPos?.(position)
          : null;
        const currentOffset = coordinates
          ? coordinates.top - hostTop
          : this.view.documentTop
            + this.view.lineBlockAt(position).top * this.view.scaleY
            - hostTop;
        const correction = currentOffset - snapshot.anchorOffset;
        if (Number.isFinite(correction) && Math.abs(correction) > 0.5) {
          this.writeScrollTop(this.scrollHost.scrollTop + correction);
        }
      } catch {
        // Keep the absolute fallback and retry after CM6's scheduled measure.
      }
    }
    snapshot.scrollTop = this.scrollHost.scrollTop;
    snapshot.scrollLeft = this.scrollHost.scrollLeft;
    this.stableSnapshot = snapshot;
  }

  private writeScrollTop(value: number): void {
    this.scrollHost.scrollTop = value;
    this.expectedProgrammaticScrollTop = this.scrollHost.scrollTop;
  }

  private scheduleRestore(snapshot: ViewportSnapshot, explicit = false): void {
    if ((!explicit && this.scrolling) || snapshot.interaction !== this.interaction) return;
    const generation = ++this.generation;
    this.restoringGeneration = generation;
    this.restore(snapshot, generation);
    this.view.requestMeasure({
      read: () => snapshot,
      write: (measured) => this.restore(measured, generation),
    });
    this.win.requestAnimationFrame(() => {
      this.restore(snapshot, generation);
      this.win.requestAnimationFrame(() => {
        this.restore(snapshot, generation);
        if (generation === this.generation) {
          this.stableSnapshot = snapshot;
          this.restoringGeneration = 0;
        }
      });
    });
  }

  private scheduleBaselineCapture(): void {
    if (this.scrolling) return;
    if (this.baselineFrame) this.win.cancelAnimationFrame(this.baselineFrame);
    this.baselineFrame = this.win.requestAnimationFrame(() => {
      this.baselineFrame = this.win.requestAnimationFrame(() => {
        this.baselineFrame = 0;
        if (!this.scrolling && this.forcedDepth === 0) this.stableSnapshot = this.capture();
      });
    });
  }
}
