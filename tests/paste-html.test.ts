import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { htmlToMarkdown } from "../src/paste-html.ts";

describe("HTML paste conversion", () => {
  test("sanitizes scripts and keeps common markdown structures", () => {
    const md = htmlToMarkdown(`
      <h2>Title</h2>
      <script>alert(1)</script>
      <p>Hello <strong>world</strong> and <a href="https://example.com">site</a>.</p>
      <ul><li>one</li><li>two</li></ul>
      <table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>
    `);
    expect(md).toContain("## Title");
    expect(md).toContain("Hello **world** and [site](https://example.com).");
    expect(md).toContain("-   one");
    expect(md).toContain("| A |");
    expect(md).not.toContain("script");
  });

  test("drops unsafe pasted links", () => {
    const md = htmlToMarkdown(`<a href="javascript:alert(1)">bad</a>`);
    expect(md).toBe("bad");
  });

  test("keeps plain relative links without dot or slash prefixes", () => {
    const md = htmlToMarkdown(`<a href="path/note.md#heading">note</a>`);
    expect(md).toBe("[note](path/note.md#heading)");
  });

  test("keeps Typora-style inline extensions where possible", () => {
    expect(htmlToMarkdown("<p><mark>hot</mark> H<sub>2</sub> E<sup>2</sup></p>"))
      .toBe("==hot== H~2~ E^2^");
  });

  test("keeps Noema rendered math as TeX source", () => {
    const md = htmlToMarkdown(`
      <p>Inline <span class="aaronnote-math-inline" data-tex="x+1"><span>x + 1</span></span>.</p>
      <math-block data-aaronnote-math-block="" class="math-block-rendered" data-tex="y^2">
        <div class="aaronnote-math-block math-block-render" data-tex="y^2"><span>y2</span></div>
      </math-block>
    `);
    expect(md).toContain("Inline \\(x+1\\).");
    expect(md).toContain("\\[\ny^2\n\\]");
    expect(md).not.toContain("y2");
  });

  test("degrades very large HTML paste to plain text", () => {
    const huge = `<p>${"x".repeat(910_000)}</p>`;
    expect(htmlToMarkdown(huge)).toBe("x".repeat(910_000));
  });
});
