import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
// @ts-ignore Node ESM module outside the TS app graph.
import { createKernelWikiIndexBuilder } from "../server/lib/kernel-wiki-index.mjs";
// @ts-ignore Node ESM module outside the TS app graph.
import { buildWikiIndex, configureWikiIndexBuilder } from "../server/lib/wiki-workspace.mjs";

afterEach(() => configureWikiIndexBuilder(null));

describe("the kernel owns the Wiki index", () => {
  test("a refresh while the kernel is not running fails instead of being done by the host", async () => {
    const build = createKernelWikiIndexBuilder({ kernel: () => ({ ready: false }), fetchImpl: async () => { throw new Error("no"); } });
    await expect(build("/v")).rejects.toThrow(/not running/);
  });

  test("the builder asks the kernel for the registered vault only", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ code: 0, data: { index: { notes: [] }, mode: "incremental", reason: "changes", changed: 0, elapsedMs: 1 } }));
    }) as unknown as typeof fetch;
    const build = createKernelWikiIndexBuilder({ kernel: () => ({ ready: true, baseUrl: "http://k/", box: { id: "box1", root: "/v" } }), fetchImpl });
    await build("/v", { full: true });
    expect(calls).toEqual([{ url: "http://k/api/noema/wiki/refresh", body: { notebook: "box1", full: true, includeIndex: true } }]);
    await expect(build("/elsewhere")).rejects.toThrow(/indexes \/v/);
  });

  test("buildWikiIndex takes the kernel's index and adds the relationships", async () => {
    const root = mkdtempSync(join(tmpdir(), "kernel-index-"));
    try {
      const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "shared/wiki-db-fixtures.json"), "utf8").split("$ROOT").join(root));
      let asked: unknown = null;
      configureWikiIndexBuilder(async (_root: string, options: unknown) => {
        asked = options;
        return { index: fixture.index, mode: "full", reason: "no-db", changed: 9, elapsedMs: 3 };
      });
      const index = await buildWikiIndex(root, { layout: "wiki", mode: "full" });
      expect(asked).toEqual({ full: true });
      expect(index.notes).toHaveLength(fixture.index.notes.length);
      expect(index.notes.some((note: object) => "searchText" in note)).toBe(false);
      // Relationships are the host's in-memory view of the same links the kernel wrote.
      const linked = index.notes.filter((note: { refs?: string[] }) => (note.refs ?? []).length > 0);
      expect(linked.length).toBeGreaterThan(0);
      expect(index.maintenance).toMatchObject({ builder: "kernel", mode: "full", reason: "no-db" });
      expect(index.directories.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a kernel error reaches the caller", async () => {
    configureWikiIndexBuilder(async () => { throw new Error("kernel restarting"); });
    await expect(buildWikiIndex("/v", { layout: "wiki" })).rejects.toThrow(/kernel restarting/);
  });
});
