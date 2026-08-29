import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import {
  EditorViewportStabilizer,
  isViewportScrollKey,
  mapPositionAcrossText,
  minimalDocumentChange,
} from "../src/cm6/viewport-stability.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CM6 viewport position mapping", () => {
  test("treats legacy xwidget Spacebar as the same scroll interaction as Space", () => {
    expect(isViewportScrollKey({ key: " ", code: "Space" })).toBe(true);
    expect(isViewportScrollKey({ key: "Spacebar", code: "Space" })).toBe(true);
    expect(isViewportScrollKey({ key: "Space", code: "Space" })).toBe(true);
    expect(isViewportScrollKey({ key: "a", code: "KeyA" })).toBe(false);
  });

  test("maps a position through an insertion before the visible content", () => {
    const source = "alpha\nbeta\ngamma\n";
    const target = "new heading\nalpha\nbeta\ngamma\n";
    const position = source.indexOf("beta") + 2;

    expect(mapPositionAcrossText(source, target, position)).toBe(
      target.indexOf("beta") + 2,
    );
  });

  test("uses local context when several distant edits span the viewport", () => {
    const visible = "the uniquely visible paragraph remains exactly where the reader left it";
    const source = `old heading\n\n${visible}\n\nold footer`;
    const target = `a longer replacement heading\n\n${visible}\n\na completely different footer`;
    const position = source.indexOf("visible paragraph") + 9;

    expect(mapPositionAcrossText(source, target, position)).toBe(
      target.indexOf("visible paragraph") + 9,
    );
  });

  test("builds a minimal contiguous document transaction", () => {
    expect(minimalDocumentChange("prefix old suffix", "prefix new suffix")).toEqual({
      from: 7,
      to: 10,
      insert: "new",
    });
    expect(minimalDocumentChange("same", "same")).toBeNull();
  });

  test("does not write a stale viewport snapshot during active scrolling", () => {
    vi.useFakeTimers();
    let nextFrame = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const handle = nextFrame++;
      frames.set(handle, callback);
      return handle;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
      frames.delete(handle);
    });
    const fireFrames = (): void => {
      const queued = [...frames.entries()];
      frames.clear();
      for (const [, callback] of queued) callback(0);
    };

    const scrollHost = document.createElement("div");
    const dom = document.createElement("div");
    const contentDOM = document.createElement("div");
    dom.append(contentDOM);
    scrollHost.append(dom);
    document.body.append(scrollHost);
    let measurements = 0;
    const fakeView = {
      dom,
      contentDOM,
      state: { doc: { length: 200 } },
      viewport: { from: 0, to: 100 },
      documentTop: 0,
      scaleY: 1,
      lineBlockAtHeight: () => ({ from: 0, top: 0 }),
      lineBlockAt: () => ({ from: 0, top: 0 }),
      requestMeasure: () => { measurements += 1; },
    } as unknown as EditorView;
    const stabilizer = new EditorViewportStabilizer(fakeView, scrollHost);
    const relayoutTransaction = {
      docChanged: false,
      selection: { main: { anchor: 0 } },
      effects: [],
      reconfigured: false,
      scrollIntoView: false,
      changes: { mapPos: (position: number) => position },
      state: fakeView.state,
    } as never;

    try {
      fireFrames();
      fireFrames();
      scrollHost.dispatchEvent(new WheelEvent("wheel"));
      scrollHost.scrollTop = 120;
      scrollHost.dispatchEvent(new Event("scroll"));
      scrollHost.dispatchEvent(new Event("scroll"));
      scrollHost.dispatchEvent(new Event("scroll"));
      expect(vi.getTimerCount()).toBe(1);
      fireFrames();
      fireFrames();

      stabilizer.afterUpdate([relayoutTransaction]);
      expect(measurements).toBe(0);
      expect(scrollHost.scrollTop).toBe(120);

      vi.advanceTimersByTime(141);
      expect(vi.getTimerCount()).toBe(0);
      fireFrames();
      fireFrames();
      stabilizer.afterUpdate([relayoutTransaction]);
      expect(measurements).toBe(1);
    } finally {
      stabilizer.destroy();
      scrollHost.remove();
    }
  });

  test("keeps the document top pinned across a visual relayout", () => {
    const scrollHost = document.createElement("div");
    const dom = document.createElement("div");
    const contentDOM = document.createElement("div");
    dom.append(contentDOM);
    scrollHost.append(dom);
    document.body.append(scrollHost);
    let documentTop = 0;
    const fakeView = {
      dom,
      contentDOM,
      state: { doc: { length: 200 } },
      viewport: { from: 0, to: 100 },
      get documentTop() { return documentTop; },
      scaleY: 1,
      lineBlockAtHeight: () => ({ from: 0, top: 0 }),
      lineBlockAt: () => ({ from: 0, top: 0 }),
      requestMeasure: () => {},
    } as unknown as EditorView;
    const stabilizer = new EditorViewportStabilizer(fakeView, scrollHost);

    try {
      expect(scrollHost.scrollTop).toBe(0);
      stabilizer.preserve(() => { documentTop = 53; });
      expect(scrollHost.scrollTop).toBe(0);
    } finally {
      stabilizer.destroy();
      scrollHost.remove();
    }
  });

  test("explicit preserve restores even inside the old scroll-idle window", () => {
    vi.useFakeTimers();
    const scrollHost = document.createElement("div");
    const dom = document.createElement("div");
    const contentDOM = document.createElement("div");
    dom.append(contentDOM);
    scrollHost.append(dom);
    document.body.append(scrollHost);
    scrollHost.scrollTop = 100;
    let anchorTop = 100;
    let measurement: {
      read: () => unknown;
      write: (value: unknown) => void;
    } | null = null;
    const fakeView = {
      dom,
      contentDOM,
      state: { doc: { length: 2_000 } },
      viewport: { from: 100, to: 500 },
      get documentTop() { return -scrollHost.scrollTop; },
      scaleY: 1,
      lineBlockAtHeight: () => ({ from: 100, top: 100 }),
      lineBlockAt: () => { throw new Error("virtual line block is not measured"); },
      coordsAtPos: () => ({ top: anchorTop - scrollHost.scrollTop }),
      requestMeasure: (request: typeof measurement) => { measurement = request; },
    } as unknown as EditorView;
    const stabilizer = new EditorViewportStabilizer(fakeView, scrollHost);

    try {
      scrollHost.dispatchEvent(new WheelEvent("wheel"));
      expect(vi.getTimerCount()).toBe(1);
      stabilizer.preserve(() => { anchorTop = 1_000; }, undefined, 100);
      expect(scrollHost.scrollTop).toBe(1_000);
      vi.advanceTimersByTime(141);
      anchorTop = 1_200;
      const queued = measurement as unknown as {
        read: () => unknown;
        write: (value: unknown) => void;
      };
      queued.write(queued.read());
      expect(scrollHost.scrollTop).toBe(1_200);
    } finally {
      stabilizer.destroy();
      scrollHost.remove();
    }
  });

  test("keeps multi-phase programmatic scroll acknowledgements from canceling caret restoration", () => {
    const scrollHost = document.createElement("div");
    const dom = document.createElement("div");
    const contentDOM = document.createElement("div");
    dom.append(contentDOM);
    scrollHost.append(dom);
    document.body.append(scrollHost);
    scrollHost.scrollTop = 100;
    let anchorTop = 100;
    let measurement: {
      read: () => unknown;
      write: (value: unknown) => void;
    } | null = null;
    const fakeView = {
      dom,
      contentDOM,
      state: { doc: { length: 2_000 } },
      viewport: { from: 100, to: 500 },
      get documentTop() { return -scrollHost.scrollTop; },
      scaleY: 1,
      lineBlockAtHeight: () => ({ from: 100, top: 100 }),
      lineBlockAt: () => ({ from: 100, top: anchorTop }),
      requestMeasure: (request: typeof measurement) => { measurement = request; },
    } as unknown as EditorView;
    const stabilizer = new EditorViewportStabilizer(fakeView, scrollHost);

    try {
      stabilizer.preserve(() => { anchorTop = 1_000; });
      expect(scrollHost.scrollTop).toBe(1_000);

      // WebKit may acknowledge the transaction write and the correction write
      // separately even though both observe the final programmed scrollTop.
      scrollHost.dispatchEvent(new Event("scroll"));
      scrollHost.dispatchEvent(new Event("scroll"));

      anchorTop = 1_200;
      const queued = measurement as unknown as {
        read: () => unknown;
        write: (value: unknown) => void;
      };
      queued.write(queued.read());
      expect(scrollHost.scrollTop).toBe(1_200);
    } finally {
      stabilizer.destroy();
      scrollHost.remove();
    }
  });

  test("does not mistake WebKit height clamping for user scroll during a preserved relayout", () => {
    const scrollHost = document.createElement("div");
    const dom = document.createElement("div");
    const contentDOM = document.createElement("div");
    dom.append(contentDOM);
    scrollHost.append(dom);
    document.body.append(scrollHost);
    scrollHost.scrollTop = 100;
    let anchorTop = 100;
    let measurement: {
      read: () => unknown;
      write: (value: unknown) => void;
    } | null = null;
    const fakeView = {
      dom,
      contentDOM,
      state: { doc: { length: 2_000 } },
      viewport: { from: 100, to: 500 },
      get documentTop() { return -scrollHost.scrollTop; },
      scaleY: 1,
      lineBlockAtHeight: () => ({ from: 100, top: 100 }),
      lineBlockAt: () => ({ from: 100, top: anchorTop }),
      requestMeasure: (request: typeof measurement) => { measurement = request; },
    } as unknown as EditorView;
    const stabilizer = new EditorViewportStabilizer(fakeView, scrollHost);

    try {
      stabilizer.preserve(() => { anchorTop = 1_000; });
      expect(scrollHost.scrollTop).toBe(1_000);

      // Preview removal can temporarily shorten the document. WebKit clamps
      // the outer host before CM6's next measure and emits a plain scroll.
      scrollHost.scrollTop = 200;
      scrollHost.dispatchEvent(new Event("scroll"));

      anchorTop = 1_200;
      const queued = measurement as unknown as {
        read: () => unknown;
        write: (value: unknown) => void;
      };
      queued.write(queued.read());
      expect(scrollHost.scrollTop).toBe(1_200);
    } finally {
      stabilizer.destroy();
      scrollHost.remove();
    }
  });

  test("lets real wheel input cancel a pending preserved relayout", () => {
    const scrollHost = document.createElement("div");
    const dom = document.createElement("div");
    const contentDOM = document.createElement("div");
    dom.append(contentDOM);
    scrollHost.append(dom);
    document.body.append(scrollHost);
    scrollHost.scrollTop = 100;
    let anchorTop = 100;
    let measurement: {
      read: () => unknown;
      write: (value: unknown) => void;
    } | null = null;
    const fakeView = {
      dom,
      contentDOM,
      state: { doc: { length: 2_000 } },
      viewport: { from: 100, to: 500 },
      get documentTop() { return -scrollHost.scrollTop; },
      scaleY: 1,
      lineBlockAtHeight: () => ({ from: 100, top: 100 }),
      lineBlockAt: () => ({ from: 100, top: anchorTop }),
      requestMeasure: (request: typeof measurement) => { measurement = request; },
    } as unknown as EditorView;
    const stabilizer = new EditorViewportStabilizer(fakeView, scrollHost);

    try {
      stabilizer.preserve(() => { anchorTop = 1_000; });
      scrollHost.dispatchEvent(new WheelEvent("wheel"));
      scrollHost.scrollTop = 333;
      scrollHost.dispatchEvent(new Event("scroll"));

      anchorTop = 1_200;
      const queued = measurement as unknown as {
        read: () => unknown;
        write: (value: unknown) => void;
      };
      queued.write(queued.read());
      expect(scrollHost.scrollTop).toBe(333);
    } finally {
      stabilizer.destroy();
      scrollHost.remove();
    }
  });
});
