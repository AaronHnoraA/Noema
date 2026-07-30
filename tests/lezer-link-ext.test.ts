import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { parser } from "@lezer/markdown";
import { nestingAwareLinkExtension } from "../src/cm6/languages/markdown/index.ts";

const extended = parser.configure(nestingAwareLinkExtension);

function emphasisRanges(source: string, configured = false): string[] {
  const ranges: string[] = [];
  (configured ? extended : parser).parse(source).iterate({
    enter(node) {
      if (node.name === "Emphasis" || node.name === "StrongEmphasis") {
        ranges.push(`${node.name}:${node.from}-${node.to}`);
      }
    },
  });
  return ranges;
}

describe("complete nested-link parser", () => {
  test.each([
    "_[[_]",
    "[[*]*",
    "[[_]_",
    "[*[*]",
    "ordinary [unfinished _label] text",
    "*valid emphasis* beside [plain] text",
  ])("preserves stock emphasis semantics for %s", (source) => {
    expect(emphasisRanges(source, true)).toEqual(emphasisRanges(source, false));
  });

  test("claims only a complete nested-label link", () => {
    expect(extended.parse("[outer [inner] text](target.md)").toString())
      .toContain("Link(LinkMark,LinkMark,LinkMark,URL,LinkMark)");
    expect(extended.parse("[outer [inner] text").toString())
      .toBe(parser.parse("[outer [inner] text").toString());
  });

  test("claims a local fragment destination containing spaces", () => {
    expect(extended.parse("[Step 1](#step 1)").toString())
      .toContain("Link(LinkMark,LinkMark,LinkMark,URL,LinkMark)");
    expect(extended.parse("[Step 1](#step 1").toString())
      .toBe(parser.parse("[Step 1](#step 1").toString());
  });

  test("keeps adversarial unmatched brackets linear in practice", () => {
    const source = "[".repeat(100_000) + " plain";
    const started = performance.now();
    extended.parse(source);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
