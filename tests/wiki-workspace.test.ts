import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  adoptWikiRepository,
  buildWikiIndex,
  copyWikiPage,
  createWikiPage,
  deleteWikiPage,
  discoverWikiRepositories,
  exportWiki,
  initWikiRepository,
  moveWikiPage,
  publicWikiNotes,
  repositoryFromId,
  resolveWikiLink,
  searchWikiDatabase,
  updateWikiTag,
  updateWikiNamespace,
  wikiDatabaseFile,
  wikiPageDiff,
  wikiPageHistory,
  restoreWikiPageVersion,
  wikiTagIndex,
} from "../server/lib/wiki-workspace.mjs";
import { isUuidV7 } from "../shared/identity.mjs";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "noema-wiki-"));
  roots.push(root);
  return root;
}

async function gitRepository(root: string, partition: "public" | "private", name: string): Promise<string> {
  const path = join(root, partition, name);
  await mkdir(path, { recursive: true });
  await execFileAsync("git", ["init", path]);
  return path;
}

function note(id: string, title: string, body = "", extra = ""): string {
  return `#+begin meta
id: ${id}
title: ${title}
date: 2026-07-31
kind: note
aliases: ${extra}
tags:
refs:
#+end meta

# ${title}

${body}
`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Wiki workspace", () => {
  test("discovers only direct Git repositories and reports non-Git directories", async () => {
    const root = await tempRoot();
    await gitRepository(root, "public", "math");
    await gitRepository(root, "private", "daily");
    await mkdir(join(root, "public", "not-a-repository"), { recursive: true });

    const result = await discoverWikiRepositories(root);
    expect(result.repositories.map((repository) => repository.id)).toEqual(["public/math", "private/daily"]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "non-git-directory", path: join(root, "public", "not-a-repository") }),
    ]));
  });

  test("adopts an existing direct Git repository with a stable committed manifest", async () => {
    const root = await tempRoot();
    await gitRepository(root, "private", "legacy");
    const adopted = await adoptWikiRepository(root, "private/legacy");
    expect(isUuidV7(adopted.repository.uid)).toBe(true);
    expect((await discoverWikiRepositories(root)).repositories[0]).toMatchObject({
      uid: adopted.repository.uid,
      identityStatus: "managed",
    });
  });

  test("rekeys an existing page index when a repository gains a stable identity", async () => {
    const root = await tempRoot();
    const repository = await gitRepository(root, "private", "legacy-notes");
    await writeFile(join(repository, "existing.md"), note("existing-id", "Existing page"));
    const before = await buildWikiIndex(root, { layout: "wiki" });
    expect(before.notes[0].pageKey).toMatch(/^provisional:[^:]+:existing\.md$/);

    const adopted = await adoptWikiRepository(root, "private/legacy-notes");
    const after = await buildWikiIndex(root, { layout: "wiki" });
    expect(after.notes[0]).toMatchObject({ id: "existing-id", file: join(repository, "existing.md") });
    expect(after.notes[0].pageKey).toBe(`${adopted.repository.uid}:existing.md`);
    expect(after.notes[0].pageKey).not.toBe(before.notes[0].pageKey);
    expect(searchWikiDatabase(root, { query: "Existing" })).toMatchObject({ total: 1 });
  });

  test("builds a global title/alias Wiki index with wanted and ambiguous reports", async () => {
    const root = await tempRoot();
    const math = await gitRepository(root, "public", "math");
    const notes = await gitRepository(root, "private", "notes");
    await writeFile(join(math, "tensor.md"), note("tensor-id", "Tensor", "[[Daily]]\n[[Missing Page]]", "Linear map"));
    await writeFile(join(notes, "daily.md"), note("daily-id", "Daily"));
    await writeFile(join(notes, "duplicate.md"), note("duplicate-id", "Tensor"));

    const index = await buildWikiIndex(root, { layout: "wiki" });
    expect(index.notes).toHaveLength(3);
    expect(resolveWikiLink(index, "Daily")).toMatchObject({ status: "resolved" });
    expect(resolveWikiLink(index, "Linear map")).toMatchObject({ status: "resolved" });
    expect(resolveWikiLink(index, "roam://daily-id")).toMatchObject({
      status: "resolved",
      candidates: [expect.objectContaining({ id: "daily-id" })],
    });
    expect(resolveWikiLink(index, "Tensor")).toMatchObject({ status: "ambiguous" });
    expect(resolveWikiLink(index, "Tensor", { sourceFile: join(math, "tensor.md") })).toMatchObject({
      status: "resolved",
      candidates: [expect.objectContaining({ file: join(math, "tensor.md") })],
    });
    expect(index.reports.wanted[0]).toMatchObject({ title: "Missing Page" });
    expect(index.reports.duplicates).toHaveLength(0);
    expect(wikiDatabaseFile(root)).toBe(join(root, ".noema", "wiki.db"));
  });

  test("resolves repository, page, and fully qualified namespaces", async () => {
    const root = await tempRoot();
    const math = await gitRepository(root, "public", "Math");
    const physics = await gitRepository(root, "private", "Physics");
    await writeFile(join(math, "tensor.md"), note("math-tensor", "Tensor", "[[Quantum:Tensor]]"));
    await writeFile(join(physics, "tensor.md"), note("physics-tensor", "Tensor")
      .replace("title: Tensor", "title: Tensor\nnamespace: Quantum"));

    const index = await buildWikiIndex(root, { layout: "wiki" });
    expect(index.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "math-tensor", namespace: "Math", qualifiedTitle: "Math:Tensor", fullTitle: "public/Math:Tensor" }),
      expect.objectContaining({ id: "physics-tensor", namespace: "Quantum", qualifiedTitle: "Quantum:Tensor", fullTitle: "private/Quantum:Tensor" }),
    ]));
    expect(resolveWikiLink(index, "Tensor")).toMatchObject({ status: "ambiguous" });
    expect(resolveWikiLink(index, "Math:Tensor")).toMatchObject({
      status: "resolved", candidates: [expect.objectContaining({ id: "math-tensor" })],
    });
    expect(resolveWikiLink(index, "private/Quantum:Tensor")).toMatchObject({
      status: "resolved", candidates: [expect.objectContaining({ id: "physics-tensor" })],
    });
    expect(resolveWikiLink(index, "Tensor", { sourceFile: join(math, "tensor.md") })).toMatchObject({
      status: "resolved", candidates: [expect.objectContaining({ id: "math-tensor" })],
    });
    expect(searchWikiDatabase(root, { namespace: "Quantum" })).toMatchObject({
      total: 1, items: [expect.objectContaining({ id: "physics-tensor", namespace: "Quantum" })],
    });

    await updateWikiNamespace(root, { from: "Quantum", to: "Physics/Quantum", partition: "private" });
    const renamed = await buildWikiIndex(root, { layout: "wiki" });
    expect(resolveWikiLink(renamed, "Physics/Quantum:Tensor")).toMatchObject({ status: "resolved" });
    expect(resolveWikiLink(renamed, "Quantum:Tensor")).toMatchObject({ status: "resolved" });
    expect(resolveWikiLink(renamed, "private/Quantum:Tensor")).toMatchObject({ status: "resolved" });
    expect(await readFile(join(physics, "tensor.md"), "utf8")).toContain("namespace_aliases: Quantum");
  });

  test("persists searchable Markdown content, excludes Typst pages, and keeps a stable generation", async () => {
    const root = await tempRoot();
    const repository = await gitRepository(root, "public", "physics");
    await writeFile(join(repository, "entanglement.md"), note(
      "0198fbac-0780-7c99-85e6-333333333333",
      "Quantum Entanglement",
      "Entanglement correlations and 量子纠缠实验.",
    ));
    await writeFile(join(repository, "ignored.typ"), "= Typst should stay outside the Wiki\n");
    await writeFile(join(repository, "paper.pdf"), "attachment metadata only");

    const first = await buildWikiIndex(root, { layout: "wiki" });
    const second = await buildWikiIndex(root, { layout: "wiki" });
    expect(first.notes.map((item) => item.title)).toEqual(["Quantum Entanglement"]);
    expect(first.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ repositoryPath: "ignored.typ", kind: "file" }),
      expect.objectContaining({ repositoryPath: "paper.pdf", kind: "file" }),
    ]));
    expect(second.generation).toBe(first.generation);
    expect(searchWikiDatabase(root, { query: "Entanglement correlations" })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ title: "Quantum Entanglement" })],
    });
    expect(searchWikiDatabase(root, { query: "Entang" })).toMatchObject({ total: 1 });
    expect(searchWikiDatabase(root, { query: "量子纠" })).toMatchObject({ total: 1 });
    expect(searchWikiDatabase(root, { query: "attachment metadata only" })).toMatchObject({ total: 0 });
  });

  test("uses Git commits as page history and restores an old version into the working tree", async () => {
    const root = await tempRoot();
    const created = await initWikiRepository(root, "private", "history");
    const page = await createWikiPage(root, "wiki", {
      title: "Versioned page",
      repositoryId: "private/history",
      filename: "versioned.md",
    });
    await execFileAsync("git", ["-C", created.repository.path, "add", "versioned.md"]);
    await execFileAsync("git", ["-C", created.repository.path, "-c", "user.name=Historian", "-c", "user.email=history@example.test", "commit", "-m", "first version"]);
    const firstSha = (await execFileAsync("git", ["-C", created.repository.path, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(page.file, (await readFile(page.file, "utf8")).replace("# Versioned page", "# Version two"));
    await execFileAsync("git", ["-C", created.repository.path, "add", "versioned.md"]);
    await execFileAsync("git", ["-C", created.repository.path, "-c", "user.name=Historian", "-c", "user.email=history@example.test", "commit", "-m", "second version"]);

    const history = await wikiPageHistory(root, { pageId: page.id });
    expect(history.commits[0]).toMatchObject({ subject: "second version", author: "Historian" });
    expect((await wikiPageDiff(root, { pageId: page.id, sha: history.commits[0].sha })).diff).toContain("Version two");
    await restoreWikiPageVersion(root, { pageId: page.id, sha: firstSha });
    expect(await readFile(page.file, "utf8")).toContain("# Versioned page");
  });

  test("uses a workbench request to create a page at an explicit repository destination", async () => {
    const root = await tempRoot();
    await gitRepository(root, "private", "project");
    const result = await createWikiPage(root, "wiki", {
      title: "New Design",
      repositoryId: "private/project",
      directory: "architecture",
      filename: "new-design.md",
      namespace: "Research/Architecture",
      tags: "wiki, design",
    });
    expect(result.file).toBe(join(root, "private", "project", "architecture", "new-design.md"));
    expect(await readFile(result.file, "utf8")).toContain("title: New Design");
    expect(await readFile(result.file, "utf8")).toContain("namespace: Research/Architecture");
    expect(await readFile(result.file, "utf8")).toContain("private: true");
  });

  test("expands configurable filename patterns inside the selected repository", async () => {
    const root = await tempRoot();
    await gitRepository(root, "public", "math");
    const result = await createWikiPage(root, "wiki", {
      title: "Tensor Product",
      repositoryId: "public/math",
      filenamePattern: "notes/{date}-{slug}.md",
    });
    expect(result.file).toMatch(/public\/math\/notes\/\d{4}-\d{2}-\d{2}-tensor-product\.md$/);
  });

  test("publishing selection is a hard public-only boundary", async () => {
    const root = await tempRoot();
    const publicRepo = await gitRepository(root, "public", "knowledge");
    const privateRepo = await gitRepository(root, "private", "daily");
    await writeFile(join(publicRepo, "visible.md"), note("visible", "Visible"));
    await writeFile(join(publicRepo, "hidden.md"), note("hidden", "Hidden").replace("refs:", "private: true\nrefs:"));
    await writeFile(join(privateRepo, "secret.md"), note("secret", "Secret"));
    const index = await buildWikiIndex(root, { layout: "wiki" });
    expect(publicWikiNotes(index).map((item) => item.title)).toEqual(["Visible"]);
  });

  test("persists repository and page UUIDv7 identities independently of physical paths", async () => {
    const root = await tempRoot();
    const created = await initWikiRepository(root, "private", "research");
    expect(isUuidV7(created.repository.uid)).toBe(true);
    expect(await readFile(join(created.repository.path, "noema.toml"), "utf8"))
      .toContain(`repository_id = "${created.repository.uid}"`);
    expect(await readFile(join(created.repository.path, ".gitignore"), "utf8")).toContain(".direnv/");
    expect(await readFile(join(created.repository.path, ".gitignore"), "utf8")).not.toContain(".cell");
    expect((await execFileAsync("git", ["-C", created.repository.path, "branch", "--show-current"])).stdout.trim()).toBe("main");
    expect((await execFileAsync("git", ["-C", created.repository.path, "status", "--porcelain"])).stdout).toBe("");

    const page = await createWikiPage(root, "wiki", {
      title: "Stable identity",
      repositoryId: "private/research",
      filename: "loose/first-name.md",
    });
    expect(isUuidV7(page.id)).toBe(true);
    const before = await repositoryFromId(root, "private/research");
    await mkdir(join(created.repository.path, "organized"), { recursive: true });
    await rename(join(created.repository.path, "loose", "first-name.md"), join(created.repository.path, "organized", "renamed.md"));
    const index = await buildWikiIndex(root, { layout: "wiki" });
    expect(index.notes[0]).toMatchObject({ id: page.id, repositoryPath: "organized/renamed.md" });
    expect((await repositoryFromId(root, "private/research")).uid).toBe(before.uid);
  });

  test("indexes all physical files, hard dependencies, blocks, and manages tags", async () => {
    const root = await tempRoot();
    const created = await initWikiRepository(root, "private", "research");
    await mkdir(join(created.repository.path, "papers", "images"), { recursive: true });
    await mkdir(join(created.repository.path, "papers", ".cell"), { recursive: true });
    await writeFile(join(created.repository.path, "papers", "images", "plot.png"), "plot");
    await writeFile(join(created.repository.path, "papers", ".cell", "result.json"), "{}");
    await writeFile(join(created.repository.path, "papers", "draft.md"), note(
      "0198fbac-0780-7c99-85e6-111111111111",
      "Draft",
      "![plot](images/plot.png)\n[internal](@@claim)\n[external](marginnote4app://note/123)\n\nClaim {#0198fbac-0780-7c99-85e6-222222222222}",
    ).replace("tags:", "tags: research, draft"));

    let index = await buildWikiIndex(root, { layout: "wiki" });
    expect(index.files.map((file) => file.repositoryPath)).toEqual(expect.arrayContaining([
      "noema.toml",
      "papers/draft.md",
      "papers/.cell/result.json",
      "papers/images/plot.png",
    ]));
    expect(index.notes[0].dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "papers/images/plot.png", status: "resolved" }),
    ]));
    expect(index.notes[0].dependencies).toHaveLength(1);
    expect(index.notes[0].blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "0198fbac-0780-7c99-85e6-222222222222" }),
    ]));
    expect(wikiTagIndex(index)[0]).toMatchObject({ name: "draft", count: 1 });
    await updateWikiTag(root, { action: "rename", from: "draft", to: "working" });
    index = await buildWikiIndex(root, { layout: "wiki" });
    expect(index.notes[0].tags).toEqual(["research", "working"]);
  });

  test("copies and privacy-gates moves while preserving page identity on move", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "research");
    await initWikiRepository(root, "public", "shared");
    const page = await createWikiPage(root, "wiki", {
      title: "Source",
      repositoryId: "private/research",
      filename: "source.md",
    });
    const copied = await copyWikiPage(root, {
      pageId: page.id,
      repositoryId: "private/research",
      filename: "copy.md",
      title: "Copy",
    });
    expect(copied.id).not.toBe(page.id);
    expect(isUuidV7(copied.id)).toBe(true);
    await expect(moveWikiPage(root, {
      pageId: page.id,
      repositoryId: "public/shared",
      filename: "source.md",
    })).rejects.toMatchObject({ code: "ERR_WIKI_PRIVACY_CONFIRM" });
    const moved = await moveWikiPage(root, {
      pageId: page.id,
      repositoryId: "public/shared",
      filename: "source.md",
      confirm: "MOVE PRIVATE TO PUBLIC",
    });
    expect(moved.pageId).toBe(page.id);
    expect(await readFile(moved.file, "utf8")).toContain(`id: ${page.id}`);
  });

  test("requires backlink confirmation and moves deleted pages to recoverable Trash", async () => {
    const root = await tempRoot();
    const repository = await initWikiRepository(root, "private", "research");
    const target = await createWikiPage(root, "wiki", {
      title: "Target",
      repositoryId: "private/research",
      filename: "target.md",
    });
    await writeFile(join(repository.repository.path, "source.md"), note(
      "0198fbac-0780-7c99-85e6-333333333333",
      "Source",
      "See [[Target]].",
    ));
    const trashRoot = join(root, "test-trash");
    await expect(deleteWikiPage(root, { pageId: target.id }, { trashRoot }))
      .rejects.toMatchObject({ code: "ERR_WIKI_BACKLINK_CONFIRM" });
    const deleted = await deleteWikiPage(root, { pageId: target.id, confirm: "DELETE" }, { trashRoot });
    await expect(stat(target.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(String(deleted.trashedFile))).isFile()).toBe(true);
  });

  test("exports a physical repository snapshot with a portable manifest", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "public", "shared");
    await createWikiPage(root, "wiki", {
      title: "Exported",
      repositoryId: "public/shared",
      filename: "exported.md",
    });
    const outputPath = join(root, "snapshot.zip");
    const result = await exportWiki(root, {
      mode: "physical",
      repositoryId: "public/shared",
      path: "",
      outputPath,
    });
    expect(result.fileCount).toBeGreaterThanOrEqual(2);
    expect((await stat(outputPath)).size).toBeGreaterThan(0);
  });
});
