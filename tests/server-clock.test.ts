import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import * as serverIndex from "../server/lib/index.mjs";

const {
  buildAgenda,
  buildClockModel,
  clockIn,
  clockOut,
  configure,
  extractPlanningItems,
  resolveClockRefs,
  syncRoamDb,
} = serverIndex as any;

const note = (file: string, title: string) => ({
  file,
  path: file,
  key: title,
  id: title,
  title,
  tags: [],
  inlineTags: [],
  groupKey: "",
  groupLabel: "",
});

async function withVault(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "aaronnote-clock-"));
  try {
    await mkdir(join(root, "state"), { recursive: true });
    configure({ root, workspaceRoot: root, stateRoot: join(root, "state"), tmpRoot: join(root, "tmp") });
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("clock ref resolution", () => {
  test("resolves a same-file clock ref to its todo", () => {
    const content = [
      "@@todo(doing) [write proof of lemma]",
      '@@clock [write proof of lemma] {from: "2026-07-07 09:00", to: "2026-07-07 10:30"}',
    ].join("\n");
    const { todos, clocks } = extractPlanningItems(content, note("/notes/a.md", "A"), 1);
    const { lints } = resolveClockRefs(clocks, todos);
    expect(lints).toEqual([]);
    expect(clocks[0].todoId).toBe(todos[0].id);
  });

  test("a broken clock ref lints but still counts toward aggregation", () => {
    const content = '@@clock [nonexistent task] {from: "2026-07-07 09:00", to: "2026-07-07 10:00"}';
    const { todos, clocks } = extractPlanningItems(content, note("/notes/a.md", "A"), 1);
    const { lints } = resolveClockRefs(clocks, todos);
    expect(lints).toMatchObject([{ kind: "broken-clock-ref" }]);
    const model = buildClockModel(clocks, todos, []);
    expect(model.tasks).toMatchObject([{ todoId: "", minutes: 60 }]);
  });

  test("a `task: #id` anchor resolves the clock to its todo regardless of the bracket title text", () => {
    const content = [
      "@@todo(doing) [some stale title in the bracket] {id: abc123}",
      '@@clock [some stale title in the bracket] {from: "2026-07-07 09:00", to: "2026-07-07 10:00", task: "#abc123"}',
    ].join("\n");
    const { todos, clocks } = extractPlanningItems(content, note("/notes/a.md", "A"), 1);
    const { lints } = resolveClockRefs(clocks, todos);
    expect(lints).toEqual([]);
    expect(clocks[0].todoId).toBe("#abc123");
  });

  test("a task-id anchor survives the todo's title text changing entirely (the title-based fallback would have broken)", () => {
    const renamed = [
      "@@todo(doing) [a totally different title now] {id: abc123}",
      '@@clock [some stale title in the bracket] {from: "2026-07-07 09:00", to: "2026-07-07 10:00", task: "#abc123"}',
    ].join("\n");
    const { todos, clocks } = extractPlanningItems(renamed, note("/notes/a.md", "A"), 1);
    const { lints } = resolveClockRefs(clocks, todos);
    expect(lints).toEqual([]);
    expect(clocks[0].todoId).toBe("#abc123");
    const model = buildClockModel(clocks, todos, []);
    expect(model.tasks).toMatchObject([{ todoId: "#abc123", minutes: 60 }]);
  });

  test("a broken task-id anchor lints as broken-clock-ref", () => {
    const content = '@@clock [whatever] {from: "2026-07-07 09:00", task: "#nonexistent"}';
    const { todos, clocks } = extractPlanningItems(content, note("/notes/a.md", "A"), 1);
    const { lints } = resolveClockRefs(clocks, todos);
    expect(lints).toMatchObject([{ kind: "broken-clock-ref", ref: "#nonexistent" }]);
  });
});

describe("buildClockModel aggregation", () => {
  test("sums minutes per task/day and compares against effort", () => {
    const content = [
      "@@todo(doing) [write proof of lemma] {effort: 2h}",
      '@@clock [write proof of lemma] {from: "2026-07-07 09:00", to: "2026-07-07 10:00"}',
      '@@clock [write proof of lemma] {from: "2026-07-08 09:00", to: "2026-07-08 09:30"}',
    ].join("\n");
    const { todos, clocks } = extractPlanningItems(content, note("/notes/a.md", "A"), 1);
    resolveClockRefs(clocks, todos);
    const model = buildClockModel(clocks, todos, []);
    expect(model.tasks).toMatchObject([{ minutes: 90, effortMinutes: 120 }]);
    expect(model.byDay).toEqual({ "2026-07-07": 60, "2026-07-08": 30 });
  });

  test("an open clock (no `to`) is running and counted against now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 7, 9, 30));
    try {
      const content = [
        "@@todo(doing) [deep work session]",
        '@@clock [deep work session] {from: "2026-07-07 09:00"}',
      ].join("\n");
      const { todos, clocks } = extractPlanningItems(content, note("/notes/a.md", "A"), 1);
      resolveClockRefs(clocks, todos);
      const model = buildClockModel(clocks, todos, []);
      expect(model.running).toMatchObject({ todoId: todos[0].id, minutesSoFar: 30 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("buildAgenda lints multiple running, reversed, and overlapping clock spans", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 7, 13, 0));
    try {
      await withVault(async (root) => {
        await writeFile(
          join(root, "a.md"),
          [
            "---\nid: a\n---\n# A\n",
            "@@todo(doing) [deep work] {id: abc123}",
            '@@clock [deep work] {from: "2026-07-07 09:00", to: "2026-07-07 10:00", task: "#abc123"}',
            '@@clock [deep work] {from: "2026-07-07 09:30", to: "2026-07-07 10:30", task: "#abc123"}',
            '@@clock [deep work] {from: "2026-07-07 12:00", to: "2026-07-07 11:00", task: "#abc123"}',
            '@@clock [deep work] {from: "2026-07-07 11:30", task: "#abc123"}',
            '@@clock [deep work] {from: "2026-07-07 12:30", task: "#abc123"}',
            "",
          ].join("\n"),
          "utf8",
        );
        await syncRoamDb(null, { mode: "full" });

        const agenda = await buildAgenda({ includePlanning: true });
        const kinds = agenda.lints.map((lint: any) => lint.kind);
        expect(kinds).toContain("overlapping-clocks");
        expect(kinds).toContain("reversed-clock-span");
        expect(kinds).toContain("multiple-running-clocks");
        expect(agenda.clocktable.running).toMatchObject({ todoId: "#abc123" });
        expect(agenda.clocktable.tasks.find((task: any) => task.todoId === "#abc123")?.minutes).toBeGreaterThan(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clock-in / clock-out", () => {
  test("clockIn mints a stable id for the todo and inserts a running @@clock line anchored to it", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(file, "---\nid: a\n---\n# A\n\n@@todo(doing) [write proof of lemma]\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const todosBefore = (await buildAgenda({ includePlanning: true })).todos;
      const todo = todosBefore.find((t: any) => t.text === "write proof of lemma");
      expect(todo.id).not.toMatch(/^#/);

      const result = await clockIn({ file, index: todo.index, source: todo.source });
      expect(result.todoId).toMatch(/^#[a-z0-9]{6}$/);

      const content = await readFile(file, "utf8");
      expect(content).toMatch(/@@todo\(doing\) \[write proof of lemma\]\s*\{id[:=]/);
      expect(content).toContain("@@clock [write proof of lemma]{from:");
      expect(content).toContain(`task: ${result.todoId}`);

      const agenda = await buildAgenda({ includePlanning: true });
      expect(agenda.clocktable.running).toMatchObject({ todoId: result.todoId });
      const refreshedTodo = agenda.todos.find((t: any) => t.text === "write proof of lemma");
      expect(refreshedTodo.id).toBe(result.todoId);
    });
  });

  test("clockOut closes the running clock and clears clocktable.running", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(file, "---\nid: a\n---\n# A\n\n@@todo(doing) [write proof of lemma]\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const todo = (await buildAgenda({ includePlanning: true })).todos.find((t: any) => t.text === "write proof of lemma");
      await clockIn({ file, index: todo.index, source: todo.source });

      await clockOut({});

      const content = await readFile(file, "utf8");
      const { clocks } = extractPlanningItems(content, note(file, "A"), 1);
      expect(clocks).toHaveLength(1);
      expect(clocks[0].args.from).toBeTruthy();
      expect(clocks[0].args.to).toBeTruthy();
      const agenda = await buildAgenda({ includePlanning: true });
      expect(agenda.clocktable.running).toBeNull();
    });
  });

  test("clockOut with nothing running throws a 404", async () => {
    await withVault(async (root) => {
      await writeFile(join(root, "a.md"), "---\nid: a\n---\n# A\n\n@@todo [idle task]\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      await expect(clockOut({})).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  test("only one clock may run at a time: clocking in a second todo auto-closes the first", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(
        file,
        "---\nid: a\n---\n# A\n\n@@todo(doing) [first task]\n\n@@todo(doing) [second task]\n",
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      const todos = (await buildAgenda({ includePlanning: true })).todos;
      const first = todos.find((t: any) => t.text === "first task");

      const firstClockIn = await clockIn({ file, index: first.index, source: first.source });
      let agenda = await buildAgenda({ includePlanning: true });
      expect(agenda.clocktable.running).toMatchObject({ todoId: firstClockIn.todoId });

      // second task's index/source shifted after the first clock-in inserted
      // a line; re-locate it fresh, the way a real client would.
      const refreshedSecond = (await buildAgenda({ includePlanning: true })).todos.find((t: any) => t.text === "second task");
      const secondClockIn = await clockIn({ file, index: refreshedSecond.index, source: refreshedSecond.source });

      agenda = await buildAgenda({ includePlanning: true });
      expect(agenda.clocktable.running).toMatchObject({ todoId: secondClockIn.todoId });
      const firstTaskModel = agenda.clocktable.tasks.find((t: any) => t.todoId === firstClockIn.todoId);
      expect(firstTaskModel.minutes).toBeGreaterThanOrEqual(0);
    });
  });
});
