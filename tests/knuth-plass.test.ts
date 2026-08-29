import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  KP_FORCED_BREAK,
  breakParagraph,
  type KpItem,
} from "../src/linebreak/knuth-plass.ts";
import { mixedCjkItems } from "../src/linebreak/mixed-cjk.ts";

const monoMeasure = (text: string): number => [...text].length;

describe("Knuth-Plass paragraph core", () => {
  test("never shrinks malformed glue below zero width", () => {
    const items: KpItem[] = [
      { kind: "box", from: 0, to: 1, width: 2, text: "a" },
      {
        kind: "glue",
        from: 1,
        to: 2,
        width: 1,
        stretch: 0,
        shrink: 100,
        role: "word",
        breakable: false,
      },
      { kind: "box", from: 2, to: 3, width: 2, text: "b" },
      { kind: "penalty", from: 3, to: 3, width: 0, penalty: KP_FORCED_BREAK },
    ];

    expect(breakParagraph(items, { lineWidth: 3 }).feasible).toBe(false);
    const edge = breakParagraph(items, { lineWidth: 4 });
    expect(edge.feasible).toBe(true);
    expect(edge.lines[0]?.adjustments[0]?.delta).toBe(-1);
  });

  test("finds a globally feasible layout and leaves the final line ragged", () => {
    const items = mixedCjkItems("alpha beta gamma delta", {
      em: 1,
      measure: monoMeasure,
    });
    const layout = breakParagraph(items, { lineWidth: 11 });

    expect(layout.feasible).toBe(true);
    expect(layout.lines.map((line) => line.to)).toEqual([11, 22]);
    expect(layout.lines[0]?.justified).toBe(true);
    expect(layout.lines[1]?.justified).toBe(false);
    expect(layout.lines[0]?.adjustments.length).toBeGreaterThan(0);
  });

  test("uses secondary Han spacing only after primary word-space stretch", () => {
    const items = mixedCjkItems("中 文中文 后", { em: 1, measure: monoMeasure });
    const layout = breakParagraph(items, { lineWidth: 5.75, tolerance: 4 });
    const first = layout.lines[0]!;
    const roles = first.adjustments.map((adjustment) => {
      const item = items[adjustment.item];
      return item?.kind === "glue" ? item.role : "";
    });

    expect(layout.feasible).toBe(true);
    expect(roles).toContain("word");
    expect(roles).toContain("cjk");
  });

  test("never starts a line with Chinese closing punctuation", () => {
    const source = "甲乙丙，丁戊己。庚辛";
    const items = mixedCjkItems(source, { em: 1, measure: monoMeasure });
    const layout = breakParagraph(items, { lineWidth: 4, tolerance: 3 });

    expect(layout.feasible).toBe(true);
    for (const line of layout.lines.slice(1)) {
      expect("，。！？；：".includes(source.slice(line.from, line.to)[0] ?? "")).toBe(false);
    }
  });

  test("applies adjacent punctuation compression and end-of-line hanging", () => {
    const compressed = mixedCjkItems("甲。』乙", { em: 1, measure: monoMeasure });
    const period = compressed.find((item) => item.kind === "box" && item.text === "。");
    expect(period?.kind).toBe("box");
    if (period?.kind === "box") {
      expect(period.width).toBe(0.5);
      expect(period.tracking).toBe(-0.5);
    }

    const hanging = mixedCjkItems("甲乙。丙", { em: 1, measure: monoMeasure });
    const layout = breakParagraph(hanging, { lineWidth: 2.5, tolerance: 3 });
    expect(layout.feasible).toBe(true);
    expect(layout.lines[0]?.to).toBe(3);
    expect(layout.lines[0]?.naturalWidth).toBe(2.5);
  });

  test("adds expensive emergency breakpoints only to overlong Latin runs", () => {
    const items = mixedCjkItems("superlong", {
      em: 1,
      measure: monoMeasure,
      emergencyLineWidth: 4,
    });
    const layout = breakParagraph(items, { lineWidth: 4 });

    expect(items.filter((item) => item.kind === "penalty" && item.penalty > 0)).toHaveLength(8);
    expect(layout.feasible).toBe(true);
    expect(layout.lines.length).toBeGreaterThan(1);
  });

  test("keeps URLs, decimal numbers, and currency prefixes rigid", () => {
    const items = mixedCjkItems("价格￥123.45与https://example.test/path", {
      em: 1,
      measure: monoMeasure,
    });
    const boxes = items
      .filter((item) => item.kind === "box")
      .map((item) => item.kind === "box" ? item.text : "");

    expect(boxes).toContain("123.45");
    expect(boxes).toContain("https://example.test/path");
    expect(items.some((item) => item.kind === "glue" && item.from === 3)).toBe(false);
  });

  test("treats Markdown hard breaks as mandatory and soft breaks as glue", () => {
    const text = "alpha\nbeta\ngamma";
    const secondNewlineEnd = text.lastIndexOf("\n") + 1;
    const items = mixedCjkItems(text, {
      em: 1,
      measure: monoMeasure,
      hardBreakEnds: new Set([secondNewlineEnd]),
    });
    const layout = breakParagraph(items, { lineWidth: 20 });

    expect(items.some((item) => item.kind === "glue" && item.role === "soft-newline")).toBe(true);
    expect(items.some((item) => item.kind === "penalty" && item.penalty === KP_FORCED_BREAK)).toBe(true);
    expect(layout.lines.map((line) => text.slice(line.from, line.to))).toEqual([
      "alpha\nbeta\n",
      "gamma",
    ]);
  });

  test("prunes candidate starts once even fully shrunk text is overfull", () => {
    const items: KpItem[] = [];
    for (let index = 0; index < 400; index++) {
      items.push({ kind: "box", from: index * 2, to: index * 2 + 1, width: 1, text: "x" });
      items.push({
        kind: "glue",
        from: index * 2 + 1,
        to: index * 2 + 2,
        width: 1,
        stretch: 0.5,
        shrink: 0.3,
        role: "word",
      });
    }
    items.push({
      kind: "penalty",
      from: 800,
      to: 800,
      width: 0,
      penalty: KP_FORCED_BREAK,
    });
    const layout = breakParagraph(items, { lineWidth: 20 });

    expect(layout.feasible).toBe(true);
    expect(layout.evaluatedEdges).toBeLessThan(layout.breakpoints * 30);
  });

  test("reuses an unchanged exact DP prefix after a local edit", () => {
    const source = Array.from({ length: 180 }, (_, index) => `word${index}`).join(" ");
    const firstItems = mixedCjkItems(source, { em: 1, measure: monoMeasure });
    const first = breakParagraph(firstItems, { lineWidth: 32, justify: false });
    const changed = `${source.slice(0, -3)}XYZ`;
    const changedItems = mixedCjkItems(changed, { em: 1, measure: monoMeasure });
    const incremental = breakParagraph(changedItems, { lineWidth: 32, justify: false }, first.incremental);
    const fromScratch = breakParagraph(changedItems, { lineWidth: 32, justify: false });

    expect(incremental.feasible).toBe(true);
    expect(incremental.lines.map((line) => line.to)).toEqual(fromScratch.lines.map((line) => line.to));
    expect(incremental.demerits).toBeCloseTo(fromScratch.demerits, 8);
    expect(incremental.reusedBreakpoints).toBeGreaterThan(150);
    expect(incremental.evaluatedEdges).toBeLessThan(fromScratch.evaluatedEdges / 4);
  });
});
