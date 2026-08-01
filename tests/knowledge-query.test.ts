import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { knowledgeEntityMatches, parseKnowledgeQuery } from "../shared/knowledge-query.mjs";
import { knowledgeSearchResponse, recommendKnowledgeNotes } from "../server/lib/knowledge-search.mjs";

describe("knowledge query", () => {
  const math = {
    id: "math", title: "Hermitian Matrix", tags: ["math", "qc"], repositoryId: "public/Public-Math",
    namespace: "Linear Algebra", path: "Hermitian.md", kind: "note", refs: ["density"], backlinks: [],
  };

  test("shares field, phrase, and negative matching semantics", () => {
    expect(parseKnowledgeQuery('tag:math title:"Hermitian Matrix" -repo:Bio').clauses).toHaveLength(3);
    expect(knowledgeEntityMatches(math, "tag:math namespace:algebra -repo:bio", { degree: 1 })).toBe(true);
    expect(knowledgeEntityMatches(math, "tag:biology", { degree: 1 })).toBe(false);
    expect(knowledgeEntityMatches({ kind: "dependency", title: "plot.png" }, "is:attachment")).toBe(true);
    expect(knowledgeEntityMatches({ ...math, refs: [], backlinks: [] }, "is:orphan", { degree: 0 })).toBe(true);
  });

  test("ranks direct related pages and diversifies repository recommendations", () => {
    const index = {
      notes: [
        math,
        { id: "density", title: "Density", tags: ["math"], repositoryId: "public/Public-QC", namespace: "QC", refs: [], backlinks: ["math"], mtimeMs: Date.now() },
        { id: "tensor", title: "Tensor", tags: ["math"], repositoryId: "public/Public-Math", namespace: "Linear Algebra", refs: [], backlinks: [] },
        { id: "bio", title: "Cell", tags: ["bio"], repositoryId: "public/Public-Bio", namespace: "Bio", refs: [], backlinks: [] },
      ],
    };
    const items = recommendKnowledgeNotes(index, { context: { id: "math" }, limit: 3 });
    expect(items[0]?.id).toBe("density");
    expect(new Set(items.map((item) => item.repositoryId)).size).toBeGreaterThan(1);
  });

  test("offers bounded title typo suggestions without behavioral history", () => {
    const result = knowledgeSearchResponse(
      { generation: "g", notes: [math] },
      { query: "Hermtian", mode: "suggest", limit: 8 },
      { items: [], total: 0, nextCursor: null },
    ) as { items: Array<{ id?: string; reasons?: string[] }> };
    expect(result.items[0]).toMatchObject({ id: "math", reasons: ["spelling suggestion"] });
  });
});
