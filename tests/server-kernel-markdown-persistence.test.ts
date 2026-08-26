import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { configure, configureMarkdownFileProvider } from "../server/lib/state.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { readNote } from "../server/lib/index.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { saveNote } from "../server/lib/save.mjs";
// @ts-ignore Runtime path operations are Node ESM outside the TS graph.
import { createNode, duplicateManagedFile, moveManagedPath, renameManagedPath, updateCurrentNoteMeta } from "../server/lib/runtime.mjs";

const roots: string[] = [];

afterEach(async () => {
  configureMarkdownFileProvider(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("server facade with desktop kernel persistence", () => {
  test("keeps Node save policy while routing source reads and writes through the provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-persistence-"));
    const notes = join(root, "notes");
    const file = join(notes, "a.md");
    roots.push(root);
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Initial\n", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    let reads = 0;
    let writes = 0;
    configureMarkdownFileProvider({
      owns(candidate: string) {
        return candidate === file;
      },
      async read() {
        reads++;
        return { content: await readFile(file, "utf8") };
      },
      async write(body: { content: string }) {
        writes++;
        await writeFile(file, body.content, "utf8");
        return { ok: true, content: body.content };
      },
    });

    const opened = await readNote(file) as { content: string; version: string; mtimeMs: number };
    expect(opened.content).toBe("# Initial\n");
    const saved = await saveNote({
      file,
      content: "# Saved through kernel\n\nExact bytes.\n",
      clientId: "desktop-kernel-test",
      seq: 1,
      baseMtimeMs: opened.mtimeMs,
      baseVersion: opened.version,
      refresh: "deferred",
    }) as { ok?: boolean; conflict?: boolean; note?: { title?: string } };

    expect(saved).toMatchObject({ ok: true, note: { title: "Saved through kernel" } });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(writes).toBe(1);
    expect(await readFile(file, "utf8")).toBe("# Saved through kernel\n\nExact bytes.\n");
  });

  test("rejects an external edit before calling the provider write", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-conflict-"));
    const notes = join(root, "notes");
    const file = join(notes, "a.md");
    roots.push(root);
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Initial\n", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    let writes = 0;
    configureMarkdownFileProvider({
      owns(candidate: string) {
        return candidate === file;
      },
      async read() {
        return { content: await readFile(file, "utf8") };
      },
      async write(body: { content: string }) {
        writes++;
        await writeFile(file, body.content, "utf8");
        return { ok: true, content: body.content };
      },
    });

    const opened = await readNote(file) as { version: string; mtimeMs: number };
    await writeFile(file, "# External\n", "utf8");
    const changed = await stat(file);
    expect(changed.mtimeMs).toBeGreaterThanOrEqual(opened.mtimeMs);
    const saved = await saveNote({
      file,
      content: "# Local\n",
      clientId: "desktop-kernel-conflict",
      seq: 1,
      baseMtimeMs: opened.mtimeMs,
      baseVersion: opened.version,
      refresh: "deferred",
    }) as { conflict?: boolean };

    expect(saved.conflict).toBe(true);
    expect(writes).toBe(0);
    expect(await readFile(file, "utf8")).toBe("# External\n");
  });

  test("surfaces a kernel CAS conflict that lands after the Node precheck", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-cas-race-"));
    const notes = join(root, "notes");
    const file = join(notes, "a.md");
    roots.push(root);
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Initial\n", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    let expectedVersion = "";
    configureMarkdownFileProvider({
      owns(candidate: string) {
        return candidate === file;
      },
      async read() {
        return { content: await readFile(file, "utf8") };
      },
      async write(body: { expectedVersion?: string }) {
        expectedVersion = String(body.expectedVersion || "");
        await writeFile(file, "# Raced external edit\n", "utf8");
        return {
          ok: false,
          conflict: true,
          content: "# Raced external edit\n",
          mtimeMs: 42,
          size: 23,
          version: "raced-version",
        };
      },
    });

    const opened = await readNote(file) as { version: string; mtimeMs: number };
    const saved = await saveNote({
      file,
      content: "# Local edit\n",
      clientId: "desktop-kernel-cas",
      seq: 1,
      baseMtimeMs: opened.mtimeMs,
      baseVersion: opened.version,
      refresh: "deferred",
    }) as { ok?: boolean; conflict?: boolean; version?: string };

    expect(expectedVersion).toBe(opened.version);
    expect(saved).toMatchObject({ ok: false, conflict: true, version: "raced-version" });
    expect(await readFile(file, "utf8")).toBe("# Raced external edit\n");
  });

  test("fails closed when the kernel cannot provide the current source", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-outage-"));
    const notes = join(root, "notes");
    const file = join(notes, "a.md");
    roots.push(root);
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Preserved\n", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    let writes = 0;
    configureMarkdownFileProvider({
      owns(candidate: string) {
        return candidate === file;
      },
      async read() {
        throw new Error("kernel unavailable");
      },
      async write() {
        writes++;
        return { ok: true, content: "# Lost\n" };
      },
    });

    await expect(saveNote({
      file,
      content: "# Local\n",
      clientId: "desktop-kernel-outage",
      seq: 1,
      force: true,
      refresh: "deferred",
    })).rejects.toThrow("kernel unavailable");
    expect(writes).toBe(0);
    expect(await readFile(file, "utf8")).toBe("# Preserved\n");
  });

  test("routes Markdown rename and incoming path-reference rewrites through the provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-rename-"));
    const notes = join(root, "notes");
    const oldFile = join(notes, "old.md");
    const newFile = join(notes, "new.md");
    const sourceFile = join(notes, "source.md");
    roots.push(root);
    await mkdir(notes, { recursive: true });
    await writeFile(oldFile, "# Old\n", "utf8");
    await writeFile(sourceFile, "[old](old.md#section)\n", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    let moves = 0;
    let writes = 0;
    configureMarkdownFileProvider({
      owns(candidate: string) {
        return candidate.startsWith(`${notes}/`) && candidate.endsWith(".md");
      },
      async read(candidate: string) {
        return { content: await readFile(candidate, "utf8") };
      },
      async write(body: { file: string; content: string }) {
        writes++;
        await writeFile(body.file, body.content, "utf8");
        return { ok: true, content: body.content };
      },
      async move(body: { file: string; target: string }) {
        moves++;
        await rename(body.file, body.target);
        return { ok: true };
      },
    });

    const result = await renameManagedPath({ path: oldFile, name: "new.md" }) as {
      file?: string;
      oldFile?: string;
      referenceRewrite?: { changedCount?: number; referenceCount?: number };
    };
    expect(result).toMatchObject({
      file: newFile,
      oldFile,
      referenceRewrite: { changedCount: 1, referenceCount: 1 },
    });
    expect(moves).toBe(1);
    expect(writes).toBe(1);
    await expect(stat(oldFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(newFile, "utf8")).toBe("# Old\n");
    expect(await readFile(sourceFile, "utf8")).toBe("[old](new.md#section)\n");
  });

  test("preserves a moved Markdown document's relative links through the provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-move-"));
    const notes = join(root, "notes");
    const drafts = join(notes, "drafts");
    const archive = join(notes, "archive");
    const oldFile = join(drafts, "old.md");
    const newFile = join(archive, "old.md");
    const sourceFile = join(notes, "source.md");
    roots.push(root);
    await mkdir(join(drafts, "images"), { recursive: true });
    await mkdir(archive, { recursive: true });
    await writeFile(oldFile, "[peer](peer.md#part)\n![plot](images/plot.png?raw=1#view)\n", "utf8");
    await writeFile(join(drafts, "peer.md"), "# Peer\n", "utf8");
    await writeFile(join(drafts, "images", "plot.png"), "plot", "utf8");
    await writeFile(sourceFile, "[old](drafts/old.md)\n", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    let moves = 0;
    let writes = 0;
    configureMarkdownFileProvider({
      owns(candidate: string) {
        return candidate.startsWith(`${notes}/`) && candidate.endsWith(".md");
      },
      async read(candidate: string) {
        return { content: await readFile(candidate, "utf8") };
      },
      async write(body: { file: string; content: string }) {
        writes++;
        await writeFile(body.file, body.content, "utf8");
        return { ok: true, content: body.content };
      },
      async move(body: { file: string; target: string }) {
        moves++;
        await rename(body.file, body.target);
        return { ok: true };
      },
    });

    const result = await moveManagedPath({ path: oldFile, directory: archive }) as {
      relativeReferenceRewrite?: { referenceCount?: number };
      referenceRewrite?: { changedCount?: number; referenceCount?: number };
    };
    expect(result).toMatchObject({
      relativeReferenceRewrite: { referenceCount: 2 },
      referenceRewrite: { changedCount: 1, referenceCount: 1 },
    });
    expect(moves).toBe(1);
    expect(writes).toBe(2);
    await expect(stat(oldFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(newFile, "utf8")).toBe("[peer](../drafts/peer.md#part)\n![plot](../drafts/images/plot.png?raw=1#view)\n");
    expect(await readFile(sourceFile, "utf8")).toBe("[old](archive/old.md)\n");
  });

  test("moves a Markdown directory through the provider and repairs links in one pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-directory-move-"));
    const notes = join(root, "notes");
    const sourceDir = join(notes, "drafts", "topic");
    const targetDir = join(notes, "archive", "deep", "topic");
    const aFile = join(sourceDir, "a.md");
    const bFile = join(sourceDir, "b.markdown");
    const sourceFile = join(notes, "source.md");
    roots.push(root);
    await mkdir(join(sourceDir, "images"), { recursive: true });
    await mkdir(join(notes, "archive", "deep"), { recursive: true });
    await writeFile(aFile, "[b](b.markdown#part)\n[peer](../../peer.md)\n![plot](images/plot.png)\n", "utf8");
    await writeFile(bFile, "[a](a.md)\n", "utf8");
    await writeFile(join(sourceDir, "images", "plot.png"), "plot", "utf8");
    await writeFile(join(notes, "peer.md"), "# Peer\n", "utf8");
    await writeFile(sourceFile, "[a](drafts/topic/a.md#section)\n![plot](drafts/topic/images/plot.png?raw=1)\n", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    let moves = 0;
    let writes = 0;
    configureMarkdownFileProvider({
      owns(candidate: string) {
        return candidate.startsWith(`${notes}/`) && /\.(?:md|markdown)$/.test(candidate);
      },
      ownsPath(candidate: string) {
        return candidate.startsWith(`${notes}/`);
      },
      async read(candidate: string) {
        return { content: await readFile(candidate, "utf8") };
      },
      async write(body: { file: string; content: string }) {
        writes++;
        await writeFile(body.file, body.content, "utf8");
        return { ok: true, content: body.content };
      },
      async move(body: { file: string; target: string; directory?: boolean }) {
        moves++;
        expect(body.directory).toBe(true);
        await rename(body.file, body.target);
        return {
          ok: true,
          directory: true,
          documents: [
            { fromPath: "/drafts/topic/a.md", toPath: "/archive/deep/topic/a.md", id: "a" },
            { fromPath: "/drafts/topic/b.markdown", toPath: "/archive/deep/topic/b.markdown", id: "b" },
          ],
        };
      },
    });

    const result = await moveManagedPath({ path: sourceDir, target: targetDir }) as {
      relativeReferenceRewrite?: { referenceCount?: number };
      referenceRewrite?: { changedCount?: number; referenceCount?: number };
    };
    expect(result).toMatchObject({
      relativeReferenceRewrite: { referenceCount: 1 },
      referenceRewrite: { changedCount: 1, referenceCount: 2 },
    });
    expect(moves).toBe(1);
    expect(writes).toBe(2);
    expect(await readFile(join(targetDir, "a.md"), "utf8")).toBe(
      "[b](b.markdown#part)\n[peer](../../../peer.md)\n![plot](images/plot.png)\n",
    );
    expect(await readFile(join(targetDir, "b.markdown"), "utf8")).toBe("[a](a.md)\n");
    expect(await readFile(sourceFile, "utf8")).toBe(
      "[a](archive/deep/topic/a.md#section)\n![plot](archive/deep/topic/images/plot.png?raw=1)\n",
    );
    expect(await readFile(join(targetDir, "images", "plot.png"), "utf8")).toBe("plot");
    await expect(stat(sourceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("routes create, metadata edits, and duplication through kernel persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-path-writes-"));
    const notes = join(root, "notes");
    const file = join(notes, "created.md");
    const copy = join(notes, "created-copy.md");
    roots.push(root);
    await mkdir(notes, { recursive: true });
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    let reads = 0;
    let writes = 0;
    configureMarkdownFileProvider({
      owns(candidate: string) {
        return candidate.startsWith(`${notes}/`) && candidate.endsWith(".md");
      },
      async read(candidate: string) {
        reads++;
        return { content: await readFile(candidate, "utf8") };
      },
      async write(body: { file: string; content: string }) {
        writes++;
        await mkdir(join(body.file, ".."), { recursive: true });
        await writeFile(body.file, body.content, "utf8");
        return { ok: true, content: body.content };
      },
    });

    await createNode({ nodeType: "roam", id: "created", title: "Created", path: "created.md" });
    expect(writes).toBe(1);
    await updateCurrentNoteMeta({ file, title: "Created", project: "path-model", tags: ["kernel"] }, "add");
    expect(writes).toBe(2);
    expect(await readFile(file, "utf8")).toContain("project: path-model");

    await duplicateManagedFile({ path: file, target: copy });
    expect(writes).toBe(3);
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(await readFile(copy, "utf8")).toBe(await readFile(file, "utf8"));
  });

  test("delegates metadata semantics to the kernel provider without a generic Node rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-meta-runtime-"));
    const notes = join(root, "notes");
    const file = join(notes, "paper.md");
    roots.push(root);
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Paper\n", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    let genericWrites = 0;
    const mutations: Array<{ action: string; body: Record<string, unknown> }> = [];
    configureMarkdownFileProvider({
      owns(candidate: string) {
        return candidate === file;
      },
      async read() {
        return { content: await readFile(file, "utf8") };
      },
      async write(body: { content: string }) {
        genericWrites++;
        await writeFile(file, body.content, "utf8");
        return { ok: true, content: body.content };
      },
      async mutateMeta(body: Record<string, unknown>, action: string) {
        mutations.push({ action, body });
        const markdown = "#+begin meta\nid: 0198fc34-7b32-7a11-8cb4-6c40e3b33d68\ntitle: Paper\ndate: 2026-08-26\nkind: default\ntags: kernel\nrefs:\n#+end meta\n\n# Paper\n";
        await writeFile(file, markdown, "utf8");
        return { changed: true, markdown, version: "kernel-meta-version", source: "kernel-meta" };
      },
    });

    const result = await updateCurrentNoteMeta({
      file,
      content: "# Paper\n",
      title: "Paper",
      tags: ["kernel"],
    }, "add") as { changed?: boolean; mutationSource?: string; content?: string };

    expect(result).toMatchObject({ changed: true, mutationSource: "kernel-meta" });
    expect(result.content).toContain("id: 0198fc34-7b32-7a11-8cb4-6c40e3b33d68");
    expect(genericWrites).toBe(0);
    expect(mutations).toEqual([{
      action: "add",
      body: { file, content: "# Paper\n", title: "Paper", tags: ["kernel"] },
    }]);
  });
});
