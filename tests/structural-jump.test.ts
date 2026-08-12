import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/lib.ts";
import {
  jumpStructuralDelimiter,
  jumpTexUnit,
  structuralJumpTarget,
  structuralPairs,
  texUnitBoundaries,
  texUnitJumpTarget,
} from "../src/cm6/structural-jump.ts";

describe("region-bounded structural jumps", () => {
  test("moves within the innermost math pair", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount, { initialContent: "\\(\\frac{a}{(b+c)}\\)" });
    try {
      const cursor = editor.getMarkdown().indexOf("b");
      editor.setSelection(cursor);
      const close = editor.getMarkdown().indexOf(")}") + 1;
      expect(structuralJumpTarget(editor.view, 1)).toBe(close);
      expect(jumpStructuralDelimiter(editor.view, 1)).toBe(true);
      expect(editor.getSelection().from).toBe(close);
      expect(structuralJumpTarget(editor.view, -1)).toBe(editor.getMarkdown().indexOf("(b") + 1);
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("does not cross the current Markdown block", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount, { initialContent: "plain paragraph\n\nnext (target)" });
    try {
      editor.setSelection(3);
      expect(structuralJumpTarget(editor.view, 1)).toBeNull();
      expect(jumpStructuralDelimiter(editor.view, 1)).toBe(false);
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("does not turn a closed TeX group into an implicit formula exit", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const markdown = String.raw`before \(\text{words}\) after`;
    const editor = createEditor(mount, { initialContent: markdown });
    try {
      const afterText = markdown.indexOf("}") + 1;
      editor.setSelection(afterText, undefined, { scrollIntoView: false });

      expect(structuralJumpTarget(editor.view, 1)).toBeNull();
      expect(jumpStructuralDelimiter(editor.view, 1)).toBe(false);
      expect(editor.getSelection().from).toBe(afterText);
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("clamps inside an inline formula with no bracket pair", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const markdown = String.raw`before \(x\) after`;
    const editor = createEditor(mount, { initialContent: markdown });
    try {
      const body = markdown.indexOf("x");
      editor.setSelection(body, undefined, { scrollIntoView: false });
      expect(structuralJumpTarget(editor.view, 1)).toBeNull();
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("ignores escaped brackets and inline-code pairs", () => {
    expect(structuralPairs("\\(escaped\\) `code(x)` [real]")).toEqual([{ open: 22, close: 27 }]);
  });

  test("treats TeX commands and identifiers as units without landing inside them", () => {
    const source = String.raw`\frac{alpha_1}{\text{two words}}+z`;
    const boundaries = texUnitBoundaries(source);
    expect(boundaries).toContain(String.raw`\frac`.length);
    expect(boundaries).not.toContain(2);
    expect(boundaries).not.toContain(4);
    const alphaFrom = source.indexOf("alpha");
    expect(boundaries).toContain(alphaFrom);
    expect(boundaries).toContain(alphaFrom + "alpha".length);
    expect(boundaries).not.toContain(alphaFrom + 2);
  });

  test("consumes a non-BMP escaped character without slicing the remaining source", () => {
    const source = "\\😀+x";
    expect(texUnitBoundaries(source)).toEqual([0, 3, 4, 5]);
  });

  test("adds Cmd-bracket TeX-unit navigation before delimiter fallback", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const markdown = String.raw`before \(\frac{alpha_1}{\text{two words}}+z\) after`;
    const editor = createEditor(mount, { initialContent: markdown });
    try {
      const commandFrom = markdown.indexOf(String.raw`\frac`);
      editor.setSelection(commandFrom + 2);
      expect(texUnitJumpTarget(editor.view, 1)).toBe(commandFrom + String.raw`\frac`.length);
      expect(jumpTexUnit(editor.view, 1)).toBe(true);
      expect(editor.getSelection().from).toBe(commandFrom + String.raw`\frac`.length);
      expect(texUnitJumpTarget(editor.view, -1)).toBe(commandFrom);

      const alphaFrom = markdown.indexOf("alpha");
      editor.setSelection(alphaFrom);
      expect(texUnitJumpTarget(editor.view, 1)).toBe(alphaFrom + "alpha".length);
    } finally {
      editor.destroy();
      mount.remove();
    }
  });
});
