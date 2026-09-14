import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import {
  createResearchNotebookWatchReconciler,
  researchNotebookWatchDirectory,
  researchNotebookWatchFile,
} from "../server/lib/research-watch.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("research notebook external-change reconciliation", () => {
  test("accepts only repository notebook files outside derived directories", () => {
    const root = "/tmp/noema-project";
    expect(researchNotebookWatchFile(root, `${root}/research/a.NOEMA`)).toBe(`${root}/research/a.NOEMA`);
    expect(researchNotebookWatchFile(root, `${root}/research/legacy.NOEMA.IPYNB`)).toBe(`${root}/research/legacy.NOEMA.IPYNB`);
    expect(researchNotebookWatchFile(root, `${root}/research/ordinary.ipynb`)).toBe("");
    expect(researchNotebookWatchFile(root, `${root}/research/a.md`)).toBe("");
    expect(researchNotebookWatchFile(root, `${root}/.agent/a.noema`)).toBe("");
    expect(researchNotebookWatchFile(root, `${root}/.git/a.noema`)).toBe("");
    expect(researchNotebookWatchFile(root, "/tmp/outside.noema")).toBe("");
    expect(researchNotebookWatchDirectory(root, `${root}/research`)).toBe(`${root}/research`);
    expect(researchNotebookWatchDirectory(root, `${root}/.agent/views`)).toBe("");
    expect(researchNotebookWatchDirectory(root, "/tmp/outside")).toBe("");
  });

  test("serializes changed-file snapshots and ignores ordinary notebooks", async () => {
    const root = resolve(await mkdtemp(join(tmpdir(), "noema-research-watch-")));
    roots.push(root);
    const calls: Record<string, unknown>[] = [];
    const errors: string[] = [];
    const reconciler = createResearchNotebookWatchReconciler({
      root,
      snapshot: vi.fn(async (body) => { calls.push(body); }),
      onError: (error) => errors.push(String(error)),
    });

    await reconciler.filesChanged([
      join(root, "research.noema"), join(root, "ordinary.ipynb"),
      join(root, "note.md"), join(root, ".agent", "ignored.noema"),
    ]);

    expect(calls.map((call) => String(call.file))).toEqual([join(root, "research.noema")]);
    expect(calls.every((call) => call.actor === "watcher:external" && call.reason === "external.file-change")).toBe(true);
    expect(errors).toEqual([]);
    reconciler.close();
  });

  test("full rescan discovers nested notebooks but never scans runtime or VCS state", async () => {
    const root = resolve(await mkdtemp(join(tmpdir(), "noema-research-watch-")));
    roots.push(root);
    await mkdir(join(root, "nested"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, ".agent"), { recursive: true });
    await writeFile(join(root, "root.noema"), "{}", "utf8");
    await writeFile(join(root, "nested", "child.noema"), "{}", "utf8");
    await writeFile(join(root, "nested", "ordinary.ipynb"), "{}", "utf8");
    await writeFile(join(root, "nested", "note.md"), "# note", "utf8");
    await writeFile(join(root, ".git", "ignored.noema"), "{}", "utf8");
    await writeFile(join(root, ".agent", "ignored.noema"), "{}", "utf8");
    const files: string[] = [];
    const reconciler = createResearchNotebookWatchReconciler({
      root,
      snapshot: vi.fn(async (body) => { files.push(String(body.file)); }),
    });

    await reconciler.fullRescan();

    expect(files).toEqual([join(root, "nested", "child.noema"), join(root, "root.noema")]);
    reconciler.close();
  });
});
