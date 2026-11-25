import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import {
  EditorViewportStabilizer,
  isViewportScrollKey,
  mapPositionAcrossText,
  minimalDocumentChange,
  preserveEditorViewport,
} from "../src/cm6/viewport-stability.ts";
import { pointerSelectionEffect, pointerSelectionExtension } from "../src/cm6/extensions/visual/selection.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CM6 viewport position mapping", () => {
  test("preserve helper runs a void editor update exactly once", () => {
    const update = vi.fn(() => {});
    preserveEditorViewport({} as EditorView, update);
    expect(update).toHaveBeenCalledTimes(1);
  });

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
      state: EditorState.create({ doc: "x".repeat(200) }),
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

  test("explicit preserve restores even inside the old scroll-idle window", async () => {
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
      await Promise.resolve();
      expect(scrollHost.scrollTop).toBe(1_200);
    } finally {
      stabilizer.destroy();
      scrollHost.remove();
    }
  });

  test("preserves the caret after CodeMirror applies its own height-map delta", async () => {
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
      scrollHost.scrollTop += 200; // CodeMirror applies this after measure writes.
      await Promise.resolve();
      expect(scrollHost.scrollTop).toBe(1_200);
    } finally {
      stabilizer.destroy();
      scrollHost.remove();
    }
  });

  test("does not mistake WebKit height clamping for user scroll during a preserved relayout", async () => {
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
      await Promise.resolve();
      expect(scrollHost.scrollTop).toBe(1_200);
    } finally {
      stabilizer.destroy();
      scrollHost.remove();
    }
  });

  test("lets real wheel input cancel a pending preserved relayout", async () => {
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
      await Promise.resolve();
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
      let measurements = 0;
      const fakeView = {
        dom,
        contentDOM,
        state: EditorState.create({ doc: "x".repeat(1_000) }),
        viewport: { from: 0, to: 1000 },
        get documentTop() { return -scrollHost.scrollTop; },
        scaleY: 1,
        posAtCoords: () => 400,
        lineBlockAtHeight: () => ({ from: 0, top: 0 }),
        lineBlockAt: () => ({ from: 400, top: layout.pressedLineTop }),
        requestMeasure: (request: { read: () => unknown; write: (value: unknown) => void }) => {
          measurements += 1;
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
        scrollHost, layout, stabilizer, fakeView, selectionTransaction, press, fireFrames,
        measurements: () => measurements,
        dispose: () => { stabilizer.destroy(); scrollHost.remove(); vi.useRealTimers(); vi.restoreAllMocks(); },
      };
    }

    test("does not correct scroll on each selection move during a pointer drag", () => {
      const env = setup();
      try {
        let state = EditorState.create({
          doc: "x".repeat(1_000),
          extensions: [pointerSelectionExtension],
        });
        Object.assign(env.fakeView, { state });
        env.press();
        const start = state.update({ effects: pointerSelectionEffect.of(true) });
        state = start.state;
        Object.assign(env.fakeView, { state });
        env.stabilizer.afterUpdate([start]);
        for (let head = 410; head <= 450; head += 10) {
          const move = state.update({ selection: { anchor: 400, head } });
          state = move.state;
          Object.assign(env.fakeView, { state });
          env.stabilizer.afterUpdate([move]);
        }
        env.fireFrames();
        env.fireFrames();
        expect(env.measurements()).toBe(0);
        expect(env.scrollHost.scrollTop).toBe(300);

        env.layout.pressedLineTop = 350;
        const end = state.update({ effects: pointerSelectionEffect.of(false) });
        Object.assign(env.fakeView, { state: end.state });
        env.stabilizer.afterUpdate([end]);
        expect(env.scrollHost.scrollTop).toBe(150);
        expect(env.measurements()).toBe(1);
      } finally {
        env.dispose();
      }
    });

    test("edge auto-scroll keeps ownership while the selection changes", () => {
      const env = setup();
      try {
        let state = EditorState.create({
          doc: "x".repeat(1_000),
          extensions: [pointerSelectionExtension],
        });
        Object.assign(env.fakeView, { state });
        env.press();
        const start = state.update({ effects: pointerSelectionEffect.of(true) });
        state = start.state;
        Object.assign(env.fakeView, { state });
        env.stabilizer.afterUpdate([start]);
        env.scrollHost.scrollTop = 250;
        env.scrollHost.dispatchEvent(new Event("scroll"));
        const move = state.update({ selection: { anchor: 400, head: 450 } });
        Object.assign(env.fakeView, { state: move.state });
        env.stabilizer.afterUpdate([move]);
        env.fireFrames();
        env.fireFrames();
        expect(env.scrollHost.scrollTop).toBe(250);
        expect(env.measurements()).toBe(0);
      } finally {
        env.dispose();
      }
    });

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
        // A widget that reports its height after the button is released.
        document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        env.layout.pressedLineTop = 389;
        env.stabilizer.afterUpdate([env.selectionTransaction()]);
        expect(env.scrollHost.scrollTop).toBe(189);
      } finally {
        env.dispose();
      }
    });

    test("an explicit navigation releases the pressed-line anchor", () => {
      const env = setup();
      try {
        env.press();
        env.layout.pressedLineTop = 349;
        env.stabilizer.afterUpdate([env.selectionTransaction(true)]);
        env.fireFrames();
        env.fireFrames();
        expect(env.scrollHost.scrollTop).toBe(300);
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

    test("pressing a rendered widget anchors on the start of its line/block DOM top, not on widget.to or shifting chip coords", () => {
      vi.useFakeTimers();
      const scrollHost = document.createElement("div");
      const dom = document.createElement("div");
      const contentDOM = document.createElement("div");
      const lineEl = document.createElement("div");
      lineEl.className = "cm-line";
      const chip = document.createElement("span");
      chip.setAttribute("contenteditable", "false");
      chip.dataset.cmSourceFrom = "20";
      const popup = document.createElement("span");
      chip.append(popup);
      lineEl.append(chip);
      contentDOM.append(lineEl);
      dom.append(contentDOM);
      scrollHost.append(dom);
      document.body.append(scrollHost);
      scrollHost.scrollTop = 300;

      // Real DOM line top sits at document-space y=500 (viewport y=200 at scrollTop=300)
      // while `coordsAtPos` on the chip shifts by +28px when the chip expands to raw text,
      // and `posAtCoords` wrongly hits line 3 because of a floating popup.
      let lineDocTop = 500;
      let chipCoordsTop = 212;
      vi.spyOn(scrollHost, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800, x: 0, y: 0, toJSON: () => ({}) });
      vi.spyOn(lineEl, "getBoundingClientRect").mockImplementation(() => {
        const top = lineDocTop - scrollHost.scrollTop;
        return { top, bottom: top + 28, left: 0, right: 800, width: 800, height: 28, x: 0, y: top, toJSON: () => ({}) };
      });

      const state = EditorState.create({ doc: "First line.\nSecond @@comment [note] line.\nThird line." });
      const secondLineFrom = state.doc.line(2).from;
      const chipPos = state.doc.toString().indexOf("@@comment");
      const thirdLinePos = state.doc.line(3).from + 2;

      const fakeView = {
        dom,
        contentDOM,
        state,
        viewport: { from: 0, to: state.doc.length },
        get documentTop() { return -scrollHost.scrollTop; },
        scaleY: 1,
        // Simulate posAtCoords landing on line 3 (floating popup) and coordsAtPos shifting!
        posAtCoords: () => thirdLinePos,
        posAtDOM: (node: Node) => (node === chip ? chipPos : secondLineFrom),
        domAtPos: (pos: number) => ({ node: pos === secondLineFrom ? lineEl : contentDOM, offset: 0 }),
        coordsAtPos: () => ({ top: chipCoordsTop }),
        lineBlockAtHeight: () => ({ from: 0, top: 0 }),
        lineBlockAt: (pos: number) => ({ from: pos, top: 500 }),
        requestMeasure: (request: { read: () => unknown; write: (value: unknown) => void }) => {
          request.write(request.read());
        },
      } as unknown as EditorView;
      const stabilizer = new EditorViewportStabilizer(fakeView, scrollHost);
      const tx = {
        docChanged: false,
        selection: { main: { anchor: chipPos } },
        effects: [],
        reconfigured: false,
        scrollIntoView: false,
        changes: { mapPos: (p: number) => p },
        state,
      } as never;

      try {
        popup.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 50, clientY: 230 }));
        // Chip collapses to raw text: chip coords shift wildly, but line top did not move.
        chipCoordsTop = 240;
        stabilizer.afterUpdate([tx]);
        expect(scrollHost.scrollTop).toBe(300);

        // If a block ABOVE actually refolds and pulls lineEl up by 60px, stabilizer follows it cleanly!
        lineDocTop = 440;
        stabilizer.afterUpdate([tx]);
        expect(scrollHost.scrollTop).toBe(240);
      } finally {
        stabilizer.destroy();
        scrollHost.remove();
      }
    });

    test("opening a preview table into side:-1 toolbar + source header keeps 0px scroll jump", () => {
      vi.useFakeTimers();
      const scrollHost = document.createElement("div");
      const dom = document.createElement("div");
      const contentDOM = document.createElement("div");
      const prevHeading = document.createElement("div");
      prevHeading.className = "cm-org-env-heading-widget";
      const previewTable = document.createElement("div");
      previewTable.className = "cm-table-block";
      previewTable.setAttribute("contenteditable", "false");
      contentDOM.append(prevHeading, previewTable);
      dom.append(contentDOM);
      scrollHost.append(dom);
      document.body.append(scrollHost);
      scrollHost.scrollTop = 400;

      const state = EditorState.create({
        doc: "#+begin observation 三个复杂度模型\n| 模型 | 假设 | 问题 |\n| --- | --- | --- |\n| A | B | C |\n#+end observation",
      });
      const tableFrom = state.doc.line(2).from;
      let opened = false;
      const toolbarEl = document.createElement("div");
      toolbarEl.className = "cm-table-source-toolbar";
      const headerLineEl = document.createElement("div");
      headerLineEl.className = "cm-line cm-table-source-row cm-table-source-header";
      const tableDocTop = 520;

      vi.spyOn(scrollHost, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800, x: 0, y: 0, toJSON: () => ({}) });
      vi.spyOn(prevHeading, "getBoundingClientRect").mockImplementation(() => {
        const top = 480 - scrollHost.scrollTop;
        return { top, bottom: top + 40, left: 0, right: 800, width: 800, height: 40, x: 0, y: top, toJSON: () => ({}) };
      });
      vi.spyOn(previewTable, "getBoundingClientRect").mockImplementation(() => {
        const top = tableDocTop - scrollHost.scrollTop;
        return { top, bottom: top + 180, left: 0, right: 800, width: 800, height: 180, x: 0, y: top, toJSON: () => ({}) };
      });
      vi.spyOn(toolbarEl, "getBoundingClientRect").mockImplementation(() => {
        const top = tableDocTop - scrollHost.scrollTop;
        return { top, bottom: top + 6, left: 0, right: 800, width: 800, height: 6, x: 0, y: top, toJSON: () => ({}) };
      });
      vi.spyOn(headerLineEl, "getBoundingClientRect").mockImplementation(() => {
        // Sits 6px below toolbarEl (matching .cm-table-block padding-top: 6px).
        const top = tableDocTop + 6 - scrollHost.scrollTop;
        return { top, bottom: top + 54, left: 0, right: 800, width: 800, height: 54, x: 0, y: top, toJSON: () => ({}) };
      });

      const fakeView = {
        dom,
        contentDOM,
        state,
        hasFocus: true,
        viewport: { from: 0, to: state.doc.length },
        get documentTop() { return -scrollHost.scrollTop; },
        scaleY: 1,
        posAtDOM: (node: Node) => {
          if (node === prevHeading) return 0;
          if (node === previewTable || node === toolbarEl || node === headerLineEl) return tableFrom;
          return 0;
        },
        domAtPos: (pos: number) => {
          if (pos === tableFrom) {
            return opened
              ? { node: headerLineEl, offset: 0 }
              : { node: contentDOM, offset: 1 };
          }
          return { node: contentDOM, offset: 0 };
        },
        lineBlockAtHeight: () => ({ from: 0, top: 0 }),
        lineBlockAt: (pos: number) => ({ from: pos, top: tableDocTop + (opened ? 6 : 0) }),
        requestMeasure: (request: { read: () => unknown; write: (value: unknown) => void }) => {
          request.write(request.read());
        },
      } as unknown as EditorView;
      const stabilizer = new EditorViewportStabilizer(fakeView, scrollHost);

      try {
        stabilizer.preserve(() => {
          opened = true;
          contentDOM.replaceChildren(prevHeading, toolbarEl, headerLineEl);
        }, undefined, tableFrom);
        // Must not jump by +6px when .cm-table-block swaps to .cm-table-source-toolbar + .cm-line.
        expect(scrollHost.scrollTop).toBe(400);
      } finally {
        stabilizer.destroy();
        scrollHost.remove();
      }
    });

    test("preserve clears any prior focus guard and keeps leasedSnapshot synced with corrected scrollTop", () => {
      vi.useFakeTimers();
      const scrollHost = document.createElement("div");
      const dom = document.createElement("div");
      const contentDOM = document.createElement("div");
      const blockEl = document.createElement("div");
      blockEl.className = "cm-line";
      contentDOM.append(blockEl);
      dom.append(contentDOM);
      scrollHost.append(dom);
      document.body.append(scrollHost);
      scrollHost.scrollTop = 400;

      let blockDocTop = 500;
      vi.spyOn(scrollHost, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800, x: 0, y: 0, toJSON: () => ({}) });
      vi.spyOn(blockEl, "getBoundingClientRect").mockImplementation(() => {
        const top = blockDocTop - scrollHost.scrollTop;
        return { top, bottom: top + 30, left: 0, right: 800, width: 800, height: 30, x: 0, y: top, toJSON: () => ({}) };
      });
      const state = EditorState.create({ doc: "above\ntarget line\nbelow" });
      const targetFrom = state.doc.line(2).from;
      const fakeView = {
        dom,
        contentDOM,
        state,
        hasFocus: false,
        viewport: { from: 0, to: state.doc.length },
        get documentTop() { return -scrollHost.scrollTop; },
        scaleY: 1,
        posAtDOM: () => targetFrom,
        domAtPos: () => ({ node: blockEl, offset: 0 }),
        lineBlockAtHeight: () => ({ from: 0, top: 0 }),
        lineBlockAt: (pos: number) => ({ from: pos, top: blockDocTop }),
        requestMeasure: (request: { read: () => unknown; write: (value: unknown) => void }) => {
          request.write(request.read());
        },
      } as unknown as EditorView;
      const stabilizer = new EditorViewportStabilizer(fakeView, scrollHost);

      try {
        // Focus guard armed at scrollTop=400 (as activateEditorFromPointer does before click fires).
        stabilizer.focusContent(() => {});
        // Clicking a widget opens it while an earlier block refolds by -60px.
        stabilizer.preserve(() => {
          blockDocTop = 440;
        }, undefined, targetFrom);
        expect(scrollHost.scrollTop).toBe(340);

        // Neither a WebKit scroll event nor focusContent's rAF may yank scrollTop back to 400.
        scrollHost.dispatchEvent(new Event("scroll"));
        expect(scrollHost.scrollTop).toBe(340);

        // If WebKit later throws a rogue focus-reveal jump to 50 during the active lease,
        // it snaps synchronously back to the corrected 340 (never stale 400).
        scrollHost.scrollTop = 50;
        scrollHost.dispatchEvent(new Event("scroll"));
        expect(scrollHost.scrollTop).toBe(340);
      } finally {
        stabilizer.destroy();
        scrollHost.remove();
      }
    });
  });
});
