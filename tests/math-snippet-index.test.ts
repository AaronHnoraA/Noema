import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { scanMathCommandChunk } from "../aaronnote/math-snippet-index.ts";

describe("math snippet document index", () => {
  test("counts commands only inside inline and display math", () => {
    const result = scanMathCommandChunk([
      "prose \\outside",
      "\\(\\alpha + \\frac{a}{b}\\)",
      "```tex",
      "\\(\\ignored\\)",
      "```",
      "\\[",
      "\\beta + \\alpha",
      "\\]",
    ].join("\n"));
    expect(result.counts.get("\\alpha")).toBe(2);
    expect(result.counts.get("\\frac")).toBe(1);
    expect(result.counts.get("\\beta")).toBe(1);
    expect(result.counts.has("\\outside")).toBe(false);
    expect(result.counts.has("\\ignored")).toBe(false);
  });
});
