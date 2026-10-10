/**
 * Toggle semantics for inline and block formats, list continuation and fence
 * closing — the behaviours MarkText, HyperMD (files.md) and Tiptap (Marker)
 * share and Noema's plain wrap/prefix commands lacked.
 */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { EditorSelection } from "@codemirror/state";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import { runEditorDelete, runEditorEnter } from "../../src/cm6/input-commands.ts";
import { indentMarkdownBlock } from "../../src/cm6/commands/index.ts";
import { activeInlineFormats, inlineFormatsAvailable } from "../../src/cm6/inline-format.ts";
import type { Editor } from "../../src/editor-api.ts";

const editors: Editor[] = [];

function open(doc: string, from = 0, to = from): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: doc });
  editor.setSelection(from, to);
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

describe("inline format toggles", () => {
  it("removes bold when the selection is its content", () => {
    const ed = open("**hello** world", 2, 7);
    expect(ed.runCommand("bold")).toBe(true);
    expect(ed.getMarkdown()).toBe("hello world");
    expect(ed.getMarkdownSelection()).toEqual({ from: 0, to: 5 });
  });

  it("removes bold when the selection includes the markers", () => {
    const ed = open("**hello** world", 0, 9);
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("hello world");
    expect(ed.getMarkdownSelection()).toEqual({ from: 0, to: 5 });
  });

  it("removes bold around a bare caret inside it", () => {
    const ed = open("say **hello** now", 8);
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("say hello now");
    expect(ed.getMarkdownSelection()).toEqual({ from: 6, to: 6 });
  });

  it("re-applying bold round-trips", () => {
    const ed = open("hello world", 0, 5);
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("**hello** world");
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("hello world");
    expect(ed.getMarkdownSelection()).toEqual({ from: 0, to: 5 });
  });

  it("keeps selection-edge whitespace outside the markers", () => {
    const ed = open("say hello world", 3, 10);
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("say **hello** world");
    expect(ed.getMarkdownSelection()).toEqual({ from: 6, to: 11 });
  });

  it("merges partly-overlapping spans instead of nesting markers", () => {
    const ed = open("a **b c** d", 0, 6);
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("**a b c** d");
  });

  it("absorbs spans fully inside the selection", () => {
    const ed = open("a **b** c", 0, 9);
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("**a b c**");
  });

  it("toggles bold inside bold-italic without touching the italic", () => {
    const ed = open("***word***", 5);
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("*word*");
  });

  it("wraps a multi-line selection line by line after block prefixes", () => {
    const ed = open("- one\n- two", 0, 11);
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("- **one**\n- **two**");
    expect(activeInlineFormats(ed.view.state).has("bold")).toBe(true);
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("- one\n- two");
    expect(activeInlineFormats(ed.view.state).has("bold")).toBe(false);
  });

  it("pressing bold twice over a soft-wrapped paragraph restores the text", () => {
    const ed = open("first\nsecond", 0, 12);
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("**first\nsecond**");
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("first\nsecond");
  });

  it.each([
    ["italic", "*first\nsecond*"],
    ["strike", "~~first\nsecond~~"],
    ["code", "`first\nsecond`"],
  ] as const)("%s spans one soft-wrapped paragraph and toggles off", (kind, formatted) => {
    const ed = open("first\nsecond", 0, 12);
    expect(ed.runCommand(kind)).toBe(true);
    expect(ed.getMarkdown()).toBe(formatted);
    expect(ed.runCommand(kind)).toBe(true);
    expect(ed.getMarkdown()).toBe("first\nsecond");
  });

  it("adds formatting to an unformatted line without stripping a formatted neighbor", () => {
    const ed = open("- **one**\n- two", 0, 15);
    expect(activeInlineFormats(ed.view.state).has("bold")).toBe(false);
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("- **one**\n- **two**");
  });

  it.each([
    ["before\n\n```js\nx\n```\n\nafter", "**before**\n\n```js\nx\n```\n\n**after**"],
    ["before\n\n| a | b |\n| --- | --- |\n| x | y |\n\nafter", "**before**\n\n| **a** | **b** |\n| --- | --- |\n| **x** | **y** |\n\n**after**"],
    ["before\n\n---\n\nafter", "**before**\n\n---\n\n**after**"],
  ])("formats text across structural blocks without rewriting their syntax", (doc, formatted) => {
    const ed = open(doc, 0, doc.length);
    expect(inlineFormatsAvailable(ed.view.state)).toBe(true);
    expect(ed.runCommand("bold")).toBe(true);
    expect(ed.getMarkdown()).toBe(formatted);
    expect(activeInlineFormats(ed.view.state).has("bold")).toBe(true);
    expect(ed.runCommand("bold")).toBe(true);
    expect(ed.getMarkdown()).toBe(doc);
  });

  it("allows formatting text inside one table cell", () => {
    const doc = "| a | b |\n| --- | --- |\n| cell | value |";
    const from = doc.indexOf("cell");
    const ed = open(doc, from, from + 4);
    expect(inlineFormatsAvailable(ed.view.state)).toBe(true);
    expect(ed.runCommand("bold")).toBe(true);
    expect(ed.getMarkdown()).toBe(doc.replace("cell", "**cell**"));
  });

  it("keeps a backward mixed-block selection and already-formatted text", () => {
    const doc = "**before**\n\n```js\n**literal**\n```\n\nafter";
    const ed = open(doc);
    ed.view.dispatch({ selection: EditorSelection.range(doc.length, 0) });
    expect(ed.runCommand("bold")).toBe(true);
    expect(ed.getMarkdown()).toBe("**before**\n\n```js\n**literal**\n```\n\n**after**");
    expect(ed.view.state.selection.main.anchor).toBeGreaterThan(ed.view.state.selection.main.head);
    expect(ed.runCommand("bold")).toBe(true);
    expect(ed.getMarkdown()).toBe("before\n\n```js\n**literal**\n```\n\nafter");
  });

  it("toggles highlight, strike, sup and sub", () => {
    const ed = open("==mark== ~~gone~~ x^2^ H~2~O", 3);
    ed.runCommand("highlight");
    expect(ed.getMarkdown()).toBe("mark ~~gone~~ x^2^ H~2~O");
    ed.setSelection(8, 8);
    ed.runCommand("strike");
    expect(ed.getMarkdown()).toBe("mark gone x^2^ H~2~O");
    ed.setSelection(12, 12);
    ed.runCommand("superscript");
    expect(ed.getMarkdown()).toBe("mark gone x2 H~2~O");
    ed.setSelection(15, 15);
    ed.runCommand("subscript");
    expect(ed.getMarkdown()).toBe("mark gone x2 H2O");
  });

  it("inline code picks a fence longer than any backtick run inside", () => {
    const ed = open("use a`b here", 4, 7);
    ed.runCommand("code");
    expect(ed.getMarkdown()).toBe("use ``a`b`` here");
    ed.setSelection(7, 7);
    ed.runCommand("code");
    expect(ed.getMarkdown()).toBe("use a`b here");
  });

  it("formats every selection range", () => {
    const ed = open("one two", 0);
    ed.view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]) });
    ed.runCommand("italic");
    expect(ed.getMarkdown()).toBe("*one* *two*");
  });

  it("does not insert emphasis markers inside a fenced code block", () => {
    const ed = open("```\ncode\n```", 6);
    expect(ed.runCommand("bold")).toBe(false);
    expect(ed.getMarkdown()).toBe("```\ncode\n```");
  });

  it("is one undo step", () => {
    const ed = open("**hello** world", 2, 7);
    ed.runCommand("bold");
    ed.undo();
    expect(ed.getMarkdown()).toBe("**hello** world");
  });

  it("clear-format removes every format the selection touches", () => {
    const ed = open("a **b** *c* `d` ==e== f", 0, 23);
    expect(ed.runCommand("clear-format")).toBe(true);
    expect(ed.getMarkdown()).toBe("a b c d e f");
  });
});

describe("block format toggles", () => {
  it("heading of the same level turns back into text", () => {
    const ed = open("# Title", 3);
    ed.runCommand("heading-1");
    expect(ed.getMarkdown()).toBe("Title");
    expect(ed.getMarkdownSelection()).toEqual({ from: 1, to: 1 });
  });

  it("heading keeps the caret on the same text", () => {
    const ed = open("Title", 2);
    ed.runCommand("heading-2");
    expect(ed.getMarkdown()).toBe("## Title");
    expect(ed.getMarkdownSelection()).toEqual({ from: 5, to: 5 });
  });

  it("blockquote toggles every selected line", () => {
    const ed = open("one\n\ntwo", 0, 8);
    ed.runCommand("blockquote");
    expect(ed.getMarkdown()).toBe("> one\n>\n> two");
    ed.setSelection(0, ed.getMarkdown().length);
    ed.runCommand("blockquote");
    expect(ed.getMarkdown()).toBe("one\n\ntwo");
  });

  it("lists convert every selected line and toggle off", () => {
    const ed = open("a\nb\nc", 0, 5);
    ed.runCommand("ordered-list");
    expect(ed.getMarkdown()).toBe("1. a\n2. b\n3. c");
    ed.setSelection(0, ed.getMarkdown().length);
    ed.runCommand("bullet-list");
    expect(ed.getMarkdown()).toBe("- a\n- b\n- c");
    ed.setSelection(0, ed.getMarkdown().length);
    ed.runCommand("bullet-list");
    expect(ed.getMarkdown()).toBe("a\nb\nc");
  });

  it("task conversion keeps an existing checked state and indentation", () => {
    const ed = open("  - [x] done\n  - [ ] todo", 0, 25);
    ed.runCommand("bullet-list");
    expect(ed.getMarkdown()).toBe("  - done\n  - todo");
    const tasks = open("  * [x] done", 0, 12);
    tasks.runCommand("ordered-list");
    expect(tasks.getMarkdown()).toBe("  1. done");
  });

  it("a list item becomes a task without losing its bullet", () => {
    const ed = open("* item", 3);
    ed.runCommand("task-list");
    expect(ed.getMarkdown()).toBe("* [ ] item");
  });
});

// Found by running every command at random selections with one invariant:
// a command is one undo step and never throws.
describe("command invariants", () => {
  it("making a list ordered, with the renumbering it causes, is one undo step", () => {
    const doc = "- a\n- b\n1. one\n2. two";
    const ed = open(doc, 1);
    expect(ed.runCommand("ordered-list")).toBe(true);
    expect(ed.getMarkdown()).not.toBe(doc);
    ed.undo();
    expect(ed.getMarkdown()).toBe(doc);
  });

  it("continuing an ordered list in the middle is one undo step", () => {
    const doc = "1. one\n2. two\n3. three";
    const ed = open(doc, 6);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("1. one\n2. \n3. two\n4. three");
    ed.undo();
    expect(ed.getMarkdown()).toBe(doc);
  });

  it("indents a selection that runs past the end of its list", () => {
    const doc = "- a\n  - b\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\ntext";
    const ed = open(doc, 6, doc.length - 2);
    expect(() => indentMarkdownBlock(ed.view, 1)).not.toThrow();
    expect(() => indentMarkdownBlock(ed.view, -1)).not.toThrow();
    expect(ed.getMarkdown()).toContain("| x | y |");
  });

  it("renders an environment block typed in either opener spelling", () => {
    for (const [begin, end] of [["#+begin theorem T", "#+end theorem"], ["#+ begin theorem T", "#+ end theorem"]]) {
      const ed = open("intro\n\nplain\n\noutro", 0);
      ed.view.dispatch({ changes: { from: 7, to: 12, insert: `${begin}\nbody\n${end}` } });
      expect(ed.view.dom.querySelectorAll(".cm-org-env-heading-widget")).toHaveLength(1);
      expect(ed.view.dom.querySelectorAll(".cm-org-env-body-line")).toHaveLength(1);
      // Removing the closer dissolves the block again.
      const doc = ed.getMarkdown();
      ed.view.dispatch({ changes: { from: doc.indexOf(end), to: doc.indexOf(end) + end.length, insert: "" } });
      expect(ed.view.dom.querySelectorAll(".cm-org-env-heading-widget")).toHaveLength(0);
    }
  });

  it("opens documents whose image or tag is broken across lines", () => {
    for (const doc of ["intro\n\n![alt\ntext](a.png)\n\nend", "[a](<u\nv>) and <span\nclass=\"x\">y</span>", "| a |\n| - |\n| ![i\n](x.png) |"]) {
      const ed = open(doc, 0);
      ed.setSelection(doc.length, doc.length);
      ed.setSelection(0, 0);
      expect(ed.getMarkdown()).toBe(doc);
    }
  });
});

describe("code block toggle", () => {
  it("fences the selected lines in place instead of copying them", () => {
    const ed = open("intro\nline one\nline two\noutro", 9, 20);
    expect(ed.runCommand("code-block", "ts")).toBe(true);
    expect(ed.getMarkdown()).toBe("intro\n```ts\nline one\nline two\n```\noutro");
    const selection = ed.getSelection();
    expect(ed.getMarkdown().slice(selection.from, selection.to)).toBe("line one\nline two");
    ed.undo();
    expect(ed.getMarkdown()).toBe("intro\nline one\nline two\noutro");
  });

  it("removes the fence around the caret and keeps the code", () => {
    const ed = open("a\n\n```js\nconst x = 1;\nx;\n```\n\nb", 12);
    ed.runCommand("code-block");
    expect(ed.getMarkdown()).toBe("a\n\nconst x = 1;\nx;\n\nb");
    const selection = ed.getSelection();
    expect(ed.getMarkdown().slice(selection.from, selection.to)).toBe("const x = 1;\nx;");
  });

  it("uses a fence longer than any backtick run it wraps", () => {
    const doc = "show:\n```\ninner\n```";
    const ed = open("x", 0, 1);
    ed.setMarkdown(doc);
    ed.setSelection(0, 5);
    ed.runCommand("code-block");
    expect(ed.getMarkdown()).toBe("```\nshow:\n```\n```\ninner\n```");
    const literal = open("a ``` b\nc", 0, 9);
    literal.runCommand("code-block");
    expect(literal.getMarkdown()).toBe("````\na ``` b\nc\n````");
  });

  it("unwraps an empty and an unterminated fence without losing text", () => {
    const empty = open("```\n```", 1);
    empty.runCommand("code-block");
    expect(empty.getMarkdown()).toBe("");
    const open_ = open("```py\nprint(1)", 8);
    open_.runCommand("code-block");
    expect(open_.getMarkdown()).toBe("print(1)");
  });
});

describe("inline math toggle", () => {
  it("wraps the selection, keeping edge whitespace outside the delimiters", () => {
    const ed = open("let  x^2 + 1  hold", 4, 13);
    expect(ed.runCommand("inline-math")).toBe(true);
    expect(ed.getMarkdown()).toBe("let  \\(x^2 + 1\\)  hold");
    expect(ed.getSelection()).toMatchObject({ from: 7, to: 14 });
  });

  it("unwraps the formula around the caret and leaves its neighbours alone", () => {
    const ed = open("\\(a\\) and \\(b_1\\) end", 14);
    ed.runCommand("inline-math");
    expect(ed.getMarkdown()).toBe("\\(a\\) and b_1 end");
    expect(ed.getSelection()).toMatchObject({ from: 10, to: 13 });
  });

  it("gives a bare caret an empty pair to type into", () => {
    const ed = open("so  holds", 3);
    ed.runCommand("inline-math");
    expect(ed.getMarkdown()).toBe("so \\(\\) holds");
    expect(ed.getSelection()).toMatchObject({ from: 5, to: 5 });
  });

  it("refuses a selection across lines or inside code", () => {
    const lines = open("a\nb", 0, 3);
    expect(lines.runCommand("inline-math")).toBe(false);
    const code = open("`x + y`", 3);
    expect(code.runCommand("inline-math")).toBe(false);
    expect(code.getMarkdown()).toBe("`x + y`");
  });
});

describe("task checkbox toggle", () => {
  it("checks and unchecks the task under the caret, whatever its marker", () => {
    const ed = open("> 1. [ ] quoted task", 12);
    expect(ed.runCommand("toggle-task")).toBe(true);
    expect(ed.getMarkdown()).toBe("> 1. [x] quoted task");
    ed.runCommand("toggle-task");
    expect(ed.getMarkdown()).toBe("> 1. [ ] quoted task");
  });

  it("settles a mixed selection as all checked, then all unchecked, in one undo step each", () => {
    const doc = "- [x] done\n  * [ ] nested [link](a)\n- plain\n+ [X] upper";
    const ed = open(doc, 0, doc.length);
    ed.runCommand("toggle-task");
    expect(ed.getMarkdown()).toBe("- [x] done\n  * [x] nested [link](a)\n- plain\n+ [X] upper");
    ed.runCommand("toggle-task");
    expect(ed.getMarkdown()).toBe("- [ ] done\n  * [ ] nested [link](a)\n- plain\n+ [ ] upper");
    ed.undo();
    expect(ed.getMarkdown()).toBe("- [x] done\n  * [x] nested [link](a)\n- plain\n+ [X] upper");
  });

  it("leaves a line that is not a task alone", () => {
    const ed = open("- plain [ ] text", 4);
    expect(ed.runCommand("toggle-task")).toBe(false);
    expect(ed.getMarkdown()).toBe("- plain [ ] text");
  });
});

describe("list continuation", () => {
  it("renumbers ordered siblings after a structural insertion", () => {
    const ed = open("1. a\n2. b\n3. c");
    ed.view.dispatch({ changes: { from: 5, insert: "1. new\n" }, userEvent: "input.paste" });
    expect(ed.getMarkdown()).toBe("1. a\n2. new\n3. b\n4. c");
  });

  it("still repairs a changed ordered marker inside a quote", () => {
    const ed = open("> 1. a\n> 2. b");
    ed.view.dispatch({ changes: { from: 9, to: 10, insert: "8" }, userEvent: "input.type" });
    expect(ed.getMarkdown()).toBe("> 1. a\n> 2. b");
  });

  it("a new item after a checked task starts unchecked", () => {
    const ed = open("- [x] done", 10);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("- [x] done\n- [ ] ");
  });

  it("continues tasks under any bullet and ordered markers", () => {
    const star = open("* [ ] star", 10);
    runEditorEnter(star.view);
    expect(star.getMarkdown()).toBe("* [ ] star\n* [ ] ");
    const ordered = open("1. [X] first", 12);
    runEditorEnter(ordered.view);
    expect(ordered.getMarkdown()).toBe("1. [X] first\n2. [ ] ");
  });

  it("Enter on an empty task item of any marker exits the list", () => {
    const ed = open("* [ ] a\n* [ ] ", 14);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("* [ ] a\n\n");
  });
});

describe("fenced code Enter", () => {
  it("closes an opening fence and puts the caret inside", () => {
    const ed = open("```python", 9);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("```python\n\n```");
    expect(ed.getMarkdownSelection()).toEqual({ from: 10, to: 10 });
  });

  it("closes tilde fences and keeps indentation", () => {
    const ed = open("  ~~~", 5);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("  ~~~\n  \n  ~~~");
  });

  it("leaves a closing fence alone", () => {
    const ed = open("```js\nx\n```", 11);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("```js\nx\n```\n");
  });

  it("leaves an already-closed opener alone", () => {
    const ed = open("```js\n```", 5);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("```js\n\n```");
    expect(ed.getMarkdownSelection()).toEqual({ from: 6, to: 6 });
  });
});

describe("table quick create", () => {
  it("Enter after a lone header row adds the delimiter and a body row", () => {
    const ed = open("| a | b |", 9);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("| a   | b   |\n| --- | --- |\n|     |     |");
    expect(ed.getMarkdownSelection()).toEqual({ from: 30, to: 30 });
  });

  it("a single pipe cell is not mistaken for a table", () => {
    const ed = open("| note |", 8);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("| note |\n");
  });

  it("Tab on pipes without a delimiter row indents instead of reformatting", async () => {
    const { runEditorTab } = await import("../../src/cm6/input-commands.ts");
    const ed = open("| a | b |", 3);
    runEditorTab(ed.view);
    expect(ed.getMarkdown().trimStart()).toBe("| a | b |");
  });
});

describe("heading promote / demote", () => {
  it("promotes text to h6 and stops at h1", () => {
    const ed = open("Title", 2);
    ed.runCommand("heading-promote");
    expect(ed.getMarkdown()).toBe("###### Title");
    ed.setMarkdown("## Title");
    ed.setSelection(4, 4);
    ed.runCommand("heading-promote");
    expect(ed.getMarkdown()).toBe("# Title");
    expect(ed.runCommand("heading-promote")).toBe(false);
  });

  it("demotes h6 back to text and leaves text alone", () => {
    const ed = open("###### Title", 8);
    ed.runCommand("heading-demote");
    expect(ed.getMarkdown()).toBe("Title");
    expect(ed.runCommand("heading-demote")).toBe(false);
  });

  it("is offered by quick insert", () => {
    const ed = open("# Title", 3);
    const ids = ed.getQuickInsertItems("heading").map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["heading-promote", "heading-demote"]));
  });
});

describe("details found by comparing with MarkText, files.md and Marker", () => {
  it("headings change inside quotes and list items instead of breaking them", () => {
    const quote = open("> # T", 5);
    quote.runCommand("heading-1");
    expect(quote.getMarkdown()).toBe("> T");
    const item = open("- item", 4);
    item.runCommand("heading-2");
    expect(item.getMarkdown()).toBe("- ## item");
    item.runCommand("heading-promote");
    expect(item.getMarkdown()).toBe("- # item");
  });

  it("a list command inside a list converts the whole list", () => {
    const ed = open("- a\n- b\n- c", 4, 7);
    ed.runCommand("ordered-list");
    expect(ed.getMarkdown()).toBe("1. a\n2. b\n3. c");
    ed.setSelection(6, 6);
    ed.runCommand("ordered-list");
    expect(ed.getMarkdown()).toBe("a\nb\nc");
  });

  it("list conversion crosses nested items and loose blank lines but stops at another list", () => {
    const ed = open("- a\n  - x\n\n- b\n\n1. other", 0);
    ed.runCommand("task-list");
    expect(ed.getMarkdown()).toBe("- [ ] a\n  - x\n\n- [ ] b\n\n1. other");
  });

  it("a heading keeps its marker when it becomes a list item", () => {
    const ed = open("# Title", 3);
    ed.runCommand("bullet-list");
    expect(ed.getMarkdown()).toBe("- # Title");
  });

  it("Backspace after a task box removes the box before the list marker", () => {
    const ed = open("- [ ] task", 6);
    runEditorDelete(ed.view, "backward");
    expect(ed.getMarkdown()).toBe("- task");
  });

  it("closes fences opened inside list items and quotes with their prefixes", () => {
    const item = open("- ```js", 7);
    runEditorEnter(item.view);
    expect(item.getMarkdown()).toBe("- ```js\n  \n  ```");
    const quote = open("> ```js", 7);
    runEditorEnter(quote.view);
    expect(quote.getMarkdown()).toBe("> ```js\n> \n> ```");
  });

  it("a format never splits a link or code span", () => {
    const link = open("see [docs](u) now", 0, 7);
    link.runCommand("bold");
    expect(link.getMarkdown()).toBe("**see [docs](u)** now");
    const code = open("a `b c` d", 0, 5);
    code.runCommand("italic");
    expect(code.getMarkdown()).toBe("*a `b c`* d");
  });

  it("the link command toggles and uses the word at the caret", () => {
    const word = open("word", 2);
    word.runCommand("link");
    expect(word.getMarkdown()).toBe("[word](https://)");
    const linked = open("see [docs](u) now", 7);
    linked.runCommand("link");
    expect(linked.getMarkdown()).toBe("see docs now");
    expect(linked.getMarkdownSelection()).toEqual({ from: 6, to: 6 });
    const url = open("https://x.y", 0, 11);
    url.runCommand("link");
    expect(url.getMarkdown()).toBe("[https://x.y](https://x.y)");
    expect(url.getMarkdownSelection()).toEqual({ from: 1, to: 12 });
    const image = open("![alt](i.png)", 3);
    expect(image.runCommand("link")).toBe(false);
  });

  it("links whole inline objects and flattens old links instead of nesting them", () => {
    const code = open("use `code` now", 0, 7);
    code.runCommand("link");
    expect(code.getMarkdown()).toBe("[use `code`](https://) now");

    const linked = open("see [docs](u) now", 0, 7);
    linked.runCommand("link");
    expect(linked.getMarkdown()).toBe("[see docs](https://) now");

    const image = open("see ![cat](c.png) now", 0, 7);
    image.runCommand("link");
    expect(image.getMarkdown()).toBe("[see ![cat](c.png)](https://) now");
  });

  it("keeps inline objects whole at both ends of a multiline format selection", () => {
    const doc = "a [docs](u)\nthen `code` here";
    const ed = open(doc, doc.indexOf("docs") + 1, doc.indexOf("code") + 2);
    ed.runCommand("bold");
    expect(ed.getMarkdown()).toBe("a **[docs](u)\nthen `code`** here");
  });

  it("relinks an existing link and leaves code and separate blocks intact", () => {
    const linked = open("see [docs](old) now", 7);
    linked.runCommand("link", "https://new.example");
    expect(linked.getMarkdown()).toBe("see [docs](https://new.example) now");

    const code = open("use `code` now", 6);
    expect(code.runCommand("link")).toBe(false);
    expect(code.getMarkdown()).toBe("use `code` now");

    const lines = open("first\n\nsecond", 0, 13);
    expect(lines.runCommand("link")).toBe(false);
    expect(lines.getMarkdown()).toBe("first\n\nsecond");
  });

  it("recognizes formats and links across a soft line break", () => {
    const bold = open("**first\nsecond**", 10);
    expect(bold.runCommand("bold")).toBe(true);
    expect(bold.getMarkdown()).toBe("first\nsecond");
    expect(bold.getMarkdownSelection()).toEqual({ from: 8, to: 8 });

    const code = open("use `first\nsecond` now", 13);
    expect(code.runCommand("bold")).toBe(false);
    expect(code.runCommand("link")).toBe(false);
    expect(code.runCommand("code")).toBe(true);
    expect(code.getMarkdown()).toBe("use first\nsecond now");

    const linked = open("see [first\nsecond](url) now", 12);
    expect(linked.runCommand("link")).toBe(true);
    expect(linked.getMarkdown()).toBe("see first\nsecond now");
  });

  it("links a soft-wrapped paragraph and relinks an existing soft-wrapped link", () => {
    const plain = open("first\nsecond", 0, 12);
    expect(plain.runCommand("link")).toBe(true);
    expect(plain.getMarkdown()).toBe("[first\nsecond](https://)");

    const linked = open("see [first\nsecond](old) now", 11);
    expect(linked.runCommand("link", "new")).toBe(true);
    expect(linked.getMarkdown()).toBe("see [first\nsecond](new) now");
  });

  it.each([
    ["# Title", "# [Title](https://)"],
    ["## Title ##", "## [Title](https://) ##"],
    ["Title\n=====", "[Title](https://)\n====="],
  ])("links heading content while preserving its markers", (doc, expected) => {
    const ed = open(doc, 0, doc.length);
    expect(ed.runCommand("link")).toBe(true);
    expect(ed.getMarkdown()).toBe(expected);
  });

  it("clears a format spanning a soft line break", () => {
    const ed = open("**first\nsecond**", 9);
    expect(ed.runCommand("clear-format")).toBe(true);
    expect(ed.getMarkdown()).toBe("first\nsecond");
  });

  it("keeps quoted and listed paragraphs intact across a soft break", () => {
    const quote = open("> **first\n> second**", 14);
    expect(quote.runCommand("bold")).toBe(true);
    expect(quote.getMarkdown()).toBe("> first\n> second");

    const item = open("- [first\n  second](url)", 14);
    expect(item.runCommand("link")).toBe(true);
    expect(item.getMarkdown()).toBe("- first\n  second");
  });

  it("turns an angle autolink into a single link", async () => {
    const ed = open("see <https://old.example> now", 6, 14);
    ed.runCommand("link", "https://new.example");
    expect(ed.getMarkdown()).toBe("see [https://old.example](https://new.example) now");
    const { renderMarkdownHTML } = await import("../../src/render-html.ts");
    expect(renderMarkdownHTML(ed.getMarkdown()).match(/<a\b/g)).toHaveLength(1);
  });
});

describe("format availability", () => {
  it("reports inline formats unavailable inside a code block", () => {
    const code = open("```\ncode\n```", 5, 7);
    expect(inlineFormatsAvailable(code.view.state)).toBe(false);
    const prose = open("text", 0, 4);
    expect(inlineFormatsAvailable(prose.view.state)).toBe(true);
  });

  it("does not insert literal bold markers at a caret inside inline code", async () => {
    const { inlineFormatAvailable } = await import("../../src/cm6/inline-format.ts");
    const ed = open("use `code` now", 6);
    expect(inlineFormatAvailable(ed.view.state, "bold")).toBe(false);
    expect(inlineFormatAvailable(ed.view.state, "code")).toBe(true);
    expect(ed.runCommand("bold")).toBe(false);
    expect(ed.getMarkdown()).toBe("use `code` now");
    expect(ed.runCommand("code")).toBe(true);
    expect(ed.getMarkdown()).toBe("use code now");
  });
});

describe("table cell navigation", () => {
  const table = "| a | b |\n| --- | --- |\n| one | two |\n|  |  |";

  it("Tab selects the next cell's text so typing replaces it", async () => {
    const { runEditorTab } = await import("../../src/cm6/input-commands.ts");
    const ed = open(table, table.indexOf("one") + 1);
    runEditorTab(ed.view);
    const { from, to } = ed.getMarkdownSelection();
    expect(ed.getMarkdown().slice(from, to)).toBe("two");
  });

  it("Enter selects the same column below, and an empty cell gets a caret", () => {
    const ed = open(table, table.indexOf("a") + 1);
    runEditorEnter(ed.view);
    let { from, to } = ed.getMarkdownSelection();
    expect(ed.getMarkdown().slice(from, to)).toBe("one");
    runEditorEnter(ed.view);
    ({ from, to } = ed.getMarkdownSelection());
    expect(from).toBe(to);
  });
});

describe("heading Enter and Backspace at the start of the text", () => {
  it("Enter opens a line above and keeps the heading", () => {
    const ed = open("# Title", 2);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("\n# Title");
    expect(ed.getMarkdownSelection()).toEqual({ from: 3, to: 3 });
    const quoted = open("> ## T", 5);
    runEditorEnter(quoted.view);
    expect(quoted.getMarkdown()).toBe(">\n> ## T");
  });

  it("Backspace turns the heading into a paragraph instead of leaving #Title", () => {
    const ed = open("## Title", 3);
    runEditorDelete(ed.view, "backward");
    expect(ed.getMarkdown()).toBe("Title");
  });
});

describe("Delete at a line end joins text, not markup", () => {
  it.each([
    ["para\n- item", 4, "paraitem"],
    ["para\n# H", 4, "paraH"],
    ["para\n> q", 4, "paraq"],
    ["- a\n- b", 3, "- ab"],
    ["- [ ] a\n- [x] b", 7, "- [ ] ab"],
    ["a\nb", 1, "ab"],
  ])("%j", (doc, at, expected) => {
    const ed = open(doc, at);
    runEditorDelete(ed.view, "forward");
    expect(ed.getMarkdown()).toBe(expected);
    expect(ed.getMarkdownSelection()).toEqual({ from: at, to: at });
  });

  it("leaves code fences and the lines inside code alone", () => {
    const fence = open("para\n```js\nx\n```", 4);
    runEditorDelete(fence.view, "forward");
    expect(fence.getMarkdown()).toBe("para\n```js\nx\n```");
    const code = open("```js\n- a\n- b\n```", 9);
    runEditorDelete(code.view, "forward");
    expect(code.getMarkdown()).toBe("```js\n- a- b\n```");
  });
});

describe("leaving a block that ends the note", () => {
  it.each([
    ["| a | b |\n| - | - |\n| 1 | 2 |"],
    ["```js\nx\n```"],
    ["\\[\nx\n\\]"],
    ["#+begin note\nx\n#+end note"],
    ["text\n\n---"],
  ])("ArrowDown on the last line of %j opens a line below", async (doc) => {
    const { openLineAfterTrailingBlock } = await import("../../src/cm6/input-commands.ts");
    const ed = open(doc, doc.length);
    expect(openLineAfterTrailingBlock(ed.view)).toBe(true);
    expect(ed.getMarkdown()).toBe(`${doc}\n`);
    expect(ed.getMarkdownSelection()).toEqual({ from: doc.length + 1, to: doc.length + 1 });
  });

  it("does nothing after an ordinary paragraph or before the last line", async () => {
    const { openLineAfterTrailingBlock } = await import("../../src/cm6/input-commands.ts");
    expect(openLineAfterTrailingBlock(open("plain text", 3).view)).toBe(false);
    expect(openLineAfterTrailingBlock(open("```js\nx\n```\n", 2).view)).toBe(false);
    expect(openLineAfterTrailingBlock(open("| a | b |", 9).view)).toBe(false);
    expect(openLineAfterTrailingBlock(open("```js", 5).view)).toBe(false);
    expect(openLineAfterTrailingBlock(open("#+end note", 10).view)).toBe(false);
    expect(openLineAfterTrailingBlock(open("$$", 2).view)).toBe(false);
    expect(openLineAfterTrailingBlock(open("| a | b |\n| --- | --- |\n| a long cell | b |", 28).view)).toBe(false);
  });
});
