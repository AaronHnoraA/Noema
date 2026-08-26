import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  markdownBlockSourceOffset,
  markdownLineStartOffset,
} from "../aaronnote/markdown-box-lab-navigation.ts";

describe("Markdown box block navigation", () => {
  test("converts kernel 1-based lines to CM6 source offsets", () => {
    const markdown = "first\nsecond\nthird";
    expect(markdownLineStartOffset(markdown, 1)).toBe(0);
    expect(markdownLineStartOffset(markdown, 2)).toBe(6);
    expect(markdownLineStartOffset(markdown, 3)).toBe(13);
  });

  test("clamps missing or out-of-range lines", () => {
    expect(markdownLineStartOffset("one\ntwo", 0)).toBe(0);
    expect(markdownLineStartOffset("one\ntwo", 99)).toBe(7);
  });

  test("prefers the live UUIDv7 anchor after unsaved lines shift the kernel location", () => {
    const id = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68";
    const markdown = `unsaved\nlines\n\nTarget {#${id} owner=Noema}\n`;
    expect(markdownBlockSourceOffset(markdown, id.toUpperCase(), 1))
      .toBe(markdown.indexOf("Target"));
  });

  test("falls back to the kernel line for legacy IDs and ambiguous live anchors", () => {
    const id = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68";
    const duplicate = `One {#${id}}\nTwo {#${id}}\nFallback`;
    expect(markdownBlockSourceOffset(duplicate, id, 3)).toBe(duplicate.indexOf("Fallback"));
    expect(markdownBlockSourceOffset("one\ntwo", "20260825095344-i40x2sr", 2)).toBe(4);
  });
});
