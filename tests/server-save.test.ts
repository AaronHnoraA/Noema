import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { configure } from "../server/lib/state.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { getTodos, notesIndexPayload, queueRoamDbSync, readNote, roamNotesIndexPayload, runtimeDebugSnapshot, saveSamplesRoamDbSync } from "../server/lib/index.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { saveNote } from "../server/lib/save.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { createNode } from "../server/lib/fs-ops.mjs";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout.trim();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupRoot() {
  const root = await mkdtemp(join(tmpdir(), "aaronnote-save-"));
  const notes = join(root, "roam");
  await mkdir(notes, { recursive: true });
  roots.push(root);
  configure({
    root: notes,
    workspaceRoot: root,
    pluginRoot: join(root, "plugin"),
  });
  return { root, notes };
}

describe("server save API", () => {
  test("save DB-sync sampling uses the calibrated one-in-50000 boundary", () => {
    expect(saveSamplesRoamDbSync(0)).toBe(true);
    expect(saveSamplesRoamDbSync((1 / 50_000) - Number.EPSILON)).toBe(true);
    expect(saveSamplesRoamDbSync(1 / 50_000)).toBe(false);
    expect(saveSamplesRoamDbSync(1)).toBe(false);
  });

  test("deferred save returns the current note summary without a full notes list", async () => {
    const { notes } = await setupRoot();
    const file = join(notes, "a.md");
    await writeFile(file, "# A\n", "utf8");
    const base = await stat(file);

    const msg = await saveNote({
      file,
      content: "# A\n\nBody\n",
      clientId: "test",
      seq: 1,
      baseMtimeMs: base.mtimeMs,
      refresh: "deferred",
    }) as { ok?: boolean; notes?: unknown; note?: { title?: string }; notesRefresh?: string };

    expect(msg.ok).toBe(true);
    expect(msg.notes).toBeUndefined();
    expect(msg.note?.title).toBe("A");
    expect(msg.notesRefresh).toBe("deferred");
    expect(await readFile(file, "utf8")).toBe("# A\n\nBody\n");
  });

  test("saving a note does not leave runtime temp files in the note directory", async () => {
    const { notes } = await setupRoot();
    const file = join(notes, "a.md");
    await writeFile(file, "# A\n", "utf8");
    const base = await stat(file);

    await saveNote({
      file,
      content: "# A\n\nBody\n",
      clientId: "test",
      seq: 1,
      baseMtimeMs: base.mtimeMs,
      refresh: "deferred",
    });

    const entries = await readdir(notes);
    expect(entries.filter((name) => name.includes(".tmp") || name === ".tmp")).toEqual([]);
  });

  test("symlinked note root still treats real-path files as roam notes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-symlink-root-"));
    const notes = join(root, "Noema");
    const linkedNotes = join(root, ".roam");
    await mkdir(notes, { recursive: true });
    await symlink(notes, linkedNotes, "dir");
    roots.push(root);
    configure({
      root: linkedNotes,
      workspaceRoot: root,
      pluginRoot: join(root, "plugin"),
    });
    const file = join(notes, "a.md");
    await writeFile(file, "# A\n", "utf8");
    const base = await stat(file);
    expect((await notesIndexPayload()).notes).toHaveLength(1);

    const opened = await readNote(file) as { standalone?: boolean; file?: string };
    expect(opened.standalone).toBe(false);
    expect(opened.file).toBe(file);

    const saved = await saveNote({
      file,
      content: "# A\n\nBody\n",
      clientId: "test",
      seq: 1,
      baseMtimeMs: base.mtimeMs,
      refresh: "deferred",
    }) as { standalone?: boolean; note?: { path?: string }; notesRefresh?: string };

    expect(saved.standalone).toBe(false);
    expect(saved.note?.path).toBe("a.md");
    expect(saved.notesRefresh).toBe("deferred");
    const indexed = await notesIndexPayload() as { notes?: Array<{ file?: string; path?: string }> };
    expect(indexed.notes).toHaveLength(1);
    expect(indexed.notes?.[0]).toMatchObject({ file, path: "a.md" });
  });

  test("roam-only index ignores the active standalone markdown scan root", async () => {
    const { root, notes } = await setupRoot();
    const roamFile = join(notes, "a.md");
    const standaloneDir = join(root, "docs", "roam-agent", "wiki", "notes");
    const standaloneFile = join(standaloneDir, "GraphTensor.md");
    await mkdir(standaloneDir, { recursive: true });
    await writeFile(roamFile, "#+begin meta\nid: roam-a\n#+end meta\n\n# A\n", "utf8");
    await writeFile(standaloneFile, "#+begin meta\nid: docs-graph\n#+end meta\n\n# Graph Tensor\n", "utf8");

    await readNote(standaloneFile);
    const standaloneIndex = await notesIndexPayload() as { notes?: Array<{ file?: string; id?: string }> };
    expect(standaloneIndex.notes?.map((note) => note.file)).toContain(standaloneFile);

    const roamIndex = await roamNotesIndexPayload() as { notes?: Array<{ file?: string; id?: string }> };
    expect(roamIndex.notes?.map((note) => note.file)).toEqual([roamFile]);
    expect(roamIndex.notes?.map((note) => note.id)).toEqual(["roam-a"]);
  });

  test("mtime mismatch reports a conflict and preserves disk content", async () => {
    const { notes } = await setupRoot();
    const file = join(notes, "a.md");
    await writeFile(file, "# A\n", "utf8");
    const base = await stat(file);
    await writeFile(file, "# External\n", "utf8");

    const msg = await saveNote({
      file,
      content: "# Local\n",
      clientId: "test",
      seq: 1,
      baseMtimeMs: base.mtimeMs - 10_000,
      refresh: "deferred",
    }) as { conflict?: boolean };

    expect(msg.conflict).toBe(true);
    expect(await readFile(file, "utf8")).toBe("# External\n");
  });

  test("deferred save invalidates the lazy todo cache", async () => {
    const { notes } = await setupRoot();
    const file = join(notes, "a.md");
    await writeFile(file, "# A\n\n@@todo(todo) [first]\n", "utf8");

    expect((await notesIndexPayload()).notes).toHaveLength(1);
    const first = await getTodos();
    expect((first.todos as Array<{ text?: string; status?: string }>).map((todo) => [todo.status, todo.text]))
      .toEqual([["todo", "first"]]);

    const saved = await saveNote({
      file,
      content: "# A\n\n@@todo(done) [second]\n",
      clientId: "test",
      seq: 1,
      force: true,
      refresh: "deferred",
    }) as { ok?: boolean };
    expect(saved.ok).toBe(true);

    expect((await notesIndexPayload()).notes).toHaveLength(1);
    const second = await getTodos();
    expect((second.todos as Array<{ text?: string; status?: string }>).map((todo) => [todo.status, todo.text]))
      .toEqual([["done", "second"]]);
  });

  test("a deferred save that misses the sample only queues roam db work", async () => {
    const { root, notes } = await setupRoot();
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Noema Test"]);
    const file = join(notes, "a.md");
    await writeFile(file, "# A\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);
    const base = await stat(file);

    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const saved = await saveNote({
        file,
        content: "# A\n\nNo auto commit\n",
        clientId: "test",
        seq: 1,
        baseMtimeMs: base.mtimeMs,
        refresh: "deferred",
      }) as { ok?: boolean };
      expect(saved.ok).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(await git(root, ["rev-list", "--count", "HEAD"])).toBe("1");
      expect(await git(root, ["status", "--porcelain", "--", "."])).toContain("roam/a.md");
    } finally {
      random.mockRestore();
    }
  });

  test("creating a roam node queues db sync without committing immediately", async () => {
    const { root, notes } = await setupRoot();
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Noema Test"]);
    await writeFile(join(notes, "a.md"), "# A\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);

    await createNode({
      nodeType: "roam",
      id: "queued-node",
      title: "Queued Node",
      path: "queued-node.md",
    });

    expect(await git(root, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(root, ["status", "--porcelain", "--", "."])).toContain("roam/queued-node.md");
  });

  test("creating nodes and folders does not write Noema keep files", async () => {
    const { notes } = await setupRoot();

    await createNode({
      nodeType: "roam",
      id: "clean-node",
      title: "Clean Node",
      path: "nested/clean-node.md",
    });

    expect(await readdir(notes)).not.toContain(".aaronnote-keep");
    expect(await readdir(join(notes, "nested"))).not.toContain(".aaronnote-keep");
  });

  test("new notes get an editable meta summary with and without template metadata", async () => {
    const { root, notes } = await setupRoot();
    const templates = join(root, "templates", "noema", "markdown-mode");
    await mkdir(templates, { recursive: true });
    await writeFile(join(templates, "custom"), [
      "# name: Custom",
      "# key: custom",
      "# --",
      "#+begin meta",
      "id: {{id}}",
      "title: {{title}}",
      "kind: {{kind}}",
      "#+end meta",
      "",
      "# {{title}}",
      "",
      "$0",
    ].join("\n"), "utf8");
    configure({
      root: notes,
      workspaceRoot: root,
      templatesRoot: join(root, "templates", "noema"),
      pluginRoot: join(root, "plugin"),
    });

    await createNode({ nodeType: "roam", id: "plain", title: "Plain", path: "plain.md" });
    await createNode({ nodeType: "roam", id: "custom", title: "Custom", path: "custom.md", templateKey: "custom" });

    for (const file of [join(notes, "plain.md"), join(notes, "custom.md")]) {
      const content = await readFile(file, "utf8");
      expect(content.match(/#\+begin summary/g)).toHaveLength(1);
      expect(content).toContain("#+begin summary\n\n#+end summary");
    }
  });

  test("runtime debug reports deduplicated queued roam sync files", async () => {
    const { notes } = await setupRoot();
    const file = join(notes, "a.md");
    await writeFile(file, "# A\n", "utf8");

    queueRoamDbSync(null, [file, file, join(notes, ".", "a.md")]);
    const debug = runtimeDebugSnapshot() as {
      roamDbSync?: { queued?: boolean; changedFiles?: number; inFlight?: boolean };
      paths?: { stateRoot?: string; tmpRoot?: string };
      saveWrites?: { queuedFiles?: number };
    };

    expect(debug.roamDbSync?.queued).toBe(true);
    expect(debug.roamDbSync?.changedFiles).toBe(1);
    expect(debug.roamDbSync?.inFlight).toBe(false);
    expect(debug.paths?.stateRoot).toBeTruthy();
    expect(debug.paths?.tmpRoot).toBeTruthy();
    expect(debug.saveWrites?.queuedFiles).toBe(0);
  });

  test("configure clears stale queued roam sync state", async () => {
    const { notes } = await setupRoot();
    const file = join(notes, "a.md");
    queueRoamDbSync(null, [file]);
    expect((runtimeDebugSnapshot() as { roamDbSync?: { queued?: boolean } }).roamDbSync?.queued).toBe(true);

    await setupRoot();
    expect((runtimeDebugSnapshot() as { roamDbSync?: { queued?: boolean; changedFiles?: number } }).roamDbSync)
      .toMatchObject({ queued: false, changedFiles: 0 });
  });

});
