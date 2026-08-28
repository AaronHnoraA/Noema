import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { EditorState } from "@codemirror/state";

import { AssistScheduler, type AssistUpdateFlags } from "../aaronnote/assist-scheduler.ts";
import { ProseCheckLifecycle } from "../aaronnote/prose-check-lifecycle.ts";
import { createWritingStatsController } from "../aaronnote/features/writing-stats/controller.ts";
import type { Editor } from "../src/editor-api.ts";

/**
 * Idle-power guardrail for letting work run through renderer quiescence.
 *
 * Unblocking these schedulers at quiescence is only safe if the work they then
 * perform is finite: it must complete and leave the page with nothing armed.
 * A scheduler that re-arms itself, or that keeps an animation-frame or idle
 * chain alive after finishing, would turn "idle" into continuous draw — and in
 * the Emacs xwidget host every frame is paid twice, because Emacs redraws the
 * widget through its own redisplay. Each case below drives the work to
 * completion while quiescent and then asserts a true resting state.
 */

function createFrameApi() {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    api: {
      requestAnimationFrame(callback: FrameRequestCallback): number {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      },
      cancelAnimationFrame(handle: number): void {
        callbacks.delete(handle);
      },
    },
    pending(): number[] {
      return [...callbacks.keys()];
    },
    drain(): number {
      let fired = 0;
      // A scheduler that re-arms from inside its own callback would not
      // terminate here, which is exactly what this guards against.
      while (callbacks.size > 0 && fired < 100) {
        const [handle, callback] = callbacks.entries().next().value as [number, FrameRequestCallback];
        callbacks.delete(handle);
        callback(0);
        fired += 1;
      }
      return fired;
    },
  };
}

function installIdleApi() {
  const originalRequest = Object.getOwnPropertyDescriptor(window, "requestIdleCallback");
  const originalCancel = Object.getOwnPropertyDescriptor(window, "cancelIdleCallback");
  let nextHandle = 1;
  const callbacks = new Map<number, IdleRequestCallback>();
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: (callback: IdleRequestCallback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
  });
  Object.defineProperty(window, "cancelIdleCallback", {
    configurable: true,
    value: (handle: number) => callbacks.delete(handle),
  });
  return {
    size: () => callbacks.size,
    drain(): number {
      let fired = 0;
      while (callbacks.size > 0 && fired < 5_000) {
        const [handle, callback] = callbacks.entries().next().value as [number, IdleRequestCallback];
        callbacks.delete(handle);
        callback({ didTimeout: false, timeRemaining: () => 10 });
        fired += 1;
      }
      return fired;
    },
    restore(): void {
      if (originalRequest) Object.defineProperty(window, "requestIdleCallback", originalRequest);
      else delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
      if (originalCancel) Object.defineProperty(window, "cancelIdleCallback", originalCancel);
      else delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("renderer rests after quiescent work completes", () => {
  test("the assist scheduler arms one frame and stops", () => {
    const frames = createFrameApi();
    const runs: AssistUpdateFlags[] = [];
    const scheduler = new AssistScheduler(frames.api, () => true, (flags) => runs.push(flags));

    scheduler.setActivity("quiescent");
    scheduler.schedule({ toc: true });
    expect(frames.pending()).toHaveLength(1);

    expect(frames.drain()).toBe(1);
    expect(runs).toHaveLength(1);
    // Nothing re-armed: the coalesced flags were consumed, not rescheduled.
    expect(frames.pending()).toEqual([]);
  });

  test("a chunked writing-stats scan finishes and queues no further idle work", () => {
    vi.useFakeTimers();
    const idle = installIdleApi();
    const holder = { state: EditorState.create({ doc: "alpha beta gamma ".repeat(40_000) }) };
    const editor = {
      view: holder,
      getMarkdownLength: () => holder.state.doc.length,
    } as unknown as Editor;
    const label = document.createElement("span");
    const controller = createWritingStatsController(editor, label);

    try {
      controller.schedule(true);
      controller.setActivity("quiescent");
      vi.runOnlyPendingTimers();

      const chunks = idle.drain();
      expect(chunks).toBeGreaterThan(0);
      expect(controller.isDocumentChanged()).toBe(false);
      // The scan terminated on its own rather than chaining forever.
      expect(idle.size()).toBe(0);

      // Staying idle must not start another pass over an unchanged document.
      vi.advanceTimersByTime(60_000);
      expect(idle.size()).toBe(0);
    } finally {
      controller.destroy();
      idle.restore();
    }
  });

  test("the settled prose check runs once and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    let clock = 0;
    const lifecycle = new ProseCheckLifecycle<string, string>({
      autoDebounceMs: 1_800,
      now: () => clock,
      run: async (input) => { started.push(input); return input; },
      apply: () => true,
    });
    const advance = (ms: number): void => { clock += ms; vi.advanceTimersByTime(ms); };
    const flush = async (): Promise<void> => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    };

    lifecycle.scheduleAuto("doc", "sig");
    lifecycle.setQuiescent(true);
    advance(1_800);
    await flush();
    expect(started).toEqual(["doc"]);

    // Signature deduplication caps automatic work at one run per revision, so a
    // long idle stretch must add nothing — no retry, no poll, no re-check.
    advance(120_000);
    await flush();
    expect(started).toEqual(["doc"]);
    expect(lifecycle.scheduleAuto("doc", "sig")).toBe(false);
  });
});
