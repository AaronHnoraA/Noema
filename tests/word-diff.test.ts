import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { needsRenderedComparison, wordDiff } from "../src/word-diff.ts";

describe("C72 word diff", () => {
  test("C72 marks the words that changed and keeps the rest", () => {
    expect(wordDiff("The field is fixed.", "The field is finite and fixed.")).toEqual([
      { kind: "same", text: "The field is " }, { kind: "ins", text: "finite and " }, { kind: "same", text: "fixed." },
    ]);
    expect(wordDiff("a b c", "a x c")).toEqual([
      { kind: "same", text: "a " }, { kind: "ins", text: "x" }, { kind: "del", text: "b" }, { kind: "same", text: " c" },
    ]);
    expect(needsRenderedComparison("with \\(x^2\\)")).toBe(true);
    expect(needsRenderedComparison("plain words")).toBe(false);
  });
});
