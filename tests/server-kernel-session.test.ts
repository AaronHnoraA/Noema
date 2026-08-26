import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-ignore Runtime is a Node ESM module outside the TypeScript app graph.
import { configure, configureSessionProvider, readCursorPositions, readRecentNotes, touchCursorPosition, touchRecentNote } from "../server/lib/runtime.mjs";

const roots: string[] = [];

afterEach(async () => {
  configureSessionProvider(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("server facade with kernel session persistence", () => {
  test("routes Markdown session writes to the kernel and keeps Node JSON untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-session-runtime-"));
    const notes = join(root, "notes");
    const stateRoot = join(root, "state");
    const file = join(notes, "paper.md");
    roots.push(root);
    await mkdir(notes, { recursive: true });
    configure({ root: notes, workspaceRoot: root, stateRoot, pluginRoot: join(root, "plugin") });

    const calls: string[] = [];
    configureSessionProvider({
      owns(candidate: string) {
        return candidate === file;
      },
      async read() {
        calls.push("read");
        return {
          source: "kernel-session",
          recent: [{ file, openedAt: 30 }],
          positions: [{ file, mode: "source", from: 5, to: 6, scrollY: 7, updatedAt: 40 }],
        };
      },
      async touchRecent(candidate: string, openedAt: number) {
        calls.push(`recent:${candidate}:${openedAt}`);
        return { source: "kernel-session", recent: [{ file, openedAt }], positions: [] };
      },
      async touchPosition(position: { file: string; updatedAt: number }) {
        calls.push(`position:${position.file}:${position.updatedAt}`);
        return {
          source: "kernel-session", recent: [],
          positions: [{ ...position, mode: "markdown", from: 8, to: 8, scrollY: 80 }],
        };
      },
    });

    expect(await touchRecentNote(file, 50)).toEqual([{ file, openedAt: 50 }]);
    expect(await touchCursorPosition({ file, mode: "markdown", from: 8, to: 8, scrollY: 80, updatedAt: 60 }))
      .toEqual([{ file, mode: "markdown", from: 8, to: 8, scrollY: 80, updatedAt: 60 }]);
    expect(await readRecentNotes()).toEqual([{ file, openedAt: 30 }]);
    expect(await readCursorPositions()).toEqual([{ file, mode: "source", from: 5, to: 6, scrollY: 7, updatedAt: 40 }]);
    expect(calls).toEqual([
      `recent:${file}:50`,
      `position:${file}:60`,
      "read",
      "read",
    ]);
    await expect(readFile(join(stateRoot, "recent.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(stateRoot, "positions.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("falls back to Node state when the optional session provider is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-session-fallback-"));
    const notes = join(root, "notes");
    const stateRoot = join(root, "state");
    const file = join(notes, "paper.md");
    roots.push(root);
    await mkdir(notes, { recursive: true });
    configure({ root: notes, workspaceRoot: root, stateRoot, pluginRoot: join(root, "plugin") });
    configureSessionProvider({
      owns() { return true; },
      async read() { throw new Error("kernel unavailable"); },
      async touchRecent() { throw new Error("kernel unavailable"); },
      async touchPosition() { throw new Error("kernel unavailable"); },
    });

    expect(await touchRecentNote(file, 10)).toEqual([{ file, openedAt: 10 }]);
    expect(await touchCursorPosition({ file, from: 2, to: 3, updatedAt: 20 }))
      .toEqual([{ file, mode: "markdown", from: 2, to: 3, scrollY: 0, updatedAt: 20 }]);
    await expect(readFile(join(stateRoot, "recent.json"), "utf8")).resolves.toContain("paper.md");
    await expect(readFile(join(stateRoot, "positions.json"), "utf8")).resolves.toContain("paper.md");
  });
});
