import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import type { Editor } from "../src/lib.ts";
import { createEditor } from "../src/lib.ts";
import {
  expandSnippetBody,
  insertExpandedSnippetIntoContentEditable,
  mathLiveSnippetTemplate,
  matchingSnippetsForPrefix,
  matchingSnippetsAtTokenBoundary,
  SnippetSession,
  SnippetUsageStore,
  snippetBrowserCompatibility,
  snippetPopupKeyAction,
  snippetScore,
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
  test("exposes immutable pending tabstops for LiveTeX preview", () => {
    const text = new TextEditor();
    const session = new SnippetSession(text.asEditor());
    expect(session.insert({
      key: "preview",
      name: "Preview",
      mode: "tex-mode",
      body: "${1}+$1+${2}$0",
    })).toBe(true);

    let preview = session.previewState();
    expect(preview.stops.filter((stop) => stop.index === 1)).toHaveLength(2);
    expect(preview.stops.filter((stop) => stop.active).every((stop) => stop.index === 1)).toBe(true);
    expect(preview.stops.some((stop) => stop.mirror)).toBe(true);
    expect(preview.stops.some((stop) => stop.index === 0)).toBe(false);

    expect(session.next()).toBe(true);
    preview = session.previewState();
    expect(preview.stops.every((stop) => stop.index === 2)).toBe(true);
    expect(preview.stops[0]?.active).toBe(true);
  });

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

  test("shows one Noema completion when snippet and company providers expand identically", () => {
    const matches = matchingSnippetsForPrefix([
      { id: "personal:cup", key: "cup", mode: "tex-mode", body: "\\cup$0", provider: "personal" },
      { id: "document:cup", key: "\\cup", mode: "tex-mode", body: "\\cup$0", provider: "document" },
      { id: "latex-workshop:cup", key: "\\cup", mode: "tex-mode", body: "\\cup$0", provider: "latex-workshop" },
      { id: "personal:bigcup", key: "bigcup", mode: "tex-mode", body: "\\bigcup$0", provider: "personal" },
    ], "\\cup", { mode: "tex-mode", context: "math", limit: 10 });

    expect(matches.map((snippet) => snippet.id)).toEqual(["personal:cup", "personal:bigcup"]);
  });

  test("treats a plain pi snippet as an exact backslash-command completion", () => {
    const snippet = {
      key: "pi",
      mode: "tex-mode",
      body: "\\pi$0",
    };
    expect(snippetScore(snippet, "\\pi", false)).toBe(0);
    expect(matchingSnippetsForPrefix([snippet], "\\pi", {
      mode: "tex-mode",
      context: "math",
      allowFuzzy: false,
    })).toEqual([snippet]);

    const implies = {
      key: "implies",
      mode: "tex-mode",
      body: "\\implies$0",
    };
    const upperPi = {
      key: "Pi",
      mode: "tex-mode",
      body: "\\Pi$0",
    };
    expect(snippetScore(upperPi, "\\pi", false)).toBeGreaterThan(0);
    expect(matchingSnippetsForPrefix([upperPi, implies, snippet], "\\pi", {
      mode: "tex-mode",
      context: "math",
      allowFuzzy: true,
    }).map((candidate) => candidate.key)).toEqual(["pi", "Pi", "implies"]);
  });

  test("recovers a math snippet token after MathLive discards ignored source whitespace", () => {
    const snippets = [
      { key: "frac", name: "Fraction", mode: "tex-mode", body: "\\frac{$1}{$2}$0" },
      { key: "frame", name: "Frame", mode: "tex-mode", body: "\\boxed{$1}$0" },
    ];
    const resolved = matchingSnippetsAtTokenBoundary(snippets, "xfrac", {
      mode: "tex-mode",
      context: "math",
      allowFuzzy: false,
    });

    expect(resolved.prefix).toBe("frac");
    expect(resolved.deleteBefore).toBe(4);
    expect(resolved.matches.map((snippet) => snippet.key)).toEqual(["frac"]);
    expect(matchingSnippetsAtTokenBoundary(snippets, String.raw`\frac`, {
      mode: "tex-mode",
      context: "math",
    }).prefix).toBe(String.raw`\frac`);
  });

  test("snippet popup accepts Enter only for the math company surface", () => {
    expect(snippetPopupKeyAction({ key: "Enter" })).toEqual({ type: "consume" });
    expect(snippetPopupKeyAction({ key: "Enter", acceptEnter: true })).toEqual({ type: "accept" });
    expect(snippetPopupKeyAction({ key: "Tab" })).toEqual({ type: "accept" });
    expect(snippetPopupKeyAction({ key: "2", commandKey: true })).toEqual({ type: "select", index: 1 });
    expect(snippetPopupKeyAction({ key: "3", altKey: true })).toEqual({ type: "select", index: 2 });
    expect(snippetPopupKeyAction({ key: "0", commandKey: true })).toEqual({ type: "select", index: 9 });
    expect(snippetPopupKeyAction({ key: "4", commandKey: true, ctrlKey: true })).toEqual({ type: "select", index: 3 });
    expect(snippetPopupKeyAction({ key: "Tab", isComposing: true })).toEqual({ type: "none" });
    expect(snippetPopupKeyAction({ key: " " })).toEqual({ type: "none" });
    expect(snippetPopupKeyAction({ key: "ArrowDown", shiftKey: true })).toEqual({ type: "none" });
    expect(snippetPopupKeyAction({ key: "Home", shiftKey: true })).toEqual({ type: "none" });
  });

  test("preserves MathLive tabstop defaults, nesting, numeric order, and mirrors", () => {
    const template = mathLiveSnippetTemplate({
      key: "styled",
      mode: "tex-mode",
      body: "\\mathcal{${1:F}}+${3:${2:x}}+${1}$0",
    }, "test");

    expect(template.latex).toBe(
      String.raw`\mathcal{\placeholder[test-t1-o0]{F}}+\placeholder[test-t3-o0]{\placeholder[test-t2-o0]{x}}+\placeholder[test-t1-o1]{F}`,
    );
    expect(template.tabstops).toEqual([
      { index: 1, primaryId: "test-t1-o0", occurrenceIds: ["test-t1-o0", "test-t1-o1"] },
      { index: 2, primaryId: "test-t2-o0", occurrenceIds: ["test-t2-o0"] },
      { index: 3, primaryId: "test-t3-o0", occurrenceIds: ["test-t3-o0"] },
    ]);
  });

  test("uses a selected square for empty LiveTeX fields without changing source expansion", () => {
    const snippet = {
      key: "sqrt",
      mode: "tex-mode",
      body: "\\sqrt{$1}+${2:}$0",
    };

    expect(expandSnippetBody(snippet).text).toBe("\\sqrt{}+");
    const template = mathLiveSnippetTemplate(snippet, "empty-field");
    expect(template.latex).toBe(
      String.raw`\sqrt{\placeholder[empty-field-t1-o0]{□}}+\placeholder[empty-field-t2-o0]{□}`,
    );
    expect(template.latex).not.toContain("t0");
  });

  test("parses a tabstop immediately after a TeX row break", () => {
    const expanded = expandSnippetBody({
      key: "matrix",
      mode: "tex-mode",
      body: "\\begin{matrix}${1:a}\\\\${2:b}\\end{matrix}$0",
    });

    expect(expanded.text).toBe("\\begin{matrix}a\\\\b\\end{matrix}");
    expect(expanded.tabstops.filter((stop) => stop.index !== 0).map((stop) => stop.text))
      .toEqual(["a", "b"]);
  });

  test("keeps balanced TeX groups inside nested tabstop defaults", () => {
    const expanded = expandSnippetBody({
      key: "nested-default",
      mode: "tex-mode",
      body: "${1:\\frac{${2:a}}{${3:b}}}+$0",
    });

    expect(expanded.text).toBe("\\frac{a}{b}+");
    const outer = expanded.tabstops.find((stop) => stop.index === 1);
    expect(outer && expanded.text.slice(outer.from, outer.to)).toBe("\\frac{a}{b}");
    expect(expanded.tabstops.find((stop) => stop.index === 2)?.text).toBe("a");
    expect(expanded.tabstops.find((stop) => stop.index === 3)?.text).toBe("b");
  });

  test("marks only terminal TeX control-word snippets for a source separator", () => {
    expect(mathLiveSnippetTemplate({
      key: "otimes",
      mode: "tex-mode",
      body: "\\otimes$0",
    }, "operator-boundary").needsFinalSourceBoundary).toBe(true);
    expect(mathLiveSnippetTemplate({
      key: "frac",
      mode: "tex-mode",
      body: "\\frac{$1}{$2}$0",
    }, "group-boundary").needsFinalSourceBoundary).toBeUndefined();
    expect(mathLiveSnippetTemplate({
      key: "linebreak",
      mode: "tex-mode",
      body: "\\\\$0",
    }, "control-symbol-boundary").needsFinalSourceBoundary).toBeUndefined();
    expect(mathLiveSnippetTemplate({
      key: "prompt-after-command",
      mode: "tex-mode",
      body: "\\pi${1:x}$0",
    }, "prompt-boundary").needsFinalSourceBoundary).toBeUndefined();
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

  test("suspends an outer source snippet while LiveTeX edits its active field", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount);
    try {
      const session = new SnippetSession(editor);
      expect(session.insert({
        key: ";",
        mode: "markdown-mode",
        body: "\\(${1:x}\\) $0",
      })).toBe(true);
      expect(editor.textBetween(editor.getSelection().from, editor.getSelection().to)).toBe("x");

      expect(session.suspend()).toBe(true);
      expect(session.isSuspended()).toBe(true);
      expect(session.canMove(true)).toBe(false);
      expect(session.canMove(false)).toBe(true);

      const field = editor.getSelection();
      const latex = String.raw`\frac{a}{b}`;
      editor.view.dispatch({
        changes: { from: field.from, to: field.to, insert: latex },
        selection: { anchor: editor.getMarkdownLength() - (field.to - field.from) + latex.length },
      });
      expect(session.active()).toBe(true);

      expect(session.resumeAndMove(false)).toBe(true);
      expect(session.isSuspended()).toBe(false);
      expect(editor.getSelection()).toEqual({
        from: editor.getMarkdownLength(),
        to: editor.getMarkdownLength(),
      });
      expect(session.active()).toBe(true);
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

  test("inline-math shortcut reveals empty formula source without an x placeholder", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount);
    try {
      const session = new SnippetSession(editor);
      expect(session.insert({
        key: ";",
        name: "Inline math",
        mode: "markdown-mode",
        body: "\\($1\\) $0",
      })).toBe(true);

      expect(editor.getMarkdown()).toBe("\\(\\) ");
      expect(editor.getSelection()).toEqual({ from: 2, to: 2 });
      expect(mount.querySelector(".cm-math-inline-editor")).toBeNull();
      expect(mount.querySelector(".cm-math-inline")).toBeNull();
      expect(mount.textContent).toContain("\\(\\)");
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
