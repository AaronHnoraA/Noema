/**
 * Characterization tests for how the caret crosses replacement widgets.
 *
 * These pin behavior rather than assert an ideal. Today only math contributes
 * `EditorView.atomicRanges`, and only in Visual mode; every other
 * `Decoration.replace` widget is caret-transparent and repairs itself on the
 * next selection update, meaning the caret genuinely sits inside a replaced
 * range for one frame. Three separate mechanisms have to agree about skipping
 * a formula — CodeMirror's `skipAtomicRanges`, vim-lite's `snapStaticMathMotion`
 * and math.ts's pre-emptive arrow activation — so lock the current contract
 * before anyone changes one of them.
 */

import { EditorView } from "@codemirror/view";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

async function mount(text: string) {
  const { createEditorCM6 } = await import("../../src/cm6/editor-cm6.ts");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: text });
  return {
    editor,
    cleanup: () => { editor.destroy(); host.remove(); },
  };
}

/** Every atomic span the view currently reports, flattened. */
function atomicSpans(view: EditorView): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = [];
  for (const provider of view.state.facet(EditorView.atomicRanges)) {
    const set = provider(view);
    const iterator = set.iter();
    while (iterator.value) {
      spans.push({ from: iterator.from, to: iterator.to });
      iterator.next();
    }
  }
  return spans.sort((a, b) => a.from - b.from);
}

describe("inline math is the atomic unit while it is rendered", () => {
  test("a rendered formula reports one atomic span covering its delimiters", async () => {
    const { editor, cleanup } = await mount("before \\(x^2\\) after");
    editor.setSelection(0, 0);
    expect(atomicSpans(editor.view)).toContainEqual({ from: 7, to: 14 });
    cleanup();
  });

  test("the atomic span disappears once the caret is inside the formula", async () => {
    const { editor, cleanup } = await mount("before \\(x^2\\) after");
    // Strictly inside the delimiters is what reveals the TeX source.
    editor.setSelection(10, 10);
    expect(atomicSpans(editor.view)).not.toContainEqual({ from: 7, to: 14 });
    cleanup();
  });

  test("Source mode drops math atomicity entirely", async () => {
    const { toggleAaronnoteMarkdownSource } = await import("../../src/cm6/editor-cm6.ts");
    const { editor, cleanup } = await mount("before \\(x^2\\) after");
    editor.setSelection(0, 0);
    expect(atomicSpans(editor.view).length).toBeGreaterThan(0);
    expect(toggleAaronnoteMarkdownSource(editor.view)).toBe(true);
    expect(atomicSpans(editor.view)).toEqual([]);
    cleanup();
  });
});

describe("arrowing into inline math enters it instead of skipping over it", () => {
  test("ArrowRight from just before the formula lands inside the delimiters", async () => {
    const { runEditorMovement } = await import("../../src/cm6/input-commands.ts");
    const { editor, cleanup } = await mount("ab \\(x\\) cd");
    editor.setSelection(3, 3);
    expect(runEditorMovement(editor.view, "ArrowRight")).toBe("formula");
    // `\(` is two characters, so "inside" is from + 2.
    expect(editor.getMarkdownSelection().from).toBe(5);
    cleanup();
  });

  test("ArrowLeft from just after the formula lands inside the delimiters", async () => {
    const { runEditorMovement } = await import("../../src/cm6/input-commands.ts");
    const { editor, cleanup } = await mount("ab \\(x\\) cd");
    editor.setSelection(8, 8);
    expect(runEditorMovement(editor.view, "ArrowLeft")).toBe("formula");
    expect(editor.getMarkdownSelection().from).toBe(6);
    cleanup();
  });

  test("plain prose movement is unaffected", async () => {
    const { runEditorMovement } = await import("../../src/cm6/input-commands.ts");
    const { editor, cleanup } = await mount("alpha beta");
    editor.setSelection(2, 2);
    expect(runEditorMovement(editor.view, "ArrowRight")).toBe("cursor");
    expect(editor.getMarkdownSelection().from).toBe(3);
    cleanup();
  });
});

describe("non-math replacement widgets stay caret-transparent", () => {
  test("an image widget contributes no atomic range", async () => {
    const { editor, cleanup } = await mount("text ![alt](img.png) more");
    editor.setSelection(0, 0);
    // Deliberate: images repair themselves on the next selection update rather
    // than blocking the caret. If this ever starts reporting a span, the change
    // was intentional and this expectation should move with it.
    expect(atomicSpans(editor.view)).toEqual([]);
    cleanup();
  });
});
