import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore Server ESM module lives outside the renderer TypeScript graph.
import { aaronnoteMarkdownToLatexPandoc } from "../server/lib/latex-export-pandoc.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("kernel-backed LaTeX transformation boundary", () => {
  test("uses Go preparation and postprocessing around the Node-owned Pandoc process", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-latex-kernel-transform-"));
    roots.push(root);
    const pandoc = join(root, "pandoc-shim");
    await writeFile(pandoc, "#!/bin/sh\nexec /bin/cat\n", "utf8");
    await chmod(pandoc, 0o755);
    const provider = {
      prepare: vi.fn(async () => ({
        meta: { title: "Go title" },
        markdown: "prepared by Go\n",
        warnings: ["Go warning"],
        features: { usesSideComment: false, usesTikz: true },
      })),
      postprocess: vi.fn(async (latex: string) => `postprocessed:${latex}`),
    };
    const result = await aaronnoteMarkdownToLatexPandoc("private source", {
      pandocBin: pandoc,
      rules: { hiddenBlocks: ["secret"] },
      citationKeyMap: new Map([["refs\0Key", "refs:Key"]]),
      transformProvider: provider,
    });
    expect(provider.prepare).toHaveBeenCalledWith("private source", {
      rules: { hiddenBlocks: ["secret"] },
      citationKeyMap: new Map([["refs\0Key", "refs:Key"]]),
    });
    expect(provider.postprocess).toHaveBeenCalledWith("prepared by Go\n");
    expect(result).toEqual({
      meta: { title: "Go title" },
      body: "postprocessed:prepared by Go\n",
      features: { usesSideComment: false, usesTikz: true },
      warnings: ["Go warning"],
      preprocessedMarkdown: "prepared by Go\n",
      transformSource: "kernel-latex",
    });
  });

  test("rejects a partial transform provider instead of mixing Go and Node transforms", async () => {
    await expect(aaronnoteMarkdownToLatexPandoc("source", {
      pandocBin: "/does/not/run",
      transformProvider: { prepare: vi.fn() },
    })).rejects.toThrow("provider is incomplete");
  });

  test("fails closed when the configured Go transform rejects the source", async () => {
    const provider = {
      prepare: vi.fn(async () => { throw new Error("unclosed private block"); }),
      postprocess: vi.fn(),
    };
    await expect(aaronnoteMarkdownToLatexPandoc("source", {
      pandocBin: "/does/not/run",
      transformProvider: provider,
    })).rejects.toThrow("unclosed private block");
    expect(provider.postprocess).not.toHaveBeenCalled();
  });
});
