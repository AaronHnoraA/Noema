import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { domHref, safeHref } from "../src/url-safety.ts";

describe("URL safety", () => {
  test("allows normal note, web, and app links", () => {
    expect(safeHref("./note.md")).toBe(true);
    expect(safeHref("note.md")).toBe(true);
    expect(safeHref("path/note.md#heading")).toBe(true);
    expect(safeHref("#heading")).toBe(true);
    expect(safeHref("https://example.com")).toBe(true);
    expect(safeHref("mailto:a@example.com")).toBe(true);
    expect(safeHref("roam://node")).toBe(true);
    expect(safeHref("zotero://select/items/1_X")).toBe(true);
  });

  test("blocks scriptable protocols for live DOM hrefs", () => {
    expect(safeHref("javascript:alert(1)")).toBe(false);
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(domHref("javascript:alert(1)")).toBeNull();
  });
});
