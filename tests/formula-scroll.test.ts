import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import {
  beginFormulaScrollBurst,
  deferFormulaScrollWork,
  forgetFormulaScrollBurst,
  type FormulaScrollView,
} from "../src/cm6/formula-scroll.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function connectedView(): FormulaScrollView {
  const dom = document.createElement("div");
  document.body.append(dom);
  return { dom, requestMeasure: vi.fn() };
}

describe("formula scroll burst", () => {
  test("coalesces expensive formula mounts until 120 ms after the last scroll", () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return 1;
    });
    const view = connectedView();
    const first = document.createElement("div");
    const second = document.createElement("div");
    view.dom.append(first, second);
    const mounted: string[] = [];

    beginFormulaScrollBurst(view);
    expect(deferFormulaScrollWork(view, first, () => mounted.push("first"))).toBe(true);
    vi.advanceTimersByTime(80);
    beginFormulaScrollBurst(view);
    expect(deferFormulaScrollWork(view, second, () => mounted.push("second"))).toBe(true);
    vi.advanceTimersByTime(119);
    expect(frames).toHaveLength(0);
    expect(mounted).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(frames).toHaveLength(1);
    frames[0]!(performance.now());
    expect(mounted).toEqual(["first", "second"]);
    expect(view.requestMeasure).toHaveBeenCalledTimes(1);

    forgetFormulaScrollBurst(view);
    view.dom.remove();
  });

  test("drops detached placeholders and cancels work on teardown", () => {
    vi.useFakeTimers();
    const view = connectedView();
    const placeholder = document.createElement("div");
    view.dom.append(placeholder);
    const mount = vi.fn();

    beginFormulaScrollBurst(view);
    expect(deferFormulaScrollWork(view, placeholder, mount)).toBe(true);
    forgetFormulaScrollBurst(view);
    vi.advanceTimersByTime(500);

    expect(mount).not.toHaveBeenCalled();
    expect(view.requestMeasure).not.toHaveBeenCalled();
    view.dom.remove();
  });
});
