import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore The production host wrapper is a Node ESM module outside the TS app graph.
import { clearVirtualReferencesCache, virtualReferencesPayload } from "../server/lib/virtual-references.mjs";

const roots: string[] = [];

afterEach(async () => {
  clearVirtualReferencesCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("server virtual references", () => {
  test("scans index-visible Markdown on demand and invalidates the ten-minute cache by index generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-virtual-refs-"));
    roots.push(root);
    const alpha = join(root, "alpha.md");
    const source = join(root, "source.md");
    const linked = join(root, "linked.md");
    await writeFile(alpha, "# Alpha\n", "utf8");
    await writeFile(source, "Alpha and First are discussed here.\n", "utf8");
    await writeFile(linked, "`Alpha` [First](alpha.md)\n", "utf8");
    const index = {
      generation: "g1",
      notes: [
        { id: "alpha", title: "Alpha", aliases: ["First"], file: alpha, refs: [] },
        { id: "source", title: "Source", file: source, refs: [] },
        { id: "linked", title: "Linked", file: linked, refs: ["alpha"] },
      ],
    };

    const initial = await virtualReferencesPayload(index, { targetId: "alpha" });
    expect(initial).toEqual(expect.objectContaining({
      type: "virtual-references",
      evaluationSource: "noema-aho-corasick",
      scannedDocuments: 3,
      ttlMs: 600_000,
    }));
    expect(initial.mentions).toHaveLength(1);
    expect(initial.mentions[0]).toEqual(expect.objectContaining({
      sourceId: "source",
      count: 2,
      keywords: ["Alpha", "First"],
      note: expect.objectContaining({ id: "source" }),
    }));

    await writeFile(source, "No mention remains.\n", "utf8");
    expect((await virtualReferencesPayload(index, { targetId: "alpha" })).mentions).toHaveLength(1);
    index.generation = "g2";
    expect((await virtualReferencesPayload(index, { targetId: "alpha" })).mentions).toEqual([]);
  });

  test("returns an empty bounded payload when the requested note is not index-visible", async () => {
    const result = await virtualReferencesPayload({ generation: "empty", notes: [] }, { targetId: "missing" });
    expect(result).toEqual({
      type: "virtual-references",
      evaluationSource: "noema-aho-corasick",
      target: null,
      mentions: [],
      ttlMs: 600_000,
    });
  });
});
