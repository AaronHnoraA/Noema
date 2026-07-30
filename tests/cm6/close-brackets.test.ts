/**
 * VSCode 式括号自动配对（src/cm6/close-brackets-vscode.ts）。
 *
 * 覆盖：行尾/空白前补全（回归 stock 行为）、数学环境 `\(here\)` 内 `\` 前补全
 * （本次修复的动机 bug）、字母数字前不补全、type-over、Backspace 配对删除、
 * 非空选区包裹回退到 stock closeBrackets、多光标。
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { deleteBracketPair } from "@codemirror/autocomplete";
import { createEditor } from "../../src/editor-api.ts";

function mountCM6(initialContent = "") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent });
  return { editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

type InputHandler = (view: EditorView, from: number, to: number, insert: string) => boolean;

function typeChar(view: EditorView, ch: string): void {
  const handlers = view.state.facet(EditorView.inputHandler) as unknown as InputHandler[];
  const { from, to } = view.state.selection.main;
  for (const handler of handlers) {
    if (handler(view, from, to, ch)) return;
  }
  view.dispatch(view.state.update(view.state.replaceSelection(ch), { userEvent: "input.type" }));
}

function setCursor(view: EditorView, pos: number): void {
  view.dispatch({ selection: EditorSelection.cursor(pos) });
}

describe("vscodeCloseBrackets", () => {
  test("closes before end of line (regression parity with stock)", () => {
    const { editor, cleanup } = mountCM6("x");
    try {
      setCursor(editor.view, 1);
      typeChar(editor.view, "(");
      expect(editor.getMarkdown()).toBe("x()");
      expect(editor.view.state.selection.main.head).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("closes before whitespace (regression parity with stock)", () => {
    const { editor, cleanup } = mountCM6("x y");
    try {
      setCursor(editor.view, 1);
      typeChar(editor.view, "[");
      expect(editor.getMarkdown()).toBe("x[] y");
    } finally {
      cleanup();
    }
  });

  test("closes before a backslash inside inline math (the motivating bug)", () => {
    const { editor, cleanup } = mountCM6("\\(\\)");
    try {
      // Cursor between the opening `\(` and the closing `\)`.
      setCursor(editor.view, 2);
      typeChar(editor.view, "(");
      expect(editor.getMarkdown()).toBe("\\(()\\)");
    } finally {
      cleanup();
    }
  });

  test("closes before punctuation stock's finite `before` set does not cover", () => {
    // Stock closeBrackets only auto-closes before `)]}:;>`, whitespace, or
    // end-of-line. A period is none of those, so this only closes under the
    // broadened VSCode-style rule (close unless next char is a word char).
    const { editor, cleanup } = mountCM6("end.");
    try {
      setCursor(editor.view, 3);
      typeChar(editor.view, "(");
      expect(editor.getMarkdown()).toBe("end().");
    } finally {
      cleanup();
    }
  });

  test("does not close before a letter or digit", () => {
    const { editor, cleanup } = mountCM6("word");
    try {
      setCursor(editor.view, 0);
      typeChar(editor.view, "(");
      expect(editor.getMarkdown()).toBe("(word");
    } finally {
      cleanup();
    }
  });

  test("type-over: typing the closer right after auto-close moves the cursor over it", () => {
    const { editor, cleanup } = mountCM6("x");
    try {
      setCursor(editor.view, 1);
      typeChar(editor.view, "(");
      expect(editor.getMarkdown()).toBe("x()");
      const posAfterOpen = editor.view.state.selection.main.head;
      typeChar(editor.view, ")");
      expect(editor.getMarkdown()).toBe("x()");
      expect(editor.view.state.selection.main.head).toBe(posAfterOpen + 1);
    } finally {
      cleanup();
    }
  });

  test("no type-over for a closing bracket that was not auto-inserted", () => {
    const { editor, cleanup } = mountCM6("()");
    try {
      setCursor(editor.view, 1);
      typeChar(editor.view, ")");
      expect(editor.getMarkdown()).toBe("())");
    } finally {
      cleanup();
    }
  });

  test("Backspace deletes an auto-closed pair together", () => {
    const { editor, cleanup } = mountCM6("x");
    try {
      setCursor(editor.view, 1);
      typeChar(editor.view, "{");
      expect(editor.getMarkdown()).toBe("x{}");
      const handled = deleteBracketPair({ state: editor.view.state, dispatch: (tr) => editor.view.dispatch(tr) });
      expect(handled).toBe(true);
      expect(editor.getMarkdown()).toBe("x");
    } finally {
      cleanup();
    }
  });

  test("non-empty selection falls back to stock wrap behavior", () => {
    const { editor, cleanup } = mountCM6("word");
    try {
      editor.view.dispatch({ selection: EditorSelection.range(0, 4) });
      typeChar(editor.view, "(");
      expect(editor.getMarkdown()).toBe("(word)");
    } finally {
      cleanup();
    }
  });

  test("multi-cursor: both cursors auto-close consistently", () => {
    // Cursor 1 is right after "a" (next char is a space); cursor 2 is at the
    // end of the doc (no next char). Both qualify for auto-close.
    const { editor, cleanup } = mountCM6("a b");
    try {
      editor.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]) });
      typeChar(editor.view, "(");
      expect(editor.getMarkdown()).toBe("a() b()");
    } finally {
      cleanup();
    }
  });

  test("multi-cursor: any cursor declining aborts auto-close for all", () => {
    // Cursor 1 is right before "a" (next char is a letter) — this range must
    // decline, and per changeByRange's all-or-nothing semantics the whole
    // multi-range edit falls back to a plain character insert everywhere.
    const { editor, cleanup } = mountCM6("a b");
    try {
      editor.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3)]) });
      typeChar(editor.view, "(");
      expect(editor.getMarkdown()).toBe("(a b(");
    } finally {
      cleanup();
    }
  });
});
