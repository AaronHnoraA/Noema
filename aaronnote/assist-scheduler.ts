export type AssistUpdateOptions = {
  snippets?: boolean;
  mathPreview?: boolean;
  cursor?: boolean;
  toc?: boolean;
  selectionTool?: boolean;
};

export type AssistUpdateFlags = Required<AssistUpdateOptions>;

type FrameApi = {
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
};

const emptyFlags = (): AssistUpdateFlags => ({
  snippets: false,
  mathPreview: false,
  cursor: false,
  toc: false,
  selectionTool: false,
});

function sameFlags(a: AssistUpdateFlags, b: AssistUpdateFlags): boolean {
  return a.snippets === b.snippets
    && a.mathPreview === b.mathPreview
    && a.cursor === b.cursor
    && a.toc === b.toc
    && a.selectionTool === b.selectionTool;
}

export class AssistScheduler {
  private frame = 0;
  private pending = emptyFlags();
  private paused = false;
  private quiescent = false;
  private readonly frameApi: FrameApi;
  private readonly visible: () => boolean;
  private readonly run: (flags: AssistUpdateFlags) => void;

  constructor(
    frameApi: FrameApi,
    visible: () => boolean,
    run: (flags: AssistUpdateFlags) => void,
  ) {
    this.frameApi = frameApi;
    this.visible = visible;
    this.run = run;
  }

  /** Apply the shared renderer lifecycle without duplicating host logic. */
  setActivity(state: import("../src/renderer-activity.ts").RendererActivityState): void {
    if (state === "hidden" || state === "destroyed") {
      this.setPaused(true);
      return;
    }
    if (this.paused) this.setPaused(false);
    this.setQuiescent(state === "quiescent");
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.quiescent = false;
      this.cancel();
    } else if (!this.quiescent) {
      this.schedulePending();
    }
  }

  /** Quiescence suspends the frame, but retains coalesced work for resume. */
  setQuiescent(quiescent: boolean): void {
    if (this.quiescent === quiescent) return;
    this.quiescent = quiescent;
    if (quiescent) {
      this.cancelFrame();
    } else if (!this.paused) {
      this.schedulePending();
    }
  }

  cancel(): void {
    if (this.frame) {
      this.frameApi.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.pending = emptyFlags();
  }

  private cancelFrame(): void {
    if (!this.frame) return;
    this.frameApi.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private schedulePending(): void {
    if (this.paused || this.quiescent || !this.visible() || !Object.values(this.pending).some(Boolean)) return;
    if (this.frame) return;
    this.frame = this.frameApi.requestAnimationFrame(() => {
      this.frame = 0;
      if (this.paused || this.quiescent || !this.visible()) return;
      const flags = this.pending;
      this.pending = emptyFlags();
      this.run(flags);
    });
  }

  schedule(options: AssistUpdateOptions = {}): void {
    if (this.paused) {
      this.cancel();
      return;
    }
    if (!this.visible()) {
      this.cancel();
      return;
    }
    const explicit = Object.keys(options).length > 0;
    const next: AssistUpdateFlags = {
      snippets: this.pending.snippets || options.snippets === true,
      mathPreview: this.pending.mathPreview || options.mathPreview === true,
      cursor: this.pending.cursor || (explicit ? options.cursor === true : true),
      toc: this.pending.toc || options.toc === true,
      selectionTool: this.pending.selectionTool || (explicit ? options.selectionTool === true : true),
    };
    if (this.frame && sameFlags(this.pending, next)) return;
    if (this.frame) this.cancelFrame();
    this.pending = next;
    if (this.quiescent) return;
    this.schedulePending();
  }

}
