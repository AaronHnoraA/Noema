import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { sanitizeEmbeddedHtml } from "../src/sanitize-html.ts";

describe("sanitizeEmbeddedHtml", () => {
  test("strips <script> tags and content", () => {
    const out = sanitizeEmbeddedHtml('<b>hi</b><script>alert(1)</script>');
    expect(out).toContain("<b>hi</b>");
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
  });

  test("strips event-handler attributes (XSS via onerror)", () => {
    const out = sanitizeEmbeddedHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert");
  });

  test("strips <iframe> and <object>", () => {
    expect(sanitizeEmbeddedHtml('<iframe src="evil.com"></iframe>')).not.toContain("iframe");
    expect(sanitizeEmbeddedHtml('<object data="evil.swf"></object>')).not.toContain("object");
    expect(sanitizeEmbeddedHtml('<embed src="evil.swf">')).not.toContain("embed");
  });

  test("strips javascript: URIs", () => {
    const out = sanitizeEmbeddedHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("click");
  });

  test("preserves plain relative link hrefs", () => {
    const out = sanitizeEmbeddedHtml('<a href="path/note.md#heading">note</a>');
    expect(out).toContain('href="path/note.md#heading"');
  });

  test("preserves benign inline tags", () => {
    const out = sanitizeEmbeddedHtml('<sub>2</sub><sup>2</sup><br>plain<em>em</em>');
    expect(out).toContain("<sub>2</sub>");
    expect(out).toContain("<sup>2</sup>");
    expect(out).toContain("<em>em</em>");
  });

  test("preserves block HTML tables", () => {
    const table = '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>';
    const out = sanitizeEmbeddedHtml(table);
    expect(out).toContain("<table>");
    expect(out).toContain("<th>A</th>");
    expect(out).toContain("<td>B</td>");
  });
  // One vector per call: happy-dom's node iterator skips the siblings of an
  // element DOMPurify removes, so a combined input would test happy-dom, not
  // the policy.  WebKit's iterator follows the spec.
  test("nothing submits a form or floats over the editor", () => {
    const form = sanitizeEmbeddedHtml('<form action="https://evil.example/"><input name="q">go</form>');
    expect(form).not.toContain("<form");
    expect(form).toContain("go");
    const submit = sanitizeEmbeddedHtml('<button formaction="https://evil.example/" form="f">go</button>');
    expect(submit).not.toContain("formaction");
    expect(submit).not.toContain('form="');
    expect(submit).toContain("<button>go</button>");
    const popover = sanitizeEmbeddedHtml('<div popover id="p">over</div><button popovertarget="p" popovertargetaction="show">open</button>');
    expect(popover).not.toContain("popover");
    expect(popover).toContain('id="p"');
    const dialog = sanitizeEmbeddedHtml('<dialog open>modal</dialog>');
    expect(dialog).not.toContain("<dialog");
    expect(dialog).toContain("modal");
  });

  test("keeps inline style for layout", () => {
    expect(sanitizeEmbeddedHtml('<div style="display:flex">a</div>')).toContain('style="display:flex"');
  });
});
