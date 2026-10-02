/**
 * Shared formula-rendering backpressure for both Noema hosts.
 *
 * CM6 updates its viewport synchronously from the scroll event. Mounting a
 * large KaTeX subtree in that same turn makes WebKit/Blink style thousands of
 * nodes before the scroll frame can paint. Newly entering display formulas
 * therefore register a lightweight height placeholder during a scroll burst.
 * A bounded animation-frame queue fills visible formulas first, including
 * during continuous scrolling, so a gesture never leaves the page blank.
 */

export type FormulaScrollView = {
  dom: HTMLElement;
  requestMeasure(): void;
};

type DeferredFormulaWork = {
  active: boolean;
  timer: number;
  frame: number;
  pending: Map<HTMLElement, () => void>;
  win: Window;
};

const formulaScrollWork = new WeakMap<FormulaScrollView, DeferredFormulaWork>();
export const FORMULA_SCROLL_SETTLE_MS = 120;
const MAX_FORMULAS_PER_FRAME = 2;
const FORMULA_FRAME_BUDGET_MS = 4;

function stateFor(view: FormulaScrollView): DeferredFormulaWork {
  let state = formulaScrollWork.get(view);
  if (state) return state;
  const win = view.dom.ownerDocument.defaultView ?? window;
  state = { active: false, timer: 0, frame: 0, pending: new Map(), win };
  formulaScrollWork.set(view, state);
  return state;
}

function flushFormulaScrollWork(view: FormulaScrollView, state: DeferredFormulaWork): void {
  state.frame = 0;
  if (!view.dom.isConnected) {
    state.pending.clear();
    return;
  }
  const pending = [...state.pending];
  // Read all geometry before any mount writes DOM. Off-screen overscan work
  // must not delay the formulas the reader can currently see.
  const distances = new Map<HTMLElement, number>();
  for (const [element] of pending) {
    if (!element.isConnected) { state.pending.delete(element); continue; }
    const rect = element.getBoundingClientRect();
    distances.set(element, Math.max(0, -rect.bottom, rect.top - state.win.innerHeight));
  }
  pending.sort(([a], [b]) => (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity));
  const started = state.win.performance.now();
  let mounted = 0;
  for (const [element, mount] of pending) {
    if (!element.isConnected) continue;
    if (mounted >= MAX_FORMULAS_PER_FRAME
        || (mounted > 0 && state.win.performance.now() - started >= FORMULA_FRAME_BUDGET_MS)) break;
    state.pending.delete(element);
    mount();
    mounted++;
  }
  if (mounted) view.requestMeasure();
  if (state.pending.size > 0) scheduleFormulaFrame(view, state);
}

function scheduleFormulaFrame(view: FormulaScrollView, state: DeferredFormulaWork): void {
  if (!state.frame) state.frame = state.win.requestAnimationFrame(() => flushFormulaScrollWork(view, state));
}

/** Mark the start/continuation of one expensive renderer transition. */
export function beginFormulaRenderBurst(
  view: FormulaScrollView,
  settleMs = FORMULA_SCROLL_SETTLE_MS,
): void {
  const state = stateFor(view);
  state.active = true;
  if (state.timer) state.win.clearTimeout(state.timer);
  state.timer = state.win.setTimeout(() => {
    state.timer = 0;
    state.active = false;
    if (state.pending.size > 0) {
      scheduleFormulaFrame(view, state);
    }
  }, Math.max(0, settleMs));
}

/** Scroll is one source of a renderer transition; mode changes use the same queue. */
export function beginFormulaScrollBurst(
  view: FormulaScrollView,
  settleMs = FORMULA_SCROLL_SETTLE_MS,
): void {
  beginFormulaRenderBurst(view, settleMs);
}

/**
 * Queue expensive formula DOM work only while a burst is active.
 * Returns false when the caller should mount synchronously.
 */
export function deferFormulaScrollWork(
  view: FormulaScrollView,
  element: HTMLElement,
  mount: () => void,
): boolean {
  const state = formulaScrollWork.get(view);
  if (!state?.active) return false;
  state.pending.set(element, mount);
  scheduleFormulaFrame(view, state);
  return true;
}

/** Cancel timers and release detached formula placeholders on editor teardown. */
export function forgetFormulaScrollBurst(view: FormulaScrollView): void {
  const state = formulaScrollWork.get(view);
  if (!state) return;
  if (state.timer) state.win.clearTimeout(state.timer);
  if (state.frame) state.win.cancelAnimationFrame(state.frame);
  state.pending.clear();
  formulaScrollWork.delete(view);
}
