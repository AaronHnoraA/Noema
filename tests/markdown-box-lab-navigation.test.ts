import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { markdownLineStartOffset } from "../aaronnote/markdown-box-lab-navigation.ts";

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
});
