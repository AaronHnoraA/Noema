export type SaveDrainOptions<Snapshot, Result> = {
  capture: () => Snapshot | null;
  write: (snapshot: Snapshot) => Promise<Result>;
  apply: (snapshot: Snapshot, result: Result) => boolean | void;
  fail: (error: unknown, snapshot: Snapshot) => void;
  active?: (value: boolean) => void;
};

/**
 * Serializes editor saves and coalesces changes made while a write is active.
 * `capture` is called again only after the preceding result has been applied,
 * so a follow-up request observes the mtime returned by that write.
 */
export class SaveDrain<Snapshot, Result> {
  private running: Promise<void> | null = null;
  private readonly options: SaveDrainOptions<Snapshot, Result>;

  constructor(options: SaveDrainOptions<Snapshot, Result>) {
    this.options = options;
  }

  request(): Promise<void> {
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
          this.options.fail(error, snapshot);
          return;
        }
        if (this.options.apply(snapshot, result) === false) return;
      }
    } finally {
      this.options.active?.(false);
    }
  }
}
