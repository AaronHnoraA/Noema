/**
 * A monotonically advancing "latest-wins" gate that unifies the two common
 * cancellation patterns in this codebase:
 *
 *   1. Hand-rolled seq counters:
 *        let counter = 0;
 *        const seq = ++counter;
 *        await something();
 *        if (seq !== counter) return;   // repeated after every await
 *
 *   2. Manual AbortController:
 *        prevController?.abort();
 *        const controller = new AbortController();
 *        …
 *
 * Usage:
 *   const epoch = new Epoch();
 *   // start a new run, aborting any prior in-flight run:
 *   const run = epoch.begin();
 *   await doWork(run.signal);
 *   if (!run.current) return;          // replaces `seq !== counter`
 *   // cancel without starting a new run (hide/stop/unload):
 *   epoch.cancel();
 */
export interface EpochRun {
  /** Monotonically increasing id — pass to server/IPC when a wire sequence number is needed. */
  readonly id: number;
  /** False once a later begin() or cancel() has occurred — replaces `seq !== counter` guards. */
  readonly current: boolean;
  /** Aborted when a later begin() or cancel() occurs — pass to fetch / IPC signal options. */
  readonly signal: AbortSignal;
}

export class Epoch {
  private gen = 0;
  private controller: AbortController | null = null;

  /** Start a new run; aborts and displaces any prior in-flight run. */
  begin(): EpochRun {
    this.controller?.abort();
    const id = ++this.gen;
    const controller = new AbortController();
    this.controller = controller;
    const self = this;
    return {
      id,
      get current() { return id === self.gen; },
      signal: controller.signal,
    };
  }

  /** Displace the current run without starting a new one — use for hide/stop/unload paths. */
  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    this.gen++;
  }
}
