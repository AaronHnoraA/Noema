import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  buildWikiIndex,
  createWikiPage,
  discoverWikiRepositories,
  publicWikiNotes,
  resolveWikiLink,
  wikiDatabaseFile,
} from "../server/lib/wiki-workspace.mjs";

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
    expect(index.reports.wanted[0]).toMatchObject({ title: "Missing Page" });
    expect(index.reports.duplicates.length).toBeGreaterThan(0);
    expect(wikiDatabaseFile(root)).toBe(join(root, ".noema", "wiki.db"));
  });

  test("uses a workbench request to create a page at an explicit repository destination", async () => {
    const root = await tempRoot();
    await gitRepository(root, "private", "project");
    const result = await createWikiPage(root, "wiki", {
      title: "New Design",
      repositoryId: "private/project",
      directory: "architecture",
      filename: "new-design.md",
      tags: "wiki, design",
    });
    expect(result.file).toBe(join(root, "private", "project", "architecture", "new-design.md"));
    expect(await readFile(result.file, "utf8")).toContain("title: New Design");
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
});
