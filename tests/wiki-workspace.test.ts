import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  adoptWikiRepository,
  buildWikiIndex,
  cloneWikiRepository,
  configureWikiGitProvider,
  copyWikiPage,
  createWikiPage,
  deleteWikiPage,
  listTrashedWikiPages,
  restoreTrashedWikiPage,
  discoverWikiRepositories,
  exportWiki,
  initWikiRepository,
  mergeWikiPages,
  moveWikiPage,
  publicWikiNotes,
  repositoryFromId,
  resolveWikiLink,
  runWikiGitAction,
  searchWikiDatabase,
  updateWikiTag,
  updateWikiNamespace,
  wikiDatabaseFile,
  wikiIndexStatus,
  wikiPageDiff,
  wikiPageHistory,
  runWikiBranchAction,
  runWikiRemoteAction,
  wikiRepositoryBranches,
  wikiRepositoryDiff,
  wikiRepositoryRemotes,
  wikiRepositoryStatus,
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
  configureWikiGitProvider(null);
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

  test("updates wiki.db incrementally without mutating Git", async () => {
    const root = await tempRoot();
    const repository = await gitRepository(root, "private", "research");
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Noema Test"]);
    const file = join(repository, "page.md");
    await writeFile(file, note("page-id", "Page", "First body"));
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "initial"]);

    const first = await buildWikiIndex(root, { layout: "wiki", mode: "auto" });
    expect(first.maintenance).toMatchObject({ mode: "full", reason: "no-db" });
    await writeFile(file, note("page-id", "Page", "Second body"));
    const headBefore = (await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
    const statusBefore = (await execFileAsync("git", ["-C", repository, "status", "--porcelain"])).stdout;

    const second = await buildWikiIndex(root, { layout: "wiki", mode: "auto", changedFiles: [file, file] });
    expect(second.maintenance).toMatchObject({ mode: "incremental", changedFiles: [file] });
    expect(second.maintenance?.changes.pages).toBe(1);
    expect(searchWikiDatabase(root, { query: "Second body" })).toMatchObject({ total: 1 });
    expect((await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
    expect((await execFileAsync("git", ["-C", repository, "status", "--porcelain"])).stdout).toBe(statusBefore);
    expect(existsSync(join(root, "roam.db"))).toBe(false);
    expect(wikiIndexStatus(root)).toMatchObject({
      ok: true,
      schemaVersion: 9,
      lastMode: "incremental",
      repositories: [expect.objectContaining({ repositoryId: "private/research", headSha: headBefore })],
    });
  });

  test("indexes and resolves page-scoped block fragments", async () => {
    const root = await tempRoot();
    const repository = await gitRepository(root, "private", "research");
    const blockId = "0198fbac-0780-7c99-85e6-333333333333";
    const missingId = "0198fbac-0780-7c99-85e6-444444444444";
    const targetFile = join(repository, "target.md");
    await writeFile(targetFile, note("target-id", "Target", [
      `#+begin theorem Spectral theorem {#${blockId}}`,
      "Statement.",
      "#+end theorem",
      "```md",
      "{#0198fbac-0780-7c99-85e6-555555555555}",
      "```",
      "~~~md",
      "{#0198fbac-0780-7c99-85e6-666666666666}",
      "~~~",
    ].join("\n")));
    await writeFile(join(repository, "source.md"), note("source-id", "Source", [
      `[cite](roam://target-id#${blockId})`,
      `[[roam://target-id#${blockId}|Spectral theorem]]`,
    ].join("\n")));

    const index = await buildWikiIndex(root, { layout: "wiki" });
    const target = index.notes.find((item) => item.id === "target-id")!;
    expect(target.blocks).toEqual([expect.objectContaining({
      id: blockId,
      kind: "org-env",
      envKind: "theorem",
      label: "theorem · Spectral theorem",
    })]);
    expect(resolveWikiLink(index, `roam://target-id#${blockId}`)).toMatchObject({
      status: "resolved",
      fragment: blockId,
      targetBlockId: blockId,
      candidates: [expect.objectContaining({ id: "target-id" })],
    });
    expect(resolveWikiLink(index, `#${blockId}`, { sourceFile: targetFile })).toMatchObject({
      status: "resolved",
      targetBlockId: blockId,
    });
    expect(resolveWikiLink(index, `roam://target-id#${missingId}`)).toMatchObject({
      status: "missing-fragment",
      fragment: missingId,
    });
    expect(searchWikiDatabase(root, { query: "Target" }).items[0]).toMatchObject({
      blocks: [expect.objectContaining({ id: blockId, label: "theorem · Spectral theorem" })],
    });

    const db = new DatabaseSync(wikiDatabaseFile(root), { readOnly: true });
    try {
      expect(db.prepare("SELECT target_id, target_block_id, status FROM links WHERE target_block_id=?").all(blockId))
        .toEqual(expect.arrayContaining([expect.objectContaining({ target_id: "target-id", target_block_id: blockId, status: "resolved" })]));
    } finally {
      db.close();
    }
  });

  test("reports exact changed files for the legacy direct Git pull tool", async () => {
    const root = await tempRoot();
    const seed = join(root, "seed");
    const remote = join(root, "remote.git");
    const collaborator = join(root, "collaborator");
    const repository = join(root, "public", "notes");
    await mkdir(seed, { recursive: true });
    await execFileAsync("git", ["init", seed]);
    await execFileAsync("git", ["-C", seed, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", seed, "config", "user.name", "Noema Test"]);
    await writeFile(join(seed, "initial.md"), note("initial-id", "Initial"));
    await execFileAsync("git", ["-C", seed, "add", "."]);
    await execFileAsync("git", ["-C", seed, "commit", "-m", "initial"]);
    await execFileAsync("git", ["clone", "--bare", seed, remote]);
    await mkdir(join(root, "public"), { recursive: true });
    await execFileAsync("git", ["clone", remote, repository]);
    await execFileAsync("git", ["clone", remote, collaborator]);
    await execFileAsync("git", ["-C", collaborator, "config", "user.email", "collaborator@example.com"]);
    await execFileAsync("git", ["-C", collaborator, "config", "user.name", "Collaborator"]);
    const incoming = join(collaborator, "incoming.md");
    await writeFile(incoming, note("incoming-id", "Incoming"));
    await execFileAsync("git", ["-C", collaborator, "add", "."]);
    await execFileAsync("git", ["-C", collaborator, "commit", "-m", "incoming"]);
    await execFileAsync("git", ["-C", collaborator, "push"]);

    await expect(runWikiGitAction(root, "pull", { repositoryId: "public/notes" })).resolves.toMatchObject({
      action: "pull",
      phase: "idle",
      changedPaths: [join(repository, "incoming.md")],
    });
  });

  test("routes direct Git status and actions through the kernel provider", async () => {
    const root = await tempRoot();
    const repository = await gitRepository(root, "public", "kernel-backed");
    const requests: Array<Record<string, unknown>> = [];
    configureWikiGitProvider({
      owns: (path: string) => path === repository,
      async status(path: string) {
        requests.push({ type: "status", path });
        return {
          branch: "main", remote: "origin", clean: true, status: "## main", source: "kernel-vaultgit",
        };
      },
      async action(request: Record<string, unknown>) {
        requests.push({ type: "action", ...request });
        return {
          branch: "main", remote: "origin", clean: true, status: "## main", source: "kernel-vaultgit",
          action: "pull", phase: "idle", changedPaths: ["incoming.md", ".noema/state.json", " leading.md"], message: "Repository refreshed",
        };
      },
      async history() { throw new Error("unexpected history request"); },
      async diff() { throw new Error("unexpected diff request"); },
      async restore() { throw new Error("unexpected restore request"); },
    });

    await expect(wikiRepositoryStatus(root, "public/kernel-backed")).resolves.toMatchObject({
      clean: true, source: "kernel-vaultgit",
    });
    await expect(runWikiGitAction(root, "pull", { repositoryId: "public/kernel-backed" })).resolves.toMatchObject({
      action: "pull",
      source: "kernel-vaultgit",
      changedPaths: [
        join(repository, "incoming.md"),
        join(repository, ".noema", "state.json"),
        join(repository, " leading.md"),
      ],
    });
    expect(requests).toEqual([
      { type: "status", path: repository },
      { type: "action", repositoryPath: repository, action: "pull", message: "", paths: [] },
    ]);
  });

  test("incremental relationship persistence re-resolves unchanged source pages", async () => {
    const root = await tempRoot();
    const repository = await gitRepository(root, "private", "research");
    const source = join(repository, "source.md");
    await writeFile(source, note("source-id", "Source", "[[Target]]"));
    await buildWikiIndex(root, { layout: "wiki" });
    const target = join(repository, "target.md");
    await writeFile(target, note("target-id", "Target"));
    const next = await buildWikiIndex(root, { layout: "wiki", mode: "incremental", changedFiles: [target] });
    expect(next.maintenance?.mode).toBe("incremental");
    const db = new DatabaseSync(wikiDatabaseFile(root), { readOnly: true });
    try {
      const sourceKey = next.notes.find((item) => item.id === "source-id")?.pageKey;
      expect(sourceKey).toBeTruthy();
      expect(db.prepare("SELECT raw_target, target_id, status FROM links WHERE source_key=?").get(sourceKey!))
        .toMatchObject({ raw_target: "Target", target_id: "target-id", status: "resolved" });
    } finally {
      db.close();
    }
  });

  test("incremental metadata repair preserves cached full-text content", async () => {
    const root = await tempRoot();
    const repository = await gitRepository(root, "private", "research");
    await writeFile(join(repository, "cached.md"), note("cached-id", "Cached", "RareSearchNeedle"));
    await buildWikiIndex(root, { layout: "wiki" });
    const db = new DatabaseSync(wikiDatabaseFile(root));
    try {
      db.prepare("UPDATE pages SET title='stale' WHERE page_id='cached-id'").run();
    } finally {
      db.close();
    }
    const next = await buildWikiIndex(root, { layout: "wiki", mode: "incremental" });
    expect(next.maintenance?.changes.pages).toBe(1);
    expect(searchWikiDatabase(root, { query: "RareSearchNeedle" })).toMatchObject({ total: 1 });
  });

  test("falls back to an atomic full rebuild when the HEAD watermark is rewritten", async () => {
    const root = await tempRoot();
    const repository = await gitRepository(root, "private", "research");
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Noema Test"]);
    const file = join(repository, "page.md");
    await writeFile(file, note("page-id", "Page", "Before"));
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "initial"]);
    await buildWikiIndex(root, { layout: "wiki" });
    await writeFile(file, note("page-id", "Page", "Rewritten"));
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "--amend", "--no-edit"]);

    const rebuilt = await buildWikiIndex(root, { layout: "wiki", mode: "auto" });
    expect(rebuilt.maintenance).toMatchObject({ mode: "full", reason: "head-watermark-unreachable" });
    expect(searchWikiDatabase(root, { query: "Rewritten" })).toMatchObject({ total: 1 });
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
    expect(history).toMatchObject({ source: "node-vaultgit" });
    expect(history.commits[0]).toMatchObject({ subject: "second version", author: "Historian" });
    expect(await wikiPageDiff(root, { pageId: page.id, sha: history.commits[0].sha })).toMatchObject({
      source: "node-vaultgit", diff: expect.stringContaining("Version two"),
    });
    await expect(restoreWikiPageVersion(root, { pageId: page.id, sha: firstSha })).resolves.toMatchObject({
      source: "node-vaultgit",
    });
    expect(await readFile(page.file, "utf8")).toContain("# Versioned page");
  });

  test("routes Wiki page history, diff, and restore through the kernel provider", async () => {
    const root = await tempRoot();
    const created = await initWikiRepository(root, "private", "kernel-history");
    const page = await createWikiPage(root, "wiki", {
      title: "Kernel history",
      repositoryId: "private/kernel-history",
      filename: "versioned.md",
    });
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const requests: Array<Record<string, unknown>> = [];
    configureWikiGitProvider({
      owns: (path: string) => path === created.repository.path,
      async status() {
        return { branch: "main", remote: "", clean: true, status: "## main", source: "kernel-vaultgit" };
      },
      async action() {
        return {
          branch: "main", remote: "", clean: true, status: "## main", source: "kernel-vaultgit",
          action: "pull", phase: "idle", changedPaths: [], message: "Repository refreshed",
        };
      },
      async history(repositoryPath: string, filePath: string, limit: number) {
        requests.push({ type: "history", repositoryPath, filePath, limit });
        return {
          path: filePath,
          commits: [{ sha, date: "2026-08-26T00:00:00Z", author: "Historian", email: "history@example.test", subject: "version" }],
          source: "kernel-vaultgit",
        };
      },
      async diff(repositoryPath: string, filePath: string, requestedSHA: string) {
        requests.push({ type: "diff", repositoryPath, filePath, sha: requestedSHA });
        return { path: filePath, diff: "+Version", scope: "commit", sha: requestedSHA, source: "kernel-vaultgit" };
      },
      async restore(repositoryPath: string, filePath: string, requestedSHA: string) {
        requests.push({ type: "restore", repositoryPath, filePath, sha: requestedSHA });
        return { path: filePath, sha: requestedSHA, source: "kernel-vaultgit", bytes: 18 };
      },
    });

    await expect(wikiPageHistory(root, { pageId: page.id, limit: 25 })).resolves.toMatchObject({
      source: "kernel-vaultgit", commits: [{ sha, author: "Historian" }],
    });
    await expect(wikiPageDiff(root, { pageId: page.id, sha })).resolves.toMatchObject({
      file: page.file, path: "versioned.md", diff: "+Version", source: "kernel-vaultgit",
    });
    await expect(restoreWikiPageVersion(root, { pageId: page.id, sha })).resolves.toMatchObject({
      file: page.file, sha, source: "kernel-vaultgit",
    });
    expect(requests).toEqual([
      { type: "history", repositoryPath: created.repository.path, filePath: "versioned.md", limit: 25 },
      { type: "diff", repositoryPath: created.repository.path, filePath: "versioned.md", sha },
      { type: "restore", repositoryPath: created.repository.path, filePath: "versioned.md", sha },
    ]);
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

  test("renames a page title in place while preserving its ID and old title alias", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "notes");
    const page = await createWikiPage(root, "wiki", { title: "Old title", repositoryId: "private/notes" });
    const moved = await moveWikiPage(root, { pageId: page.id, title: "New title", repositoryId: "private/notes", filename: "old-title.md" });
    expect(moved.file).toBe(page.file);
    const index = await buildWikiIndex(root, { layout: "wiki" });
    expect(index.notes.find((item) => item.id === page.id)).toMatchObject({ title: "New title", aliases: ["Old title"] });
    expect(resolveWikiLink(index, "Old title")).toMatchObject({ status: "resolved" });
    await expect(createWikiPage(root, "wiki", { title: "Old title", repositoryId: "private/notes", filename: "another.md" }))
      .rejects.toMatchObject({ code: "ERR_WIKI_TITLE_CONFLICT" });
  });

  test("privacy-gates copies into public Git and distinguishes repository placement from publishing", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "notes");
    await initWikiRepository(root, "public", "shared");
    const page = await createWikiPage(root, "wiki", { title: "Private source", repositoryId: "private/notes" });
    await expect(copyWikiPage(root, { pageId: page.id, repositoryId: "public/shared", filename: "copy.md" }))
      .rejects.toMatchObject({ code: "ERR_WIKI_PRIVACY_CONFIRM" });
    const hidden = await copyWikiPage(root, { pageId: page.id, repositoryId: "public/shared", filename: "hidden.md", title: "Hidden copy", confirm: "COPY PRIVATE TO PUBLIC" });
    const published = await copyWikiPage(root, { pageId: page.id, repositoryId: "public/shared", filename: "published.md", title: "Published copy", confirm: "COPY PRIVATE TO PUBLIC", publish: true });
    const moved = await moveWikiPage(root, { pageId: page.id, repositoryId: "public/shared", filename: "moved.md", confirm: "MOVE PRIVATE TO PUBLIC", publish: true });
    const index = await buildWikiIndex(root, { layout: "wiki" });
    const publicIds = publicWikiNotes(index).map((item) => item.id);
    expect(publicIds).not.toContain(hidden.id);
    expect(publicIds).toContain(published.id);
    expect(publicIds).toContain(moved.pageId);
    expect(await readFile(moved.file, "utf8")).toContain("private: false");
  });

  test("refuses relocation that would strand ordinary relative resources", async () => {
    const root = await tempRoot();
    const repository = await initWikiRepository(root, "private", "notes");
    const page = await createWikiPage(root, "wiki", { title: "With resource", repositoryId: "private/notes" });
    await writeFile(join(repository.repository.path, "figure.png"), "image");
    await writeFile(page.file, `${await readFile(page.file, "utf8")}\n![figure](figure.png)\n`);
    await expect(moveWikiPage(root, { pageId: page.id, repositoryId: "private/notes", directory: "moved", filename: "with-resource.md" }))
      .rejects.toMatchObject({ code: "ERR_WIKI_DEPENDENCIES" });
    expect(await readFile(page.file, "utf8")).toContain("figure.png");
  });

  test("merges body without title ambiguity and restores a trashed page with its original ID", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "notes");
    const survivor = await createWikiPage(root, "wiki", { title: "Survivor", repositoryId: "private/notes" });
    const duplicate = await createWikiPage(root, "wiki", { title: "Duplicate", repositoryId: "private/notes" });
    await writeFile(duplicate.file, `${await readFile(duplicate.file, "utf8")}\nUnique duplicate body.\n`);
    const merged = await mergeWikiPages(root, { survivorId: survivor.id, duplicateId: duplicate.id, confirm: "MERGE" });
    expect(await readFile(merged.survivorFile, "utf8")).toContain("Unique duplicate body.");
    expect(await readFile(merged.archiveFile, "utf8")).toContain("Unique duplicate body.");
    let index = await buildWikiIndex(root, { layout: "wiki" });
    expect(resolveWikiLink(index, "Duplicate")).toMatchObject({ status: "resolved", candidates: [expect.objectContaining({ id: survivor.id })] });
    expect(resolveWikiLink(index, `roam://${duplicate.id}`)).toMatchObject({ status: "resolved", candidates: [expect.objectContaining({ id: survivor.id })] });
    await deleteWikiPage(root, { pageId: survivor.id, confirm: "DELETE" }, { trashRoot: join(root, "test-trash") });
    expect((await listTrashedWikiPages(root)).pages).toEqual([expect.objectContaining({ pageId: survivor.id, available: true })]);
    const restored = await restoreTrashedWikiPage(root, { pageId: survivor.id });
    expect(restored.file).toBe(survivor.file);
    index = await buildWikiIndex(root, { layout: "wiki" });
    expect(index.notes.some((item) => item.id === survivor.id)).toBe(true);
    expect((await listTrashedWikiPages(root)).pages).toEqual([]);
  });

  test("reports branch, upstream, ahead/behind and per-file state as structured status", async () => {
    const root = await tempRoot();
    const upstream = join(root, "origin.git");
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", upstream]);
    const repository = await gitRepository(root, "private", "tracked");
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Noema Test"]);
    await execFileAsync("git", ["-C", repository, "checkout", "-B", "main"]);
    await writeFile(join(repository, "kept.md"), note("kept", "Kept"));
    await writeFile(join(repository, "renamed-from.md"), note("moved", "Moved"));
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "initial"]);
    await execFileAsync("git", ["-C", repository, "remote", "add", "origin", upstream]);
    await execFileAsync("git", ["-C", repository, "push", "-u", "origin", "main"]);

    // One commit the remote has not seen, plus a staged rename, an unstaged
    // edit and an untracked file in the working tree.
    await writeFile(join(repository, "ahead.md"), note("ahead", "Ahead"));
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "local work"]);
    await execFileAsync("git", ["-C", repository, "mv", "renamed-from.md", "renamed-to.md"]);
    await writeFile(join(repository, "kept.md"), note("kept", "Kept", "edited"));
    await writeFile(join(repository, "数学 note.md"), note("untracked", "Untracked"));

    const status = await wikiRepositoryStatus(root, "private/tracked") as Record<string, any>;
    expect(status).toMatchObject({
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      clean: false,
      conflictedFiles: 0,
      source: "node-vaultgit",
    });
    expect(status.remote).toBe(upstream);
    expect(status.head).toMatch(/^[0-9a-f]{40}$/);
    const byPath = new Map(status.entries.map((entry: any) => [entry.path, entry]));
    expect(byPath.get("renamed-to.md")).toMatchObject({ origPath: "renamed-from.md", label: "Renamed", staged: true });
    expect(byPath.get("kept.md")).toMatchObject({ staged: false, unstaged: true, label: "Modified" });
    expect(byPath.get("数学 note.md")).toMatchObject({ untracked: true, label: "Untracked" });
    expect(status.changedFiles).toBe(3);
    expect(status.status).toContain("## main...origin/main [ahead 1]");
  });

  test("derives the same structured status from a kernel-provided porcelain string", async () => {
    const root = await tempRoot();
    const upstream = join(root, "kernel.git");
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", upstream]);
    const repository = await gitRepository(root, "public", "kernel-status");
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Noema Test"]);
    await execFileAsync("git", ["-C", repository, "checkout", "-B", "main"]);
    await writeFile(join(repository, "note.md"), note("kernel", "Kernel"));
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "seed"]);
    await execFileAsync("git", ["-C", repository, "remote", "add", "origin", upstream]);
    await execFileAsync("git", ["-C", repository, "push", "origin", "main"]);
    await execFileAsync("git", ["-C", repository, "fetch", "origin"]);
    await execFileAsync("git", ["-C", repository, "checkout", "-b", "work/mac"]);
    configureWikiGitProvider({
      owns: (path: string) => path === repository,
      async status() {
        return {
          branch: "work/mac",
          remote: "origin",
          clean: false,
          status: "## work/mac...origin/main [ahead 2, behind 1]\n M note.md",
          source: "kernel-vaultgit",
        };
      },
      async action() { throw new Error("unexpected action request"); },
      async history() { throw new Error("unexpected history request"); },
      async diff() { throw new Error("unexpected diff request"); },
      async restore() { throw new Error("unexpected restore request"); },
    });
    const status = await wikiRepositoryStatus(root, "public/kernel-status") as Record<string, any>;
    expect(status).toMatchObject({ ahead: 2, behind: 1, upstream: "origin/main", source: "kernel-vaultgit" });
    expect(status.entries).toHaveLength(1);
    expect(status.entries[0]).toMatchObject({ path: "note.md", unstaged: true });
    expect(status.publishTarget).toBeUndefined();
  });

  test("names the origin publish target for a kernel-owned device branch", async () => {
    const root = await tempRoot();
    const upstream = join(root, "kernel-device.git");
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", upstream]);
    const repository = await gitRepository(root, "public", "kernel-device");
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Noema Test"]);
    await execFileAsync("git", ["-C", repository, "checkout", "-B", "main"]);
    await writeFile(join(repository, "note.md"), note("kernel", "Kernel"));
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "seed"]);
    await execFileAsync("git", ["-C", repository, "remote", "add", "origin", upstream]);
    await execFileAsync("git", ["-C", repository, "push", "origin", "main"]);
    await execFileAsync("git", ["-C", repository, "fetch", "origin"]);
    await execFileAsync("git", ["-C", repository, "checkout", "-b", "noema/device-a"]);
    await writeFile(join(repository, "later.md"), note("later", "Later"));
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "device work"]);

    // The kernel owns this repository, and reports a branch with no upstream —
    // the distance that matters is still the one to the publish target.
    configureWikiGitProvider({
      owns: (path: string) => path === repository,
      async status() {
        return { branch: "noema/device-a", remote: "origin", clean: true, status: "## noema/device-a", source: "kernel-vaultgit" };
      },
      async action() { throw new Error("unexpected action request"); },
      async history() { throw new Error("unexpected history request"); },
      async diff() { throw new Error("unexpected diff request"); },
      async restore() { throw new Error("unexpected restore request"); },
    });
    await expect(wikiRepositoryStatus(root, "public/kernel-device")).resolves.toMatchObject({
      branch: "noema/device-a",
      upstream: "",
      publishTarget: "origin/main",
      ahead: 1,
      behind: 0,
      source: "kernel-vaultgit",
    });
  });

  test("measures a device work branch against its origin publish target", async () => {
    const root = await tempRoot();
    const upstream = join(root, "publish.git");
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", upstream]);
    const repository = await gitRepository(root, "private", "device");
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Noema Test"]);
    await execFileAsync("git", ["-C", repository, "checkout", "-B", "main"]);
    await writeFile(join(repository, "seed.md"), note("seed", "Seed"));
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "seed"]);
    await execFileAsync("git", ["-C", repository, "remote", "add", "origin", upstream]);
    await execFileAsync("git", ["-C", repository, "push", "origin", "main"]);
    await execFileAsync("git", ["-C", repository, "fetch", "origin"]);

    // A device branch with no upstream, two commits past the publish target.
    await execFileAsync("git", ["-C", repository, "checkout", "-b", "noema/device-a"]);
    for (const name of ["one.md", "two.md"]) {
      await writeFile(join(repository, name), note(name, name));
      await execFileAsync("git", ["-C", repository, "add", "."]);
      await execFileAsync("git", ["-C", repository, "commit", "-m", `add ${name}`]);
    }

    const status = await wikiRepositoryStatus(root, "private/device") as Record<string, any>;
    expect(status).toMatchObject({
      branch: "noema/device-a",
      upstream: "",
      publishTarget: "origin/main",
      ahead: 2,
      behind: 0,
      clean: true,
    });
  });

  test("diffs a tracked change against HEAD and an untracked file against nothing", async () => {
    const root = await tempRoot();
    const repository = await gitRepository(root, "private", "diffs");
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Noema Test"]);
    await writeFile(join(repository, "tracked.md"), "before\n");
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "initial"]);
    await writeFile(join(repository, "tracked.md"), "after\n");
    await writeFile(join(repository, "fresh.md"), "brand new\n");

    const tracked = await wikiRepositoryDiff(root, { repositoryId: "private/diffs", path: "tracked.md" }) as Record<string, any>;
    expect(tracked.tracked).toBe(true);
    expect(tracked.diff).toContain("-before");
    expect(tracked.diff).toContain("+after");

    const untracked = await wikiRepositoryDiff(root, { repositoryId: "private/diffs", path: "fresh.md" }) as Record<string, any>;
    expect(untracked.tracked).toBe(false);
    expect(untracked.diff).toContain("+brand new");

    await expect(wikiRepositoryDiff(root, { repositoryId: "private/diffs", path: "../escape.md" }))
      .rejects.toThrow(/Invalid repository-relative path/);
  });

  test("lists branches with upstream, current, managed and other-worktree state", async () => {
    const root = await tempRoot();
    const repository = await gitRepository(root, "private", "branches");
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Noema Test"]);
    await execFileAsync("git", ["-C", repository, "checkout", "-B", "main"]);
    await writeFile(join(repository, "seed.md"), note("seed", "Seed"));
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "seed"]);
    await execFileAsync("git", ["-C", repository, "branch", "noema/device-a"]);
    const parked = join(root, "parked");
    await execFileAsync("git", ["-C", repository, "worktree", "add", "-b", "noema-integration/device-a", parked, "HEAD"]);

    const listed = await wikiRepositoryBranches(root, { repositoryId: "private/branches" });
    expect(listed.current).toBe("main");
    const byName = new Map<string, any>(listed.branches.map((branch: any) => [String(branch.name), branch]));
    expect(byName.get("main")).toMatchObject({ current: true, managed: false, checkedOutAt: "" });
    expect(byName.get("noema/device-a")).toMatchObject({ current: false, managed: true });
    expect(byName.get("noema-integration/device-a").checkedOutAt).toContain("parked");
    // The current branch sorts first, and Noema-managed branches sort last.
    expect(listed.branches[0].name).toBe("main");
  });

  test("guards branch switching on a clean tree and refuses worktree-held branches", async () => {
    const root = await tempRoot();
    const repository = await gitRepository(root, "private", "switching");
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Noema Test"]);
    await execFileAsync("git", ["-C", repository, "checkout", "-B", "main"]);
    await writeFile(join(repository, "seed.md"), note("seed", "Seed"));
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "seed"]);
    const parked = join(root, "parked");
    await execFileAsync("git", ["-C", repository, "worktree", "add", "-b", "held", parked, "HEAD"]);

    const created = await runWikiBranchAction(root, {
      repositoryId: "private/switching",
      action: "create",
      name: "topic/rewrite",
    });
    expect(created.current).toBe("topic/rewrite");

    await expect(runWikiBranchAction(root, { repositoryId: "private/switching", action: "switch", name: "held" }))
      .rejects.toThrow(/checked out in another worktree/);

    await writeFile(join(repository, "dirty.md"), note("dirty", "Dirty"));
    await expect(runWikiBranchAction(root, { repositoryId: "private/switching", action: "switch", name: "main" }))
      .rejects.toThrow(/Commit or checkpoint the working tree/);
  });

  test("refuses to delete the current branch, and a Noema branch without force", async () => {
    const root = await tempRoot();
    const repository = await gitRepository(root, "private", "deleting");
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Noema Test"]);
    await execFileAsync("git", ["-C", repository, "checkout", "-B", "main"]);
    await writeFile(join(repository, "seed.md"), note("seed", "Seed"));
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "seed"]);
    await execFileAsync("git", ["-C", repository, "branch", "noema/device-a"]);
    await execFileAsync("git", ["-C", repository, "branch", "spare"]);

    await expect(runWikiBranchAction(root, { repositoryId: "private/deleting", action: "delete", name: "main" }))
      .rejects.toThrow(/Switch to another branch/);
    await expect(runWikiBranchAction(root, { repositoryId: "private/deleting", action: "delete", name: "noema/device-a" }))
      .rejects.toThrow(/maintained by Noema/);
    await expect(runWikiBranchAction(root, {
      repositoryId: "private/deleting", action: "delete", name: "noema/device-a", force: true,
    })).resolves.toMatchObject({ action: "delete" });

    const remaining = await runWikiBranchAction(root, { repositoryId: "private/deleting", action: "delete", name: "spare" });
    expect(remaining.branches.map((branch: any) => branch.name)).toEqual(["main"]);
  });

  test("rejects unsafe branch names and remote URLs before they reach git", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "validation");
    for (const name of ["--force", "bad name", "tip..end", "refs/@{0}", "trailing/"]) {
      await expect(runWikiBranchAction(root, { repositoryId: "private/validation", action: "create", name }))
        .rejects.toThrow(/branch name/i);
    }
    await expect(runWikiRemoteAction(root, {
      repositoryId: "private/validation", action: "set", name: "origin",
      url: "https://user:secret@example.test/repo.git",
    })).rejects.toThrow(/embedded credentials/);
    await expect(runWikiRemoteAction(root, {
      repositoryId: "private/validation", action: "set", name: "origin", url: "--upload-pack=touch",
    })).rejects.toThrow(/must not start with/);
    await expect(runWikiRemoteAction(root, {
      repositoryId: "private/validation", action: "set", name: "bad name", url: "https://example.test/repo.git",
    })).rejects.toThrow(/Invalid remote name/);
  });

  test("adds, rewrites, and removes the origin remote", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "remotes");
    expect((await wikiRepositoryRemotes(root, { repositoryId: "private/remotes" })).remotes).toEqual([]);

    await runWikiRemoteAction(root, {
      repositoryId: "private/remotes", action: "set", name: "origin", url: "https://example.test/first.git",
    });
    await expect(runWikiRemoteAction(root, {
      repositoryId: "private/remotes", action: "set", name: "origin", url: "git@example.test:owner/second.git",
    })).resolves.toMatchObject({
      remotes: [{ name: "origin", fetchUrl: "git@example.test:owner/second.git" }],
    });
    await expect(runWikiRemoteAction(root, { repositoryId: "private/remotes", action: "remove", name: "origin" }))
      .resolves.toMatchObject({ remotes: [] });
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

  test("derives backlinks and dependency status from the current workspace, not the parse cache", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "math");
    const repository = join(root, "private", "math");
    const source = await createWikiPage(root, "wiki", { title: "Source", repositoryId: "private/math", filename: "source.md" });
    const target = await createWikiPage(root, "wiki", { title: "Target", repositoryId: "private/math", filename: "target.md" });
    await writeFile(source.file, `${await readFile(source.file, "utf8")}See [[Target]].\n`);
    await writeFile(target.file, `${await readFile(target.file, "utf8")}![figure](figures/plot.png)\n`);

    let index = await buildWikiIndex(root, { layout: "wiki" });
    let page = index.notes.find((note) => note.id === target.id)!;
    expect(page.backlinks).toEqual([source.id]);
    expect(page.dependencies).toMatchObject([{ path: "figures/plot.png", status: "missing" }]);

    // Only other files change; Target itself is served from the parse cache.
    await writeFile(source.file, (await readFile(source.file, "utf8")).replace("See [[Target]].", "No link."));
    await mkdir(join(repository, "figures"));
    await writeFile(join(repository, "figures", "plot.png"), "png");
    index = await buildWikiIndex(root, { layout: "wiki" });
    page = index.notes.find((note) => note.id === target.id)!;
    expect(page.backlinks).toEqual([]);
    expect(page.dependencies).toMatchObject([{ path: "figures/plot.png", status: "resolved" }]);
    await expect(deleteWikiPage(root, { pageId: target.id }, { trashRoot: join(root, "trash") }))
      .resolves.toMatchObject({ type: "wiki-page-trashed", backlinks: [] });
  });

  test("reads page identity from the preamble only and edits metadata literally", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "meta");
    const page = await createWikiPage(root, "wiki", { title: "Cost plan", repositoryId: "private/meta", filename: "cost.md" });
    const guide = join(root, "private", "meta", "guide.md");
    await writeFile(guide, [
      "# Writing metadata", "", ...Array.from({ length: 12 }, (_, line) => `Line ${line}.`), "",
      "#+begin meta", `id: ${page.id}`, "title: Cost plan", "#+end meta", "",
    ].join("\n"));
    const index = await buildWikiIndex(root, { layout: "wiki" });
    expect(index.reports.duplicateIds).toEqual([]);
    expect(index.notes.find((note) => note.file === guide)).toMatchObject({ title: "Writing metadata", identityStatus: "provisional" });

    // `$1` and `$&` are replacement patterns to String.replace; an empty field
    // must not swallow the line after it.
    const moved = await moveWikiPage(root, { pageId: page.id, title: "Cost $100 & $& plan" });
    const content = await readFile(moved.file, "utf8");
    expect(content).toContain("\ntitle: Cost $100 & $& plan\n");
    expect(content).toContain("\naliases: Cost plan\n");
    expect(content).toContain("\nrefs: \n");
    expect(content).toContain("\n# Cost $100 & $& plan\n");
    expect(content.match(/#\+end meta/g)).toHaveLength(1);
  });

  test("finds short CJK terms the trigram index cannot answer and filters by modification date", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "math");
    const group = await createWikiPage(root, "wiki", { title: "群论", repositoryId: "private/math", filename: "group.md", tags: ["代数"] });
    const ring = await createWikiPage(root, "wiki", { title: "Rings", repositoryId: "private/math", filename: "ring.md" });
    await writeFile(ring.file, `${await readFile(ring.file, "utf8")}环是带有两种运算的集合，同构保持结构。\n`);
    await buildWikiIndex(root, { layout: "wiki" });

    expect(searchWikiDatabase(root, { query: "群论" }).items.map((item) => item.id)).toEqual([group.id]);
    expect(searchWikiDatabase(root, { query: "群" }).items.map((item) => item.id)).toEqual([group.id]);
    const body = searchWikiDatabase(root, { query: "同构" });
    expect(body).toMatchObject({ total: 1, nextCursor: null });
    expect(body.items[0]).toMatchObject({ id: ring.id, excerpt: expect.stringContaining("[[同构]]") });
    expect(searchWikiDatabase(root, { query: "同构 运算" }).items.map((item) => item.id)).toEqual([ring.id]);
    expect(searchWikiDatabase(root, { query: "同构 tag:代数" }).items).toEqual([]);
    expect(searchWikiDatabase(root, { query: "100%" }).items).toEqual([]);

    const ids = (query: string) => searchWikiDatabase(root, { query }).items.map((item) => item.id).sort();
    const both = [group.id, ring.id].sort();
    expect(ids("after:1d")).toEqual(both);
    expect(ids("before:2000-01-01")).toEqual([]);
    expect(ids("-before:2000-01-01")).toEqual(both);
    expect(ids("after:not-a-date")).toEqual([]);
    expect(ids("群 after:1d")).toEqual([group.id]);
  });

  test("filters by the period a page is dated in", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "math");
    const old = await createWikiPage(root, "wiki", { title: "Old page", repositoryId: "private/math", filename: "old.md" });
    const recent = await createWikiPage(root, "wiki", { title: "Recent page", repositoryId: "private/math", filename: "recent.md" });
    const undated = await createWikiPage(root, "wiki", { title: "Undated page", repositoryId: "private/math", filename: "undated.md" });
    const redate = async (file: string, line: string) => {
      await writeFile(file, (await readFile(file, "utf8")).replace(/^date: .*\n/m, line));
    };
    await redate(old.file, "date: 2019-03-14\n");
    await redate(undated.file, "");
    await buildWikiIndex(root, { layout: "wiki" });

    const ids = (query: string) => searchWikiDatabase(root, { query }).items.map((item) => item.id).sort();
    // A new page is stamped with the day it was created.
    expect(ids("created:1d")).toEqual([recent.id]);
    expect(ids("created:2019")).toEqual([old.id]);
    expect(ids("created:2019-03")).toEqual([old.id]);
    expect(ids("created:2019-03-14")).toEqual([old.id]);
    expect(ids("created:2019-03-15")).toEqual([]);
    expect(ids("created:2019-04")).toEqual([]);
    // A page without a date belongs to no period, and is what the negation keeps.
    expect(ids("-created:2019 page")).toEqual([recent.id, undated.id].sort());
    expect(ids("created:not-a-date")).toEqual([]);
    expect(searchWikiDatabase(root, { query: "created:2019" }).items[0]).toMatchObject({
      createdMs: new Date(2019, 2, 14).getTime(),
    });
  });

  test("resolves a page whose alias repeats its own title, and never a redirect by title", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "math");
    const kept = await createWikiPage(root, "wiki", { title: "Tensor", repositoryId: "private/math", filename: "tensor.md" });
    const merged = await createWikiPage(root, "wiki", { title: "Tensors", repositoryId: "private/math", filename: "tensors.md" });
    const reader = await createWikiPage(root, "wiki", { title: "Reader", repositoryId: "private/math", filename: "reader.md" });
    await writeFile(kept.file, (await readFile(kept.file, "utf8")).replace("refs: ", "aliases: tensor\nrefs: "));
    await writeFile(reader.file, `${await readFile(reader.file, "utf8")}[[Tensor]] and [[Tensors]].\n`);
    await mergeWikiPages(root, { survivorId: kept.id, duplicateId: merged.id, confirm: "MERGE" });

    const index = await buildWikiIndex(root, { layout: "wiki" });
    expect(index.reports.ambiguous).toEqual([]);
    expect(index.notes.find((note) => note.id === reader.id)?.refs).toEqual([kept.id]);
    const db = new DatabaseSync(wikiDatabaseFile(root), { readOnly: true });
    try {
      const rows = db.prepare("SELECT l.raw_target, l.target_id, l.status FROM links l JOIN pages p ON p.page_key=l.source_key WHERE p.page_id=? ORDER BY l.raw_target").all(reader.id);
      expect(rows).toEqual([
        { raw_target: "Tensor", target_id: kept.id, status: "resolved" },
        { raw_target: "Tensors", target_id: kept.id, status: "resolved" },
      ]);
    } finally {
      db.close();
    }
  });

  test("links a title that contains a colon unless a namespace answers first", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "math");
    await initWikiRepository(root, "private", "notes");
    const chapter = await createWikiPage(root, "wiki", { title: "Chapter 1: Scope", repositoryId: "private/math", filename: "chapter.md" });
    const theorem = await createWikiPage(root, "wiki", { title: "定理：存在性", repositoryId: "private/math", filename: "theorem.md" });
    const scoped = await createWikiPage(root, "wiki", { title: "Scope", repositoryId: "private/notes", filename: "scope.md" });
    const reader = await createWikiPage(root, "wiki", { title: "Reader", repositoryId: "private/math", filename: "reader.md" });
    await writeFile(reader.file, `${await readFile(reader.file, "utf8")}[[Chapter 1: Scope]] [[定理：存在性]] [[notes:Scope]] [[Nowhere: Else]]\n`);
    const index = await buildWikiIndex(root, { layout: "wiki" });
    const page = index.notes.find((note) => note.id === reader.id)!;
    expect([...page.refs].sort()).toEqual([chapter.id, theorem.id, scoped.id].sort());
    expect(page.unresolvedLinks).toEqual(["Nowhere: Else"]);
    expect(index.reports.wanted).toMatchObject([{ title: "Nowhere: Else", namespace: "math" }]);
    expect(resolveWikiLink(index, "定理：存在性", { sourceFile: reader.file })).toMatchObject({
      status: "resolved", candidates: [{ id: theorem.id }],
    });
  });

  test("keeps authored values on one meta line", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "meta");
    const create = (body: Record<string, unknown>) => createWikiPage(root, "wiki", { repositoryId: "private/meta", ...body });
    await expect(create({ title: "Innocent\nid: 019a0000-0000-7000-8000-000000000001", filename: "a.md" })).rejects.toThrow(/single line/);
    await expect(create({ title: "Page", filename: "b.md", id: "x\nredirect_to: roam://y" })).rejects.toThrow(/single line/);
    await expect(create({ title: "Page", filename: "c.md", kind: "page\nprivate: false" })).rejects.toThrow(/single line/);
    const page = await create({ title: "Tagged", filename: "d.md", tags: ["a, b", "c"] });
    expect(await readFile(page.file, "utf8")).toContain("\ntags: a  b, c\n");
    await expect(moveWikiPage(root, { pageId: page.id, title: "New\nkind: redirect" })).rejects.toThrow(/single line/);
    await expect(copyWikiPage(root, { pageId: page.id, filename: "e.md", title: "Copy\nid: z" })).rejects.toThrow(/single line/);
    expect(existsSync(join(root, "private", "meta", "a.md"))).toBe(false);
  });

  test("a move that fails part way leaves the page and its assets where they were", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "math");
    const repository = join(root, "private", "math");
    const page = await createWikiPage(root, "wiki", { title: "Movable", repositoryId: "private/math", filename: "movable.md" });
    const before = await readFile(page.file, "utf8");
    await mkdir(join(repository, "images", page.id), { recursive: true });
    await writeFile(join(repository, "images", page.id, "plot.png"), "png");
    // The destination already holds an asset directory for this page id.
    await mkdir(join(repository, "archive", "images", page.id), { recursive: true });

    await expect(moveWikiPage(root, { pageId: page.id, directory: "archive", title: "Moved" }))
      .rejects.toMatchObject({ code: "ERR_WIKI_ASSET_CONFLICT" });
    expect(await readFile(page.file, "utf8")).toBe(before);
    expect(existsSync(join(repository, "archive", "movable.md"))).toBe(false);
    expect(existsSync(join(repository, "images", page.id, "plot.png"))).toBe(true);

    await rm(join(repository, "archive", "images"), { recursive: true });
    const moved = await moveWikiPage(root, { pageId: page.id, directory: "archive", title: "Moved" });
    expect(moved.file).toBe(join(repository, "archive", "movable.md"));
    expect(existsSync(page.file)).toBe(false);
    expect(existsSync(join(repository, "archive", "images", page.id, "plot.png"))).toBe(true);
    expect(await readFile(moved.file, "utf8")).toContain("\ntitle: Moved\n");
  });

  test("does not copy or retag a page whose metadata lives in YAML front matter", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "yaml");
    const id = "019a0000-0000-7000-8000-00000000f00d";
    const file = join(root, "private", "yaml", "front.md");
    const content = `---\nid: ${id}\ntitle: Front\ntags: old\n---\n\n# Front\n`;
    await writeFile(file, content);
    await expect(copyWikiPage(root, { pageId: id, filename: "front-copy.md" })).rejects.toMatchObject({ code: "ERR_WIKI_IDENTITY" });
    expect(existsSync(join(root, "private", "yaml", "front-copy.md"))).toBe(false);
    await expect(updateWikiTag(root, { action: "rename", from: "old", to: "new" }))
      .resolves.toMatchObject({ changed: [], skipped: [{ id }] });
    expect(await readFile(file, "utf8")).toBe(content);
  });

  test("indexes a Markdown file exported by Alexandrie from its YAML front matter", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "imported");
    // The shape `generateMarkdownWithMetadata` writes: quoted title, optional
    // description, comma-separated tags, then the document body.
    await writeFile(join(root, "private", "imported", "guide.md"),
      '---\ntitle: "Docker 部署"\ndescription: "How to deploy"\ntags: docker, 运维\n---\n\n\nBody with [[Docker 部署]] and 运维 notes.\n');
    const index = await buildWikiIndex(root, { layout: "wiki" });
    expect(index.notes).toMatchObject([{ title: "Docker 部署", tags: ["docker", "运维"], identityStatus: "provisional" }]);
    expect(searchWikiDatabase(root, { query: "tag:运维" }).items.map((item) => item.title)).toEqual(["Docker 部署"]);
    expect(searchWikiDatabase(root, { query: "运维" }).total).toBe(1);
  });

  test("tracks an asset whose file name contains parentheses", async () => {
    const root = await tempRoot();
    await initWikiRepository(root, "private", "math");
    const repository = join(root, "private", "math");
    const page = await createWikiPage(root, "wiki", { title: "Figures", repositoryId: "private/math", filename: "figures.md" });
    await writeFile(join(repository, "fig(1).png"), "png");
    await writeFile(join(repository, "shot (2).png"), "png");
    await writeFile(page.file, `${await readFile(page.file, "utf8")}![a](fig(1).png) and ![b](<shot (2).png>) and [c](gone(3).pdf)\n`);
    const index = await buildWikiIndex(root, { layout: "wiki" });
    expect(index.notes.find((note) => note.id === page.id)?.dependencies).toMatchObject([
      { path: "fig(1).png", status: "resolved" },
      { path: "shot (2).png", status: "resolved" },
      { path: "gone(3).pdf", status: "missing" },
    ]);
  });

  test("clones only from remotes the remote policy accepts", async () => {
    const root = await tempRoot();
    await expect(cloneWikiRepository(root, { partition: "private", name: "evil", remote: "ext::sh -c 'touch pwned'" }))
      .rejects.toThrow(/Git remote URL/);
    await expect(cloneWikiRepository(root, { partition: "private", name: "evil", remote: "https://user:secret@example.test/x.git" }))
      .rejects.toThrow(/embedded credentials/);
    expect(existsSync(join(root, "private", "evil"))).toBe(false);
  });
});
