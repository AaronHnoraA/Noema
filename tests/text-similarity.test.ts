import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { rareTokenWeight, similarTitlePairs, similarTitles, titleSimilarity, tokenize } from "../shared/text-similarity.mjs";
import * as upstream from "../shared/nanomuse-recall.mjs";

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

// Behaviour fixed by nanoMuse's own tests and docstrings at the translated commit.
describe("nanoMuse recall translation", () => {
  test("tokenizes words in any script and CJK by bigram", () => {
    expect([...upstream.tokenize("Likes a window_seat в Пекине")].sort()).toEqual(["likes", "seat", "window", "пекине"]);
    expect([...upstream.tokenize("住在 上海")].sort()).toEqual(["上海", "住在", "在上"]);
    expect([...upstream.tokenize("群")]).toEqual(["群"]);
  });

  test("measures Jaccard overlap and falls back to equality without tokens", () => {
    expect(upstream.similarity("prefers window seats", "prefers window seats")).toBe(1);
    expect(upstream.similarity("prefers window seats", "lives in Shanghai")).toBe(0);
    expect(upstream.similarity("a", "A ")).toBe(1);
    expect(upstream.similarity("a", "b")).toBe(0);
  });

  test("matches inflected forms of words of five characters or more", () => {
    expect(upstream.sameStem("Пекине", ["Пекин"])).toBe(true);
    expect(upstream.sameStem("products", ["product"])).toBe(true);
    expect(upstream.sameStem("cats", ["cat"])).toBe(false);
    expect(upstream.sameStem("предпочитает", ["предпочтения"])).toBe(false);
  });

  test("ranks by rare shared words with a verbatim bonus", () => {
    const items = [
      { id: "a", content: "likes tea in the morning", createdAt: "1" },
      { id: "b", content: "likes a window seat on flights", createdAt: "2" },
      { id: "c", content: "likes hiking", createdAt: "3" },
    ];
    expect(upstream.search(items, "likes window", 10).map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(upstream.search(items, "window seat", 1).map((item) => item.id)).toEqual(["b"]);
    expect(upstream.search(items, "", 2).map((item) => item.id)).toEqual(["a", "b"]);
    expect(upstream.search(items, "submarine", 10)).toEqual([]);
  });

  test("fuses rankings by reciprocal rank and keeps standouts", () => {
    const [a, b, c] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(upstream.fuse([[a, b, c], [b, c, a]], 2).map((item) => item.id)).toEqual(["b", "a"]);
    expect(upstream.standouts([{ score: 5 }, { score: 5 }, { score: 1 }], 10).map((item) => item.score)).toEqual([5, 5]);
    const many = [9, 1, 1, 1, 1, 1, 1, 1].map((score) => ({ score }));
    expect(upstream.standouts(many, 10).map((item) => item.score)).toEqual([9]);
    expect(upstream.standouts([], 10)).toEqual([]);
  });
});
