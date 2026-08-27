/**
 * Coalesces editor height-map measurements into one animation frame.
 *
 * ResizeObserver can report many block widgets in the same layout pass.  The
 * editor only needs one requestMeasure() per view, and a background host must
 * not keep an animation-frame chain alive.  Pending work is retained as one
 * dirty bit per view while paused and is flushed once after resume.
 */
export type AnimationFrameApi = {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
};

export class ViewMeasureScheduler<View extends object> {
  private readonly pending = new Set<View>();
  private frame: number | null = null;
  private generation = 0;
  private paused = false;

  private readonly frames: AnimationFrameApi;
  private readonly connected: (view: View) => boolean;
  private readonly measure: (view: View) => void;

  constructor(
    frames: AnimationFrameApi,
    connected: (view: View) => boolean,
    measure: (view: View) => void,
  ) {
    this.frames = frames;
    this.connected = connected;
    this.measure = measure;
  }

  setPaused(next: boolean): void {
    if (this.paused === next) return;
    this.paused = next;
    if (next) {
      this.cancelFrame();
      return;
    }
    this.ensureFrame();
  }

  schedule(view: View): void {
    if (!this.connected(view)) {
      this.pending.delete(view);
      return;
    }
    this.pending.add(view);
    this.ensureFrame();
  }

  discard(view: View): void {
    this.pending.delete(view);
    if (this.pending.size === 0) this.cancelFrame();
  }

  private cancelFrame(): void {
    if (this.frame === null) return;
    this.frames.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.generation += 1;
  }

  private ensureFrame(): void {
    if (this.paused || this.frame !== null || this.pending.size === 0) return;
    const generation = ++this.generation;
    this.frame = this.frames.requestAnimationFrame(() => {
      if (generation !== this.generation) return;
      this.frame = null;
      if (this.paused) return;
      const views = [...this.pending];
      this.pending.clear();
      for (const view of views) {
        if (this.connected(view)) this.measure(view);
      }
    });
  }
}
