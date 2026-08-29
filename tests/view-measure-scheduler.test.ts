import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  measuredHeightChanged,
  stableMeasuredHeight,
} from "../src/cm6/extensions/visual/widgets/measured-observer.ts";
import { ViewMeasureScheduler } from "../src/cm6/view-measure-scheduler.ts";

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

type FakeView = { connected: boolean; id: string };

describe("ViewMeasureScheduler", () => {
  test("coalesces every resized widget into one measure per editor view", () => {
    const frames = createFrameApi();
    const measured: string[] = [];
    const scheduler = new ViewMeasureScheduler<FakeView>(
      frames.api,
      (view) => view.connected,
      (view) => measured.push(view.id),
    );
    const first = { connected: true, id: "first" };
    const second = { connected: true, id: "second" };

    scheduler.schedule(first);
    scheduler.schedule(first);
    scheduler.schedule(second);

    expect(frames.pendingHandles()).toEqual([1]);
    frames.fire(1);
    expect(measured).toEqual(["first", "second"]);
    expect(frames.pendingHandles()).toEqual([]);
  });

  test("pause cancels the frame and resume flushes one retained dirty bit", () => {
    const frames = createFrameApi();
    const measured: string[] = [];
    const scheduler = new ViewMeasureScheduler<FakeView>(
      frames.api,
      (view) => view.connected,
      (view) => measured.push(view.id),
    );
    const view = { connected: true, id: "editor" };

    scheduler.schedule(view);
    scheduler.setPaused(true);
    scheduler.schedule(view);

    expect(frames.cancelled).toEqual([1]);
    expect(frames.pendingHandles()).toEqual([]);
    frames.fire(1);
    expect(measured).toEqual([]);

    scheduler.setPaused(false);
    expect(frames.pendingHandles()).toEqual([2]);
    frames.fire(2);
    expect(measured).toEqual(["editor"]);
  });

  test("drops disconnected or explicitly discarded views", () => {
    const frames = createFrameApi();
    const measured: string[] = [];
    const scheduler = new ViewMeasureScheduler<FakeView>(
      frames.api,
      (view) => view.connected,
      (view) => measured.push(view.id),
    );
    const view = { connected: true, id: "editor" };

    scheduler.schedule(view);
    scheduler.discard(view);
    expect(frames.cancelled).toEqual([1]);

    view.connected = false;
    scheduler.schedule(view);
    expect(frames.pendingHandles()).toEqual([]);
    expect(measured).toEqual([]);
  });
});

describe("measured widget resize stability", () => {
  test("quantizes fractional layout to physical-pixel boundaries", () => {
    expect(stableMeasuredHeight(100.24, 2)).toBe(100);
    expect(stableMeasuredHeight(100.26, 2)).toBe(100.5);
  });

  test("ignores one-pixel WebKit oscillation but retains real async growth", () => {
    expect(measuredHeightChanged(100, 100.5)).toBe(false);
    expect(measuredHeightChanged(100, 101)).toBe(false);
    expect(measuredHeightChanged(100, 101.5)).toBe(true);
    expect(measuredHeightChanged(undefined, 100)).toBe(true);
  });

  test("ResizeObserver never rebuilds viewport decorations", () => {
    const source = readFileSync(join(
      process.cwd(),
      "src", "cm6", "extensions", "visual", "widgets", "measured-observer.ts",
    ), "utf8");
    expect(source).not.toContain("scheduleViewportDecorationRefresh");
    expect(source).toContain("view.requestMeasure()");
    expect(source).toContain("setMeasuredWidgetObservationPaused");
  });

  test("widget registration does not synchronously force layout", () => {
    const source = readFileSync(join(
      process.cwd(),
      "src", "cm6", "extensions", "visual", "widgets", "measured-observer.ts",
    ), "utf8");
    const registration = source.slice(
      source.indexOf("export function observeWidget"),
      source.indexOf("export function unobserveWidget"),
    );
    const executableRegistration = registration.replace(/\/\/.*$/gm, "");

    expect(executableRegistration).toContain("ro.observe(el)");
    expect(executableRegistration).not.toContain("measuredElementHeight(");
    expect(executableRegistration).not.toContain("getBoundingClientRect(");
    expect(executableRegistration).not.toContain("offsetHeight");
  });
});
