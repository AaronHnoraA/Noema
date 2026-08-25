import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore Server ESM modules live outside the renderer TS graph.
import { configureKatexMacrosProvider, loadRuntimeKatexMacros } from "../server/lib/index.mjs";

const roots: string[] = [];

afterEach(async () => {
  configureKatexMacrosProvider(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime KaTeX macro data plane", () => {
  test("uses the Go provider in desktop mode", async () => {
    configureKatexMacrosProvider({
      async load(dir: string) {
        return { dir, macros: { "\\GoMacro": "\\mathbf{G}" }, errors: [] };
      },
    });
    await expect(loadRuntimeKatexMacros("/desktop/macros")).resolves.toEqual({
      dir: "/desktop/macros",
      macros: { "\\GoMacro": "\\mathbf{G}" },
      errors: [],
      source: "kernel-katex-macros",
    });
  });

  test("retains the Node parser for Emacs and kernel outages", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-katex-fallback-"));
    roots.push(root);
    await writeFile(join(root, "fallback.tex"), "\\newcommand{\\Fallback}{\\mathbb{F}}", "utf8");
    configureKatexMacrosProvider({ async load() { throw new Error("kernel unavailable"); } });
    await expect(loadRuntimeKatexMacros(root)).resolves.toMatchObject({
      dir: root,
      macros: { "\\Fallback": "\\mathbb{F}" },
      errors: [],
      source: "node-katex-macros",
    });
  });
});
