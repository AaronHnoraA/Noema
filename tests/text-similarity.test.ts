import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { rareTokenWeight, similarTitlePairs, similarTitles, titleSimilarity, tokenize } from "../shared/text-similarity.mjs";
import { standouts } from "../shared/nanomuse-recall.mjs";

describe("text similarity", () => {
  test("splits words and pairs CJK characters inside each run", () => {
    expect([...tokenize("Hopf 代数 a")].sort()).toEqual(["hopf", "代数"]);
    expect([...tokenize("群论 基础")].sort()).toEqual(["基础", "群论"]);
    expect([...tokenize("群")]).toEqual(["群"]);
    expect([...tokenize("かな")]).toEqual(["かな"]);
  });

  test("compares titles by shared tokens, plurals and numbers", () => {
    expect(titleSimilarity("Tensor Product", "tensor products")).toBe(1);
    expect(titleSimilarity("Category", "Categories")).toBe(1);
    expect(titleSimilarity("Lecture 1", "Lecture 2")).toBe(0);
    expect(titleSimilarity("群论 基础", "群论基础")).toBeCloseTo(2 / 3);
    expect(titleSimilarity("Groups", "Rings")).toBe(0);
    // Different concepts that merely share a prefix stay different titles.
    expect(titleSimilarity("Group", "Groupoid")).toBe(0);
    expect(titleSimilarity("tensor", "tensorforscientist")).toBe(0);
    expect(titleSimilarity("", "")).toBe(0);
  });

  test("finds similar titles through aliases and skips redirects and dates", () => {
    const notes = [
      { title: "Tensor Product", aliases: ["张量积"], file: "a" },
      { title: "Tensor Products", aliases: [], kind: "redirect", file: "b" },
      { title: "Rings", aliases: [], file: "c" },
    ];
    expect(similarTitles("张量积", notes).map((item) => item.note.file)).toEqual(["a"]);
    expect(similarTitles("tensor products", notes).map((item) => item.name)).toEqual(["Tensor Product"]);
    expect(similarTitles("2026-10-10", [{ title: "2026-10-10", aliases: [] }])).toEqual([]);
  });

  test("pairs likely duplicates once", () => {
    const notes = [
      { title: "Quantum Error Correction", aliases: [], file: "a" },
      { title: "Quantum error corrections", aliases: [], file: "b" },
      { title: "Quantum Walks", aliases: [], file: "c" },
    ];
    const pairs = similarTitlePairs(notes);
    expect(pairs.map((pair) => [pair.left.file, pair.right.file])).toEqual([["a", "b"]]);
  });

  test("weights rare terms", () => {
    expect(rareTokenWeight(100, 1)).toBeGreaterThan(rareTokenWeight(100, 50));
  });
});

describe("nanoMuse recall translation", () => {
  test("keeps the entries that stand out from the rest", () => {
    expect(standouts([{ score: 5 }, { score: 5 }, { score: 1 }], 10).map((item) => item.score)).toEqual([5, 5]);
    const many = [9, 1, 1, 1, 1, 1, 1, 1].map((score) => ({ score }));
    expect(standouts(many, 10).map((item) => item.score)).toEqual([9]);
    expect(standouts([{ score: 3 }, { score: 2 }, { score: 1 }], 1).map((item) => item.score)).toEqual([3]);
    expect(standouts([], 10)).toEqual([]);
  });
});
