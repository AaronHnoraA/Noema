import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  knowledgeCreatedTime,
  knowledgeDateBound,
  knowledgeDatePeriod,
  knowledgeEntityMatches,
  parseKnowledgeQuery,
} from "../shared/knowledge-query.mjs";
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

  test("bounds modification time by calendar date or age", () => {
    const now = new Date(2026, 9, 9, 15, 30).getTime();
    expect(knowledgeDateBound("2026-10-09", now)).toBe(new Date(2026, 9, 9).getTime());
    expect(knowledgeDateBound("2026-10", now)).toBe(new Date(2026, 9, 1).getTime());
    expect(knowledgeDateBound("2026", now)).toBe(new Date(2026, 0, 1).getTime());
    expect(knowledgeDateBound("7d", now)).toBe(new Date(2026, 9, 2).getTime());
    expect(knowledgeDateBound("2w", now)).toBe(new Date(2026, 8, 25).getTime());
    expect(knowledgeDateBound("1m", now)).toBe(new Date(2026, 8, 9).getTime());
    expect(knowledgeDateBound("1y", now)).toBe(new Date(2025, 9, 9).getTime());
    for (const invalid of ["", "soon", "2026-13", "2026-02-30", "7h"]) expect(knowledgeDateBound(invalid, now)).toBeNull();

    const page = { ...math, mtimeMs: new Date(2026, 5, 15, 12).getTime() };
    expect(parseKnowledgeQuery("since:2026-06 until:2026-07").clauses.map((clause) => clause.field)).toEqual(["after", "before"]);
    expect(knowledgeEntityMatches(page, "after:2026-06-15 before:2026-06-16")).toBe(true);
    expect(knowledgeEntityMatches(page, "before:2026-06-15")).toBe(false);
    expect(knowledgeEntityMatches(page, "-after:2026-07")).toBe(true);
    expect(knowledgeEntityMatches(page, "after:soon")).toBe(false);
    expect(knowledgeEntityMatches(math, "after:2000")).toBe(false);
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

  test("created: names the period a page is dated in", () => {
    const now = new Date(2026, 9, 9, 15).getTime();
    expect(knowledgeDatePeriod("2026", now)).toEqual({ from: new Date(2026, 0, 1).getTime(), to: new Date(2027, 0, 1).getTime() });
    expect(knowledgeDatePeriod("2026-12", now)).toEqual({ from: new Date(2026, 11, 1).getTime(), to: new Date(2027, 0, 1).getTime() });
    expect(knowledgeDatePeriod("2026-10-09", now)).toEqual({ from: new Date(2026, 9, 9).getTime(), to: new Date(2026, 9, 10).getTime() });
    expect(knowledgeDatePeriod("7d", now)).toEqual({ from: new Date(2026, 9, 2).getTime(), to: Infinity });
    expect(knowledgeDatePeriod("soon", now)).toBeNull();

    expect(knowledgeCreatedTime("2026-10-09")).toBe(new Date(2026, 9, 9).getTime());
    expect(knowledgeCreatedTime("2026-10-09T08:30:00Z")).toBe(new Date(2026, 9, 9).getTime());
    expect(knowledgeCreatedTime("")).toBe(0);
    expect(knowledgeCreatedTime("last week")).toBe(0);

    const page = { title: "Page", createdMs: new Date(2026, 9, 9).getTime(), mtimeMs: Date.now() };
    expect(knowledgeEntityMatches(page, "created:2026-10")).toBe(true);
    expect(knowledgeEntityMatches(page, "created:2026-10-09")).toBe(true);
    expect(knowledgeEntityMatches(page, "created:2026-10-10")).toBe(false);
    expect(knowledgeEntityMatches(page, "created:2025")).toBe(false);
    expect(knowledgeEntityMatches(page, "-created:2025")).toBe(true);
    expect(knowledgeEntityMatches({ title: "Undated" }, "created:2026")).toBe(false);
    expect(parseKnowledgeQuery("created:2026-10").clauses[0]).toMatchObject({ field: "created", value: "2026-10" });
  });
});
