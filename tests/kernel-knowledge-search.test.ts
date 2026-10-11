import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore The search adapter is a Node ESM module outside the TS app graph.
import { createKernelKnowledgeSearch, kernelLexicalSearchEligible } from "../server/lib/kernel-knowledge-search.mjs";
// @ts-ignore
import { knowledgeSearchResponse } from "../server/lib/knowledge-search.mjs";

describe("data-kernel knowledge search", () => {
  test("every search is the kernel's; related pages and the empty suggestion are not searches", () => {
    expect(kernelLexicalSearchEligible({ query: "portable identity", mode: "suggest" })).toBe(true);
    expect(kernelLexicalSearchEligible({ query: "tag:design portable" })).toBe(true);
    expect(kernelLexicalSearchEligible({ query: "-repo:private portable" })).toBe(true);
    expect(kernelLexicalSearchEligible({ query: "" })).toBe(true);
    expect(kernelLexicalSearchEligible({ query: "", mode: "suggest" })).toBe(false);
    expect(kernelLexicalSearchEligible({ query: "portable", mode: "related" })).toBe(false);
  });

  test("sends the whole request to the kernel and returns its answer", async () => {
    let url = "";
    let requestBody: Record<string, unknown> = {};
    const answer = {
      ok: true, type: "wiki-search", source: "kernel-wiki", generation: "g1", total: 1, match: "full", nextCursor: null,
      items: [{ id: "id-1", title: "Identity", matchKind: "fuzzy", excerpt: "Portable [[identity]] source" }],
      explain: ['a word beginning "identty"'], corrected: { from: "identty", to: "identity" },
    };
    const search = createKernelKnowledgeSearch({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-a", root: "/vault" },
      fetchImpl: async (target: string, init: RequestInit) => {
        url = target;
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ code: 0, data: answer }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const result = await search({ generation: "g1", notes: [] }, {
      query: "Math:identty tag:design", mode: "suggest", limit: 8, cursor: 16, namespace: "Math", sort: "recent",
      allowedRepositoryIds: ["public/Math"],
    });
    expect(url).toBe("http://127.0.0.1:6806/api/noema/knowledge/search");
    expect(requestBody).toEqual({
      notebook: "box-a", query: "Math:identty tag:design", mode: "suggest", limit: 8, cursor: 16,
      repositoryId: "", partition: "", namespace: "Math", sort: "recent", allowedRepositoryIds: ["public/Math"],
    });
    expect(result).toEqual(answer);

    // The host adds what its pages show and keeps what the kernel explained.
    const response = knowledgeSearchResponse({ generation: "g1", notes: [] }, { query: "identty" }, result);
    expect(response).toMatchObject({
      type: "knowledge-search", total: 1, corrected: { from: "identty", to: "identity" },
      explain: ['a word beginning "identty"'],
      items: [{ id: "id-1", matchKind: "fuzzy", reasons: ["similar title"] }],
    });
  });

  test("a reference lookup carries its note and comes back untouched", async () => {
    let requestBody: Record<string, unknown> = {};
    const answer = { ok: true, type: "wiki-references", source: "kernel-wiki", scope: "here", total: 1,
      items: [{ kind: "heading", label: "Setup", insert: "[Setup](#setup)" }], explain: [] };
    const search = createKernelKnowledgeSearch({
      baseUrl: "http://127.0.0.1:6806", box: { id: "box-a", root: "/vault" },
      fetchImpl: async (_target: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ code: 0, data: answer }), { status: 200 });
      },
    });
    const body = { query: "set", mode: "references", file: "/vault/n.md", content: "# Setup\n" };
    expect(kernelLexicalSearchEligible(body)).toBe(true);
    const result = await search({}, body);
    expect(requestBody).toMatchObject({ mode: "references", file: "/vault/n.md", content: "# Setup\n" });
    expect(knowledgeSearchResponse({ notes: [] }, body, result)).toBe(result);

    // An empty lookup is still the kernel's: it lists this page.
    expect(kernelLexicalSearchEligible({ query: "", mode: "references" })).toBe(true);
    const down = createKernelKnowledgeSearch({
      baseUrl: "http://127.0.0.1:6806", box: { id: "box-a", root: "/vault" },
      fetchImpl: async () => { throw new Error("down"); },
    });
    expect(await down({}, body)).toMatchObject({ ok: false, type: "wiki-references", items: [] });
  });

  test("a kernel that cannot answer falls back to the host's search and says so", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-search-"));
    try {
      const failures: unknown[] = [];
      for (const fetchImpl of [
        async () => { throw new Error("connect ECONNREFUSED"); },
        async () => new Response("not found", { status: 404 }),
        async () => new Response(JSON.stringify({ code: -1, msg: "notebook is required" }), { status: 200 }),
      ]) {
        const search = createKernelKnowledgeSearch({
          baseUrl: "http://127.0.0.1:6806", box: { id: "box-a", root }, fetchImpl,
          onFallback: (error: unknown) => failures.push(error),
        });
        const result = await search({}, { query: "anything" });
        expect(result).toMatchObject({ ok: true, type: "wiki-search", source: "host-wiki-fallback", items: [], total: 0 });
      }
      expect(failures).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
