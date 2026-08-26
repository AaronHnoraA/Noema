import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore Server facade modules live outside the TS app graph.
import { configure, configureMarkdownFileProvider } from "../server/lib/state.mjs";
// @ts-ignore Server facade modules live outside the TS app graph.
import { resolveBlockReference } from "../server/lib/index.mjs";

const roots: string[] = [];

afterEach(async () => {
  configureMarkdownFileProvider(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production block-reference navigation", () => {
  test("returns the bounded kernel location through the shared host facade", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "noema-block-navigation-"));
    const notes = join(workspace, "notes");
    const file = join(notes, "target.md");
    const id = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68";
    roots.push(workspace);
    await mkdir(notes, { recursive: true });
    await writeFile(file, `Target {#${id}}\n`, "utf8");
    configure({ root: notes, workspaceRoot: workspace, stateRoot: join(workspace, "state") });

    const requested: string[] = [];
    configureMarkdownFileProvider({
      owns(candidate: string) { return candidate === file; },
      async resolveBlock(candidate: string) {
        requested.push(candidate);
        return {
          id,
          notebook: "box-a",
          path: "/target.md",
          file,
          line: 1,
          blockType: "NodeParagraph",
        };
      },
    });

    await expect(resolveBlockReference({ id: id.toUpperCase() })).resolves.toEqual({
      type: "block-reference-location",
      source: "kernel-block-index",
      id,
      file,
      path: "/target.md",
      line: 1,
      blockType: "NodeParagraph",
    });
    expect(requested).toEqual([id]);
  });

  test("rejects malformed IDs before transport and is explicit without the kernel", async () => {
    let calls = 0;
    configureMarkdownFileProvider({
      async resolveBlock() { calls++; return {}; },
    });
    await expect(resolveBlockReference({ id: "ordinary-block" }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toBe(0);

    configureMarkdownFileProvider(null);
    await expect(resolveBlockReference({ id: "20260825095344-i40x2sr" }))
      .rejects.toMatchObject({ statusCode: 501 });
  });
});
