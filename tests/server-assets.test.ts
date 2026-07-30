import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { assetRefsFromContent, scanUnusedAssets, storeAssetFromPath } from "../server/lib/assets.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { resolveMediaFile } from "../server/lib/media.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { configure } from "../server/lib/state.mjs";

const noteRoot = decodeURIComponent(new URL("../../roam", import.meta.url).pathname.replace(/^\/@fs/, "").replace(/\/$/, ""));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("server asset refs", () => {
  test("extracts markdown image and attachment paths relative to note file", () => {
    const note = `${noteRoot}/project/a.md`;
    expect(
      assetRefsFromContent("![plot](./images/a/plot.png)\n[file](attachments/a/raw%20data.pdf)", note),
    ).toEqual([
      `${noteRoot}/project/images/a/plot.png`,
      `${noteRoot}/project/attachments/a/raw data.pdf`,
    ]);
  });

  test("ignores external asset URLs", () => {
    expect(
      assetRefsFromContent("![remote](https://example.com/a.png)\n<a href=\"mailto:x@y.z\">x</a>", `${noteRoot}/a.md`),
    ).toEqual([]);
  });

  test("scans unused assets without reporting referenced files or note sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-unused-assets-"));
    roots.push(root);
    const notes = join(root, "roam");
    await mkdir(join(notes, "attachments"), { recursive: true });
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });
    await writeFile(join(notes, "topic.md"), "[used](./attachments/used.pdf)\n", "utf8");
    await writeFile(join(notes, "attachments", "used.pdf"), "USED\n", "utf8");
    await writeFile(join(notes, "attachments", "orphan.pdf"), "ORPHAN\n", "utf8");
    await writeFile(join(notes, "attachments", "draft.md"), "# Draft\n", "utf8");
    await writeFile(join(notes, "attachments", ".aaronnote-keep"), "", "utf8");

    const assets = await scanUnusedAssets();

    expect(assets.map((asset: { path: string }) => asset.path)).toEqual(["attachments/orphan.pdf"]);
  });

  test("copies native asset paths without base64 encoding", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-assets-"));
    roots.push(root);
    const notes = join(root, "roam");
    const loose = join(root, "loose");
    await mkdir(notes, { recursive: true });
    await mkdir(loose, { recursive: true });
    const note = join(notes, "topic.md");
    const source = join(loose, "plot.png");
    await writeFile(note, "# Topic\n", "utf8");
    await writeFile(source, "PNGDATA", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    const msg = await storeAssetFromPath({
      file: note,
      path: source,
      name: "plot.png",
      type: "image/png",
    });

    expect(msg.ok).toBe(true);
    expect(msg.isImage).toBe(true);
    expect(msg.markdownPath).toBe("./images/topic/plot.png");
    expect(await readFile(join(notes, "images", "topic", "plot.png"), "utf8")).toBe("PNGDATA");
  });

  test("resolves parent-directory media paths relative to the current note", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-media-"));
    roots.push(root);
    const notes = join(root, "roam");
    await mkdir(join(notes, "sub"), { recursive: true });
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    expect(resolveMediaFile("../images/plot.png", join(notes, "sub", "topic.md")))
      .toBe(join(notes, "images", "plot.png"));
  });

  test("resolves roam-root media paths from slash and roam prefixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-roam-root-media-"));
    roots.push(root);
    const notes = join(root, "roam");
    await mkdir(join(notes, "project"), { recursive: true });
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });
    const note = join(notes, "project", "topic.md");

    expect(resolveMediaFile("/attachments/linear_route.png", note))
      .toBe(join(notes, "attachments", "linear_route.png"));
    expect(resolveMediaFile("roam/attachments/linear_route.png", note))
      .toBe(join(notes, "attachments", "linear_route.png"));
  });

  test("resolves standalone note sibling image folders above the note directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-standalone-media-"));
    roots.push(root);
    const notes = join(root, "roam");
    const project = join(root, "lab01");
    await mkdir(join(notes), { recursive: true });
    await mkdir(join(project, "spec"), { recursive: true });
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });
    const note = join(project, "spec", "CoreAverage.md");

    expect(resolveMediaFile("../images/AverageMainFunction.png", note))
      .toBe(join(project, "images", "AverageMainFunction.png"));
    expect(resolveMediaFile("/images/AverageTestRun.png", note))
      .toBe(join(project, "images", "AverageTestRun.png"));
  });

  test("resolves standalone slash paths from detected project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-project-root-media-"));
    roots.push(root);
    const notes = join(root, "roam");
    const project = join(root, "assignment");
    await mkdir(notes, { recursive: true });
    await mkdir(join(project, "docs", "spec"), { recursive: true });
    await writeFile(join(project, "pom.xml"), "<project />\n", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });
    const note = join(project, "docs", "spec", "CoreAverage.md");

    expect(resolveMediaFile("/attachments/linear_route.png", note))
      .toBe(join(project, "attachments", "linear_route.png"));
    expect(resolveMediaFile("./local.png", note))
      .toBe(join(project, "docs", "spec", "local.png"));
  });
});
