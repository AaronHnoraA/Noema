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
    expect(md).toContain("- one\n- two");
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

describe("HTML sources that style instead of tagging", () => {
  test("Google Docs keeps real bold and drops its normal-weight wrapper", () => {
    const md = htmlToMarkdown('<b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400">plain </span><span style="font-weight:700">bold</span></p></b>');
    expect(md).toBe("plain **bold**");
  });

  test("styled spans become emphasis", () => {
    expect(htmlToMarkdown('<p><span style="font-weight:bold">B</span> <span style="font-style:italic">I</span> <span style="text-decoration: line-through">S</span></p>'))
      .toBe("**B** *I* ~~S~~");
  });

  test("styled spans do not double an existing emphasis tag", () => {
    expect(htmlToMarkdown('<strong><span style="font-weight:700">Bold</span></strong>')).toBe("**Bold**");
    expect(htmlToMarkdown('<em><span style="font-style:italic">Italic</span></em>')).toBe("*Italic*");
    expect(htmlToMarkdown('<span style="font-weight:700">outer <strong>inner</strong></span>')).toBe("**outer inner**");
  });

  test("a bare URL link stays a bare URL and a permalink anchor disappears", () => {
    expect(htmlToMarkdown('<p>see <a href="https://example.com/x">https://example.com/x</a></p>')).toBe("see https://example.com/x");
    expect(htmlToMarkdown('<h2 id="x"><a class="anchor" href="#x"></a>Title</h2>')).toBe("## Title");
  });

  test("lists use one space after the marker and indent nested items to it", () => {
    expect(htmlToMarkdown("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>")).toBe("- a\n  - b\n- c");
    expect(htmlToMarkdown('<ol start="9"><li>x</li><li>y<ul><li>z</li></ul></li></ol>')).toBe("9. x\n10. y\n    - z");
    expect(htmlToMarkdown('<ol start="9"><li>x</li><li value="42">y</li><li>z</li></ol>')).toBe("9. x\n42. y\n43. z");
  });
});
