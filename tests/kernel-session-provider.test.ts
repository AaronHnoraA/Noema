import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-ignore Node ESM provider lives outside the TypeScript app graph.
import { createKernelSessionProvider } from "../server/lib/kernel-session-provider.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop kernel session provider", () => {
  test("maps the absolute-file facade to portable notebook paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-session-provider-"));
    roots.push(root);
    await mkdir(join(root, "nested"), { recursive: true });
    const file = join(root, "nested", "note.md");
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      const openedAt = Number(body.openedAt) || 10;
      const updatedAt = Number(body.updatedAt) || 20;
      return new Response(JSON.stringify({ code: 0, data: {
        source: "kernel-session",
        recent: [{ notebook: "box-a", path: "/nested/note.md", openedAt }],
        positions: [{
          notebook: "box-a", path: "/nested/note.md", client: "left", mode: "source",
          from: 4, to: 8, scrollY: 12, updatedAt,
        }],
      } }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const provider = createKernelSessionProvider({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-a", root },
      fetchImpl,
    });

    expect(provider.owns(file)).toBe(true);
    await expect(provider.read()).resolves.toMatchObject({
      source: "kernel-session",
      recent: [{ file, openedAt: 10 }],
      positions: [{ file, client: "left", mode: "source", from: 4 }],
    });
    await expect(provider.touchRecent(file, 30)).resolves.toMatchObject({ recent: [{ file, openedAt: 30 }] });
    await expect(provider.touchPosition({ file, client: "right", mode: "markdown", from: 9, updatedAt: 40 }))
      .resolves.toMatchObject({ positions: [{ file, updatedAt: 40 }] });
    expect(calls).toEqual([
      { url: "http://127.0.0.1:6806/api/noema/session/read", body: { notebook: "box-a" } },
      {
        url: "http://127.0.0.1:6806/api/noema/session/touchRecent",
        body: { notebook: "box-a", path: "/nested/note.md", openedAt: 30 },
      },
      {
        url: "http://127.0.0.1:6806/api/noema/session/touchPosition",
        body: {
          notebook: "box-a", path: "/nested/note.md", client: "right", mode: "markdown",
          from: 9, to: 0, scrollY: 0, updatedAt: 40,
        },
      },
    ]);
  });

  test("fails closed on invalid kernel identity or an out-of-box write", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-session-invalid-"));
    roots.push(root);
    const provider = createKernelSessionProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-a", root },
      fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: {
        source: "kernel-session",
        recent: [{ notebook: "other-box", path: "/note.md", openedAt: 1 }],
        positions: [],
      } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    await expect(provider.read()).rejects.toMatchObject({ statusCode: 502 });
    await expect(provider.touchRecent(join(root, "..", "outside.md"), 1)).rejects.toMatchObject({ statusCode: 403 });
  });
});
