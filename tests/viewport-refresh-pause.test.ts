import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  forgetViewportDecorationRefresh,
  refreshViewportDecorationsNow,
  scheduleViewportDecorationRefresh,
  setViewportDecorationRefreshPaused,
} from "../src/cm6/viewport-refresh.ts";

type FrameHarness = {
  cancelled: number[];
  fire(handle: number): void;
  pendingHandles(): number[];
  restore(): void;
};

function installFrameHarness(): FrameHarness {
  const originalRequest = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];

  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  };
  window.cancelAnimationFrame = (handle: number): void => {
    cancelled.push(handle);
    callbacks.delete(handle);
  };

  return {
    cancelled,
    fire(handle: number): void {
      const callback = callbacks.get(handle);
      callbacks.delete(handle);
      callback?.(0);
    },
    pendingHandles(): number[] {
      return [...callbacks.keys()];
    },
    restore(): void {
      window.requestAnimationFrame = originalRequest;
      window.cancelAnimationFrame = originalCancel;
    },
  };
}

type FakeView = EditorView & {
  dispatched: unknown[];
  measurements: number;
};

function createView(): FakeView {
  const dom = document.createElement("div");
  document.body.append(dom);
  const state = EditorState.create({ doc: "# title\n\nbody" });
  const view = {
    dom,
    state,
    visibleRanges: [{ from: 0, to: state.doc.length }],
    dispatched: [] as unknown[],
    measurements: 0,
    dispatch(spec: unknown): void {
      this.dispatched.push(spec);
    },
    requestMeasure(): void {
      this.measurements += 1;
    },
  };
  return view as unknown as FakeView;
}

function destroyView(view: FakeView): void {
  forgetViewportDecorationRefresh(view);
  view.dom.remove();
}

afterEach(() => {
  setViewportDecorationRefreshPaused(false);
});

describe("viewport decoration activity gate", () => {
  test("pause cancels the first frame and resume performs one two-stage refresh", () => {
    const frames = installFrameHarness();
    const view = createView();
    try {
      scheduleViewportDecorationRefresh(view);
      expect(frames.pendingHandles()).toEqual([1]);

      setViewportDecorationRefreshPaused(true);
      expect(frames.cancelled).toEqual([1]);
      expect(frames.pendingHandles()).toEqual([]);
      expect(view.measurements).toBe(0);
      expect(view.dispatched).toEqual([]);

      setViewportDecorationRefreshPaused(false);
      expect(frames.pendingHandles()).toEqual([2]);
      frames.fire(2);
      expect(view.measurements).toBe(1);
      expect(view.dispatched).toEqual([]);
      expect(frames.pendingHandles()).toEqual([3]);

      frames.fire(3);
      expect(view.dispatched).toHaveLength(1);
      expect(frames.pendingHandles()).toEqual([]);
    } finally {
      destroyView(view);
      frames.restore();
    }
  });

  test("pause cancels an in-flight post-measure frame without dispatching", () => {
    const frames = installFrameHarness();
    const view = createView();
    try {
      scheduleViewportDecorationRefresh(view);
      frames.fire(1);
      expect(view.measurements).toBe(1);
      expect(frames.pendingHandles()).toEqual([2]);

      setViewportDecorationRefreshPaused(true);
      expect(frames.cancelled).toEqual([2]);
      expect(view.dispatched).toEqual([]);

      setViewportDecorationRefreshPaused(false);
      expect(frames.pendingHandles()).toEqual([3]);
      frames.fire(3);
      frames.fire(4);
      expect(view.measurements).toBe(2);
      expect(view.dispatched).toHaveLength(1);
    } finally {
      destroyView(view);
      frames.restore();
    }
  });

  test("immediate refresh calls collapse to one deferred refresh while paused", () => {
    const frames = installFrameHarness();
    const view = createView();
    try {
      setViewportDecorationRefreshPaused(true);
      refreshViewportDecorationsNow(view);
      refreshViewportDecorationsNow(view);
      scheduleViewportDecorationRefresh(view);
      expect(frames.pendingHandles()).toEqual([]);
      expect(view.measurements).toBe(0);
      expect(view.dispatched).toEqual([]);

      setViewportDecorationRefreshPaused(false);
      expect(frames.pendingHandles()).toEqual([1]);
      frames.fire(1);
      frames.fire(2);
      expect(view.measurements).toBe(1);
      expect(view.dispatched).toHaveLength(1);
    } finally {
      destroyView(view);
      frames.restore();
    }
  });

  test("forget removes a paused dirty view before renderer destruction", () => {
    const frames = installFrameHarness();
    const view = createView();
    try {
      setViewportDecorationRefreshPaused(true);
      scheduleViewportDecorationRefresh(view);
      forgetViewportDecorationRefresh(view);
      view.dom.remove();

      setViewportDecorationRefreshPaused(false);
      expect(frames.pendingHandles()).toEqual([]);
      expect(view.measurements).toBe(0);
      expect(view.dispatched).toEqual([]);
    } finally {
      forgetViewportDecorationRefresh(view);
      view.dom.remove();
      frames.restore();
    }
  });
});
