import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AssistScheduler, type AssistUpdateFlags } from "../aaronnote/assist-scheduler.ts";

function createFrameApi() {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  return {
    api: {
      requestAnimationFrame(callback: FrameRequestCallback): number {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      },
      cancelAnimationFrame(handle: number): void {
        cancelled.push(handle);
        callbacks.delete(handle);
      },
    },
    cancelled,
    pendingHandles(): number[] {
      return [...callbacks.keys()];
    },
    fire(handle: number): void {
      const callback = callbacks.get(handle);
      callbacks.delete(handle);
      callback?.(0);
    },
  };
}

describe("AssistScheduler", () => {
  test("main initializes the scheduler before the first mode-label assist update", () => {
    const source = readFileSync(join(process.cwd(), "aaronnote/main.ts"), "utf8");
    const schedulerIndex = source.indexOf("const assistScheduler = new AssistScheduler");
    const firstModeUpdateIndex = source.indexOf("updateModeLabel(vim.mode())");
    expect(schedulerIndex).toBeGreaterThanOrEqual(0);
    expect(firstModeUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(schedulerIndex).toBeLessThan(firstModeUpdateIndex);
  });

  test("coalesces repeated identical schedules without replacing the frame", () => {
    const frames = createFrameApi();
    const runs: AssistUpdateFlags[] = [];
    const scheduler = new AssistScheduler(frames.api, () => true, (flags) => runs.push(flags));

    scheduler.schedule({ cursor: true });
    scheduler.schedule({ cursor: true });

    expect(frames.pendingHandles()).toEqual([1]);
    expect(frames.cancelled).toEqual([]);
    frames.fire(1);
    expect(runs).toEqual([{
      snippets: false,
      mathPreview: false,
      cursor: true,
      toc: false,
      selectionTool: false,
    }]);
  });

  test("replaces one pending frame when later work broadens the flags", () => {
    const frames = createFrameApi();
    const runs: AssistUpdateFlags[] = [];
    const scheduler = new AssistScheduler(frames.api, () => true, (flags) => runs.push(flags));

    scheduler.schedule({ cursor: true });
    scheduler.schedule({ mathPreview: true });

    expect(frames.cancelled).toEqual([1]);
    expect(frames.pendingHandles()).toEqual([2]);
    frames.fire(1);
    frames.fire(2);
    expect(runs).toEqual([{
      snippets: false,
      mathPreview: true,
      cursor: true,
      toc: false,
      selectionTool: false,
    }]);
  });

  test("pause cancels pending work and ignores stale frame callbacks", () => {
    const frames = createFrameApi();
    const runs: AssistUpdateFlags[] = [];
    const scheduler = new AssistScheduler(frames.api, () => true, (flags) => runs.push(flags));

    scheduler.schedule({ snippets: true });
    scheduler.setPaused(true);
    frames.fire(1);

    expect(frames.cancelled).toEqual([1]);
    expect(runs).toEqual([]);
    scheduler.schedule({ snippets: true });
    expect(frames.pendingHandles()).toEqual([]);
  });

  test("visible gate prevents scheduling and firing", () => {
    const frames = createFrameApi();
    const runs: AssistUpdateFlags[] = [];
    let visible = false;
    const scheduler = new AssistScheduler(frames.api, () => visible, (flags) => runs.push(flags));

    scheduler.schedule({ cursor: true });
    expect(frames.pendingHandles()).toEqual([]);

    visible = true;
    scheduler.schedule({ cursor: true });
    expect(frames.pendingHandles()).toEqual([1]);
    visible = false;
    frames.fire(1);
    expect(runs).toEqual([]);
  });

  test("empty schedule defaults to cursor and selection tool work", () => {
    const frames = createFrameApi();
    const runs: AssistUpdateFlags[] = [];
    const scheduler = new AssistScheduler(frames.api, () => true, (flags) => runs.push(flags));

    scheduler.schedule();
    frames.fire(1);

    expect(runs).toEqual([{
      snippets: false,
      mathPreview: false,
      cursor: true,
      toc: false,
      selectionTool: true,
    }]);
  });
});
