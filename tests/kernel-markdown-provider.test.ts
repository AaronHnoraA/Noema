import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

  test("resolves canonical block IDs to a verified file inside the registered box", async () => {
    const root = await setupRoot();
    const id = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68";
    const requests: Array<{ url: string; body: Record<string, string> }> = [];
    const provider = createKernelMarkdownProvider({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-a", root },
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ code: 0, data: {
          id, notebook: "box-a", path: "/nested/note.md", line: 4, type: "NodeParagraph",
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    await expect(provider.resolveBlock(id.toUpperCase())).resolves.toEqual({
      id,
      notebook: "box-a",
      path: "/nested/note.md",
      file: await realpath(join(root, "nested", "note.md")),
      line: 4,
      blockType: "NodeParagraph",
    });
    expect(requests).toEqual([{
      url: "http://127.0.0.1:6806/api/noema/markdown/resolveBlock",
      body: { id },
    }]);
  });

  test("rejects invalid IDs and kernel locations outside the registered box", async () => {
    const root = await setupRoot();
    let calls = 0;
    const provider = createKernelMarkdownProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-a", root },
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ code: 0, data: {
          id: "20260825095344-i40x2sr",
          notebook: "box-a",
          path: "/../outside.md",
          line: 1,
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    await expect(provider.resolveBlock("ordinary-block")).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toBe(0);
    await expect(provider.resolveBlock("20260825095344-i40x2sr"))
      .rejects.toMatchObject({ statusCode: 502 });
    expect(calls).toBe(1);
  });

  test("loads and saves exact source bytes through the Go endpoints", async () => {
    const root = await setupRoot();
    const file = join(root, "nested", "note.md");
    const requests: Array<{ url: string; body: Record<string, string> }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      requests.push({ url, body });
      if (url.endsWith("/movePath")) {
        return new Response(JSON.stringify({ code: 0, data: {
          ...body,
          directory: true,
          documents: [{ ...body, fromPath: "/nested/note.md", toPath: "/renamed/note.md", id: "doc-projection" }],
        } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/moveDoc")) {
        return new Response(JSON.stringify({ code: 0, data: { ...body, id: "doc-projection" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
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
    expect(await provider.write({ file, content: "# Exact\n\nBody\n", expectedVersion: "base-version" })).toMatchObject({
      ok: true,
      content: "# Exact\n\nBody\n",
    });
    const target = join(root, "nested", "renamed.md");
    expect(await provider.move({ file, target })).toMatchObject({
      ok: true,
      file: target,
      oldFile: file,
      id: "doc-projection",
    });
    const targetDirectory = join(root, "renamed");
    expect(await provider.move({ file: join(root, "nested"), target: targetDirectory, directory: true })).toMatchObject({
      ok: true,
      file: targetDirectory,
      oldFile: join(root, "nested"),
      directory: true,
      documents: [{ fromPath: "/nested/note.md", toPath: "/renamed/note.md" }],
    });
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:6806/api/noema/markdown/loadDoc",
        body: { notebook: "box-a", path: "/nested/note.md" },
      },
      {
        url: "http://127.0.0.1:6806/api/noema/markdown/saveDoc",
        body: { notebook: "box-a", path: "/nested/note.md", markdown: "# Exact\n\nBody\n", expectedVersion: "base-version" },
      },
      {
        url: "http://127.0.0.1:6806/api/noema/markdown/moveDoc",
        body: { notebook: "box-a", fromPath: "/nested/note.md", toPath: "/nested/renamed.md" },
      },
      {
        url: "http://127.0.0.1:6806/api/noema/markdown/movePath",
        body: { notebook: "box-a", fromPath: "/nested", toPath: "/renamed" },
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

  test("returns kernel CAS conflicts without treating current disk bytes as a rewrite", async () => {
    const root = await setupRoot();
    const file = join(root, "nested", "note.md");
    const provider = createKernelMarkdownProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-a", root },
      fetchImpl: async () => new Response(JSON.stringify({
        code: 0,
        data: {
          markdown: "# External\n",
          blocks: [],
          conflict: true,
          mtimeMs: 42,
          size: 11,
          version: "external-version",
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    await expect(provider.write({ file, content: "# Local\n", expectedVersion: "base-version" }))
      .resolves.toMatchObject({
        ok: false,
        conflict: true,
        content: "# External\n",
        mtimeMs: 42,
        size: 11,
        version: "external-version",
      });
  });

  test("forwards metadata intent and live editor source without interpreting the block in Node", async () => {
    const root = await setupRoot();
    const file = join(root, "nested", "note.md");
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = createKernelMarkdownProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-a", root },
      fetchImpl: async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ code: 0, data: {
          changed: true,
          markdown: "#+begin meta\n#+end meta\n\n# Live\n",
          version: "meta-version",
          source: "kernel-meta",
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    const result = await provider.mutateMeta({
      file,
      content: "# Live\n",
      title: "Live",
      project: "phase-3",
      tags: ["meta", "kernel"],
    }, "add");

    expect(result).toMatchObject({ changed: true, source: "kernel-meta", version: "meta-version" });
    expect(calls).toEqual([{
      url: "http://127.0.0.1:6806/api/noema/markdown/mutateMeta",
      body: {
        notebook: "box-a",
        path: "/nested/note.md",
        action: "add",
        markdown: "# Live\n",
        title: "Live",
        project: "phase-3",
        tags: ["meta", "kernel"],
      },
    }]);
    await expect(provider.mutateMeta({ file, tags: "meta" }, "tag"))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
