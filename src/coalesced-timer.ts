/**
 * A debounced action that coalesces rapid calls into a single trailing run.
 *
 * Replaces hand-rolled `let t; if (t) clearTimeout(t); t = setTimeout(fn, delay)`
 * patterns. When an optional `sig` is passed, scheduling is skipped while it matches
 * the signature of the last run — avoids redundant work when the computed result
 * would be identical (e.g. identical Lean diagnostics / progress pushes).
 */
export class CoalescedTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSig: string | null = null;
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  /**
   * Schedule `fn` to run after the configured delay, replacing any pending run.
   * If `sig` is provided and equals the signature of the most recent run, the call
   * is a no-op (the result would be identical). Pass `delayMs` to override the
   * constructor default for this one call (e.g. fire immediately with `0`).
   */
  schedule(fn: () => void, sig?: string, delayMs?: number): void {
    if (sig !== undefined && sig === this.lastSig) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (sig !== undefined) this.lastSig = sig;
      fn();
    }, delayMs ?? this.delayMs);
  }

  /** Cancel a pending run, if any. The recorded signature is preserved. */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
