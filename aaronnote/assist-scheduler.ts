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

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.cancel();
  }

  cancel(): void {
    if (this.frame) {
      this.frameApi.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.pending = emptyFlags();
  }

  schedule(options: AssistUpdateOptions = {}): void {
    if (this.paused || !this.visible()) {
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
    this.pending = next;
    if (this.frame) this.frameApi.cancelAnimationFrame(this.frame);
    this.frame = this.frameApi.requestAnimationFrame(() => {
      this.frame = 0;
      if (this.paused || !this.visible()) {
        this.pending = emptyFlags();
        return;
      }
      const flags = this.pending;
      this.pending = emptyFlags();
      this.run(flags);
    });
  }
}
