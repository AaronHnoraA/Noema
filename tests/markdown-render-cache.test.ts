import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { setKatexMacros } from "../src/katex-macros.ts";
import { clearMathRenderCache } from "../src/math-render.ts";
import {
  markdownRenderCacheSize,
  renderInlineMarkdownHTML,
  renderMarkdownHTML,
  renderMarkdownInlineHTML,
} from "../src/render-html.ts";

// Widgets re-render unchanged Markdown on every rebuild; the cache must give
// the same answer an uncached render gives, and follow macros and refreshes.
describe("Markdown render cache", () => {
  test("a repeated render is a hit with the same HTML", () => {
    const source = "Cell with **bold** and \\(x^2\\) " + Math.random();
    const first = renderMarkdownHTML(source);
    const size = markdownRenderCacheSize();
    expect(renderMarkdownHTML(source)).toBe(first);
    expect(markdownRenderCacheSize()).toBe(size);
    expect(renderInlineMarkdownHTML(source)).toBe(renderInlineMarkdownHTML(source));
    expect(renderMarkdownInlineHTML(source)).toBe(renderMarkdownInlineHTML(source));
  });

  test("a math cache clear (the refresh button) renders again", () => {
    const source = "refresh \\(y\\) " + Math.random();
    const before = renderMarkdownHTML(source);
    const size = markdownRenderCacheSize();
    clearMathRenderCache();
    expect(renderMarkdownHTML(source)).toBe(before);
    expect(markdownRenderCacheSize()).toBe(size + 1);
  });

  test("a macro change changes the output", () => {
    const source = "macro \\(\\Rset\\) " + Math.random();
    setKatexMacros({ "\\Rset": "\\mathbb{R}" });
    const blackboard = renderMarkdownHTML(source);
    setKatexMacros({ "\\Rset": "\\mathrm{R}" });
    const roman = renderMarkdownHTML(source);
    expect(roman).not.toBe(blackboard);
    setKatexMacros({});
  });

  test("renders with options and whole notes are not kept", () => {
    const size = markdownRenderCacheSize();
    renderMarkdownHTML("with options " + Math.random(), { allowHtml: true });
    renderMarkdownHTML("x ".repeat(20_001));
    expect(markdownRenderCacheSize()).toBe(size);
  });

  test("a hit is much cheaper than a render", () => {
    const sources = Array.from({ length: 50 }, (_, index) =>
      `| cell ${index} | \\(\\sum_{i=0}^{n} a_i x^i\\) and **text** with [link](https://e.example) ${Math.random()}`);
    const cold = performance.now();
    for (const source of sources) renderInlineMarkdownHTML(source);
    const coldMs = performance.now() - cold;
    const warm = performance.now();
    for (let round = 0; round < 10; round++) for (const source of sources) renderInlineMarkdownHTML(source);
    const warmMs = (performance.now() - warm) / 10;
    expect(warmMs).toBeLessThan(coldMs / 5);
  });
});
