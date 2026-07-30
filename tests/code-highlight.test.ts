import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { clearCodeHighlightCache, codeHighlightCacheSize, highlightCode } from "../src/code-highlight.ts";

describe("code highlighting", () => {
  test("marks common token classes and caches by language/source", () => {
    clearCodeHighlightCache();
    const ranges = highlightCode("ts", "const answer = 42;\n// done");
    expect(ranges.some((range) => range.className === "code-token-keyword")).toBe(true);
    expect(ranges.some((range) => range.className === "code-token-number")).toBe(true);
    expect(ranges.some((range) => range.className === "code-token-comment")).toBe(true);
    expect(codeHighlightCacheSize()).toBe(1);
    expect(highlightCode("typescript", "const answer = 42;\n// done")).toEqual(ranges);
    expect(codeHighlightCacheSize()).toBe(1);
  });

  test("covers common note code block languages", () => {
    expect(highlightCode("java", "public class StationInfoResponse {\n  private final String stationId;\n}")
      .some((range) => range.className === "code-token-keyword")).toBe(true);
    expect(highlightCode("java", "/** station id */\nprivate final String stationId;")
      .some((range) => range.className === "code-token-comment")).toBe(true);
    expect(highlightCode("rust", "fn main() { let answer = 42; }")
      .some((range) => range.className === "code-token-keyword")).toBe(true);
    expect(highlightCode("go", "func main() { return }")
      .some((range) => range.className === "code-token-keyword")).toBe(true);
    expect(highlightCode("elisp", "(defun aaron-test () ; done\n  t)")
      .some((range) => range.className === "code-token-comment")).toBe(true);
    expect(highlightCode("sql", "select * from notes where done = false")
      .some((range) => range.className === "code-token-keyword")).toBe(true);
    expect(highlightCode("yaml", "title: Noema\npublished: true")
      .some((range) => range.className === "code-token-property" || range.className === "code-token-attr")).toBe(true);
    expect(highlightCode("nix", "{ pkgs ? import <nixpkgs> {} }: with pkgs; hello")
      .some((range) => range.className === "code-token-keyword")).toBe(true);
  });

  test("covers Lean 4 code", () => {
    const ranges = highlightCode("lean4", "import Mathlib\n-- proof\nexample : True := by\n  trivial");

    expect(ranges.some((range) => range.className === "code-token-keyword")).toBe(true);
    expect(ranges.some((range) => range.className === "code-token-comment")).toBe(true);
  });
});
