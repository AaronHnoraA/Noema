import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  buildOfficeListPlan,
  classifyPptMarker,
  classifyWordMarker,
  convertOfficeLists,
  detectTaskMarker,
  groupConsecutiveOfficeListItems,
  parseCssLengthToPoints,
  parseInlineStyle,
  parseOrderedMarker,
  parsePptSpecialFormat,
  parseWordListStyle,
} from "../src/office-list.ts";
import { htmlToMarkdown } from "../src/paste-html.ts";

describe("SiYuan-derived Office list parsing", () => {
  test("parses Word and PowerPoint list metadata without a head stylesheet", () => {
    expect(parseWordListStyle(" color:red; MSO-LIST: l12   LEVEL3 lfo7 ;")).toEqual({
      level: 3,
      identity: "word:l12:lfo7",
    });
    expect(parseWordListStyle("mso-list:Ignore")).toBeUndefined();
    expect(parsePptSpecialFormat("mso-special-format: bullet")).toBe("bullet");
    expect(parsePptSpecialFormat("mso-special-format:\"numbullet3\\,1\"")).toBe("numbullet");
    expect(parsePptSpecialFormat("mso-special-format:bulletproof")).toBeUndefined();
  });

  test("keeps quoted and parenthesized inline style values intact", () => {
    expect(parseInlineStyle("font-family:'A; B'; background:url(data:image/png;a:b); COLOR: red"))
      .toEqual({
        "font-family": "'A; B'",
        background: "url(data:image/png;a:b)",
        color: "red",
      });
  });

  test("normalizes PowerPoint indentation units", () => {
    expect(parseCssLengthToPoints(".5in")).toBe(36);
    expect(parseCssLengthToPoints("48px")).toBe(36);
    expect(parseCssLengthToPoints("3pc")).toBe(36);
    expect(parseCssLengthToPoints("invalid")).toBeUndefined();
  });

  test("detects ordered, unordered, and task markers", () => {
    expect(parseOrderedMarker("12.\u00a0")).toEqual({ ordinal: 12, format: "number" });
    expect(parseOrderedMarker("b)")).toEqual({ ordinal: 2, format: "letter" });
    expect(parseOrderedMarker("(iv)")).toEqual({ ordinal: 4, format: "roman" });
    expect(classifyWordMarker("l", "Wingdings")).toEqual({ type: "ul" });
    expect(classifyWordMarker("3.", "Arial")).toEqual({ type: "ol", markerOrdinal: 3 });
    expect(detectTaskMarker("☐", "Arial")).toBe(false);
    expect(detectTaskMarker("☑", "Arial")).toBe(true);
    expect(detectTaskMarker("P", "Wingdings 2")).toBe(true);
    expect(classifyPptMarker("4.", "Arial", "numbullet"))
      .toEqual({ type: "ol", markerOrdinal: 4 });
  });
});

describe("SiYuan-derived Office list planning", () => {
  test("compresses skipped levels and nests child lists inside list items", () => {
    const plan = buildOfficeListPlan([
      { level: 1, type: "ul", identity: "word:l0:lfo1" },
      { level: 3, type: "ul", identity: "word:l0:lfo1" },
      { level: 3, type: "ul", identity: "word:l0:lfo1" },
      { level: 2, type: "ul", identity: "word:l0:lfo1" },
      { level: 1, type: "ul", identity: "word:l0:lfo1" },
    ]);

    expect(plan).toHaveLength(1);
    expect(plan[0].items.map((item) => item.sourceIndex)).toEqual([0, 4]);
    expect(plan[0].items[0].children).toHaveLength(1);
    expect(plan[0].items[0].children[0].items.map((item) => item.sourceIndex)).toEqual([1, 2, 3]);
  });

  test("splits list runs on numbering restarts and ordinary paragraphs", () => {
    const plan = buildOfficeListPlan([
      { level: 1, type: "ol", identity: "word:l1:lfo1", markerOrdinal: 1 },
      { level: 1, type: "ol", identity: "word:l1:lfo1", markerOrdinal: 2 },
      { level: 1, type: "ol", identity: "word:l1:lfo1", markerOrdinal: 5 },
      { level: 1, type: "ul", identity: "word:l1:lfo1" },
    ]);
    expect(plan.map((item) => item.type)).toEqual(["ol", "ol", "ul"]);
    expect(plan.map((item) => item.start)).toEqual([1, 5, undefined]);
    expect(groupConsecutiveOfficeListItems([1, 2, undefined, 3, null, 4, 5]))
      .toEqual([[1, 2], [3], [4, 5]]);
  });
});

describe("Office HTML paste integration", () => {
  test("repairs nested Word numbering before Markdown conversion", () => {
    const html = `
      <p style="mso-list:l1 level1 lfo2"><span style="mso-list:Ignore">3.<span>&nbsp;</span></span>Third</p>
      <p style="mso-list:l1 level2 lfo2"><span style="mso-list:Ignore">a.<span>&nbsp;</span></span>Nested</p>
      <p style="mso-list:l1 level1 lfo2"><span style="mso-list:Ignore">4.<span>&nbsp;</span></span>Fourth</p>
    `;
    const converted = convertOfficeLists(html);
    expect(converted.convertedCount).toBe(3);
    expect(converted.source).toBe("word");
    expect(converted.html).toContain('<ol start="3">');
    expect(converted.html).not.toContain("mso-list");

    const markdown = htmlToMarkdown(html);
    expect(markdown).toMatch(/3\.\s+Third/);
    expect(markdown).toMatch(/1\.\s+Nested/);
    expect(markdown).toMatch(/4\.\s+Fourth/);
  });

  test("repairs PowerPoint bullets", () => {
    const html = `
      <div>
        <p style="margin-left:36pt"><span style="mso-special-format:bullet;font-family:Arial">•</span>Alpha</p>
        <p style="margin-left:36pt"><span style="mso-special-format:bullet;font-family:Arial">•</span>Beta</p>
      </div>
    `;
    const converted = convertOfficeLists(html);
    expect(converted.convertedCount).toBe(2);
    expect(converted.source).toBe("ppt");
    expect(converted.html).toContain("<ul>");
    expect(htmlToMarkdown(html)).toMatch(/-\s+Alpha[\s\S]*-\s+Beta/);
  });

  test("preserves task checkbox state and sanitizes after repair", () => {
    const html = `
      <p style="mso-list:l4 level1 lfo3"><span style="mso-list:Ignore">☑</span>Done<script>alert(1)</script></p>
      <p style="mso-list:l4 level1 lfo3"><span style="mso-list:Ignore">☐</span>Next</p>
    `;
    const markdown = htmlToMarkdown(html);
    expect(markdown).toMatch(/-\s+\[x\]\s+Done/i);
    expect(markdown).toMatch(/-\s+\[ \]\s+Next/);
    expect(markdown).not.toContain("script");
    expect(markdown).not.toContain("alert");
  });

  test("leaves ordinary HTML unchanged at the repair boundary", () => {
    const html = "<p>Ordinary <strong>HTML</strong></p>";
    expect(convertOfficeLists(html)).toEqual({ html, convertedCount: 0 });
    expect(htmlToMarkdown(html)).toBe("Ordinary **HTML**");
  });
});
