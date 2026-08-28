import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";

import {
  isCoalescedVisualTyping,
  visualTypingBurstExtension,
} from "../src/cm6/extensions/visual/typing-burst.ts";
import { forgetViewportDecorationRefresh } from "../src/cm6/viewport-refresh.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("shared visual typing burst", () => {
  test("recognizes native typing and deletion but not programmatic document replacement", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const decisions: boolean[] = [];
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "abc",
        extensions: [EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) decisions.push(isCoalescedVisualTyping(update));
        })],
      }),
    });
    try {
      view.dispatch(view.state.update({ changes: { from: 3, insert: "d" }, userEvent: "input.type" }));
      view.dispatch(view.state.update({ changes: { from: 3, to: 4 }, userEvent: "delete.backward" }));
      view.dispatch(view.state.update({ changes: { from: 3, insert: "\n" }, userEvent: "input" }));
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "reset" } });
      expect(decisions).toEqual([true, true, true, false]);
    } finally {
      view.destroy();
    }
  });

  test("collapses a rapid sequence to one settled decoration refresh", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [visualTypingBurstExtension],
      }),
    });
    try {
      const animationFrame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(41);
      const baselineTimers = vi.getTimerCount();
      for (const text of ["a", "b", "c"]) {
        view.dispatch(view.state.update({
          changes: { from: view.state.doc.length, insert: text },
          userEvent: "input.type",
        }));
      }
      expect(vi.getTimerCount()).toBe(baselineTimers + 1);
      vi.advanceTimersByTime(119);
      expect(animationFrame).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(animationFrame).toHaveBeenCalledTimes(1);
    } finally {
      forgetViewportDecorationRefresh(view);
      view.destroy();
    }
  });
});
