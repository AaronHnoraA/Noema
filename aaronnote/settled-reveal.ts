/**
 * Keeping the cursor in view while a freshly opened note settles.
 *
 * Images, formulas and diagrams above the cursor get their real height after
 * the first paint, and each one moves the cursor line. Revealing once is
 * therefore not enough, and the reveal is repeated for a short while.
 *
 * Those repeats are a claim on the viewport, and only the one that opened the
 * note may hold it. The moment the reader scrolls, clicks, touches or types,
 * or the selection or document becomes something else, the viewport is theirs:
 * a late timer must never pull it back to where the cursor was.
 */

const SETTLE_DELAYS_MS = [50, 120, 250, 500, 900] as const;
const USER_INPUT_EVENTS = ["wheel", "touchstart", "pointerdown", "mousedown", "keydown"] as const;

type SettleWindow = Pick<
  Window,
  "requestAnimationFrame" | "cancelAnimationFrame" | "setTimeout" | "clearTimeout"
  | "addEventListener" | "removeEventListener"
>;

export type SettledRevealOptions = {
  /** Scroll the cursor into view. */
  reveal: () => void;
  /** False once the document or selection the reveal was armed for is gone. */
  stillCurrent: () => boolean;
  window?: SettleWindow;
  delaysMs?: readonly number[];
};

/** Reveal now and while layout settles; the result gives the viewport up. */
export function revealWhileLayoutSettles(options: SettledRevealOptions): () => void {
  const scope = options.window ?? window;
  const frames = new Set<number>();
  const timers = new Set<number>();
  let active = true;

  const release = (): void => {
    if (!active) return;
    active = false;
    for (const frame of frames) scope.cancelAnimationFrame(frame);
    for (const timer of timers) scope.clearTimeout(timer);
    frames.clear();
    timers.clear();
    for (const type of USER_INPUT_EVENTS) scope.removeEventListener(type, release, true);
  };
  const reveal = (): void => {
    if (!active) return;
    if (!options.stillCurrent()) {
      release();
      return;
    }
    options.reveal();
  };
  const onFrame = (next?: () => void): void => {
    const frame = scope.requestAnimationFrame(() => {
      frames.delete(frame);
      reveal();
      if (active) next?.();
    });
    frames.add(frame);
  };

  reveal();
  if (!active) return release;
  for (const type of USER_INPUT_EVENTS) {
    scope.addEventListener(type, release, { capture: true, passive: true });
  }
  onFrame(() => onFrame());
  const delays = options.delaysMs ?? SETTLE_DELAYS_MS;
  const last = Math.max(0, ...delays);
  for (const delay of delays) {
    const timer = scope.setTimeout(() => {
      timers.delete(timer);
      reveal();
      if (delay === last) release();
    }, delay);
    timers.add(timer);
  }
  return release;
}
