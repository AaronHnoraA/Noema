import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  chineseNumber,
  formatHeadingNumber,
  headingNumberNeedsSpacing,
  numberHeadings,
  resolveHeadingNumberEnabled,
} from "../src/heading-number.ts";
import { headingNumberingExtension, setHeadingNumbering } from "../src/cm6/heading-number.ts";
import { tocIndexExtension } from "../src/cm6/toc-index.ts";
import { createEditor } from "../src/editor-api.ts";

describe("heading number model", () => {
  test("uses logical outline depth across skipped Markdown levels", () => {
    const numbered = numberHeadings([
      { id: "a", level: 1 },
      { id: "b", level: 3 },
      { id: "c", level: 2 },
      { id: "d", level: 4 },
      { id: "e", level: 1 },
    ]);
    expect(Object.fromEntries(numbered.map((entry) => [entry.heading.id, entry.label]))).toEqual({
      a: "1", b: "1.1", c: "1.2", d: "1.2.1", e: "2",
    });
  });

  test("supports the retained SiYuan format presets", () => {
    expect(formatHeadingNumber([2, 3, 4])).toBe("2.3.4");
    expect(formatHeadingNumber([2], "chinese-document")).toBe("二、");
    expect(formatHeadingNumber([2, 3], "chinese-document")).toBe("（三）");
    expect(formatHeadingNumber([2, 3, 4], "chinese-document")).toBe("4.");
    expect(formatHeadingNumber([2, 3], "decimal-parenthesized")).toBe("3）");
    expect(formatHeadingNumber([27], "upper-alpha-hierarchical")).toBe("AA");
    expect(formatHeadingNumber([14], "upper-roman-hierarchical")).toBe("XIV");
    expect(formatHeadingNumber([25], "lower-greek-hierarchical")).toBe("αα");
  });

  test("preserves Chinese number and full-width spacing semantics", () => {
    expect(chineseNumber(1)).toBe("一");
    expect(chineseNumber(10)).toBe("十");
    expect(chineseNumber(101)).toBe("一百零一");
    expect(chineseNumber(10_010)).toBe("一万零一十");
    expect(chineseNumber(10_010_001)).toBe("一千零一万零一");
    expect(headingNumberNeedsSpacing("1.2")).toBe(true);
    expect(headingNumberNeedsSpacing("一、")).toBe(false);
    expect(resolveHeadingNumberEnabled("invalid", true)).toBe(true);
    expect(resolveHeadingNumberEnabled("false", true)).toBe(false);
  });
});

describe("CM6 heading-number decoration", () => {
  test("is ephemeral, configurable, fence-aware, and excludes source text", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const source = "# One\n### Deep\n```md\n# Not a heading\n```\n## Two";
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: source,
        extensions: [tocIndexExtension, headingNumberingExtension({ enabled: true })],
      }),
    });

    expect([...view.dom.querySelectorAll(".noema-heading-number")].map((node) => node.textContent)).toEqual(["1 ", "1.1 ", "1.2 "]);
    expect(view.state.doc.toString()).toBe(source);
    setHeadingNumbering(view, { enabled: false });
    expect(view.dom.querySelector(".noema-heading-number")).toBeNull();
    setHeadingNumbering(view, { enabled: true, format: "chinese-document" });
    expect([...view.dom.querySelectorAll(".noema-heading-number")].map((node) => node.textContent)).toEqual(["一、", "（一）", "（二）"]);

    view.destroy();
    parent.remove();
  });

  test("public editor API keeps numbers visual-only across source toggles", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const source = "# One\n## Two";
    const editor = createEditor(parent, {
      initialContent: source,
      headingNumbering: { enabled: true },
    });

    expect(parent.querySelectorAll(".noema-heading-number")).toHaveLength(2);
    editor.toggleSource();
    expect(parent.querySelector(".noema-heading-number")).toBeNull();
    editor.toggleSource();
    expect(parent.querySelectorAll(".noema-heading-number")).toHaveLength(2);
    editor.setHeadingNumbering({ enabled: false });
    expect(parent.querySelector(".noema-heading-number")).toBeNull();
    expect(editor.getMarkdown()).toBe(source);

    editor.destroy();
    parent.remove();
  });
});
