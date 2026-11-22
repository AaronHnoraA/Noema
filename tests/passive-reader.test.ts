import { afterEach, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor, type Editor } from "../src/editor-api.ts";

const opened: Array<{ editor: Editor; host: HTMLElement }> = [];
afterEach(() => { for (const { editor, host } of opened.splice(0)) { editor.destroy(); host.remove(); } });

function open(passiveReader: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, {
    initialContent: "# Title\n\nSome **bold** text\n\n## Second\n\nend\n",
    readOnly: true,
    passiveReader,
  });
  opened.push({ editor, host });
  return { editor, host, hints: () => [...host.querySelectorAll(".syntax-hint")].map((e) => e.textContent) };
}

test("a passive reader never shows heading or emphasis markup, on load or on click", async () => {
  const { editor, hints } = open(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(hints()).toEqual([]);
  editor.view.dispatch({ selection: { anchor: 30 }, userEvent: "select.pointer" });
  expect(hints()).toEqual([]);
  editor.view.dispatch({ selection: { anchor: 13 }, userEvent: "select.pointer" });
  expect(hints()).toEqual([]);
  // The real selection still moves, so selecting and copying text works.
  expect(editor.view.state.selection.main.head).toBe(13);
});

test("an ordinary read-only pane still reveals the line the caret is on", async () => {
  const { editor, hints } = open(false);
  editor.view.dispatch({ selection: { anchor: 30 }, userEvent: "select.pointer" });
  expect(hints()).toContain("## ");
});

test("a read-only page renders a TikZ block that has no id yet", async () => {
  const { setTikzRendererForTests } = await import("../src/tikz-browser.ts");
  const calls: string[] = [];
  setTikzRendererForTests(async (source) => {
    calls.push(source);
    return '<svg viewBox="0 0 20 10"><path stroke="blue" d="M0 0L20 10"/></svg>';
  });
  try {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, {
      initialContent: "intro\n\n#+begin tikz\n\\draw (0,0) -- (1,1);\n#+end tikz\n\nend\n",
      readOnly: true,
      passiveReader: true,
    });
    opened.push({ editor, host });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);
    expect(host.querySelector(".cm-tikz-env-image")).toBeTruthy();
    expect(host.textContent).not.toContain("Preparing TikZ");
    expect(editor.getMarkdown()).toContain("#+begin tikz\n");
  } finally {
    setTikzRendererForTests(null);
  }
});
