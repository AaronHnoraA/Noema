import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore The relationship adapter is a Node ESM module outside the TS app graph.
import { createKernelRelationshipOverlay } from "../server/lib/kernel-relationships.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop kernel relationship overlay", () => {
  test("merges native block refs without removing existing Wiki relationships", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-relationships-"));
    const sourceFile = join(root, "source.md");
    const targetFile = join(root, "nested", "target.md");
    roots.push(root);
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(sourceFile, "# Source\n", "utf8");
    await writeFile(targetFile, "# Target\n", "utf8");
    let requestBody: Record<string, unknown> = {};
    const overlay = createKernelRelationshipOverlay({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-a", root },
      fetchImpl: async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          code: 0,
          data: {
            relationships: [
              { fromPath: "/source.md", toPath: "/nested/target.md" },
              { fromPath: "/missing.md", toPath: "/nested/target.md" },
            ],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const original = {
      generation: "g1",
      notes: [
        { id: "source", file: sourceFile, refs: ["wiki-target"], backlinks: [] },
        { id: "target", file: targetFile, refs: [], backlinks: ["wiki-source"] },
      ],
    };

    const result = await overlay(original);
    expect(requestBody).toEqual({ notebook: "box-a" });
    expect(result.relationshipSource).toBe("kernel-refs");
    expect(result.notes).toEqual([
      { id: "source", file: sourceFile, refs: ["target", "wiki-target"], backlinks: [] },
      { id: "target", file: targetFile, refs: [], backlinks: ["source", "wiki-source"] },
    ]);
    expect(original.notes[0].refs).toEqual(["wiki-target"]);
  });
});
