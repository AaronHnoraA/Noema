import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { matchingSnippetsForPrefix } from "../aaronnote/snippets.ts";
import type { SnippetSummary } from "../aaronnote/types.ts";

describe("snippet hot-path performance boundary", () => {
  test("keeps context filtering and ranking bounded for a catalog larger than production", () => {
    const catalog: SnippetSummary[] = Array.from({ length: 2_000 }, (_, index) => ({
      id: `benchmark:${index}`,
      key: `\\command${String(index).padStart(4, "0")}`,
      name: `Command ${index}`,
      mode: "tex-mode",
      context: "math-command",
      provider: index % 3 === 0 ? "personal" : "latex-workshop",
      weight: index % 17,
      body: `\\command${index}$0`,
    }));
    const latencies: number[] = [];
    for (let run = 0; run < 24; run++) {
      const started = performance.now();
      const matches = matchingSnippetsForPrefix(catalog, "\\command1", {
        mode: "tex-mode",
        context: "math",
        limit: 10,
      });
      latencies.push(performance.now() - started);
      expect(matches).toHaveLength(10);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? Infinity;
    // Happy DOM/CI is noisier than the browser's 4 ms target. This ceiling is
    // a regression alarm for accidental extra passes or unbounded metadata IO.
    expect(p95).toBeLessThan(12);
  });
});
