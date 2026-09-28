import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  ceilOutputPlainText,
  ceilReadOnlyTextEvent,
} from "../src/cm6/extensions/visual/widgets/block-extras.ts";

function cellDom(): { root: HTMLElement; output: HTMLElement; button: HTMLButtonElement } {
  const root = document.createElement("div");
  root.className = "cm-ceil-cell-widget";
  const button = document.createElement("button");
  const output = document.createElement("div");
  output.className = "cm-ceil-output";
  output.innerHTML = "<pre>line one\nline two</pre>";
  root.append(button, output);
  document.body.append(root);
  return { root, output, button };
}

describe("@@cell read-only text", () => {
  test("pointer events inside output belong to the browser, controls to the editor", () => {
    const { root, output, button } = cellDom();
    try {
      const inOutput = new MouseEvent("mousedown", { bubbles: true });
      output.querySelector("pre")!.dispatchEvent(inOutput);
      expect(ceilReadOnlyTextEvent(inOutput)).toBe(true);
      const onButton = new MouseEvent("mousedown", { bubbles: true });
      button.dispatchEvent(onButton);
      expect(ceilReadOnlyTextEvent(onButton)).toBe(false);
    } finally {
      root.remove();
    }
  });

  test("a selection anchored in output is not mapped by CM6", () => {
    const { root, output } = cellDom();
    try {
      const range = document.createRange();
      range.selectNodeContents(output);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      expect(ceilReadOnlyTextEvent(new Event("selectionchange"))).toBe(true);
      selection.removeAllRanges();
      expect(ceilReadOnlyTextEvent(new Event("selectionchange"))).toBe(false);
    } finally {
      root.remove();
    }
  });

  test("whole-output copy text is trimmed plain text", () => {
    const { root, output } = cellDom();
    try {
      // The test DOM has no layout; WebKit's innerText keeps rendered line breaks.
      Object.defineProperty(output, "innerText", { value: "  line one\n\n\n\nline two\n" });
      expect(ceilOutputPlainText(output)).toBe("line one\n\nline two");
    } finally {
      root.remove();
    }
  });
});
