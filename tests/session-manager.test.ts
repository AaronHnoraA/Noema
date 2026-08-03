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

  test("keeps independent cursor slots for Emacs split clients", async () => {
    const { root, manager } = await setup();
    const note = join(root, "split.md");
    await manager.touchCursorPosition({
      file: note,
      client: "left-pane",
      mode: "markdown",
      from: 12,
      to: 12,
      scrollY: 120,
      updatedAt: 10,
    });
    await manager.touchCursorPosition({
      file: note,
      client: "right-pane",
      mode: "source",
      from: 84,
      to: 86,
      scrollY: 900,
      updatedAt: 20,
    });

    expect(await manager.readCursorPositions()).toEqual([
      {
        file: note,
        client: "right-pane",
        mode: "source",
        from: 84,
        to: 86,
        scrollY: 900,
        updatedAt: 20,
      },
      {
        file: note,
        mode: "source",
        from: 84,
        to: 86,
        scrollY: 900,
        updatedAt: 20,
      },
      {
        file: note,
        client: "left-pane",
        mode: "markdown",
        from: 12,
        to: 12,
        scrollY: 120,
        updatedAt: 10,
      },
    ]);
  });

  test("serializes simultaneous split cursor writes without losing either pane", async () => {
    const { root, manager } = await setup();
    const note = join(root, "concurrent.md");

    await Promise.all([
      manager.touchCursorPosition({
        file: note,
        client: "left-pane",
        mode: "markdown",
        from: 10,
        to: 10,
        scrollY: 100,
        updatedAt: 10,
      }),
      manager.touchCursorPosition({
        file: note,
        client: "right-pane",
        mode: "markdown",
        from: 90,
        to: 90,
        scrollY: 900,
        updatedAt: 20,
      }),
    ]);

    const positions = await manager.readCursorPositions();
    expect(positions.find((position) => position.client === "left-pane")?.from).toBe(10);
    expect(positions.find((position) => position.client === "right-pane")?.from).toBe(90);
    expect(positions.find((position) => !position.client)?.from).toBe(90);
  });
});
