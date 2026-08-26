/**
 * Vim's key guard around controls embedded in the editor — a widget's text
 * field, a contenteditable cell, or an element that opts out of Vim entirely.
 *
 * The rule these pin: while the document is in Normal mode, no key may reach an
 * embedded control and change its text. Backspace and Delete are the awkward
 * case, because they are not printable and so slipped past the length check
 * that swallows ordinary letters.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite, type VimLiteMode } from "../aaronnote/vim-lite.ts";

function mount(mode: VimLiteMode = "normal") {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: "abc def" });
  const vim = createVimLite(editor, host, {});
  vim.setMode(mode);
  editor.setSelection(0, 0);
  vim.syncSelectionFromEditor();
  return { host, editor, vim, done: () => { vim.destroy(); editor.destroy(); host.remove(); } };
}

function send(vim: ReturnType<typeof createVimLite>, key: string, target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target, configurable: true });
  const handled = vim.handleKeyDown(event);
  return { handled, prevented: event.defaultPrevented };
}

function withInput(mode: VimLiteMode = "normal") {
  const s = mount(mode);
  const input = document.createElement("input");
  s.host.append(input);
  return { ...s, input };
}

describe("a plain input never loses text to Normal mode", () => {
  test("Backspace is swallowed instead of deleting a character", () => {
    const s = withInput();
    expect(send(s.vim, "Backspace", s.input).handled).toBe(true);
    s.done();
  });

  test("Delete is swallowed too", () => {
    const s = withInput();
    expect(send(s.vim, "Delete", s.input).handled).toBe(true);
    s.done();
  });

  test("an ordinary letter is swallowed", () => {
    const s = withInput();
    const result = send(s.vim, "x", s.input);
    expect(result.handled).toBe(true);
    expect(result.prevented).toBe(true);
    expect(s.vim.mode()).toBe("normal");
    s.done();
  });

  test("i and a open Insert so the field becomes typable", () => {
    const a = withInput();
    expect(send(a.vim, "i", a.input).handled).toBe(true);
    expect(a.vim.mode()).toBe("insert");
    a.done();
    const b = withInput();
    send(b.vim, "a", b.input);
    expect(b.vim.mode()).toBe("insert");
    b.done();
  });

  test("Insert mode hands every key back to the control", () => {
    const s = withInput("insert");
    expect(send(s.vim, "x", s.input).handled).toBe(false);
    expect(send(s.vim, "Backspace", s.input).handled).toBe(false);
    s.done();
  });

  test("arrows stay native so the caret still moves", () => {
    const s = withInput();
    expect(send(s.vim, "ArrowLeft", s.input).handled).toBe(false);
    expect(send(s.vim, "ArrowRight", s.input).handled).toBe(false);
    s.done();
  });

  test("a Cmd chord belongs to the control, not to Vim", () => {
    const s = withInput();
    expect(send(s.vim, "a", s.input, { metaKey: true }).handled).toBe(false);
    expect(send(s.vim, "c", s.input, { metaKey: true }).handled).toBe(false);
    s.done();
  });

  test("Escape returns the document to Normal mode", () => {
    const s = withInput("insert");
    expect(send(s.vim, "Escape", s.input).handled).toBe(true);
    expect(s.vim.mode()).toBe("normal");
    s.done();
  });
});

describe("a contenteditable gets Vim-style motion", () => {
  function withContentEditable() {
    const s = mount();
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "true");
    s.host.append(el);
    return { ...s, el };
  }

  test("h and j are consumed as motions", () => {
    const s = withContentEditable();
    expect(send(s.vim, "h", s.el).handled).toBe(true);
    expect(send(s.vim, "j", s.el).handled).toBe(true);
    s.done();
  });

  test("an unbound key is swallowed rather than typed into the cell", () => {
    const s = withContentEditable();
    const result = send(s.vim, "q", s.el);
    expect(result.handled).toBe(true);
    expect(result.prevented).toBe(true);
    s.done();
  });

  test("i opens Insert", () => {
    const s = withContentEditable();
    send(s.vim, "i", s.el);
    expect(s.vim.mode()).toBe("insert");
    s.done();
  });

  test("a Cmd chord is left to the cell", () => {
    const s = withContentEditable();
    expect(send(s.vim, "ArrowLeft", s.el, { metaKey: true }).handled).toBe(false);
    s.done();
  });
});

describe("the guards around the editor itself", () => {
  test("an element marked native opts out entirely, Escape included", () => {
    const s = mount();
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-aaronnote-vim", "native");
    const input = document.createElement("input");
    wrapper.append(input);
    s.host.append(wrapper);
    expect(send(s.vim, "x", input).handled).toBe(false);
    expect(send(s.vim, "Escape", input).handled).toBe(false);
    s.done();
  });

  test("a target outside the editor host is never touched", () => {
    const s = mount();
    const outside = document.createElement("div");
    document.body.append(outside);
    expect(send(s.vim, "x", outside).handled).toBe(false);
    expect(send(s.vim, "Escape", outside).handled).toBe(false);
    outside.remove();
    s.done();
  });

  test("the editor's own content is not treated as an embedded control", () => {
    const s = mount();
    const content = s.host.querySelector(".cm-content") as HTMLElement;
    expect(send(s.vim, "x", content).handled).toBe(true);
    expect(s.editor.getMarkdown()).toBe("bc def");
    s.done();
  });
});
