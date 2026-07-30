import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SessionManager } from "../server/Features/Session/manager.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ root: string; manager: SessionManager }> {
  const root = await mkdtemp(join(tmpdir(), "aaronnote-session-"));
  roots.push(root);
  return {
    root,
    manager: new SessionManager({
      stateRoot: root,
      resolveFile(file) {
        const safe = resolve(file);
        if (!safe.endsWith(".md")) throw new Error("not markdown");
        return safe;
      },
      async writeFile(file, data, encoding) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, data, encoding);
      },
    }),
  };
}

describe("SessionManager", () => {
  test("deduplicates recent notes by newest timestamp and rejects unsafe entries", async () => {
    const { root, manager } = await setup();
    const note = join(root, "note.md");
    const result = manager.normalizeRecentNotes([
      { file: note, openedAt: 1 },
      { file: note, openedAt: 3 },
      { file: join(root, "skip.tex"), openedAt: 9 },
    ]);
    expect(result).toEqual([{ file: note, openedAt: 3 }]);
    await manager.touchRecentNote(note, 5);
    expect(await manager.readRecentNotes()).toEqual([{ file: note, openedAt: 5 }]);
  });

  test("normalizes and persists cursor positions without changing source mode", async () => {
    const { root, manager } = await setup();
    const note = join(root, "note.md");
    await manager.touchCursorPosition({
      file: note,
      mode: "source",
      from: -1,
      to: 8,
      scrollY: -2,
      updatedAt: 10,
    });
    expect(await manager.readCursorPositions()).toEqual([{
      file: note,
      mode: "source",
      from: 0,
      to: 8,
      scrollY: 0,
      updatedAt: 10,
    }]);
  });
});
