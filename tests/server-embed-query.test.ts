import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore Server facade modules live outside the TS app graph.
import { buildEmbedQuery, configure, configurePlanningProvider } from "../server/lib/index.mjs";

const roots: string[] = [];

afterEach(async () => {
  configurePlanningProvider(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable query embeds", () => {
  test("uses a stable synthetic query ID and projects only safe Markdown fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-server-embed-"));
    roots.push(root);
    const file = join(root, "query.md");
    const target = join(root, "target.md");
    await Promise.all([writeFile(file, "# Query\n", "utf8"), writeFile(target, "# Target\n", "utf8")]);
    configure({ root, workspaceRoot: root, stateRoot: join(root, "state") });
    const requests: any[] = [];
    configurePlanningProvider({
      owns(candidate: string) { return candidate === file || candidate === target; },
      async searchEmbed(request: any) {
        requests.push(request);
        return { blocks: [{
          id: "projection-query", canonicalId: "0198fc34-7b32-7a11-8cb4-6c40e3b33d73", rootId: "root-query",
          file, path: "/query.md", hPath: "Noema/query", markdown: "The SQL carrier matched itself",
          type: "NodeParagraph", subType: "", breadcrumb: [],
        }, {
          id: "projection-a", canonicalId: "0198fc34-7b32-7a11-8cb4-6c40e3b33d72", rootId: "root-a",
          file: target, path: "/target.md", hPath: "Noema/target", markdown: "Portable **result**",
          type: "NodeParagraph", subType: "", breadcrumb: [{ name: "Noema/target" }],
          content: "<script>must-not-cross-the-facade()</script>",
        }] };
      },
    });
    const body = {
      file,
      title: "Recent claims {#0198fc34-7b32-7a11-8cb4-6c40e3b33d73}",
      source: "sql: SELECT * FROM blocks WHERE type = 'p' LIMIT 5",
    };
    const first = await buildEmbedQuery(body);
    await buildEmbedQuery(body);
    expect(first).toEqual({
      type: "embed-query", title: "Recent claims", blockId: "0198fc34-7b32-7a11-8cb4-6c40e3b33d73",
      diagnostics: [], evaluationSource: "kernel-search-embed", total: 1,
      items: [{
        id: "0198fc34-7b32-7a11-8cb4-6c40e3b33d72", projectionId: "projection-a", rootId: "root-a",
        file: target, path: "/target.md", hPath: "Noema/target", markdown: "Portable **result**",
        markdownTruncated: false, kind: "NodeParagraph", subType: "", breadcrumb: [{ name: "Noema/target" }],
      }],
    });
    expect(requests[0]).toMatchObject({
      statement: "SELECT * FROM blocks WHERE type = 'p' LIMIT 5", headingMode: 0, breadcrumb: true,
      embedBlockID: expect.stringMatching(/^20000101000000-[0-9a-z]{7}$/),
    });
    expect(requests[1].embedBlockID).toBe(requests[0].embedBlockID);
    expect(JSON.stringify(first)).not.toContain("must-not-cross-the-facade");
  });

  test("returns source diagnostics before transport and is explicit when the desktop kernel is absent", async () => {
    expect(await buildEmbedQuery({ title: "Unsafe", source: "DELETE FROM blocks" })).toMatchObject({
      evaluationSource: "portable-embed-parser", total: 0,
      diagnostics: [{ kind: "invalid-query" }],
    });
    await expect(buildEmbedQuery({ file: "/tmp/query.md", title: "Query", source: "SELECT 1" }))
      .rejects.toMatchObject({ statusCode: 501 });
  });
});
