/**
 * Inline HTML formatting tags are two separate HTMLTag nodes; the text between
 * `<kbd>` and `</kbd>` must still be marked so it renders as a key cap.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";

function marked(markdown: string, cls: string): string[] {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: `x\n\n${markdown}` });
  editor.setSelection(0, 0);
  const content = host.querySelector(".cm-content") as HTMLElement;
  const texts = [...content.querySelectorAll(`.${cls}`)].map((node) => node.textContent ?? "");
  editor.destroy();
  host.remove();
  return texts;
}

describe("paired inline HTML tags", () => {
  test("marks kbd, sub, sup and mark content", () => {
    expect(marked("Press <kbd>Ctrl</kbd> + <kbd>K</kbd>", "cm-html-kbd")).toEqual(["Ctrl", "K"]);
    expect(marked("H<sub>2</sub>O and x<sup>2</sup>", "cm-html-sub")).toEqual(["2"]);
    expect(marked("H<sub>2</sub>O and x<sup>2</sup>", "cm-html-sup")).toEqual(["2"]);
    expect(marked('a <mark class="hl">hot</mark> word', "cm-html-mark")).toEqual(["hot"]);
  });

  test("ignores unmatched, mismatched and unsupported tags", () => {
    expect(marked("<kbd>open only", "cm-html-kbd")).toEqual([]);
    expect(marked("<kbd>a</sub>", "cm-html-kbd")).toEqual([]);
    expect(marked("<span>a</span>", "cm-html-span")).toEqual([]);
  });

  test("does not mark tag text inside code", () => {
    expect(marked("`<kbd>a</kbd>`", "cm-html-kbd")).toEqual([]);
  });
});
