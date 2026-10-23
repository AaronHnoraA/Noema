import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import katex from "katex";
import {
  liveTexMatrixTemplate,
  liveTexPaletteBeforeInputKey,
  liveTexPaletteCategories,
  liveTexPaletteSourceTemplate,
  rebaseLiveTexPaletteRange,
  searchLiveTexPalette,
} from "../pages/live-tex-palette.ts";

describe("LiveTeX click palette", () => {
  test("searches all categories by name and LaTeX command", () => {
    expect(searchLiveTexPalette("partial", "greek").some((item) => item.latex === "\\partial")).toBe(true);
    expect(searchLiveTexPalette("分段", "structure").some((item) => item.latex.includes("cases"))).toBe(true);
  });

  test("offers structures and symbols without duplicating ordinary keyboard keys", () => {
    const entries = liveTexPaletteCategories.flatMap(({ items }) => items);
    expect(entries.some((entry) => entry.latex.includes("\\frac"))).toBe(true);
    expect(entries.some((entry) => entry.latex.includes("\\begin{pmatrix}"))).toBe(true);
    expect(entries.every((entry) => !/^[0-9A-Za-z+*/=().-]$/.test(entry.latex))).toBe(true);
    expect(new Set(entries.map((entry) => entry.latex)).size).toBe(entries.length);
  });

  test("finds uncommon algebra symbols by name, meaning and LaTeX command", () => {
    const find = (query: string) => searchLiveTexPalette(query, "structure").map((entry) => entry.latex);
    expect(find("半直积")).toEqual(expect.arrayContaining(["\\rtimes", "\\ltimes"]));
    expect(find("semi group product")).toEqual(expect.arrayContaining(["\\rtimes", "\\ltimes"]));
    expect(find("right semi-direct")).toContain("\\rtimes");
    expect(find("\\rtimes")).toContain("\\rtimes");
    expect(find("正规子群")).toContain("\\trianglelefteq");
    expect(find("finite field")).toContain("\\mathbb{F}");
  });

  test("all built-in templates render with the installed KaTeX", () => {
    for (const category of liveTexPaletteCategories) {
      for (const entry of category.items) {
        expect(() => katex.renderToString(entry.latex.replaceAll("\\placeholder{}", "{x}"), {
          throwOnError: true,
        }), `${category.id}: ${entry.name} ${entry.latex}`).not.toThrow();
      }
    }
  });

  test("creates bounded custom matrices with distinct editable cells", () => {
    const latex = liveTexMatrixTemplate(3, 2, "pmatrix");
    expect(latex.startsWith("\\begin{pmatrix}")).toBe(true);
    expect(latex.endsWith("\\end{pmatrix}")).toBe(true);
    expect(latex.match(/\\placeholder\{\}/g)).toHaveLength(6);
    expect(latex.match(/\\\\/g)).toHaveLength(2);
    expect(liveTexMatrixTemplate(50, 50, "matrix").match(/\\placeholder\{\}/g)).toHaveLength(100);
  });

  test("inserts source-safe structures with the caret at the first unfilled slot", () => {
    expect(liveTexPaletteSourceTemplate(String.raw`\frac{\placeholder{}}{\placeholder{}}`)).toEqual({
      text: String.raw`\frac{}{}`,
      caret: String.raw`\frac{`.length,
    });
    expect(liveTexPaletteSourceTemplate(String.raw`\frac{\placeholder{}}{\placeholder{}}`, "x")).toEqual({
      text: String.raw`\frac{x}{}`,
      caret: String.raw`\frac{x}{`.length,
    });
    expect(liveTexPaletteSourceTemplate(String.raw`\ne`)).toEqual({ text: String.raw`\ne`, caret: 3 });
    expect(liveTexPaletteSourceTemplate(liveTexMatrixTemplate(2, 2, "pmatrix")).text).not.toContain("\n");
  });

  test("keeps a palette insertion anchored after edits before or at the formula caret", () => {
    expect(rebaseLiveTexPaletteRange("abc \\(x\\)", "0abc \\(x\\)", {
      from: 7, to: 7, formulaFrom: 4,
    })).toEqual({ from: 8, to: 8, formulaFrom: 5 });
    expect(rebaseLiveTexPaletteRange("abc \\(x\\)", "abc \\(xy\\)", {
      from: 7, to: 7, formulaFrom: 4,
    })).toEqual({ from: 8, to: 8, formulaFrom: 4 });
  });

  test("accepts the WebKit Enter forms without treating ordinary text as a selection", () => {
    expect(liveTexPaletteBeforeInputKey("insertParagraph", null)).toBe("Enter");
    expect(liveTexPaletteBeforeInputKey("insertLineBreak", null)).toBe("Enter");
    expect(liveTexPaletteBeforeInputKey("insertText", "\n")).toBe("Enter");
    expect(liveTexPaletteBeforeInputKey("insertText", "\r")).toBe("Enter");
    expect(liveTexPaletteBeforeInputKey("insertText", "\t")).toBe("Tab");
    expect(liveTexPaletteBeforeInputKey("insertText", "x")).toBeNull();
  });
});
