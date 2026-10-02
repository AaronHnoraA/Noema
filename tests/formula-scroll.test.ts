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
  test("the actual outer editor scroll host defers newly mounted formulas", async () => {
    const { createEditor } = await import("../src/editor-api.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: "text" });
    try {
      const element = document.createElement("div");
      editor.view.dom.append(element);
      const mount = vi.fn();
      host.dispatchEvent(new Event("scroll"));
      expect(deferFormulaScrollWork(editor.view, element, mount)).toBe(true);
      expect(mount).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("continuous scroll cannot starve the bounded formula mount queue", () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return 1;
    });
    const view = connectedView();
    const elements = Array.from({ length: 3 }, () => document.createElement("div"));
    view.dom.append(...elements);
    const mounted: string[] = [];

    beginFormulaScrollBurst(view);
    elements.forEach((element, index) => {
      expect(deferFormulaScrollWork(view, element, () => mounted.push(String(index)))).toBe(true);
    });
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(80);
    beginFormulaScrollBurst(view);
    expect(mounted).toEqual([]);
    expect(frames).toHaveLength(1);
    frames[0]!(performance.now());
    expect(mounted).toEqual(["0", "1"]);
    expect(view.requestMeasure).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(2);
    beginFormulaScrollBurst(view);
    frames[1]!(performance.now());
    expect(mounted).toEqual(["0", "1", "2"]);
    expect(view.requestMeasure).toHaveBeenCalledTimes(2);

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

  test("mounts visible formulas before overscan and drops detached work", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
    const view = connectedView();
    const elements = [document.createElement("div"), document.createElement("div"), document.createElement("div")];
    view.dom.append(...elements);
    const mounted: number[] = [];
    beginFormulaScrollBurst(view);
    elements.forEach((element, index) => {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ top: index === 1 ? 10 : 10000, bottom: index === 1 ? 100 : 10100 } as DOMRect);
      deferFormulaScrollWork(view, element, () => mounted.push(index));
    });
    elements[2]!.remove();
    frames[0]!(performance.now());
    expect(mounted).toEqual([1, 0]);
    forgetFormulaScrollBurst(view);
    view.dom.remove();
  });
});
