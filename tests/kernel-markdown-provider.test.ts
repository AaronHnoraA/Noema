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

  test("maps the Go rich catalog into the existing editor note contract", async () => {
    const root = await setupRoot();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = createKernelMarkdownProvider({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-a", root },
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ code: 0, data: {
          notes: [{
            id: "note-id", key: "note-id", title: "Note",
            path: "nested/note.md", link: "nested/note.md", file: "/untrusted/kernel/path.md",
            tags: [], refs: [], backlinks: [], blocks: [], domTargets: [],
          }],
          directories: [{ path: "nested", label: "Nested" }],
          files: [],
          indexVersion: 7,
          source: "kernel-note-catalog",
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    await expect(provider.catalog(true)).resolves.toEqual({
      type: "notes",
      notes: [expect.objectContaining({
        id: "note-id",
        file: join(root, "nested", "note.md"),
        path: "nested/note.md",
        link: "nested/note.md",
        standalone: false,
      })],
      directories: [{ path: "nested", label: "Nested" }],
      files: [],
      indexVersion: 7,
      source: "kernel-note-catalog",
    });
    expect(requests).toEqual([{
      url: "http://127.0.0.1:6806/api/noema/markdown/catalog",
      body: { notebook: "box-a", force: true },
    }]);
  });

  test("rejects a rich catalog path outside the registered box", async () => {
    const root = await setupRoot();
    const provider = createKernelMarkdownProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-a", root },
      fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: {
        notes: [{ id: "bad", path: "../outside.md" }], directories: [], files: [],
      } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    await expect(provider.catalog()).rejects.toMatchObject({ statusCode: 502 });
  });

  test("forwards virtual references to Go and distrusts every returned filesystem path", async () => {
    const root = await setupRoot();
    const file = join(root, "nested", "note.md");
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = createKernelMarkdownProvider({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-a", root },
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ code: 0, data: {
          type: "virtual-references",
          evaluationSource: "noema-aho-corasick",
          target: { id: "target", title: "Target", path: "target.md", file: "/untrusted/target.md" },
          mentions: [{
            sourceId: "note-id", sourceTitle: "Note", file: "/untrusted/mention.md",
            path: "nested/note.md", count: 2, keywords: ["Target"], snippet: "Target appears twice",
          }],
          scannedDocuments: 2,
          ttlMs: 600_000,
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    await expect(provider.virtualReferences({ targetId: "target", file, title: "Target" })).resolves.toEqual(expect.objectContaining({
      type: "virtual-references",
      target: { id: "target", title: "Target", file: join(root, "target.md"), path: "target.md" },
      mentions: [expect.objectContaining({
        sourceId: "note-id",
        file: "",
        path: "nested/note.md",
        note: undefined,
      })],
    }));
    expect(requests).toEqual([{
      url: "http://127.0.0.1:6806/api/noema/markdown/virtualReferences",
      body: {
        notebook: "box-a", targetId: "target", id: "", path: "/nested/note.md",
        title: "Target", caseSensitive: false,
      },
    }]);
  });

  test("rejects a virtual-reference mention path outside the registered box", async () => {
    const root = await setupRoot();
    const provider = createKernelMarkdownProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-a", root },
      fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: {
        type: "virtual-references",
        target: null,
        mentions: [{ sourceId: "bad", sourceTitle: "Bad", path: "../outside.md", count: 1, keywords: ["Bad"], snippet: "Bad" }],
      } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    await expect(provider.virtualReferences({ targetId: "bad" })).rejects.toMatchObject({ statusCode: 502 });
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
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
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
      if (url.endsWith("/applyChanges")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { mtimeMs: Date.now(), size: 16, version: "incremental-version" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const markdown = url.endsWith("/loadDoc") ? "# From kernel\n" : body.markdown;
      return new Response(JSON.stringify({ code: 0, data: {
        markdown, blocks: [], mtimeMs: 1234, size: 14, version: "source-version",
      } }), {
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
    expect(await provider.read(file)).toEqual({
      file,
      content: "# From kernel\n",
      mtimeMs: 1234,
      size: 14,
      version: "source-version",
    });
    expect(await provider.write({ file, content: "# Exact\n\nBody\n", expectedVersion: "base-version" })).toMatchObject({
      ok: true,
      content: "# Exact\n\nBody\n",
    });
    expect(
      await provider.writeChanges({
        file,
        expectedVersion: "saved-version",
        changes: { length: 15, newLength: 16, changes: [{ from: 2, to: 7, insert: "Exact!" }] },
      }),
    ).toMatchObject({ ok: true });
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
        body: { notebook: "box-a", path: "/nested/note.md", includeBlocks: false },
      },
      {
        url: "http://127.0.0.1:6806/api/noema/markdown/saveDoc",
        body: { notebook: "box-a", path: "/nested/note.md", markdown: "# Exact\n\nBody\n", expectedVersion: "base-version" },
      },
      {
        url: "http://127.0.0.1:6806/api/noema/markdown/applyChanges",
        body: {
          notebook: "box-a",
          path: "/nested/note.md",
          expectedVersion: "saved-version",
          changes: { length: 15, newLength: 16, changes: [{ from: 2, to: 7, insert: "Exact!" }] },
        },
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

  /**
   * Kernel request-count guardrail for the typing hot path.
   *
   * Every CM6 save reaches the Go kernel through this provider. A read before
   * the write would double the round trips on the one path that runs while the
   * user is typing, and would reintroduce a read/compare/write race that the
   * kernel's own CAS is there to own. Pin both the count and the shape.
   */
  test("an incremental save costs exactly one kernel round trip", async () => {
    const root = await setupRoot();
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const provider = createKernelMarkdownProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "notebook", root },
      fetchImpl: async (url: string, init: { body: string }) => {
        calls.push({
          path: new URL(url).pathname,
          body: JSON.parse(init.body) as Record<string, unknown>,
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: { version: "v2", mtimeMs: 42, size: 7 },
          }),
        };
      },
    });

    const saved = await provider.writeChanges({
      file: join(root, "nested", "note.md"),
      changes: { from: 0, to: 0, insert: "x" },
      expectedVersion: "v1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/noema/markdown/applyChanges");
    // The base version travels with the write so the kernel performs one
    // authoritative compare-and-swap; Node must not pre-read to compare.
    expect(calls[0]!.body.expectedVersion).toBe("v1");
    expect(calls[0]!.body.path).toBe("/nested/note.md");
    expect(saved.version).toBe("v2");
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

  test("fails closed when an incremental kernel response omits the next version", async () => {
    const root = await setupRoot();
    const file = join(root, "nested", "note.md");
    const provider = createKernelMarkdownProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-a", root },
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 0, data: { mtimeMs: 42, size: 11 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(
      provider.writeChanges({
        file,
        expectedVersion: "base-version",
        changes: { length: 1, newLength: 2, changes: [{ from: 1, to: 1, insert: "x" }] },
      }),
    ).rejects.toMatchObject({ statusCode: 502 });
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
