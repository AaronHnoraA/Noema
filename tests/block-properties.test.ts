import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// @ts-ignore Shared ESM contract lives outside the TS app graph.
import { blockPropertyItemsForDocument, patchBlockPropertySource, scanBlockPropertyDefinitions } from "../shared/block-properties.mjs";

describe("portable UUIDv7 block properties", () => {
  test("matches the shared Go scanner fixtures", async () => {
    const fixtures = JSON.parse(await readFile(join(process.cwd(), "shared", "block-property-fixtures.json"), "utf8"));
    for (const fixture of fixtures) {
      expect(scanBlockPropertyDefinitions(fixture.source), fixture.name).toEqual(fixture.expected);
    }
  });

  test("excludes ambiguous duplicate identities from attribute-view items", () => {
    const id = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68";
    expect(blockPropertyItemsForDocument(`One {#${id} status=open}\nTwo {#${id} status=done}`, {
      file: "/note.md", noteTitle: "Note",
    })).toEqual([]);
  });

  test("patches one property while preserving the rest of the source anchor", () => {
    const id = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68";
    const source = `Claim {#${id} status=draft owner='Aaron He'}\n`;
    const replaced = patchBlockPropertySource(source, { id: `#${id}`, key: "owner", value: "Noema Team" });
    expect(replaced.markdown).toBe(`Claim {#${id} status=draft owner='Noema Team'}\n`);
    const added = patchBlockPropertySource(replaced.markdown, { id, key: "score", value: "7" });
    expect(added.markdown).toBe(`Claim {#${id} status=draft owner='Noema Team' score=7}\n`);
    const removed = patchBlockPropertySource(added.markdown, { id, key: "status", value: null });
    expect(removed.markdown).toBe(`Claim {#${id} owner='Noema Team' score=7}\n`);
    expect(() => patchBlockPropertySource(`${source}${source}`, { id, key: "owner", value: "x" })).toThrow(/ambiguous/i);
  });
});
