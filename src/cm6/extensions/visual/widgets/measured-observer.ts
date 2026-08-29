import type { EditorView } from "@codemirror/view";
import { ViewMeasureScheduler } from "../../../view-measure-scheduler.ts";

// ---------------------------------------------------------------------------
// Per-content height cache: stable key → last measured pixel height
// This lets CM6 use a close estimate for estimatedHeight when a widget is
// recreated off-screen during scroll, avoiding height-map thrash.
// ---------------------------------------------------------------------------

const MAX_CACHE_SIZE = 500;
const HEIGHT_CHANGE_EPSILON_CSS_PX = 1;
export const measuredHeightCache = new Map<string, number>();

function cacheSet(key: string, height: number): void {
  if (measuredHeightCache.has(key)) {
    measuredHeightCache.delete(key); // refresh LRU order
  } else if (measuredHeightCache.size >= MAX_CACHE_SIZE) {
    const oldest = measuredHeightCache.keys().next().value;
    if (oldest !== undefined) measuredHeightCache.delete(oldest);
  }
  measuredHeightCache.set(key, height);
}

export function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Normalize WebKit's fractional layout noise to physical-pixel boundaries. */
export function stableMeasuredHeight(height: number, pixelRatio = 1): number {
  if (!Number.isFinite(height) || height <= 0) return 0;
  const scale = Math.min(4, Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1));
  return Math.round(height * scale) / scale;
}

/** A one-CSS-pixel wobble cannot affect CM6's block position meaningfully. */
export function measuredHeightChanged(previous: number | undefined, next: number): boolean {
  return previous === undefined || Math.abs(next - previous) > HEIGHT_CHANGE_EPSILON_CSS_PX;
}

function devicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

function measuredElementHeight(el: HTMLElement): number {
  const rectHeight = el.getBoundingClientRect().height;
  if (Number.isFinite(rectHeight) && rectHeight > 0) return rectHeight;
  return el.offsetHeight;
}

function resizeEntryHeight(entry: ResizeObserverEntry, el: HTMLElement): number {
  // borderBoxSize is already available from the observer's completed layout
  // pass, so prefer it over a synchronous getBoundingClientRect() read.
  const rawBox = entry.borderBoxSize as unknown as ResizeObserverSize | readonly ResizeObserverSize[] | undefined;
  const box = Array.isArray(rawBox) ? rawBox[0] : rawBox;
  const blockSize = box?.blockSize ?? 0;
  return Number.isFinite(blockSize) && blockSize > 0 ? blockSize : measuredElementHeight(el);
}

function cacheElementHeight(el: HTMLElement, height: number): void {
  if (height <= 0) return;
  const key = el.dataset.cmMeasureKey;
  if (key) cacheSet(key, height);
  const groupKey = el.dataset.cmMeasureGroupKey;
  if (groupKey) cacheSet(groupKey, height);
}

// ---------------------------------------------------------------------------
// Shared ResizeObserver — detects height changes CM6's own MutationObserver
// misses (lazy images, async SVGs, KaTeX font reflow, comment collapse, etc.).
//
// A resize only invalidates CM6's height map.  It must not rebuild viewport
// decorations: rebuilding replaces measured widgets, which can recursively
// trigger ResizeObserver in fractional-layout engines such as WebKit.
// ---------------------------------------------------------------------------

const elementToView = new WeakMap<Element, EditorView>();
const lastHeights = new WeakMap<Element, number>();
let sharedRO: ResizeObserver | null = null;
let measurementPaused = false;
let measureScheduler: ViewMeasureScheduler<EditorView> | null = null;

function getMeasureScheduler(): ViewMeasureScheduler<EditorView> | null {
  if (measureScheduler) return measureScheduler;
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return null;
  measureScheduler = new ViewMeasureScheduler<EditorView>(
    window,
    (view) => view.dom.isConnected,
    (view) => view.requestMeasure(),
  );
  measureScheduler.setPaused(measurementPaused);
  return measureScheduler;
}

function getSharedRO(): ResizeObserver | null {
  if (sharedRO) return sharedRO;
  if (typeof ResizeObserver === "undefined") return null; // jsdom / test env
  sharedRO = new ResizeObserver((entries) => {
    const scheduler = getMeasureScheduler();
    if (!scheduler) return;
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      const newH = stableMeasuredHeight(resizeEntryHeight(entry, el), devicePixelRatio());
      const oldH = lastHeights.get(el);
      if (!measuredHeightChanged(oldH, newH)) continue;
      lastHeights.set(el, newH);
      cacheElementHeight(el, newH);
      const view = elementToView.get(el);
      if (view) scheduler.schedule(view);
    }
  });
  return sharedRO;
}

/** Pause all observer-driven CM6 measurements without losing dirty views. */
export function setMeasuredWidgetObservationPaused(paused: boolean): void {
  measurementPaused = paused;
  measureScheduler?.setPaused(paused);
}

/** Drop the scheduler's last possible strong reference before view teardown. */
export function discardMeasuredWidgetView(view: EditorView): void {
  measureScheduler?.discard(view);
}

export function observeWidget(el: HTMLElement, view: EditorView): void {
  const ro = getSharedRO();
  if (!ro) return;
  elementToView.set(el, view);
  ro.observe(el);
  // Do not read layout here. Widget registration runs inside CM6's DOM
  // reconciliation, often once per newly visible formula. A synchronous
  // getBoundingClientRect() for every registration turns one viewport update
  // into alternating DOM writes and forced layouts. The first ResizeObserver
  // delivery already carries the post-layout border-box height; it seeds the
  // cache and schedules one coalesced view measurement for the whole batch.
}

export function unobserveWidget(el: HTMLElement): void {
  sharedRO?.unobserve(el);
  elementToView.delete(el);
  lastHeights.delete(el);
}
