/**
 * A Markdown link's whole-span styling must be emitted once, not once per
 * delimiter.
 *
 * `[label](url)` has five delimiter nodes — `[`, `]`, `(`, the URL and `)` —
 * and each carried the same `linkClass` for the entire link span, so every link
 * rendered as five identical nested spans. `color` and `underline` survive that
 * unchanged, which is why it went unnoticed, but an internal link's translucent
 * hover background stacked five deep, and it multiplied the decoration and DOM
 * work CodeMirror redoes on every selection change.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";

function render(markdown: string, caret = 0) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: markdown });
  editor.setSelection(caret, caret);
  const content = host.querySelector(".cm-content") as HTMLElement;
  const html = content.innerHTML;
  const text = content.textContent ?? "";
  const count = (cls: string) => content.querySelectorAll(`.${cls}`).length;
  const deepest = (cls: string) => {
    let max = 0;
    for (const node of content.querySelectorAll<HTMLElement>(`.${cls}`)) {
      let depth = 1;
      for (let up = node.parentElement; up; up = up.parentElement) {
        if (up.classList.contains(cls)) depth++;
      }
      max = Math.max(max, depth);
    }
    return max;
  };
  editor.destroy();
  host.remove();
  return { html, text, count, deepest };
}

describe("link span styling is emitted once", () => {
  test("an inline link produces a single cm-link-text span", () => {
    const r = render("[label](http://example.com) tail");
    expect(r.count("cm-link-text")).toBe(1);
    expect(r.deepest("cm-link-text")).toBe(1);
  });

  test("the link still styles the whole span and hides its delimiters", () => {
    const r = render("[label](http://example.com) tail");
    expect(r.html).toContain('class="cm-link-text"');
    expect(r.html).toContain('<span class="syntax-hidden">[</span>');
    expect(r.html).toContain('<span class="syntax-hidden">)</span>');
    expect(r.text).toBe("[label](http://example.com) tail");
  });

  test("an internal link is not nested either, so its hover tint cannot stack", () => {
    const r = render("[label](roam://wiki/Target) tail");
    expect(r.deepest("cm-roam-link-text")).toBe(1);
  });

  test("two links on one line each get their own single span", () => {
    const r = render("[a](http://x) and [b](http://y)");
    expect(r.count("cm-link-text")).toBe(2);
    expect(r.deepest("cm-link-text")).toBe(1);
  });

  test("a link with a nested bracket in its label stays one span", () => {
    const r = render("[a [b] c](http://x) tail");
    expect(r.deepest("cm-link-text")).toBe(1);
  });

  test("the caret inside a link reveals the source instead of styling the span", () => {
    const r = render("[label](http://example.com) tail", 3);
    expect(r.count("cm-link-text")).toBe(0);
    expect(r.html).toContain("syntax-hint");
  });

  test("a wiki link keeps its single static span", () => {
    const r = render("[[Target]] tail");
    expect(r.deepest("cm-link-text")).toBe(1);
    expect(r.html).toContain("cm-internal-link-text");
  });
});

describe("neighbouring inline syntax is unaffected", () => {
  test("bold still hides its markers", () => {
    const r = render("**bold** tail");
    expect(r.html).toContain('<span class="syntax-hidden">**</span>');
    expect(r.html).toContain("cm-strong");
  });

  test("an escaped star keeps the star and hides the backslash", () => {
    const r = render("\\*not em\\* tail");
    expect(r.html).toContain('<span class="syntax-hidden">\\</span>');
    expect(r.text).toBe("\\*not em\\* tail");
  });

  test("a heading keeps its dimmed marker and line class", () => {
    const r = render("# Title");
    expect(r.html).toContain("cm-md-h1");
    expect(r.html).toContain('<span class="syntax-hint"># </span>');
  });
});
