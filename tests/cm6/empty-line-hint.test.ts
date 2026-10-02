/** The slash-menu hint shows only on the focused, empty, non-code caret line. */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import { emptyLineHintLine } from "../../src/cm6/empty-line-hint.ts";
import type { Editor } from "../../src/editor-api.ts";

const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()!.destroy(); document.body.replaceChildren(); });

function state(doc: string, at: number): EditorState {
  const s = EditorState.create({ doc, selection: EditorSelection.cursor(at), extensions: markdown() });
  ensureSyntaxTree(s, s.doc.length, 1000);
  return s;
}

describe("empty line hint", () => {
  it("chooses only a focused empty prose line", () => {
    expect(emptyLineHintLine(state("a\n\nb", 2), true)).toBe(2);
    expect(emptyLineHintLine(state("a\n\nb", 2), false)).toBeNull();
    expect(emptyLineHintLine(state("a\n\nb", 1), true)).toBeNull();
    expect(emptyLineHintLine(state("```\n\n```", 4), true)).toBeNull();
  });

  it("decorates the caret line in the editor and moves with it", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const ed = createEditorCM6(host, { initialContent: "text\n\nmore" });
    editors.push(ed);
    ed.view.focus();
    ed.setSelection(5, 5);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const hinted = () => Array.from(host.querySelectorAll(".cm-empty-line-hint")).map((line) => line.textContent);
    expect(hinted()).toEqual([""]);
    expect(host.querySelector(".cm-empty-line-hint")?.getAttribute("data-hint")).toBe("Type / for commands");
    ed.setSelection(1, 1);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(hinted()).toEqual([]);
  });
});
