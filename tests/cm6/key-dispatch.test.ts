/**
 * Key-dispatch regression tests.
 *
 * These deliberately fire real `keydown` events on `.cm-content` instead of
 * calling the commands directly. The rest of the suite calls commands, which
 * is exactly how a precedence bug hid here: `@codemirror/lang-markdown` used
 * to inject a `Prec.high` Enter/Backspace keymap that outranked this editor's
 * own bindings, so `runEditorEnter` never ran for the empty-list and
 * empty-quote exits even though the command itself was correct.
 */

import { describe, expect, it } from "@voidzero-dev/vite-plus-test";

async function press(
  initial: string,
  at: number,
  key: string,
): Promise<{ doc: string; cursor: number }> {
  const { createEditorCM6 } = await import("../../src/cm6/editor-cm6.ts");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: initial });
  editor.setSelection(at, at);
  editor.view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
  const doc = editor.getMarkdown();
  const cursor = editor.getMarkdownSelection().from;
  editor.destroy();
  host.remove();
  return { doc, cursor };
}

describe("Enter reaches the canonical chain in src/cm6/input-commands.ts", () => {
  it("exits an empty list item instead of continuing it", async () => {
    const { doc } = await press("- item\n- ", 9, "Enter");
    expect(doc).toBe("- item\n");
  });

  it("exits an empty block quote instead of continuing it", async () => {
    const { doc } = await press("> quote\n> ", 10, "Enter");
    expect(doc).toBe("> quote\n");
  });

  it("exits an empty task item", async () => {
    const { doc } = await press("- [ ] a\n- [ ] ", 14, "Enter");
    expect(doc).toBe("- [ ] a\n");
  });

  it("still continues a non-empty bullet", async () => {
    const { doc } = await press("- item", 6, "Enter");
    expect(doc).toBe("- item\n- ");
  });

  it("still continues and renumbers an ordered list", async () => {
    const { doc } = await press("1. one", 6, "Enter");
    expect(doc).toBe("1. one\n2. ");
  });

  it("still continues a task item with an unchecked box", async () => {
    const { doc } = await press("- [ ] a", 7, "Enter");
    expect(doc).toBe("- [ ] a\n- [ ] ");
  });

  it("still continues a nested bullet at its own indent", async () => {
    const { doc } = await press("- a\n  - b", 9, "Enter");
    expect(doc).toBe("- a\n  - b\n  - ");
  });

  it("still adds a table row from inside a table", async () => {
    const { doc } = await press("| a | b |\n| - | - |\n| 1 | 2 |", 22, "Enter");
    expect(doc).toBe("| a   | b   |\n| --- | --- |\n| 1   | 2   |\n|     |     |");
  });
});

describe("Backspace reaches the canonical chain", () => {
  it("removes a list marker in one press", async () => {
    const { doc } = await press("- item", 2, "Backspace");
    expect(doc).toBe("item");
  });

  it("deletes a single character in ordinary prose", async () => {
    const { doc } = await press("abc", 2, "Backspace");
    expect(doc).toBe("ac");
  });
});
