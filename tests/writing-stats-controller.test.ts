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
