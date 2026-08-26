import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";

import {
  applyMarkdownFormat,
  captureMarkdownFormat,
  getCommonFormatPainterSnapshot,
  resolveMarkdownFormatSelection,
  shouldKeepFormatPainterActive,
  shouldShowFormatPainterMessage,
} from "../src/format-painter.ts";
import { createEditor, type Editor } from "../src/editor-api.ts";

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.replaceChildren();
});

describe("format painter core", () => {
  it("keeps only styles and mark types shared by every segment", () => {
    expect(getCommonFormatPainterSnapshot([
      { types: ["strong", "em"], styles: { color: "red", fontSize: "16px" } },
      { types: ["strong", "s"], styles: { color: "blue", fontSize: "16px" } },
    ])).toEqual({ types: ["strong"], styles: { fontSize: "16px" } });
    expect(getCommonFormatPainterSnapshot([])).toBeUndefined();
  });

  it("retains once, continuous, and notification policy", () => {
    expect(shouldKeepFormatPainterActive("once")).toBe(false);
    expect(shouldKeepFormatPainterActive("continuous")).toBe(true);
    expect(shouldShowFormatPainterMessage()).toBe(true);
    expect(shouldShowFormatPainterMessage(false)).toBe(false);
  });

  it("captures delimiters outside visual selections and inside source selections", () => {
    const source = "**bold** and ~~gone~~";
    expect(captureMarkdownFormat(source, 2, 6)?.types).toEqual(["strong"]);
    expect(captureMarkdownFormat(source, 13, 21)?.types).toEqual(["s"]);
    expect(resolveMarkdownFormatSelection(source, 2, 6)).toMatchObject({
      outerFrom: 0, outerTo: 8, contentFrom: 2, contentTo: 6,
    });
  });

  it("replaces existing marks atomically and keeps painted text selected", () => {
    const source = "**copy** and ~~target~~";
    const snapshot = captureMarkdownFormat(source, 2, 6)!;
    const change = applyMarkdownFormat(source, 15, 21, snapshot)!;
    expect(source.slice(0, change.from) + change.insert + source.slice(change.to)).toBe("**copy** and **target**");
    expect(change).toMatchObject({ selectionFrom: 15, selectionTo: 21 });
  });

  it("clears wrappers and treats escaped markers as literal", () => {
    const source = "\\**literal** and ==marked==";
    expect(captureMarkdownFormat(source, 3, 10)?.types).toEqual([]);
    const change = applyMarkdownFormat(source, 19, 25, { styles: {}, types: [] })!;
    expect(source.slice(0, change.from) + change.insert + source.slice(change.to)).toBe("\\**literal** and marked");
  });

  it("does not combine code with presentation marks", () => {
    const change = applyMarkdownFormat("word", 0, 4, { styles: {}, types: ["strong", "code"] })!;
    expect(change.insert).toBe("`word`");
  });

  it("is wired through the public Editor API with once and continuous modes", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { initialContent: "**copy** and ~~target~~" });
    editors.push(editor);

    editor.setMarkdownSelection(2, 6);
    expect(editor.captureFormat("continuous")?.types).toEqual(["strong"]);
    editor.setMarkdownSelection(15, 21);
    expect(editor.applyCapturedFormat()).toBe(true);
    expect(editor.getMarkdown()).toBe("**copy** and **target**");
    expect(editor.getFormatPainterState()?.mode).toBe("continuous");

    editor.clearFormatPainter();
    editor.setMarkdownSelection(2, 6);
    expect(editor.captureFormat("once")?.types).toEqual(["strong"]);
    editor.setMarkdownSelection(15, 21);
    expect(editor.applyCapturedFormat()).toBe(true);
    expect(editor.getFormatPainterState()).toBeNull();
  });
});
