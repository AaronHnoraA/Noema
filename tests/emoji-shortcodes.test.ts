/** `:name:` shortcodes render in the editor as they do in export, and complete after `:`. */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { emojiCompletionContext, emojiCompletions, scanEmojiShortcodes } from "../src/emoji-shortcodes.ts";
import { createEditorCM6 } from "../src/cm6/editor-cm6.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import type { Editor } from "../src/editor-api.ts";

const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()!.destroy(); document.body.replaceChildren(); });

function open(doc: string, at: number): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const ed = createEditorCM6(host, { initialContent: doc });
  ed.setSelection(at, at);
  editors.push(ed);
  return ed;
}

describe("emoji shortcodes", () => {
  it("scans known names only, letting a colon close one name and open the next", () => {
    expect(scanEmojiShortcodes("a :smile: b :nope: :+1: 10:30:00").map((m) => m.name)).toEqual(["smile", "+1"]);
    expect(scanEmojiShortcodes(":qq:smile:", 5)).toEqual([{ from: 8, to: 15, name: "smile", emoji: "😄" }]);
  });

  it("agrees with the export renderer", () => {
    expect(renderMarkdownHTML("hi :smile:")).toContain("😄");
  });

  it("opens completion only for a standalone colon with two name characters", () => {
    expect(emojiCompletionContext("say :sm")).toEqual({ query: "sm", deleteBefore: 3 });
    expect(emojiCompletionContext(":tada")).toEqual({ query: "tada", deleteBefore: 5 });
    expect(emojiCompletionContext("say :s")).toBeNull();
    expect(emojiCompletionContext("at 10:30")).toBeNull();
    expect(emojiCompletionContext("http:ab")).toBeNull();
  });

  it("ranks names that start with the query first", () => {
    const names = emojiCompletions("smile").map((item) => item.name);
    expect(names[0]).toBe("smile");
    expect(names.every((name) => name.includes("smile"))).toBe(true);
  });

  it("live preview shows the emoji and reveals the source under the caret", async () => {
    const doc = "hello :tada: and `:tada:`";
    const ed = open(doc, 0);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const shown = () => Array.from(ed.view.dom.querySelectorAll(".cm-emoji")).map((node) => node.textContent);
    expect(shown()).toEqual(["🎉"]);
    ed.setSelection(9, 9);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(shown()).toEqual([]);
  });
});
