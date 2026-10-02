export type SaveDrainOptions<Snapshot, Result> = {
  capture: () => Snapshot | null;
  write: (snapshot: Snapshot) => Promise<Result>;
  apply: (snapshot: Snapshot, result: Result) => boolean | void;
  fail: (error: unknown, snapshot: Snapshot, retryInMs: number | null) => void;
  active?: (value: boolean) => void;
  /**
   * Delay before retrying a write that threw (a transport failure such as a
   * restarting host), by consecutive failure count from 1, or null to stop.
   * A conflict or rejection is a result, not a failure, and is never retried.
   */
  retryDelayMs?: (attempt: number) => number | null;
};

/** Doubling backoff from one second, capped at thirty. */
export function defaultSaveRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Serializes editor saves and coalesces changes made while a write is active.
 * `capture` is called again only after the preceding result has been applied,
 * so a follow-up request observes the mtime returned by that write.
 *
 * A write that throws leaves the edits dirty. Autosave only fires again on the
 * next edit, so an author who stopped typing when the host blinked would keep
 * an unsaved note indefinitely; with `retryDelayMs` the drain retries on its
 * own (files.md re-syncs on an interval for the same reason), and any
 * successful write resets the backoff.
 */
export class SaveDrain<Snapshot, Result> {
  private running: Promise<void> | null = null;
  private readonly options: SaveDrainOptions<Snapshot, Result>;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SaveDrainOptions<Snapshot, Result>) {
    this.options = options;
  }

  request(): Promise<void> {
    this.cancelRetry();
    if (this.running) return this.running;
    const task = this.drain();
    const tracked = task.finally(() => {
      if (this.running === tracked) this.running = null;
    });
    this.running = tracked;
    return tracked;
  }

  isActive(): boolean {
    return this.running !== null;
  }

  /** Whether a failed write is waiting for its retry. */
  retryPending(): boolean {
    return this.retryTimer !== null;
  }

  /** Drop a scheduled retry, e.g. when the note it was for is closed. */
  cancelRetry(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async drain(): Promise<void> {
    this.options.active?.(true);
    try {
      while (true) {
        const snapshot = this.options.capture();
        if (!snapshot) return;
        let result: Result;
        try {
          result = await this.options.write(snapshot);
        } catch (error) {
          this.failures += 1;
          const delay = this.options.retryDelayMs?.(this.failures) ?? null;
          this.options.fail(error, snapshot, delay);
          if (delay !== null) {
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null;
              void this.request();
            }, delay);
          }
          return;
        }
        this.failures = 0;
        if (this.options.apply(snapshot, result) === false) return;
      }
    } finally {
      this.options.active?.(false);
    }
  }
}
