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
      const topWrites = vi.spyOn(scrollHost, "scrollTop", "set");
      const leftWrites = vi.spyOn(scrollHost, "scrollLeft", "set");
      stabilizer.preserve(() => { documentTop = 53; });
      expect(scrollHost.scrollTop).toBe(0);
      expect(topWrites).not.toHaveBeenCalled();
      expect(leftWrites).not.toHaveBeenCalled();
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

  describe("a press pins the pressed position against relayout", () => {
    function setup() {
      vi.useFakeTimers();
      let nextFrame = 1;
      const frames = new Map<number, FrameRequestCallback>();
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        const handle = nextFrame++;
        frames.set(handle, callback);
        return handle;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => { frames.delete(handle); });
      const fireFrames = (): void => {
        const queued = [...frames.values()];
        frames.clear();
        for (const callback of queued) callback(0);
      };
      const scrollHost = document.createElement("div");
      const dom = document.createElement("div");
      const contentDOM = document.createElement("div");
      const line = document.createElement("div");
      contentDOM.append(line);
      dom.append(contentDOM);
      scrollHost.append(dom);
      document.body.append(scrollHost);
      // The pressed line sits 500px into the document until the block the
      // caret left, above it, refolds and changes height.
      const layout = { pressedLineTop: 500 };
      const fakeView = {
        dom,
        contentDOM,
        state: { doc: { length: 1000 } },
        viewport: { from: 0, to: 1000 },
        get documentTop() { return -scrollHost.scrollTop; },
        scaleY: 1,
        posAtCoords: () => 400,
        lineBlockAtHeight: () => ({ from: 0, top: 0 }),
        lineBlockAt: () => ({ from: 400, top: layout.pressedLineTop }),
        requestMeasure: (request: { read: () => unknown; write: (value: unknown) => void }) => {
          request.write(request.read());
        },
      } as unknown as EditorView;
      const stabilizer = new EditorViewportStabilizer(fakeView, scrollHost);
      const selectionTransaction = (scrollIntoView = false) => ({
        docChanged: false,
        selection: { main: { anchor: 400 } },
        effects: [],
        reconfigured: false,
        scrollIntoView,
        changes: { mapPos: (position: number) => position },
        state: fakeView.state,
      }) as never;
      const press = (target: Element = line): void => {
        target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
      };
      scrollHost.scrollTop = 300;
      fireFrames();
      fireFrames();
      return {
        scrollHost, layout, stabilizer, selectionTransaction, press, fireFrames,
        dispose: () => { stabilizer.destroy(); scrollHost.remove(); vi.useRealTimers(); vi.restoreAllMocks(); },
      };
    }

    test("keeps the pressed line under the pointer when a block above refolds", () => {
      const env = setup();
      try {
        env.press();
        env.layout.pressedLineTop = 349;
        env.stabilizer.afterUpdate([env.selectionTransaction()]);
        expect(env.scrollHost.scrollTop).toBe(149);
        env.fireFrames();
        env.fireFrames();
        expect(env.scrollHost.scrollTop).toBe(149);
        // The same holds when the click also asks to reveal the caret.
        env.press();
        env.layout.pressedLineTop = 560;
        env.stabilizer.afterUpdate([env.selectionTransaction(true)]);
        expect(env.scrollHost.scrollTop).toBe(360);
        // A widget that reports its height after the button is released.
        document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        env.layout.pressedLineTop = 600;
        env.stabilizer.afterUpdate([env.selectionTransaction()]);
        expect(env.scrollHost.scrollTop).toBe(400);
      } finally {
        env.dispose();
      }
    });

    test("keeps the press when the browser clamps the offset for a rebuilt block", () => {
      const env = setup();
      try {
        // A scroll host that behaves like a browser: the offset can never
        // exceed what the content height allows.
        const metrics = { scrollHeight: 5000, clientHeight: 800, top: 0 };
        const clamp = (value: number): number => (
          Math.max(0, Math.min(value, metrics.scrollHeight - metrics.clientHeight))
        );
        Object.defineProperty(env.scrollHost, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
        Object.defineProperty(env.scrollHost, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
        Object.defineProperty(env.scrollHost, "scrollTop", {
          configurable: true,
          get: () => metrics.top,
          set: (value: number) => { metrics.top = clamp(value); },
        });
        // The reader wheels down to this offset and stops.
        env.scrollHost.dispatchEvent(new WheelEvent("wheel"));
        env.scrollHost.scrollTop = 4000;
        env.scrollHost.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(400);
        env.fireFrames();
        env.fireFrames();
        // The pressed row is 300px below the top of the viewport.
        env.layout.pressedLineTop = 4300;
        env.press();

        // The click rebuilds the table; unmeasured, it is 400px shorter, and
        // the browser moves the offset down to the new maximum.
        metrics.scrollHeight = 4600;
        metrics.top = clamp(metrics.top);
        expect(env.scrollHost.scrollTop).toBe(3800);
        env.scrollHost.dispatchEvent(new Event("scroll"));
        env.stabilizer.afterUpdate([env.selectionTransaction()]);
        // Nothing can be done while the document is short.
        expect(env.scrollHost.scrollTop).toBe(3800);

        // The table is measured and the document has its height back: the
        // pressed row returns to where it was pressed.
        metrics.scrollHeight = 5000;
        env.fireFrames();
        env.fireFrames();
        expect(env.scrollHost.scrollTop).toBe(4000);
      } finally {
        env.dispose();
      }
    });

    test("a real scroll to the end of the note is not mistaken for a clamp", () => {
      const env = setup();
      try {
        const metrics = { scrollHeight: 5000, clientHeight: 800, top: 0 };
        Object.defineProperty(env.scrollHost, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
        Object.defineProperty(env.scrollHost, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
        Object.defineProperty(env.scrollHost, "scrollTop", {
          configurable: true,
          get: () => metrics.top,
          set: (value: number) => { metrics.top = Math.max(0, Math.min(value, metrics.scrollHeight - metrics.clientHeight)); },
        });
        // The reader wheels down to this offset and stops.
        env.scrollHost.dispatchEvent(new WheelEvent("wheel"));
        env.scrollHost.scrollTop = 3000;
        env.scrollHost.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(400);
        env.fireFrames();
        env.fireFrames();
        env.layout.pressedLineTop = 3300;
        env.press();
        // The click's handler jumps to the end of the note: the offset goes
        // up to the maximum. That movement is intended and stays.
        env.scrollHost.scrollTop = 4200;
        env.scrollHost.dispatchEvent(new Event("scroll"));
        env.layout.pressedLineTop = 3200;
        env.stabilizer.afterUpdate([env.selectionTransaction()]);
        env.fireFrames();
        env.fireFrames();
        expect(env.scrollHost.scrollTop).toBe(4200);
      } finally {
        env.dispose();
      }
    });

    test("yields to any real movement of the viewport", () => {
      const env = setup();
      try {
        // Wheel after the press: the user is scrolling.
        env.press();
        env.scrollHost.dispatchEvent(new WheelEvent("wheel"));
        env.layout.pressedLineTop = 349;
        env.stabilizer.afterUpdate([env.selectionTransaction()]);
        expect(env.scrollHost.scrollTop).toBe(300);

        // The click's own handler scrolls elsewhere before the `scroll`
        // event of that write has been delivered.
        vi.advanceTimersByTime(200);
        env.fireFrames();
        env.fireFrames();
        env.layout.pressedLineTop = 500;
        env.press();
        env.layout.pressedLineTop = 480;
        env.stabilizer.afterUpdate([env.selectionTransaction()]);
        expect(env.scrollHost.scrollTop).toBe(280);
        env.scrollHost.scrollTop = 4000;
        env.fireFrames();
        env.fireFrames();
        expect(env.scrollHost.scrollTop).toBe(4000);
        env.scrollHost.dispatchEvent(new Event("scroll"));
        env.layout.pressedLineTop = 100;
        env.stabilizer.afterUpdate([env.selectionTransaction()]);
        expect(env.scrollHost.scrollTop).toBe(4000);
      } finally {
        env.dispose();
      }
    });

    test("ignores presses outside the document and the settle window's end", () => {
      const env = setup();
      try {
        env.press(env.scrollHost);
        env.layout.pressedLineTop = 349;
        env.stabilizer.afterUpdate([env.selectionTransaction()]);
        expect(env.scrollHost.scrollTop).toBe(300);

        vi.advanceTimersByTime(200);
        env.fireFrames();
        env.fireFrames();
        env.layout.pressedLineTop = 500;
        env.press();
        document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        const now = performance.now();
        vi.spyOn(performance, "now").mockReturnValue(now + 10_000);
        env.layout.pressedLineTop = 349;
        env.stabilizer.afterUpdate([env.selectionTransaction()]);
        expect(env.scrollHost.scrollTop).toBe(300);
      } finally {
        env.dispose();
      }
    });
  });
});
