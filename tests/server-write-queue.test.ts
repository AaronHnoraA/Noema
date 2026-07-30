import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { configure } from "../server/lib/state.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { saveNote } from "../server/lib/save.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { buildAgenda, clockIn, ensureTodoId, markNotesDirty, patchTodo, scanNotes, syncRoamDb } from "../server/lib/index.mjs";

async function withVault(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "aaronnote-write-queue-"));
  try {
    const notes = join(root, "roam");
    await mkdir(notes, { recursive: true });
    configure({ root: notes, workspaceRoot: root, stateRoot: join(root, "state"), tmpRoot: join(root, "tmp") });
    await fn(notes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("per-file write serialization", () => {
  test("concurrent patchTodo calls on two todos in the same file both land", async () => {
    await withVault(async (notes) => {
      const file = join(notes, "a.md");
      await writeFile(
        file,
        "---\nid: a\n---\n# A\n\n@@todo(doing) [first task]\n\n@@todo(doing) [second task]\n",
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      const todos = (await buildAgenda({ includePlanning: true })).todos;
      const first = todos.find((t: any) => t.text === "first task");
      const second = todos.find((t: any) => t.text === "second task");

      await Promise.all([
        patchTodo({ file, index: first.index, source: first.source, text: first.text, prio: "A" }),
        patchTodo({ file, index: second.index, source: second.source, text: second.text, prio: "B" }),
      ]);

      const content = await readFile(file, "utf8");
      expect(content).toMatch(/first task\] \{prio=A\}/);
      expect(content).toMatch(/second task\] \{prio=B\}/);
    });
  });

  test("an editor save with a stale baseMtimeMs after an interleaved patchTodo reports a conflict", async () => {
    await withVault(async (notes) => {
      const file = join(notes, "a.md");
      await writeFile(file, "---\nid: a\n---\n# A\n\n@@todo(doing) [only task]\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const base = await stat(file);
      const todo = (await buildAgenda({ includePlanning: true })).todos.find((t: any) => t.text === "only task");

      await patchTodo({ file, index: todo.index, source: todo.source, text: todo.text, prio: "A" });

      const result = (await saveNote({
        file,
        content: "---\nid: a\n---\n# A\n\n@@todo(doing) [only task edited]\n",
        clientId: "test",
        seq: 1,
        baseMtimeMs: base.mtimeMs,
      })) as { conflict?: boolean };

      expect(result.conflict).toBe(true);
      // The agenda write must not have been reverted by the rejected save.
      const content = await readFile(file, "utf8");
      expect(content).toMatch(/only task\] \{prio=A\}/);
    });
  });

  test("clockIn does not deadlock when the currently-running clock is in the same file as the new target", async () => {
    await withVault(async (notes) => {
      const file = join(notes, "a.md");
      await writeFile(
        file,
        "---\nid: a\n---\n# A\n\n@@todo(doing) [first task]\n\n@@todo(doing) [second task]\n",
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      const todos = (await buildAgenda({ includePlanning: true })).todos;
      const first = todos.find((t: any) => t.text === "first task");
      await clockIn({ file, index: first.index, source: first.source });

      const refreshedSecond = (await buildAgenda({ includePlanning: true })).todos.find((t: any) => t.text === "second task");
      const secondClockIn = await Promise.race([
        clockIn({ file, index: refreshedSecond.index, source: refreshedSecond.source }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("clockIn deadlocked")), 5000)),
      ]);
      expect((secondClockIn as any).ok).toBe(true);

      const agenda = await buildAgenda({ includePlanning: true });
      expect(agenda.clocktable.running).toMatchObject({ todoId: (secondClockIn as any).todoId });
    });
  });

  test("concurrent clockIn calls across files leave only one running clock", async () => {
    await withVault(async (notes) => {
      const aFile = join(notes, "a.md");
      const bFile = join(notes, "b.md");
      await writeFile(aFile, "---\nid: a\n---\n# A\n\n@@todo(doing) [alpha task]\n", "utf8");
      await writeFile(bFile, "---\nid: b\n---\n# B\n\n@@todo(doing) [beta task]\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const todos = (await buildAgenda({ includePlanning: true })).todos;
      const alpha = todos.find((t: any) => t.text === "alpha task");
      const beta = todos.find((t: any) => t.text === "beta task");

      const [a, b] = await Promise.all([
        clockIn({ file: aFile, index: alpha.index, source: alpha.source }),
        clockIn({ file: bFile, index: beta.index, source: beta.source }),
      ]);

      const agenda = await buildAgenda({ includePlanning: true });
      expect(agenda.lints.map((lint: any) => lint.kind)).not.toContain("multiple-running-clocks");
      expect(agenda.clocktable.running?.todoId).toBe((b as any).todoId);
      expect((a as any).todoId).not.toBe((b as any).todoId);
    });
  });

  test("concurrent ensureTodoId calls on the same todo mint exactly one id", async () => {
    await withVault(async (notes) => {
      const file = join(notes, "a.md");
      await writeFile(file, "---\nid: a\n---\n# A\n\n@@todo(doing) [only task]\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const todo = (await buildAgenda({ includePlanning: true })).todos.find((t: any) => t.text === "only task");

      const [a, b] = await Promise.all([
        ensureTodoId({ file, index: todo.index, source: todo.source, text: todo.text }),
        ensureTodoId({ file, index: todo.index, source: todo.source, text: todo.text }),
      ]);
      expect(a.id).toBe(b.id);

      const content = await readFile(file, "utf8");
      const idMatches = content.match(/\{id[:=]/g) || [];
      expect(idMatches).toHaveLength(1);
    });
  });

  test("concurrent id mints do not collide even under repeated random candidates", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      await withVault(async (notes) => {
        const aFile = join(notes, "a.md");
        const bFile = join(notes, "b.md");
        await writeFile(aFile, "---\nid: a\n---\n# A\n\n@@todo(doing) [alpha task]\n", "utf8");
        await writeFile(bFile, "---\nid: b\n---\n# B\n\n@@todo(doing) [beta task]\n", "utf8");
        await syncRoamDb(null, { mode: "full" });
        const todos = (await buildAgenda({ includePlanning: true })).todos;
        const alpha = todos.find((t: any) => t.text === "alpha task");
        const beta = todos.find((t: any) => t.text === "beta task");

        const [a, b] = await Promise.all([
          ensureTodoId({ file: aFile, index: alpha.index, source: alpha.source, text: alpha.text }),
          ensureTodoId({ file: bFile, index: beta.index, source: beta.source, text: beta.text }),
        ]);

        expect(a.id).toMatch(/^#[a-z0-9]{6}$/);
        expect(b.id).toMatch(/^#[a-z0-9]{6}$/);
        expect(a.id).not.toBe(b.id);
      });
    } finally {
      random.mockRestore();
    }
  });
});

describe("scanNotes coalescing", () => {
  test("concurrent scanNotes calls return consistent results without throwing", async () => {
    await withVault(async (notes) => {
      await writeFile(join(notes, "a.md"), "---\nid: a\n---\n# A\n", "utf8");
      await writeFile(join(notes, "b.md"), "---\nid: b\n---\n# B\n", "utf8");
      const [scanA, scanB] = await Promise.all([scanNotes(), scanNotes()]);
      expect(scanA.map((n: any) => n.file).sort()).toEqual(scanB.map((n: any) => n.file).sort());
      expect(scanA).toHaveLength(2);
    });
  });

  test("a dirty mark that lands mid-scan is not lost", async () => {
    await withVault(async (notes) => {
      await writeFile(join(notes, "a.md"), "---\nid: a\n---\n# A\n", "utf8");
      // A clean scanNotes() call takes the synchronous cached fast-path, so
      // there is no in-flight scan to race against. Force the *next* call
      // onto the async path (full rebuild) with a scope-wide dirty mark,
      // then — before it can possibly have resolved (no `await` has run
      // yet in this synchronous stretch) — mark a second file dirty. Under
      // the pre-fix code, scanNotesOnce cleared dirty state at its *end*,
      // discarding this second mark; the fix claims dirty state at the
      // *start*, so it survives into the next scanNotes() call.
      await scanNotes();
      markNotesDirty();
      const firstScan = scanNotes();
      const file = join(notes, "b.md");
      markNotesDirty(file);
      await writeFile(file, "---\nid: b\n---\n# B\n", "utf8");
      await firstScan;

      const after = await scanNotes();
      expect(after.map((n: any) => n.file)).toContain(file);
    });
  });
});
