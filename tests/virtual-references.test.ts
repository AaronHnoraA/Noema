import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Shared ESM contract lives outside the TypeScript app graph.
import { AhoCorasickMatcher, scanVirtualReferences, VirtualReferenceTTLCache } from "../shared/virtual-references.mjs";

describe("source-owned virtual references", () => {
  test("finds overlapping multi-pattern matches in one Aho-Corasick pass", () => {
    const matcher = new AhoCorasickMatcher(["he", "she", "hers", "his"]);
    expect(matcher.search("ushers").map((match: { pattern: string }) => match.pattern)).toEqual(["she", "he", "hers"]);
  });

  test("reports unlinked title and alias mentions while excluding links, code, self and ambiguous aliases", () => {
    const result = scanVirtualReferences([
      { id: "alpha", title: "Alpha", aliases: ["First"], file: "/alpha.md", text: "# Alpha\nAlpha owns itself." },
      { id: "beta", title: "Beta", aliases: ["Shared"], file: "/beta.md", text: "# Beta" },
      { id: "gamma", title: "Gamma", aliases: ["Shared"], file: "/gamma.md", text: "# Gamma" },
      {
        id: "source",
        title: "Source",
        file: "/source.md",
        refs: ["beta"],
        text: "Alpha and First are relevant. Alphabet is not. [[Beta]] is linked. `Alpha` is code. Shared is ambiguous. Alpha again.",
      },
    ]);
    const alpha = result.find((entry: { targetId: string }) => entry.targetId === "alpha");
    expect(alpha.mentions).toEqual([expect.objectContaining({
      sourceId: "source",
      count: 3,
      keywords: ["Alpha", "First"],
    })]);
    expect(result.find((entry: { targetId: string }) => entry.targetId === "beta")?.mentions).toEqual([]);
    expect(result.some((entry: { targetTitle: string }) => entry.targetTitle === "Shared")).toBe(false);
  });

  test("expires and bounds the ten-minute result cache", () => {
    let now = 0;
    const cache = new VirtualReferenceTTLCache({ ttlMs: 600_000, maxEntries: 2, now: () => now });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    now = 600_001;
    expect(cache.get("a")).toBeUndefined();
  });
});
