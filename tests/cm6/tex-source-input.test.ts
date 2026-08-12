import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditor } from "../../src/editor-api.ts";
import {
  deleteTexSourceAutoPair,
  deleteTexSourceAutoPairForward,
  isTexSourceStructuralInput,
  moveAcrossTexSourceAutoPair,
  moveAcrossTexSourceUnit,
} from "../../src/cm6/tex-source-input.ts";

type InputHandler = (view: EditorView, from: number, to: number, insert: string) => boolean;

function mountCM6(initialContent: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent });
  return { editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

function setCursor(view: EditorView, position: number): void {
  view.dispatch({ selection: EditorSelection.cursor(position) });
}

function typeChar(view: EditorView, insert: string): void {
  const { from, to } = view.state.selection.main;
  const handlers = view.state.facet(EditorView.inputHandler) as unknown as InputHandler[];
  for (const handler of handlers) {
    if (handler(view, from, to, insert)) return;
  }
  view.dispatch(view.state.update(view.state.replaceSelection(insert), { userEvent: "input.type" }));
}

describe("CM6 TeX source input", () => {
  test("rejects ordinary Markdown input before any math-range lookup", () => {
    for (const character of "abcdefghijklmnopqrstuvwxyz0123456789 ,:;!?") {
      expect(isTexSourceStructuralInput("ordinary markdown", character)).toBe(false);
    }
    expect(isTexSourceStructuralInput(String.raw`\left\langl`, "e")).toBe(true);
    expect(isTexSourceStructuralInput("x", "^")).toBe(true);
  });

  test("creates script braces and types over their closer", () => {
    const { editor, cleanup } = mountCM6(String.raw`\(x\)`);
    try {
      setCursor(editor.view, 3);
      typeChar(editor.view, "^");
      expect(editor.getMarkdown()).toBe(String.raw`\(x^{}\)`);
      expect(editor.view.state.selection.main.head).toBe(5);

      typeChar(editor.view, "2");
      typeChar(editor.view, "}");
      expect(editor.getMarkdown()).toBe(String.raw`\(x^{2}\)`);
      expect(editor.view.state.selection.main.head).toBe(7);
    } finally {
      cleanup();
    }
  });

  test("uses an existing group as the script body", () => {
    const { editor, cleanup } = mountCM6(String.raw`\(x{2}\)`);
    try {
      setCursor(editor.view, 3);
      typeChar(editor.view, "_");
      expect(editor.getMarkdown()).toBe(String.raw`\(x_{2}\)`);
      expect(editor.view.state.selection.main.head).toBe(5);
    } finally {
      cleanup();
    }
  });

  test("completes left/right delimiters and types over the semantic closer", () => {
    const { editor, cleanup } = mountCM6(String.raw`\(\left\)`);
    try {
      setCursor(editor.view, 7);
      typeChar(editor.view, "(");
      expect(editor.getMarkdown()).toBe(String.raw`\(\left(\right)\)`);
      typeChar(editor.view, "x");
      typeChar(editor.view, ")");
      expect(editor.getMarkdown()).toBe(String.raw`\(\left(x\right)\)`);
      expect(editor.view.state.selection.main.head).toBe(16);
    } finally {
      cleanup();
    }
  });

  test("only deletes a script pair when it is empty and the caret is inside", () => {
    const { editor, cleanup } = mountCM6(String.raw`\(x\)`);
    try {
      setCursor(editor.view, 3);
      typeChar(editor.view, "^");
      // Empty pair, caret between `^{` and `}` — this is the VSCode gesture.
      expect(deleteTexSourceAutoPair(editor.view)).toBe(true);
      expect(editor.getMarkdown()).toBe(String.raw`\(x\)`);
      expect(editor.view.state.selection.main.head).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("never swallows the body of a non-empty script pair", () => {
    const { editor, cleanup } = mountCM6(String.raw`\(x\)`);
    try {
      setCursor(editor.view, 3);
      typeChar(editor.view, "^");
      typeChar(editor.view, "2");
      expect(editor.getMarkdown()).toBe(String.raw`\(x^{2}\)`);
      // Caret right after `{`, and right after `}`: both used to delete `^{`
      // and `}` together, turning `x^{2}` into `x2`.
      for (const head of [5, 7]) {
        setCursor(editor.view, head);
        expect(deleteTexSourceAutoPair(editor.view)).toBe(false);
        expect(editor.getMarkdown()).toBe(String.raw`\(x^{2}\)`);
      }
    } finally {
      cleanup();
    }
  });

  test("Tab leaves an auto-created script like a completion field", () => {
    const { editor, cleanup } = mountCM6(String.raw`\(x\)`);
    try {
      setCursor(editor.view, 3);
      typeChar(editor.view, "_");
      typeChar(editor.view, "i");
      expect(moveAcrossTexSourceAutoPair(editor.view)).toBe(true);
      expect(editor.view.state.selection.main.head).toBe(7);
      expect(editor.getMarkdown()).toBe(String.raw`\(x_{i}\)`);
    } finally {
      cleanup();
    }
  });

  test("only deletes a large delimiter pair when it is empty and the caret is inside", () => {
    const { editor, cleanup } = mountCM6(String.raw`\(\left\)`);
    try {
      setCursor(editor.view, 7);
      typeChar(editor.view, "[");
      expect(editor.getMarkdown()).toBe(String.raw`\(\left[\right]\)`);
      // `\left[` was generated as one opener, so the whole pair goes.
      expect(deleteTexSourceAutoPairForward(editor.view)).toBe(true);
      expect(editor.getMarkdown()).toBe(String.raw`\(\)`);

      setCursor(editor.view, 2);
      typeChar(editor.view, "\\");
      for (const character of "left") typeChar(editor.view, character);
      typeChar(editor.view, "[");
      typeChar(editor.view, "x");
      // Body present: the delimiters must stay put.
      setCursor(editor.view, 2);
      expect(deleteTexSourceAutoPairForward(editor.view)).toBe(false);
      expect(editor.getMarkdown()).toBe(String.raw`\(\left[x\right]\)`);
    } finally {
      cleanup();
    }
  });

  test("deletes the innermost pair when several nest around the caret", () => {
    const { editor, cleanup } = mountCM6(String.raw`\(x\)`);
    try {
      setCursor(editor.view, 3);
      typeChar(editor.view, "^");
      typeChar(editor.view, "y");
      typeChar(editor.view, "_");
      expect(editor.getMarkdown()).toBe(String.raw`\(x^{y_{}}\)`);
      expect(deleteTexSourceAutoPair(editor.view)).toBe(true);
      // Only the inner `_{}` goes; the outer superscript survives.
      expect(editor.getMarkdown()).toBe(String.raw`\(x^{y}\)`);
    } finally {
      cleanup();
    }
  });

  test("wraps a selection in a large delimiter instead of replacing it", () => {
    const { editor, cleanup } = mountCM6(String.raw`\(\leftab\)`);
    try {
      editor.view.dispatch({ selection: EditorSelection.range(7, 9) });
      typeChar(editor.view, "(");
      expect(editor.getMarkdown()).toBe(String.raw`\(\left(ab\right)\)`);
      expect(editor.view.state.selection.main.from).toBe(8);
      expect(editor.view.state.selection.main.to).toBe(10);
    } finally {
      cleanup();
    }
  });

  test("leaves script characters alone outside TeX source", () => {
    const { editor, cleanup } = mountCM6("x");
    try {
      setCursor(editor.view, 1);
      typeChar(editor.view, "^");
      expect(editor.getMarkdown()).toBe("x^");
    } finally {
      cleanup();
    }
  });

  test("keeps TeX text-command arguments in text input mode", () => {
    const { editor, cleanup } = mountCM6(String.raw`\(\text{alpha}\)`);
    try {
      const cursor = editor.getMarkdown().indexOf("alpha") + "alpha".length;
      setCursor(editor.view, cursor);
      typeChar(editor.view, "^");
      expect(editor.getMarkdown()).toBe(String.raw`\(\text{alpha^}\)`);
      expect(editor.view.state.selection.main.head).toBe(cursor + 1);
    } finally {
      cleanup();
    }
  });

  test("still deletes an empty pair after the caret has left and come back", () => {
    const { editor, cleanup } = mountCM6(String.raw`\(x\) prose`);
    try {
      setCursor(editor.view, 3);
      typeChar(editor.view, "^");
      expect(editor.getMarkdown()).toBe(String.raw`\(x^{}\) prose`);
      // Leaving drops the transient auto-pair state; paired deletion has to
      // come from the document itself after that, the way single-character
      // brackets already worked.
      setCursor(editor.view, editor.getMarkdown().length);
      setCursor(editor.view, 5);
      expect(deleteTexSourceAutoPair(editor.view)).toBe(true);
      expect(editor.getMarkdown()).toBe(String.raw`\(x\) prose`);
    } finally {
      cleanup();
    }
  });

  test("leaves a filled pair alone after the caret has left and come back", () => {
    const { editor, cleanup } = mountCM6(String.raw`\(x\) prose`);
    try {
      setCursor(editor.view, 3);
      typeChar(editor.view, "^");
      typeChar(editor.view, "2");
      setCursor(editor.view, editor.getMarkdown().length);
      setCursor(editor.view, 5);
      expect(deleteTexSourceAutoPair(editor.view)).toBe(false);
      expect(editor.getMarkdown()).toBe(String.raw`\(x^{2}\) prose`);
    } finally {
      cleanup();
    }
  });

  test("consumes Cmd-bracket navigation outside TeX without indenting", () => {
    const { editor, cleanup } = mountCM6("- item");
    try {
      setCursor(editor.view, editor.getMarkdown().length);
      expect(moveAcrossTexSourceUnit(editor.view, 1)).toBe(true);
      expect(moveAcrossTexSourceUnit(editor.view, -1)).toBe(true);
      const keydown = new KeyboardEvent("keydown", {
        key: "]",
        code: "BracketRight",
        // CodeMirror resolves Mod to Ctrl under happy-dom's non-macOS
        // navigator; production macOS resolves the same binding to Cmd.
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      editor.view.contentDOM.dispatchEvent(keydown);
      expect(keydown.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("- item");
    } finally {
      cleanup();
    }
  });
});
