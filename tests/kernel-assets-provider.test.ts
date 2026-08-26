import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore Node ESM modules live outside the TS application graph.
import { createKernelAssetsProvider } from "../server/lib/kernel-assets-provider.mjs";
// @ts-ignore Node ESM modules live outside the TS application graph.
import { configure, configureAssetProvider, scanUnusedAssets, storeAsset, storeAssetFromPath } from "../server/lib/runtime.mjs";

const roots: string[] = [];

afterEach(async () => {
  configureAssetProvider(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("kernel assets provider", () => {
  test("maps Markdown files and forwards bytes without changing the channel result", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-assets-provider-"));
    roots.push(root);
    const file = join(root, "notes", "topic.md");
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(file, "# Topic\n", "utf8");
    const calls: Array<{ url: string; body: any }> = [];
    const provider = createKernelAssetsProvider({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-id", root },
      fetchImpl: async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ code: 0, data: {
          ok: true, file: join(root, "notes/images/topic/plot.png"), name: "plot.png",
          type: "image/png", isImage: true, markdownPath: "./images/topic/plot.png", source: "kernel-assets",
        } }));
      },
    });

    const result = await provider.store({ file, name: "plot.png", type: "image/png", data: "UE5H" });

    expect(result.source).toBe("kernel-assets");
    expect(calls).toEqual([{
      url: "http://127.0.0.1:6806/api/noema/markdown/storeAsset",
      body: { notebook: "box-id", path: "/notes/topic.md", name: "plot.png", type: "image/png", data: "UE5H" },
    }]);
  });

  test("desktop runtime delegates path imports to Go without creating a Node copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-assets-runtime-"));
    roots.push(root);
    const notes = join(root, "notes");
    const file = join(notes, "topic.md");
    const source = join(root, "source.png");
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Topic\n", "utf8");
    await writeFile(source, "PNG", "utf8");
    configure({ root: notes, workspaceRoot: root, stateRoot: join(root, "state"), tmpRoot: join(root, "tmp") });
    const seen: any[] = [];
    configureAssetProvider({
      owns: (candidate: string) => candidate === file,
      store: async (body: any) => ({ ...body, ok: true, source: "kernel-assets" }),
      storeFromPath: async (body: any) => {
        seen.push(body);
        return { ok: true, file: join(notes, "images/topic/source.png"), markdownPath: "./images/topic/source.png", source: "kernel-assets" };
      },
    });

    const imported = await storeAssetFromPath({ file, path: source, type: "image/png" });
    const pasted = await storeAsset({ file, name: "paste.png", type: "image/png", data: "UE5H" });

    expect(imported.source).toBe("kernel-assets");
    expect(pasted.source).toBe("kernel-assets");
    expect(seen).toEqual([{ file, path: source, type: "image/png" }]);
    await expect(readFile(join(notes, "images/topic/source.png"), "utf8")).rejects.toThrow();
  });

  test("rejects files outside the registered Markdown box", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-assets-outside-"));
    roots.push(root);
    const provider = createKernelAssetsProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-id", root },
      fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: {} })),
    });
    expect(provider.owns(join(root, "../outside.md"))).toBe(false);
    await expect(provider.store({ file: join(root, "../outside.md"), data: "eA==" })).rejects.toMatchObject({ statusCode: 403 });
  });

  test("delegates orphan scanning to the registered box with the layout flag", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-assets-scan-"));
    roots.push(root);
    const calls: Array<{ url: string; body: any }> = [];
    const provider = createKernelAssetsProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-id", root },
      includePublic: true,
      fetchImpl: async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ code: 0, data: { source: "kernel-assets", assets: [
          { file: join(root, "attachments/orphan.pdf"), path: "attachments/orphan.pdf", name: "orphan.pdf", size: 3, mtimeMs: 1, type: "application/pdf", isImage: false },
        ] } }));
      },
    });
    configureAssetProvider(provider);

    const assets = await scanUnusedAssets();

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ path: "attachments/orphan.pdf", type: "application/pdf" });
    expect(calls).toEqual([{
      url: "http://127.0.0.1:6806/api/noema/markdown/listUnusedAssets",
      body: { notebook: "box-id", includePublic: true },
    }]);
  });

  test("routes Markdown asset maintenance and Obsidian tasks through the registered kernel box", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-assets-maintenance-"));
    roots.push(root);
    const vault = join(root, "Obsidian Vault");
    await mkdir(vault);
    const calls: Array<{ url: string; body: any }> = [];
    const provider = createKernelAssetsProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-id", root },
      fetchImpl: async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({ url, body });
        return new Response(JSON.stringify({ code: 0, data: String(url).includes("startObsidianVaultAnalysis")
          ? { taskID: "20260826153000-task001", state: "queued", progress: 0, message: "queued" }
          : { ok: true, assets: [], missing: [] } }));
      },
    });

    await provider.inspect();
    await provider.searchContent("needle", 12);
    await provider.rename(join(root, "attachments", "old.pdf"), "new.pdf");
    await provider.startObsidianAnalysis(vault);
    await provider.obsidianTask("20260826153000-task001");
    await provider.startObsidianImport("20260826153000-task001", "Imports/Vault");
    await provider.cancelObsidianTask("20260826153000-task001");

    expect(calls).toEqual([
      { url: "http://127.0.0.1:6806/api/noema/markdown/inspectAssets", body: { notebook: "box-id", includePublic: false } },
      { url: "http://127.0.0.1:6806/api/noema/markdown/searchAssetContent", body: { notebook: "box-id", query: "needle", limit: 12 } },
      { url: "http://127.0.0.1:6806/api/noema/markdown/renameAsset", body: { notebook: "box-id", oldPath: join(root, "attachments", "old.pdf"), newName: "new.pdf" } },
      { url: "http://127.0.0.1:6806/api/import/startObsidianVaultAnalysis", body: { localPath: vault } },
      { url: "http://127.0.0.1:6806/api/import/getObsidianVaultTask", body: { taskID: "20260826153000-task001" } },
      { url: "http://127.0.0.1:6806/api/noema/markdown/startObsidianVaultImport", body: { notebook: "box-id", taskID: "20260826153000-task001", destination: "Imports/Vault" } },
      { url: "http://127.0.0.1:6806/api/import/cancelObsidianVaultTask", body: { taskID: "20260826153000-task001" } },
    ]);
  });
});
