import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore The provider is a Node ESM module outside the TS app graph.
import { createKernelMarkdownProvider, kernelMarkdownPath } from "../server/lib/kernel-markdown-provider.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupRoot() {
  const root = await mkdtemp(join(tmpdir(), "noema-kernel-provider-"));
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "nested", "note.md"), "# Note\n", "utf8");
  roots.push(root);
  return root;
}

describe("desktop kernel Markdown provider", () => {
  test("maps only Markdown files inside the registered box", async () => {
    const root = await setupRoot();
    expect(kernelMarkdownPath(root, join(root, "nested", "note.md"))).toBe("/nested/note.md");
    expect(kernelMarkdownPath(root, join(root, "nested", "note.markdown"))).toBe("/nested/note.markdown");
    expect(kernelMarkdownPath(root, join(root, "nested", "asset.txt"))).toBe("");
    expect(kernelMarkdownPath(root, join(root, "..", "outside.md"))).toBe("");
  });

  test("loads and saves exact source bytes through the Go endpoints", async () => {
    const root = await setupRoot();
    const file = join(root, "nested", "note.md");
    const requests: Array<{ url: string; body: Record<string, string> }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      requests.push({ url, body });
      const markdown = url.endsWith("/loadDoc") ? "# From kernel\n" : body.markdown;
      return new Response(JSON.stringify({ code: 0, data: { markdown, blocks: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const provider = createKernelMarkdownProvider({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-a", root },
      fetchImpl,
    });

    expect(provider.owns(file)).toBe(true);
    expect(await provider.read(file)).toMatchObject({ file, content: "# From kernel\n" });
    expect(await provider.write({ file, content: "# Exact\n\nBody\n" })).toMatchObject({
      ok: true,
      content: "# Exact\n\nBody\n",
    });
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:6806/api/noema/markdown/loadDoc",
        body: { notebook: "box-a", path: "/nested/note.md" },
      },
      {
        url: "http://127.0.0.1:6806/api/noema/markdown/saveDoc",
        body: { notebook: "box-a", path: "/nested/note.md", markdown: "# Exact\n\nBody\n" },
      },
    ]);
  });

  test("rejects a kernel response that rewrites Markdown", async () => {
    const root = await setupRoot();
    const file = join(root, "nested", "note.md");
    const provider = createKernelMarkdownProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-a", root },
      fetchImpl: async () => new Response(JSON.stringify({
        code: 0,
        data: { markdown: "normalized\n", blocks: [] },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    await expect(provider.write({ file, content: "source\n" })).rejects.toThrow("changed Markdown source bytes");
  });
});
