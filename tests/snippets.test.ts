import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import type { Editor } from "../src/lib.ts";
import { createEditor } from "../src/lib.ts";
import {
  expandSnippetBody,
  insertExpandedSnippetIntoContentEditable,
  matchingSnippetsForPrefix,
  SnippetSession,
  SnippetUsageStore,
  snippetBrowserCompatibility,
  snippetPopupKeyAction,
} from "../aaronnote/snippets.ts";

class TextEditor {
  text = "";
  selection = { from: 0, to: 0 };

  asEditor(): Editor {
    return this as unknown as Editor;
  }

  getMarkdown(): string {
    return this.text;
  }

  setMarkdown(md: string): void {
    this.text = md;
    this.selection = { from: md.length, to: md.length };
  }

  insertText(text: string, deleteBefore = 0): { from: number; to: number } {
    const from = Math.max(0, this.selection.from - deleteBefore);
    return this.replaceRange(from, this.selection.to, text, "end");
  }

  setSelection(from: number, to = from): void {
    this.selection = { from, to };
  }

  getSelection(): { from: number; to: number } {
    return this.selection;
  }

  textBetween(from: number, to: number): string {
    return this.text.slice(from, to);
  }

  replaceRange(from: number, to: number, text: string, select: "start" | "end" | "all" = "end"): { from: number; to: number } {
    this.text = `${this.text.slice(0, from)}${text}${this.text.slice(to)}`;
    const end = from + text.length;
    if (select === "start") this.setSelection(from);
    else if (select === "all") this.setSelection(from, end);
    else this.setSelection(end);
    return { from, to: end };
  }
}

describe("aaronnote snippets", () => {
  test("ranks snippets after applying mode and kind filters", () => {
    const tex = Array.from({ length: 12 }, (_, index) => ({
      key: `a${index}`,
      name: `Tex ${index}`,
      mode: "tex-mode",
      body: String(index),
    }));
    const matches = matchingSnippetsForPrefix([
      ...tex,
      { key: "alpha", name: "Markdown alpha", mode: "markdown-mode", body: "alpha" },
      { key: "alpha-kind", name: "Slides alpha", mode: "markdown-mode", kind: "slides", body: "slides" },
    ], "a", { mode: "markdown-mode", kind: "", limit: 10 });

    expect(matches.map((snippet) => snippet.key)).toEqual(["alpha"]);
  });

  test("matches VS Code-style snippet prefixes without searching metadata", () => {
    const matches = matchingSnippetsForPrefix([
      { key: "for-const", name: "Loop", mode: "markdown-mode", group: "control", body: "for const" },
      { key: "ratio", name: "Fraction", mode: "markdown-mode", body: "frac" },
      { key: "note", name: "fc", mode: "markdown-mode", body: "note" },
      { key: "proof", name: "Proof", mode: "markdown-mode", group: "fc", body: "proof" },
      { key: "kinded", name: "Kinded", mode: "markdown-mode", kind: "fc", body: "kinded" },
    ], "fc", { mode: "markdown-mode", kind: "", limit: 10 });

    expect(matches.map((snippet) => snippet.key)).toEqual(["for-const"]);
  });

  test("orders exact, prefix, substring, then fuzzy prefix matches", () => {
    const matches = matchingSnippetsForPrefix([
      { key: "for-const", name: "Fuzzy", mode: "markdown-mode", body: "" },
      { key: "prefix-fc", name: "Substring", mode: "markdown-mode", body: "" },
      { key: "fc", name: "Exact", mode: "markdown-mode", body: "" },
      { key: "fc-block", name: "Prefix", mode: "markdown-mode", body: "" },
    ], "fc", { mode: "markdown-mode", limit: 10 });

    expect(matches.map((snippet) => snippet.key)).toEqual(["fc", "fc-block", "prefix-fc", "for-const"]);
  });

  test("snippet popup accepts tab and cmd-number but not enter", () => {
    expect(snippetPopupKeyAction({ key: "Enter" })).toEqual({ type: "consume" });
    expect(snippetPopupKeyAction({ key: "Tab" })).toEqual({ type: "accept" });
    expect(snippetPopupKeyAction({ key: "2", commandKey: true })).toEqual({ type: "select", index: 1 });
    expect(snippetPopupKeyAction({ key: "3", altKey: true })).toEqual({ type: "select", index: 2 });
    expect(snippetPopupKeyAction({ key: "0", commandKey: true })).toEqual({ type: "select", index: 9 });
    expect(snippetPopupKeyAction({ key: "Tab", isComposing: true })).toEqual({ type: "none" });
  });

  test("expands nested tabstops inside placeholder defaults", () => {
    const expanded = expandSnippetBody({
      key: "draw",
      name: "TikZ draw",
      mode: "tex-mode",
      body: "\\draw${1:[${2:thick}]} (${3:A}) -- (${4:B});$0",
    });

    expect(expanded.text).toBe("\\draw[thick] (A) -- (B);");
    const field1 = expanded.tabstops.find((stop) => stop.index === 1);
    const field2 = expanded.tabstops.find((stop) => stop.index === 2);
    expect(field1 && expanded.text.slice(field1.from, field1.to)).toBe("[thick]");
    expect(field2 && expanded.text.slice(field2.from, field2.to)).toBe("thick");
  });

  test("supports portable YAS choices and selected-text wrapping", () => {
    const choice = expandSnippetBody({
      key: "style",
      mode: "tex-mode",
      body: "${1:$$(yas-choose-value '(\"alpha\" \"beta\"))}$0",
    });
    expect(choice.text).toBe("alpha");
    expect(choice.tabstops.find((stop) => stop.index === 1)?.choices).toEqual(["alpha", "beta"]);

    const wrapped = expandSnippetBody({
      key: "hat",
      mode: "tex-mode",
      body: "\\hat{${1:`(or yas-selected-text \"x\")`}}$0",
    }, { selectedText: "v" });
    expect(wrapped.text).toBe("\\hat{v}");
    expect(snippetBrowserCompatibility("`(message \"unsafe\")`").compatible).toBe(false);
    expect(snippetBrowserCompatibility("`$1` $0").compatible).toBe(true);
  });

  test("expands the shared Noema UUID primitive without enabling arbitrary Lisp", () => {
    const expanded = expandSnippetBody({
      key: "anchor",
      mode: "markdown-mode",
      body: "{#`(my/noema-new-id \"block\")`}$0",
    }, { newId: () => "0198fbac-0780-7c99-85e6-333333333333" });
    expect(expanded.text).toBe("{#0198fbac-0780-7c99-85e6-333333333333}");
    expect(snippetBrowserCompatibility("`(my/noema-new-id \"page\")`").compatible).toBe(true);
    expect(snippetBrowserCompatibility("`(shell-command \"uuidgen\")`").compatible).toBe(false);
  });

  test("local usage affects only equal match tiers and can be cleared", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const usage = new SnippetUsageStore(storage);
    const alpha = { id: "a", key: "alpha", mode: "tex-mode", body: "a" };
    const alpine = { id: "b", key: "alpine", mode: "tex-mode", body: "b" };
    usage.record(alpine, 1_000);
    expect(matchingSnippetsForPrefix([alpha, alpine], "al", { usage, now: 1_000 })[0]).toBe(alpine);
    expect(matchingSnippetsForPrefix([alpha, alpine], "alpha", { usage, now: 1_000 })[0]).toBe(alpha);
    usage.clear();
    expect(usage.get(alpine)).toBeUndefined();
  });

  test("expands the emacs-migrated `set` snippet body with a plain tabstop between braces", () => {
    // ~/.config/emacs/snippets/tex-mode/set — body is exactly `\{ $1 \}$2`.
    const expanded = expandSnippetBody({ key: "set", name: "Set", mode: "tex-mode", body: "\\{ $1 \\}$2" });

    expect(expanded.text).toBe("\\{  \\}");
    const field1 = expanded.tabstops.find((stop) => stop.index === 1);
    const field2 = expanded.tabstops.find((stop) => stop.index === 2);
    expect(field1).toBeTruthy();
    expect(field2).toBeTruthy();
    expect(field1 && expanded.text.slice(0, field1.from)).toBe("\\{ ");
    expect(field1 && expanded.text.slice(field1.to)).toBe(" \\}");
  });

  test("`set` snippet expands with a tabstop between braces inside inline math", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount);
    try {
      editor.setMarkdown("\\(set\\)");
      editor.setSelection(2 + "set".length);
      const session = new SnippetSession(editor);
      expect(session.insert({ key: "set", name: "Set", mode: "tex-mode", body: "\\{ $1 \\}$2" }, "set".length)).toBe(true);

      expect(editor.getMarkdown()).toBe("\\(\\{  \\}\\)");
      const selection = editor.getSelection();
      expect(selection.from).toBe(selection.to);
      expect(editor.textBetween(selection.from - 3, selection.from)).toBe("\\{ ");
      expect(editor.textBetween(selection.from, selection.from + 3)).toBe(" \\}");

      expect(session.next()).toBe(true);
      const field2 = editor.getSelection();
      expect(field2.from).toBe(field2.to);
      expect(editor.textBetween(field2.from, field2.from + 2)).toBe("\\)");
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("nested placeholders remain available when the outer field is unchanged", () => {
    const editor = new TextEditor();
    const session = new SnippetSession(editor.asEditor());
    session.insert({ key: "draw", name: "Draw", mode: "tex-mode", body: "\\draw${1:[${2:thick}]} (${3:A});$0" });

    expect(editor.textBetween(editor.selection.from, editor.selection.to)).toBe("[thick]");
    expect(session.next()).toBe(true);
    expect(editor.textBetween(editor.selection.from, editor.selection.to)).toBe("thick");
  });

  test("CM6 maps active fields through external edits before the snippet", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount, { initialContent: "prefix " });
    try {
      editor.setSelection(editor.getMarkdownLength());
      const session = new SnippetSession(editor);
      expect(session.insert({ key: "frac", mode: "tex-mode", body: "\\frac{${1:a}}{${2:b}}$0" })).toBe(true);
      editor.view.dispatch({ changes: { from: 0, insert: "long " } });
      expect(session.active()).toBe(true);
      expect(session.next()).toBe(true);
      const selection = editor.getSelection();
      expect(editor.textBetween(selection.from, selection.to)).toBe("b");
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("CM6 immediately invalidates a session when selection leaves the active field", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount);
    try {
      const session = new SnippetSession(editor);
      session.insert({ key: "frac", mode: "tex-mode", body: "\\frac{${1:a}}{${2:b}}$0" });
      editor.setSelection(editor.getMarkdownLength());
      expect(session.active()).toBe(false);
      expect(session.next()).toBe(false);
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("field tracking survives the whole-state reset used when opening a note", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount);
    try {
      // Noema creates the long-lived session before the first note open.
      const session = new SnippetSession(editor);
      editor.setMarkdown("\\(frac\\)", { history: "reset" });
      editor.setSelection("\\(frac".length);
      session.insert({ key: "frac", mode: "tex-mode", body: "\\frac{${1:a}}{${2:b}}$0" }, 4);

      // Reproduce normal typing: replace the selected default, then append one
      // character per transaction before invoking Cmd+].
      let field = editor.getSelection();
      editor.view.dispatch({ changes: { from: field.from, to: field.to, insert: "a" }, selection: { anchor: field.from + 1 } });
      for (const char of "sda") {
        field = editor.getSelection();
        editor.view.dispatch({ changes: { from: field.from, insert: char }, selection: { anchor: field.from + 1 } });
      }
      expect(editor.getMarkdown()).toBe("\\(\\frac{asda}{b}\\)");
      expect(session.active()).toBe(true);
      expect(session.next()).toBe(true);
      field = editor.getSelection();
      expect(editor.textBetween(field.from, field.to)).toBe("b");
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("snippet boundaries are handled without wrapping or falling through", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount);
    try {
      const session = new SnippetSession(editor);
      session.insert({ key: "pair", mode: "tex-mode", body: "${1:a}${2:b}$0" });
      const first = editor.getSelection();
      expect(session.previous()).toBe(true);
      expect(editor.getSelection()).toEqual(first);
      expect(session.next()).toBe(true);
      expect(session.next()).toBe(true);
      expect(session.next()).toBe(true);
      expect(session.active()).toBe(false);
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("replacing an outer nested placeholder skips stale inner fields", () => {
    const editor = new TextEditor();
    const session = new SnippetSession(editor.asEditor());
    session.insert({ key: "draw", name: "Draw", mode: "tex-mode", body: "\\draw${1:[${2:thick}]} (${3:A});$0" });

    editor.replaceRange(editor.selection.from, editor.selection.to, "[dashed]", "end");
    expect(session.next()).toBe(true);
    expect(editor.textBetween(editor.selection.from, editor.selection.to)).toBe("A");
  });

  test("syncs mirrors without moving the active insertion point", () => {
    const editor = new TextEditor();
    const session = new SnippetSession(editor.asEditor());
    session.insert({ key: "pair", name: "Pair", mode: "markdown-mode", body: "${1:x} + ${1}$0" });

    editor.replaceRange(editor.selection.from, editor.selection.to, "abc", "end");
    expect(editor.selection).toEqual({ from: 3, to: 3 });

    expect(session.next()).toBe(true);
    expect(editor.text).toBe("abc + abc");
    expect(editor.selection).toEqual({ from: 9, to: 9 });
  });

  test("nested snippets finish child fields before returning to parent fields", () => {
    const editor = new TextEditor();
    const session = new SnippetSession(editor.asEditor());
    const frac = { key: "frac", name: "Fraction", mode: "tex-mode", body: "\\frac{${1:a}}{${2:b}}$0" };

    session.insert(frac);
    editor.replaceRange(editor.selection.from, editor.selection.to, "frac", "end");
    session.insert(frac, 4);

    expect(editor.text).toBe("\\frac{\\frac{a}{b}}{b}");
    expect(editor.textBetween(editor.selection.from, editor.selection.to)).toBe("a");

    editor.replaceRange(editor.selection.from, editor.selection.to, "x", "end");
    expect(session.next()).toBe(true);
    expect(editor.textBetween(editor.selection.from, editor.selection.to)).toBe("b");

    editor.replaceRange(editor.selection.from, editor.selection.to, "y", "end");
    expect(session.next()).toBe(true);
    expect(editor.textBetween(editor.selection.from, editor.selection.to)).toBe("");
    expect(editor.text).toBe("\\frac{\\frac{x}{y}}{b}");

    expect(session.next()).toBe(true);
    expect(editor.textBetween(editor.selection.from, editor.selection.to)).toBe("b");
  });

  test("plain child snippet without tabstops does not advance the parent snippet", () => {
    const editor = new TextEditor();
    const session = new SnippetSession(editor.asEditor());
    session.insert({ key: ";", name: "Inline math", mode: "markdown-mode", body: "\\(${1:x}\\) $0" });

    editor.replaceRange(editor.selection.from, editor.selection.to, "aaaa", "end");
    expect(session.insert({ key: "aaaa", name: "Alpha", mode: "tex-mode", body: "\\alpha" }, 4)).toBe(true);

    expect(editor.text).toBe("\\(\\alpha\\) ");
    expect(editor.selection).toEqual({ from: "\\(\\alpha".length, to: "\\(\\alpha".length });
    expect(session.next()).toBe(true);
    expect(editor.selection).toEqual({ from: "\\(\\alpha\\) ".length, to: "\\(\\alpha\\) ".length });
  });

  test("contenteditable snippet insertion deletes the trigger prefix before the caret", () => {
    const root = document.createElement("div");
    root.contentEditable = "true";
    root.textContent = "before frac after";
    document.body.appendChild(root);
    try {
      const textNode = root.firstChild;
      expect(textNode).toBeTruthy();
      const range = document.createRange();
      range.setStart(textNode!, "before frac".length);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      expect(insertExpandedSnippetIntoContentEditable(root, {
        key: "frac",
        name: "Fraction",
        mode: "tex-mode",
        body: "\\frac{${1:a}}{${2:b}}$0",
      }, 4)).toBe(true);

      expect(root.textContent).toBe("before \\frac{a}{b} after");
      const after = selection.getRangeAt(0);
      expect(after.startContainer.textContent).toBe("\\frac{a}{b}");
      expect(after.startOffset).toBe("\\frac{a}{b}".length);
    } finally {
      root.remove();
    }
  });

  test("org-env snippets use normal source tabstops", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount);
    try {
      const session = new SnippetSession(editor);
      expect(session.insert({
        key: "thm",
        name: "Theorem block",
        mode: "markdown-mode",
        body: "#+begin theorem ${1:name}\n${2:Statement.}\n#+end theorem\n$0",
      })).toBe(true);

      // Correct markdown structure inserted
      expect(editor.getMarkdown().trimEnd()).toBe(
        "#+begin theorem name\nStatement.\n#+end theorem",
      );

      let selection = editor.getSelection();
      expect(editor.textBetween(selection.from, selection.to)).toBe("name");

      // Advance to content tabstop (index 2).
      expect(session.next()).toBe(true);
      selection = editor.getSelection();
      expect(editor.textBetween(selection.from, selection.to)).toBe("Statement.");

      // Advance to exit stop ($0) — cursor lands immediately after the block.
      expect(session.next()).toBe(true);
      const exit = editor.getSelection();
      expect(exit.from).toBe(exit.to);
      const blockText = "#+begin theorem name\nStatement.\n#+end theorem\n";
      expect(exit.from).toBe(blockText.length);
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("fold snippet keeps markdown title and body tabstops", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount);
    try {
      const session = new SnippetSession(editor);
      expect(session.insert({
        key: "fold",
        name: "Fold block",
        mode: "markdown-mode",
        body: "#+begin fold ${1:**Details**}\n${2:Hidden content.}\n#+end fold\n$0",
      })).toBe(true);

      expect(editor.getMarkdown().trimEnd()).toBe(
        "#+begin fold **Details**\nHidden content.\n#+end fold",
      );

      let selection = editor.getSelection();
      expect(editor.textBetween(selection.from, selection.to)).toBe("**Details**");

      expect(session.next()).toBe(true);
      selection = editor.getSelection();
      expect(editor.textBetween(selection.from, selection.to)).toBe("Hidden content.");

      expect(session.next()).toBe(true);
      const exit = editor.getSelection();
      expect(exit.from).toBe(exit.to);
      expect(exit.from).toBe("#+begin fold **Details**\nHidden content.\n#+end fold\n".length);
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("display-math snippet keeps the editable field inside the math body", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount);
    try {
      const session = new SnippetSession(editor);
      expect(session.insert({
        key: ":",
        name: "Display math",
        mode: "markdown-mode",
        body: "\\[\n$1\n\\]\n$0",
      })).toBe(true);

      let selection = editor.getSelection();
      expect(selection.from).toBe(selection.to);
      editor.replaceRange(selection.from, selection.to, "a", "end");
      expect(editor.getMarkdown()).toBe("\\[\na\n\\]");

      editor.insertText("\n");
      expect(editor.getMarkdown()).toBe("\\[\na\n\n\\]");
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("tex snippet confirmed inside display math keeps selection inside the formula", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
      const editor = createEditor(mount);
    try {
      editor.setMarkdown("\\[\nfrac\n\\]");
      editor.setSelection(editor.getMarkdown().indexOf("frac") + "frac".length);
      const session = new SnippetSession(editor);
      expect(session.insert({
        key: "frac",
        name: "Fraction",
        mode: "tex-mode",
        body: "\\frac{${1:a}}{${2:b}}$0",
      }, 4)).toBe(true);

      expect(editor.getMarkdown()).toBe("\\[\n\\frac{a}{b}\n\\]");
      const selection = editor.getSelection();
      expect(editor.textBetween(selection.from, selection.to)).toBe("a");
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("plain tex snippet confirmed inside inline math keeps cursor before the closing delimiter", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
      const editor = createEditor(mount);
    try {
      editor.setMarkdown("\\(aaaa\\)");
      editor.setSelection(2 + "aaaa".length);
      const session = new SnippetSession(editor);
      expect(session.insert({
        key: "aaaa",
        name: "Alpha",
        mode: "tex-mode",
        body: "\\alpha",
      }, 4)).toBe(true);

      expect(editor.getMarkdown()).toBe("\\(\\alpha\\)");
      const selection = editor.getSelection();
      expect(selection.from).toBe(selection.to);
      expect(editor.textBetween(selection.from - "\\alpha".length, selection.from)).toBe("\\alpha");
      expect(editor.textBetween(selection.from, selection.from + 2)).toBe("\\)");
    } finally {
      editor.destroy();
      mount.remove();
    }
  });
});
