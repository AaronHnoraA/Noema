import { EditorState } from "@codemirror/state";
import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import type { Editor } from "../src/editor-api.ts";
import { tocIndexExtension } from "../src/cm6/toc-index.ts";
import { createWritingStatsController } from "../aaronnote/features/writing-stats/controller.ts";

describe("writing stats feature controller", () => {
  test("keeps full-document and heading-subtree output behavior", () => {
    const holder = {
      state: EditorState.create({
        doc: "# One\n你好 world\n## Child\nmore words\n# Two\nend",
        extensions: [tocIndexExtension],
      }),
    };
    holder.state = holder.state.update({ selection: { anchor: 30 } }).state;
    const editor = {
      view: holder,
      getMarkdownLength: () => holder.state.doc.length,
    } as unknown as Editor;
    const label = document.createElement("span");
    const controller = createWritingStatsController(editor, label);

    expect(controller.isDocumentChanged()).toBe(true);
    controller.updateNow();
    expect(controller.isDocumentChanged()).toBe(false);
    expect(label.textContent).toMatch(/^全文 \d+ 字 · 本节 \d+ 字$/);
    expect(label.title).toContain("中日韩");
    controller.destroy();
  });

  test("counts through renderer quiescence and defers only for a hidden surface", () => {
    vi.useFakeTimers();
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
    const holder = {
      state: EditorState.create({ doc: "hello world" }),
    };
    const editor = {
      view: holder,
      getMarkdownLength: () => holder.state.doc.length,
    } as unknown as Editor;
    const label = document.createElement("span");
    const controller = createWritingStatsController(editor, label);

    const drainOneIdleCallback = (): void => {
      const entry = callbacks.entries().next().value as [number, IdleRequestCallback];
      callbacks.delete(entry[0]);
      entry[1]({ didTimeout: false, timeRemaining: () => 10 });
    };

    try {
      // Quiescence arrives ~1s after the last keystroke. Counting is already
      // chunked into idle callbacks that yield to pending input, so suspending
      // it here bought nothing and discarded work in progress.
      controller.schedule(true);
      controller.setActivity("quiescent");
      vi.advanceTimersByTime(2_000);
      expect(callbacks.size).toBe(1);
      drainOneIdleCallback();
      expect(controller.isDocumentChanged()).toBe(false);
      expect(label.textContent).toMatch(/^全文 \d+ 字$/);

      // A hidden surface is the gate that really stops the work, and it must
      // resume exactly once rather than replaying the elapsed delay.
      holder.state = EditorState.create({ doc: "hello world again" });
      controller.schedule(true);
      controller.setActivity("hidden");
      vi.advanceTimersByTime(2_000);
      expect(callbacks.size).toBe(0);
      expect(controller.isDocumentChanged()).toBe(true);

      controller.setActivity("active");
      vi.runOnlyPendingTimers();
      expect(callbacks.size).toBe(1);
      drainOneIdleCallback();
      expect(controller.isDocumentChanged()).toBe(false);
    } finally {
      controller.destroy();
      if (originalRequest) Object.defineProperty(window, "requestIdleCallback", originalRequest);
      else delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
      if (originalCancel) Object.defineProperty(window, "cancelIdleCallback", originalCancel);
      else delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback;
      vi.useRealTimers();
    }
  });

  // Regression: quiescence arrives ~1s after the last keystroke, but a chunked
  // full-document scan of a large note needs longer than that. Cancelling it
  // there meant a type-pause-type rhythm restarted the scan from zero every
  // cycle, burning CPU on work that could never finish — the exact background
  // waste the shared activity gate exists to prevent.
  test("a chunked large-document scan survives quiescence instead of restarting", () => {
    vi.useFakeTimers();
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
    // Above LARGE_DOCUMENT_CHARS, so queueIdle takes the chunked scanRange path.
    const doc = "alpha beta gamma delta ".repeat(30_000);
    const holder = { state: EditorState.create({ doc }) };
    const editor = {
      view: holder,
      getMarkdownLength: () => holder.state.doc.length,
    } as unknown as Editor;
    const label = document.createElement("span");
    const controller = createWritingStatsController(editor, label);

    try {
      controller.schedule(true);
      vi.runOnlyPendingTimers();
      expect(callbacks.size).toBe(1);

      // Drain one chunk, then let the renderer go idle mid-scan.
      const drain = (): boolean => {
        const next = callbacks.entries().next();
        if (next.done) return false;
        const [handle, callback] = next.value as [number, IdleRequestCallback];
        callbacks.delete(handle);
        callback({ didTimeout: false, timeRemaining: () => 10 });
        return true;
      };
      expect(drain()).toBe(true);
      controller.setActivity("quiescent");

      // The scan must still be in flight and must reach a rendered result
      // without any further activity waking it.
      let steps = 0;
      while (drain() && steps < 500) steps += 1;
      expect(steps).toBeGreaterThan(0);
      expect(controller.isDocumentChanged()).toBe(false);
      expect(label.textContent).toMatch(/^全文 [\d,]+ 字$/);
    } finally {
      controller.destroy();
      if (originalRequest) Object.defineProperty(window, "requestIdleCallback", originalRequest);
      else delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
      if (originalCancel) Object.defineProperty(window, "cancelIdleCallback", originalCancel);
      else delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback;
      vi.useRealTimers();
    }
  });

  // Regression: a pointer drag re-schedules on every selection change. Counting
  // a multi-megabyte selection inline on each of those passes is what made
  // drag-selecting in a large note stall the editor.
  test("a large selection is counted in idle chunks, not inline", () => {
    const originalRequest = Object.getOwnPropertyDescriptor(window, "requestIdleCallback");
    const originalCancel = Object.getOwnPropertyDescriptor(window, "cancelIdleCallback");
    const callbacks = new Map<number, IdleRequestCallback>();
    let nextHandle = 1;
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
    const doc = "word ".repeat(200_000); // 1MB, comfortably over the chunking threshold
    const holder = { state: EditorState.create({ doc }) };
    const editor = {
      view: holder,
      getMarkdownLength: () => holder.state.doc.length,
    } as unknown as Editor;
    const label = document.createElement("span");
    const controller = createWritingStatsController(editor, label);

    try {
      // Prime the full-document count so only the selection scope is at stake.
      controller.updateNow();
      const fullText = label.textContent;
      expect(fullText).toMatch(/^全文 200[,.]000 字$/);
      while (callbacks.size > 0) {
        const entry = callbacks.entries().next().value as [number, IdleRequestCallback];
        callbacks.delete(entry[0]);
        entry[1]({ didTimeout: false, timeRemaining: () => 0 });
      }

      holder.state = holder.state.update({ selection: { anchor: 0, head: doc.length } }).state;
      controller.updateNow();
      // Deferred, not counted inline: the label still shows the previous scope.
      expect(label.textContent).toBe(fullText);
      expect(callbacks.size).toBeGreaterThan(0);

      let guard = 500;
      while (callbacks.size > 0 && guard-- > 0) {
        const entry = callbacks.entries().next().value as [number, IdleRequestCallback];
        callbacks.delete(entry[0]);
        entry[1]({ didTimeout: false, timeRemaining: () => 0 });
      }
      expect(guard).toBeGreaterThan(0);
      expect(label.textContent).toMatch(/^选区 200[,.]000 字$/);
    } finally {
      controller.destroy();
      if (originalRequest) Object.defineProperty(window, "requestIdleCallback", originalRequest);
      else delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
      if (originalCancel) Object.defineProperty(window, "cancelIdleCallback", originalCancel);
      else delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    }
  });

  test("large single-line documents are counted across cancellable idle chunks", () => {
    vi.useFakeTimers();
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
    const holder = {
      state: EditorState.create({ doc: "word ".repeat(130_000) }),
    };
    const editor = {
      view: holder,
      getMarkdownLength: () => holder.state.doc.length,
    } as unknown as Editor;
    const label = document.createElement("span");
    const controller = createWritingStatsController(editor, label);

    try {
      controller.schedule(true);
      vi.advanceTimersByTime(901);
      expect(callbacks.size).toBe(1);

      const runNext = (): void => {
        const entry = callbacks.entries().next().value as [number, IdleRequestCallback] | undefined;
        expect(entry).toBeTruthy();
        callbacks.delete(entry![0]);
        entry![1]({ didTimeout: false, timeRemaining: () => 0 });
      };
      runNext();
      expect(controller.isDocumentChanged()).toBe(true);

      let guard = 100;
      while (callbacks.size > 0 && guard-- > 0) runNext();
      expect(guard).toBeGreaterThan(0);
      expect(controller.isDocumentChanged()).toBe(false);
      expect(label.textContent).toMatch(/^全文 130[,.]000 字$/);
    } finally {
      controller.destroy();
      if (originalRequest) Object.defineProperty(window, "requestIdleCallback", originalRequest);
      else delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
      if (originalCancel) Object.defineProperty(window, "cancelIdleCallback", originalCancel);
      else delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback;
      vi.useRealTimers();
    }
  });
});
