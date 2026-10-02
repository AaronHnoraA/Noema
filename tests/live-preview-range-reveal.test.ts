/**
 * A range selection reveals source markers only around its two ends.
 *
 * Revealing every span a range touched made Select All expose every `**`,
 * backtick and link URL in view and reflow the text under the selection.
 * MarkText decides from the anchor and focus; a caret still reveals the span
 * it is in.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";

function hints(markdown: string, from: number, to: number): string[] {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: markdown });
  editor.setSelection(from, to);
  const content = host.querySelector(".cm-content") as HTMLElement;
  const revealed = Array.from(content.querySelectorAll(".syntax-hint")).map((node) => node.textContent ?? "");
  editor.destroy();
  host.remove();
  return revealed;
}

describe("range selection reveal", () => {
  const md = "one **two** three `four` five";

  test("selecting everything keeps every span rendered", () => {
    expect(hints(md, 0, md.length)).toEqual([]);
  });

  test("a range end inside a span reveals that span only", () => {
    const inBold = md.indexOf("two") + 1;
    expect(hints(md, 0, inBold)).toEqual(["**", "**"]);
  });

  test("a caret inside a span still reveals it", () => {
    const inCode = md.indexOf("four") + 1;
    expect(hints(md, inCode, inCode)).toEqual(["`", "`"]);
  });
});

describe("range selection keeps rich widgets rendered", () => {
  function widgets(markdown: string, from: number, to: number) {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: markdown });
    editor.setSelection(from, to);
    // A rebuild while the selection stands (an edit, scroll or resize) must
    // agree with it; an edit elsewhere forces the widget plugins to rebuild.
    const end = editor.view.state.doc.length;
    editor.view.dispatch({
      changes: { from: end, insert: "!" },
      selection: from === to ? { anchor: from } : { anchor: from, head: to === end ? end + 1 : to },
    });
    const content = host.querySelector(".cm-content") as HTMLElement;
    const result = {
      images: content.querySelectorAll(".cm-image-widget").length,
      text: content.textContent ?? "",
    };
    editor.destroy();
    host.remove();
    return result;
  }

  const md = "before\n\n![cat](cat.png)\n\nafter";

  test("Select All leaves an image rendered", () => {
    const result = widgets(md, 0, md.length);
    expect(result.images).toBe(1);
    expect(result.text).not.toContain("![cat]");
  });

  test("a caret on the image opens its source", () => {
    const at = md.indexOf("cat.png");
    const result = widgets(md, at, at);
    expect(result.images).toBe(0);
    expect(result.text).toContain("![cat](cat.png)");
  });
});
