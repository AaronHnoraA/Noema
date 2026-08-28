/**
 * Shared renderer activity lifecycle.
 *
 * Host adapters only report facts such as a hidden surface or a buffer switch.
 * They never pause individual editor subsystems. The renderer owns one state
 * machine and fans each transition out to the same participants for Emacs,
 * Noema.app and the server page.
 */
export type RendererActivityState =
  | "active"
  | "recently-active"
  | "quiescent"
  | "hidden"
  | "destroyed";

export type RendererActivityParticipant = {
  /** Preferred shared lifecycle hook. */
  setActivity?: (state: RendererActivityState) => void;
  /** Compatibility hook for older renderer participants. */
  setPaused?: (paused: boolean) => void;
  /** Optional compatibility hook for quiescent-only scheduling. */
  setQuiescent?: (quiescent: boolean) => void;
};

type RendererTimer = ReturnType<typeof setTimeout>;

type RendererActivityTimerApi = {
  setTimeout: (callback: () => void, delay: number) => RendererTimer;
  clearTimeout: (timer: RendererTimer) => void;
};

export type RendererActivityGateOptions = {
  /** Delay after input before the renderer is considered recently active. */
  recentlyActiveMs?: number;
  /** Delay after input before background work is considered quiescent. */
  quiescentMs?: number;
  /** Optional event target used by the renderer to observe generic activity. */
  activityTarget?: EventTarget;
  /** Start the lifecycle timer immediately instead of waiting for an event. */
  autoStart?: boolean;
  timers?: Partial<RendererActivityTimerApi>;
  onStateChange?: (state: RendererActivityState) => void;
};

export type RendererActivityGate = {
  /** Current shared renderer lifecycle state. */
  state(): RendererActivityState;
  /** Descriptive alias for callers that prefer getter naming. */
  getState(): RendererActivityState;
  /** Compatibility predicate for host pause/resume code. */
  isPaused(): boolean;
  /** True when only non-essential background work is suspended. */
  isQuiescent(): boolean;
  /** Apply a host hidden/visible transition. */
  setPaused(paused: boolean): void;
  /** Report a user/editor activity fact from any host or renderer surface. */
  notifyActivity(): void;
  /** Register a renderer participant and immediately synchronize it. */
  addParticipant(participant: RendererActivityParticipant): () => void;
  /** Stop timers/listeners and mark the shared renderer destroyed. */
  destroy(): void;
};

const DEFAULT_RECENTLY_ACTIVE_MS = 250;
const DEFAULT_QUIESCENT_MS = 1_000;

function nonNegativeDelay(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) >= 0 ? Math.floor(value as number) : fallback;
}

function isHidden(state: RendererActivityState): boolean {
  return state === "hidden" || state === "destroyed";
}

function isQuiescent(state: RendererActivityState): boolean {
  return state === "quiescent";
}

/**
 * Create the one activity state machine used by every host scene.
 *
 * The generic activity listeners intentionally do not inspect host focus or
 * editor implementation details. A participant may decline a quiescent
 * transition when it owns an interaction (IME, drag, MathLive, etc.), while
 * all scheduling remains governed by this same renderer lifecycle.
 */
export function createRendererActivityGate(
  participants: readonly RendererActivityParticipant[] = [],
  options: RendererActivityGateOptions = {},
): RendererActivityGate {
  const recentlyActiveMs = nonNegativeDelay(options.recentlyActiveMs, DEFAULT_RECENTLY_ACTIVE_MS);
  const quiescentMs = Math.max(
    recentlyActiveMs,
    nonNegativeDelay(options.quiescentMs, DEFAULT_QUIESCENT_MS),
  );
  const timerApi: RendererActivityTimerApi = {
    setTimeout: options.timers?.setTimeout ?? ((callback, delay) => setTimeout(callback, delay)),
    clearTimeout: options.timers?.clearTimeout ?? ((timer) => clearTimeout(timer)),
  };
  let current: RendererActivityState = "active";
  const registered = new Set<RendererActivityParticipant>(participants);
  let recentlyTimer: RendererTimer | null = null;
  let quiescentTimer: RendererTimer | null = null;
  let destroyed = false;

  const clearTimers = (): void => {
    if (recentlyTimer !== null) timerApi.clearTimeout(recentlyTimer);
    if (quiescentTimer !== null) timerApi.clearTimeout(quiescentTimer);
    recentlyTimer = null;
    quiescentTimer = null;
  };

  const notifyParticipant = (
    participant: RendererActivityParticipant,
    next: RendererActivityState,
  ): void => {
    if (participant.setActivity) {
      participant.setActivity(next);
      return;
    }
    // This fallback keeps the gate source-compatible with small renderer
    // schedulers while they migrate. It is not a host-specific implementation.
    participant.setPaused?.(isHidden(next) || isQuiescent(next));
    participant.setQuiescent?.(isQuiescent(next));
  };

  const transition = (next: RendererActivityState): void => {
    if (current === next) return;
    current = next;
    for (const participant of registered) notifyParticipant(participant, next);
    options.onStateChange?.(next);
  };

  const armActivityTimers = (): void => {
    clearTimers();
    if (destroyed || current === "hidden" || current === "destroyed") return;
    recentlyTimer = timerApi.setTimeout(() => {
      recentlyTimer = null;
      if (current === "active") transition("recently-active");
    }, recentlyActiveMs);
    quiescentTimer = timerApi.setTimeout(() => {
      quiescentTimer = null;
      if (current === "active" || current === "recently-active") transition("quiescent");
    }, quiescentMs);
  };

  const onActivity = (): void => {
    if (destroyed || current === "hidden" || current === "destroyed") return;
    if (current !== "active") transition("active");
    armActivityTimers();
  };

  const listeners: Array<[EventTarget, string, EventListener]> = [];
  const activityTarget = options.activityTarget;
  const listen = (type: string): void => {
    if (!activityTarget) return;
    const listener = (() => onActivity()) as EventListener;
    activityTarget.addEventListener(type, listener, true);
    listeners.push([activityTarget, type, listener]);
  };
  // Keep this list deliberately small: continuous mouse movement and scroll
  // are not activity facts, while edits, focus, pointer ownership and paste
  // are. Pointer completion matters as much as pointer acquisition. Without
  // it, a drag lasting longer than `quiescentMs` leaves the renderer asleep
  // after mouseup, so the final selection/toolbar pass is retained until some
  // unrelated later input wakes the page.
  for (const type of [
    "keydown",
    "beforeinput",
    "input",
    "compositionstart",
    "compositionend",
    "focusin",
    "pointerdown",
    "pointerup",
    "pointercancel",
    // WKWebView/xwidget has historically delivered mouse compatibility events
    // even when the corresponding PointerEvent did not reach the page.
    "mouseup",
    "touchstart",
    "wheel",
    "paste",
    "drop",
  ]) listen(type);

  if (options.autoStart) armActivityTimers();

  return {
    state: () => current,
    getState: () => current,
    isPaused: () => current === "hidden" || current === "destroyed",
    isQuiescent: () => isQuiescent(current),
    setPaused(paused): void {
      if (destroyed) return;
      if (paused) {
        clearTimers();
        transition("hidden");
        return;
      }
      if (current === "hidden") transition("active");
      armActivityTimers();
    },
    notifyActivity: onActivity,
    addParticipant(participant): () => void {
      if (destroyed) return () => {};
      registered.add(participant);
      notifyParticipant(participant, current);
      return () => registered.delete(participant);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      clearTimers();
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener, true);
      listeners.length = 0;
      transition("destroyed");
      registered.clear();
    },
  };
}
