import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore The search adapter is a Node ESM module outside the TS app graph.
import { createKernelKnowledgeSearch, kernelLexicalSearchEligible } from "../server/lib/kernel-knowledge-search.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop kernel knowledge search", () => {
  test("routes plain lexical queries but preserves Node-only query modes", () => {
    expect(kernelLexicalSearchEligible({ query: "portable identity", mode: "suggest" })).toBe(true);
    expect(kernelLexicalSearchEligible({ query: "" })).toBe(false);
    expect(kernelLexicalSearchEligible({ query: "portable", mode: "related" })).toBe(false);
    expect(kernelLexicalSearchEligible({ query: "tag:design portable" })).toBe(false);
    expect(kernelLexicalSearchEligible({ query: "-repo:private portable" })).toBe(false);
  });

  test("maps FTS5 box paths back to production WikiNote results", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-search-"));
    const noteFile = join(root, "nested", "identity.md");
    roots.push(root);
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(noteFile, "# Identity\n", "utf8");
    const note = {
      id: "019c3a56-87d4-7a4b-8a92-701f398eb702",
      title: "Identity",
      file: noteFile,
      path: "nested/identity.md",
      aliases: [],
      tags: ["architecture"],
      refs: [],
      backlinks: [],
    };
    let requestBody: Record<string, unknown> = {};
    const search = createKernelKnowledgeSearch({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-a", root },
      fetchImpl: async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          code: 0,
          data: {
            matchedBlockCount: 2,
            matchedRootCount: 1,
            blocks: [
              { box: "other-box", path: "/nested/identity.md", content: "ignored" },
              { box: "box-a", path: "/nested/identity.md", content: "Portable <mark>identity</mark> source" },
            ],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    const result = await search({ generation: "g1", notes: [note] }, {
      query: "identity",
      limit: 8,
    });

    expect(requestBody).toMatchObject({
      query: "identity",
      page: 1,
      pageSize: 8,
      paths: ["box-a/"],
      method: 0,
      orderBy: 7,
    });
    expect(result).toMatchObject({
      source: "kernel-fts5",
      generation: "g1",
      total: 1,
      nextCursor: null,
      items: [{ id: note.id, title: "Identity", excerpt: "Portable [[identity]] source" }],
    });
  });

  test("does not expose indexed paths missing from the production catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-search-catalog-"));
    roots.push(root);
    const search = createKernelKnowledgeSearch({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-a", root },
      fetchImpl: async () => new Response(JSON.stringify({
        code: 0,
        data: {
          matchedBlockCount: 1,
          matchedRootCount: 1,
          blocks: [{ box: "box-a", path: "/not-in-catalog.md", content: "private" }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    const result = await search({ generation: "g1", notes: [] }, { query: "private" });
    expect(result.items).toEqual([]);
  });
});
