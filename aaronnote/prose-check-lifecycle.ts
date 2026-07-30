export type ProseCheckKind = "auto" | "manual";

export type ProseCheckTerminal =
  | "applied"
  | "not-applied"
  | "stale"
  | "cancelled"
  | "timeout"
  | "failed";

export type ProseCheckContext = {
  id: number;
  kind: ProseCheckKind;
  signature?: string;
  signal: AbortSignal;
};

export type ProseCheckOutcome = {
  id: number;
  kind: ProseCheckKind;
  signature?: string;
  terminal: ProseCheckTerminal;
  reason?: string;
  error?: unknown;
};

export type ProseCheckState =
  | {
      id: number;
      kind: ProseCheckKind;
      signature?: string;
      phase: "scheduled" | "running";
    }
  | (ProseCheckOutcome & { phase: "terminal" });

export type ProseCheckCancelEvent = {
  context: ProseCheckContext;
  reason: string;
  terminal: "cancelled" | "timeout";
};

export type ProseCheckLifecycleOptions<Input, Result> = {
  autoDebounceMs?: number;
  deadlines?: Partial<Record<ProseCheckKind, number>>;
  /** Resolve a deadline from live settings when a request actually starts. */
  deadlineMs?: (input: Input, kind: ProseCheckKind) => number;
  now?: () => number;
  run: (input: Input, context: ProseCheckContext) => Promise<Result>;
  /** Observe transport/health outcomes even when a newer scope made them stale. */
  observe?: (result: Result, context: ProseCheckContext) => void;
  /** Return true only when the result was committed to the current document. */
  apply: (result: Result, context: ProseCheckContext) => boolean;
  onState?: (state: ProseCheckState) => void;
  onFinally?: (outcome: ProseCheckOutcome) => void;
  /** Use this to propagate cancellation to a host process or remote request. */
  onCancel?: (event: ProseCheckCancelEvent) => void | Promise<void>;
};

type PendingTask<Input> = {
  id: number;
  kind: ProseCheckKind;
  input: Input;
  signature?: string;
  dueAt: number;
  finished: boolean;
  resolve?: (outcome: ProseCheckOutcome) => void;
};

type Cancellation = {
  type: "cancel";
  reason: string;
  terminal: "cancelled" | "timeout";
};

type ActiveTask<Input> = PendingTask<Input> & {
  controller: AbortController;
  context: ProseCheckContext;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  cancellation: Cancellation | null;
  resolveCancellation: (value: Cancellation) => void;
  cancellationPromise: Promise<Cancellation>;
  staleReason: string;
  cancelNotified: boolean;
};

const DEFAULT_AUTO_DEBOUNCE_MS = 1_800;
const DEFAULT_AUTO_DEADLINE_MS = 7_000;
const DEFAULT_MANUAL_DEADLINE_MS = 22_000;

function finiteDelay(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Math.max(0, value);
}

function abortError(reason: string): Error {
  const error = new Error(`Prose check cancelled: ${reason}`);
  error.name = "AbortError";
  return error;
}

/**
 * Coordinates automatic and manual prose checks without allowing two live
 * lifecycle requests at once. Callers own scope construction and rendering;
 * this class owns debounce, priority, cancellation, deadlines, and staleness.
 */
export class ProseCheckLifecycle<Input, Result> {
  private readonly options: ProseCheckLifecycleOptions<Input, Result>;
  private readonly autoDebounceMs: number;
  private readonly deadlines: Record<ProseCheckKind, number>;
  private readonly now: () => number;
  private nextId = 1;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAuto: PendingTask<Input> | null = null;
  private pendingManual: PendingTask<Input> | null = null;
  private active: ActiveTask<Input> | null = null;
  private paused = false;
  private disposed = false;
  private lastAppliedAutoSignature: string | null = null;

  constructor(options: ProseCheckLifecycleOptions<Input, Result>) {
    this.options = options;
    this.autoDebounceMs = finiteDelay(options.autoDebounceMs, DEFAULT_AUTO_DEBOUNCE_MS);
    this.deadlines = {
      auto: finiteDelay(options.deadlines?.auto, DEFAULT_AUTO_DEADLINE_MS),
      manual: finiteDelay(options.deadlines?.manual, DEFAULT_MANUAL_DEADLINE_MS),
    };
    this.now = options.now ?? Date.now;
  }

  get activeKind(): ProseCheckKind | null {
    return this.active?.kind ?? null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get appliedAutoSignature(): string | null {
    return this.lastAppliedAutoSignature;
  }

  /** Schedule the latest automatic input. Returns false when it was deduplicated. */
  scheduleAuto(input: Input, signature: string, delayMs = this.autoDebounceMs): boolean {
    if (this.disposed || this.paused) return false;
    if (signature === this.lastAppliedAutoSignature) return false;
    if (this.pendingAuto?.signature === signature) return false;
    if (!this.pendingAuto && this.active?.kind === "auto" && this.active.signature === signature) return false;

    if (this.pendingAuto) {
      this.clearAutoTimer();
      this.finish(this.pendingAuto, "cancelled", "superseded");
      this.pendingAuto = null;
    }

    const task = this.createTask("auto", input, signature, finiteDelay(delayMs, this.autoDebounceMs));
    this.pendingAuto = task;
    this.emit({ id: task.id, kind: task.kind, signature: task.signature, phase: "scheduled" });

    // Do not overlap automatic requests. The current result is now obsolete,
    // but it is allowed to drain before the newest request starts.
    if (this.active?.kind === "auto" && this.active.signature !== signature) {
      this.active.staleReason = "superseded";
    }
    this.pump();
    return true;
  }

  /**
   * Run a manual check. It jumps ahead of automatic work and cancels an active
   * automatic request. Repeating the command cancels and replaces the active
   * manual request instead of stacking another full scan behind it.
   */
  runManual(input: Input): Promise<ProseCheckOutcome> {
    let resolve!: (outcome: ProseCheckOutcome) => void;
    const promise = new Promise<ProseCheckOutcome>((done) => {
      resolve = done;
    });
    const task = this.createTask("manual", input, undefined, 0);
    task.resolve = resolve;
    this.emit({ id: task.id, kind: task.kind, phase: "scheduled" });

    if (this.disposed || this.paused) {
      this.finish(task, "cancelled", this.disposed ? "disposed" : "paused");
      return promise;
    }

    if (this.pendingManual) {
      this.finish(this.pendingManual, "cancelled", "superseded");
    }
    this.pendingManual = task;

    this.clearAutoTimer();
    if (this.pendingAuto) {
      const automatic = this.pendingAuto;
      this.pendingAuto = null;
      this.finish(automatic, "cancelled", "manual-priority");
    }
    if (this.active) {
      this.cancelActive(this.active.kind === "auto" ? "manual-priority" : "manual-restarted", "cancelled");
    }
    this.pump();
    return promise;
  }

  /** Cancel all work tied to an obsolete document or configuration. */
  invalidate(reason = "invalidated"): void {
    this.lastAppliedAutoSignature = null;
    this.cancelPending(reason);
    this.cancelActive(reason, "cancelled");
  }

  setPaused(paused: boolean, reason = "paused"): void {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.cancelPending(reason);
      this.cancelActive(reason, "cancelled");
    } else {
      this.pump();
    }
  }

  dispose(reason = "disposed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPending(reason);
    this.cancelActive(reason, "cancelled");
  }

  private createTask(
    kind: ProseCheckKind,
    input: Input,
    signature: string | undefined,
    delayMs: number,
  ): PendingTask<Input> {
    return {
      id: this.nextId++,
      kind,
      input,
      signature,
      dueAt: this.now() + delayMs,
      finished: false,
    };
  }

  private pump(): void {
    if (this.disposed || this.paused || this.active) return;
    if (this.pendingManual) {
      const task = this.pendingManual;
      this.pendingManual = null;
      this.start(task);
      return;
    }
    if (!this.pendingAuto) return;
    const remaining = Math.max(0, this.pendingAuto.dueAt - this.now());
    if (remaining > 0) {
      this.armAutoTimer(this.pendingAuto, remaining);
      return;
    }
    const task = this.pendingAuto;
    this.pendingAuto = null;
    this.start(task);
  }

  private armAutoTimer(task: PendingTask<Input>, delayMs: number): void {
    this.clearAutoTimer();
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      if (this.pendingAuto !== task || task.finished) return;
      this.pump();
    }, delayMs);
  }

  private clearAutoTimer(): void {
    if (this.autoTimer === null) return;
    clearTimeout(this.autoTimer);
    this.autoTimer = null;
  }

  private start(task: PendingTask<Input>): void {
    if (task.finished) return;
    if (this.disposed || this.paused) {
      this.finish(task, "cancelled", this.disposed ? "disposed" : "paused");
      return;
    }
    const controller = new AbortController();
    let resolveCancellation!: (value: Cancellation) => void;
    const cancellationPromise = new Promise<Cancellation>((resolve) => {
      resolveCancellation = resolve;
    });
    const context: ProseCheckContext = {
      id: task.id,
      kind: task.kind,
      signature: task.signature,
      signal: controller.signal,
    };
    const record: ActiveTask<Input> = {
      ...task,
      controller,
      context,
      deadlineTimer: null,
      cancellation: null,
      resolveCancellation,
      cancellationPromise,
      staleReason: "",
      cancelNotified: false,
    };
    this.active = record;
    this.emit({ id: record.id, kind: record.kind, signature: record.signature, phase: "running" });

    let liveDeadline: number | undefined;
    try {
      liveDeadline = this.options.deadlineMs?.(record.input, record.kind);
    } catch {
      // Invalid live configuration falls back to the constructor deadline.
    }
    const deadlineMs = liveDeadline === undefined || Number.isNaN(liveDeadline)
      ? this.deadlines[record.kind]
      : finiteDelay(liveDeadline, this.deadlines[record.kind]);
    if (Number.isFinite(deadlineMs)) {
      record.deadlineTimer = setTimeout(() => {
        if (this.active === record) this.cancelActiveRecord(record, "deadline", "timeout");
      }, deadlineMs);
    }
    void this.execute(record);
  }

  private async execute(record: ActiveTask<Input>): Promise<void> {
    type RunEvent = { type: "result"; result: Result } | { type: "error"; error: unknown };
    const runEvent = Promise.resolve()
      .then(() => this.options.run(record.input, record.context))
      .then<RunEvent, RunEvent>(
        (result) => ({ type: "result", result }),
        (error) => ({ type: "error", error }),
      );
    const event = await Promise.race<RunEvent | Cancellation>([
      runEvent,
      record.cancellationPromise,
    ]);

    let terminal: ProseCheckTerminal;
    let reason: string | undefined;
    let error: unknown;
    if (event.type === "cancel") {
      terminal = event.terminal;
      reason = event.reason;
    } else if (record.cancellation) {
      terminal = record.cancellation.terminal;
      reason = record.cancellation.reason;
    } else if (event.type === "error") {
      terminal = "failed";
      error = event.error;
    } else {
      try {
        this.options.observe?.(event.result, record.context);
        if (record.staleReason) {
          terminal = "stale";
          reason = record.staleReason;
        } else {
          const applied = this.options.apply(event.result, record.context);
          terminal = applied ? "applied" : "not-applied";
          if (applied && record.kind === "auto") {
            this.lastAppliedAutoSignature = record.signature ?? null;
          }
        }
      } catch (applyError) {
        terminal = "failed";
        error = applyError;
      }
    }

    if (record.deadlineTimer !== null) clearTimeout(record.deadlineTimer);
    record.deadlineTimer = null;
    if (this.active === record) this.active = null;
    this.finish(record, terminal, reason, error);
    this.pump();
  }

  private cancelPending(reason: string): void {
    this.clearAutoTimer();
    if (this.pendingAuto) {
      const task = this.pendingAuto;
      this.pendingAuto = null;
      this.finish(task, "cancelled", reason);
    }
    if (this.pendingManual) {
      const task = this.pendingManual;
      this.pendingManual = null;
      this.finish(task, "cancelled", reason);
    }
  }

  private cancelActive(reason: string, terminal: "cancelled" | "timeout"): void {
    if (this.active) this.cancelActiveRecord(this.active, reason, terminal);
  }

  private cancelActiveRecord(
    record: ActiveTask<Input>,
    reason: string,
    terminal: "cancelled" | "timeout",
  ): void {
    if (record.cancellation || record.finished) return;
    const cancellation: Cancellation = { type: "cancel", reason, terminal };
    record.cancellation = cancellation;
    record.resolveCancellation(cancellation);
    record.controller.abort(abortError(reason));
    if (!record.cancelNotified) {
      record.cancelNotified = true;
      try {
        void Promise.resolve(this.options.onCancel?.({ context: record.context, reason, terminal })).catch(() => {});
      } catch {
        // Cancellation reporting must never block local cleanup.
      }
    }
  }

  private finish(
    task: PendingTask<Input>,
    terminal: ProseCheckTerminal,
    reason?: string,
    error?: unknown,
  ): void {
    if (task.finished) return;
    task.finished = true;
    const outcome: ProseCheckOutcome = {
      id: task.id,
      kind: task.kind,
      signature: task.signature,
      terminal,
      reason,
      error,
    };
    this.emit({ ...outcome, phase: "terminal" });
    try {
      this.options.onFinally?.(outcome);
    } catch {
      // Observer failures must not strand the scheduler or a manual promise.
    }
    task.resolve?.(outcome);
  }

  private emit(state: ProseCheckState): void {
    try {
      this.options.onState?.(state);
    } catch {
      // State observers are isolated from lifecycle progress.
    }
  }
}
