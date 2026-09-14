import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { assetRefsFromContent, renderTikzAsset, scanUnusedAssets, storeAssetFromPath } from "../server/lib/assets.mjs";
import { tikzAssetFileName } from "../shared/tikz-source.mjs";
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
  test("matches the shared asset reference contract", async () => {
    const fixturePath = join(process.cwd(), "shared", "asset-reference-fixtures.json");
    const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
    for (const fixture of fixtures) {
      const note = join(noteRoot, ...String(fixture.note).split("/"));
      const actual = assetRefsFromContent(String(fixture.content), note)
        .map((file: string) => relative(noteRoot, file).split(sep).join("/"))
        .sort();
      expect(actual, fixture.name).toEqual(fixture.expected);
    }
  });

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

  test("revalidates and reuses a content-addressed TikZ SVG while sweeping stale variants", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-tikz-cache-"));
    roots.push(root);
    const notes = join(root, "notes");
    const note = join(notes, "topic.md");
    const assetDir = join(notes, "images", "topic");
    const source = "\\draw (0,0) -- (1,1);";
    const current = tikzAssetFileName("axis", source);
    const stale = tikzAssetFileName("axis", "\\draw (0,0) -- (2,2);");
    await mkdir(assetDir, { recursive: true });
    await writeFile(note, "# Topic\n", "utf8");
    await writeFile(join(assetDir, current), '<svg width="72pt" height="36pt" viewBox="0 0 72 36"></svg>', "utf8");
    await writeFile(join(assetDir, stale), '<svg width="20pt" height="20pt"></svg>', "utf8");
    await writeFile(join(assetDir, "tikz-axis.svg"), '<svg width="20pt" height="20pt"></svg>', "utf8");
    configure({ root: notes, workspaceRoot: root, stateRoot: join(root, "state"), tmpRoot: join(root, "tmp") });

    const result = await renderTikzAsset({ file: note, id: "axis", source });

    expect(result).toMatchObject({
      ok: true,
      rendered: false,
      markdownPath: `./images/topic/${current}`,
      intrinsic: { widthEm: 7.227, heightEm: 3.613 },
    });
    expect(await readdir(assetDir)).toEqual([current]);
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
