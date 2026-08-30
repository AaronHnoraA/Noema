/**
 * Revealing a formula's source rewrites the line's layout, so it must never
 * happen while the pointer is down.
 *
 * Clicking a formula expands it to TeX source, which is a different width than
 * the rendered formula: the line rewraps and everything after it moves. When
 * the click that dismisses the formula collapsed it during `mousedown`, the
 * text slid out from under the pointer and CodeMirror carried on extending the
 * drag to whatever had moved under the cursor — a click became a long
 * accidental selection, and a deliberately precise click landed somewhere else.
 *
 * The gesture must complete against the layout the user was looking at.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../../src/editor-api.ts";
import { pointerSelectionEffect } from "../../src/cm6/extensions/visual/selection.ts";
import { formulaSourceRangeAtPosition } from "../../src/cm6/extensions/visual/widgets/math.ts";

const INLINE = "Thus \\(A_e\\) is alternating, and the sentence carries on well past it.\n";
// The formula occupies [5, 12); its body starts at 7.
const INLINE_BODY = 7;

const BLOCK = [
  "Before the display.",
  "",
  "\\[",
  "A_e = \\sum_x u(x)",
  "\\]",
  "",
  "After the display.",
  "",
].join("\n");

function mount(text: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: text });
  return {
    editor,
    view: editor.view,
    revealed: () => formulaSourceRangeAtPosition(editor.view, INLINE_BODY) !== null,
    revealedAt: (pos: number) => formulaSourceRangeAtPosition(editor.view, pos) !== null,
    mouseDown: () => editor.view.dispatch({ effects: pointerSelectionEffect.of(true) }),
    mouseUp: () => editor.view.dispatch({ effects: pointerSelectionEffect.of(false) }),
    done: () => { editor.destroy(); host.remove(); },
  };
}

describe("inline formula source and the pointer", () => {
  test("a caret moved out with no pointer down collapses the source at once", () => {
    const s = mount(INLINE);
    s.editor.setSelection(INLINE_BODY, INLINE_BODY);
    expect(s.revealed()).toBe(true);

    s.editor.setSelection(0, 0);
    expect(s.revealed()).toBe(false);
    s.done();
  });

  test("a click outside keeps the source until the button is released", () => {
    const s = mount(INLINE);
    s.editor.setSelection(INLINE_BODY, INLINE_BODY);
    expect(s.revealed()).toBe(true);

    // mousedown lands outside the formula: CodeMirror places the caret and
    // starts a drag. The layout must not move yet.
    s.mouseDown();
    s.editor.setSelection(40, 40);
    expect(s.revealed()).toBe(true);

    // Every further mouse move is another selection transaction.
    s.editor.setSelection(40, 52);
    s.editor.setSelection(40, 60);
    expect(s.revealed()).toBe(true);

    s.mouseUp();
    expect(s.revealed()).toBe(false);
    s.done();
  });

  test("a drag that ends back inside the formula leaves it revealed", () => {
    const s = mount(INLINE);
    s.editor.setSelection(INLINE_BODY, INLINE_BODY);
    s.mouseDown();
    s.editor.setSelection(40, 40);
    s.editor.setSelection(INLINE_BODY + 1, INLINE_BODY + 1);
    s.mouseUp();
    expect(s.revealed()).toBe(true);
    s.done();
  });

  test("edits made during the drag keep the held source range mapped", () => {
    const s = mount(INLINE);
    s.editor.setSelection(INLINE_BODY, INLINE_BODY);
    s.mouseDown();
    s.editor.setSelection(40, 40);
    s.view.dispatch({ changes: { from: 0, insert: "XY" } });
    expect(s.revealedAt(INLINE_BODY + 2)).toBe(true);
    s.mouseUp();
    expect(s.revealedAt(INLINE_BODY + 2)).toBe(false);
    s.done();
  });
});

describe("display formula source and the pointer", () => {
  test("a click outside keeps the display source until the button is released", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { initialContent: BLOCK });
    const body = BLOCK.indexOf("A_e = ");
    editor.setSelection(body, body);
    // Entering a display formula reveals its source from a microtask.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const revealed = () => formulaSourceRangeAtPosition(editor.view, body) !== null;
    expect(revealed()).toBe(true);

    editor.view.dispatch({ effects: pointerSelectionEffect.of(true) });
    editor.setSelection(0, 0);
    expect(revealed()).toBe(true);

    editor.view.dispatch({ effects: pointerSelectionEffect.of(false) });
    expect(revealed()).toBe(false);

    editor.destroy();
    host.remove();
  });

  test("a caret that lands in a display formula mid-drag opens it on release", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { initialContent: BLOCK });
    const body = BLOCK.indexOf("A_e = ");
    const revealed = () => formulaSourceRangeAtPosition(editor.view, body) !== null;

    editor.view.dispatch({ effects: pointerSelectionEffect.of(true) });
    editor.setSelection(body, body);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(revealed()).toBe(false);

    editor.view.dispatch({ effects: pointerSelectionEffect.of(false) });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(revealed()).toBe(true);

    editor.destroy();
    host.remove();
  });
});
