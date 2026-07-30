import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import * as serverIndex from "../server/lib/index.mjs";

const {
  applyRepeater,
  buildAgenda,
  completeTodo,
  configure,
  createTodo,
  depRefForTodo,
  ensureTodoId,
  extractTodos,
  getTodos,
  parseDepRefs,
  parseLeadTime,
  parseRepeater,
  patchTodo,
  resolveTodoDeps,
  syncRoamDb,
  todoUrgency,
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
  const root = await mkdtemp(join(tmpdir(), "aaronnote-agenda-"));
  try {
    await mkdir(join(root, "state"), { recursive: true });
    configure({ root, workspaceRoot: root, stateRoot: join(root, "state"), tmpRoot: join(root, "tmp") });
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("repeater math", () => {
  test("parseRepeater grammar incl. bare Nd", () => {
    expect(parseRepeater("+1w")).toEqual({ mode: "+", n: 1, unit: "w" });
    expect(parseRepeater("++2d")).toEqual({ mode: "++", n: 2, unit: "d" });
    expect(parseRepeater(".+3d")).toEqual({ mode: ".+", n: 3, unit: "d" });
    expect(parseRepeater("5d")).toEqual({ mode: "+", n: 5, unit: "d" });
    expect(parseRepeater("nonsense")).toBeNull();
    expect(parseRepeater("")).toBeNull();
  });

  test("+ shifts once from the old date, even if still in the past", () => {
    const today = new Date(2026, 6, 6).getTime(); // 2026-07-06
    expect(applyRepeater("2026-06-01", parseRepeater("+1w"), today)).toBe("2026-06-08");
  });

  test("++ shifts repeatedly until the result is after today", () => {
    const today = new Date(2026, 6, 6).getTime(); // 2026-07-06
    // 2026-06-01 + 1w repeatedly: 06-08, 06-15, 06-22, 06-29, 07-06(not after), 07-13
    expect(applyRepeater("2026-06-01", parseRepeater("++1w"), today)).toBe("2026-07-13");
  });

  test(".+ shifts from the completion date (today), not the old date", () => {
    const today = new Date(2026, 6, 6).getTime(); // 2026-07-06
    expect(applyRepeater("2026-01-01", parseRepeater(".+3d"), today)).toBe("2026-07-09");
  });

  test("month/year boundaries via Date arithmetic", () => {
    const today = new Date(2026, 0, 15).getTime();
    expect(applyRepeater("2026-01-31", parseRepeater("+1m"), today)).toBe("2026-03-03");
    expect(applyRepeater("2026-01-01", parseRepeater("+1y"), today)).toBe("2027-01-01");
  });

  test("parseLeadTime supports days/weeks/months, defaults to 14", () => {
    expect(parseLeadTime("3d")).toBe(3);
    expect(parseLeadTime("2w")).toBe(14);
    expect(parseLeadTime("1m")).toBe(30);
    expect(parseLeadTime("")).toBe(14);
    expect(parseLeadTime("garbage")).toBe(14);
  });
});

describe("dependency resolution (text refs)", () => {
  test("parseDepRefs splits on & and recognizes [[Title]]:: cross-file refs", () => {
    expect(parseDepRefs("write proof & [[Other]]::fix bug")).toEqual([
      { id: null, noteTitle: null, text: "write proof", raw: "write proof" },
      { id: null, noteTitle: "Other", text: "fix bug", raw: "[[Other]]::fix bug" },
    ]);
    expect(parseDepRefs("")).toEqual([]);
  });

  test("resolves same-file deps by exact/prefix/substring tiers and computes blocked", () => {
    const todos = extractTodos(
      [
        "@@todo(doing) [write proof of lemma]",
        "@@todo [write up final draft] {after: write proof}",
        "@@todo(done) [background reading]",
      ].join("\n"),
      note("/notes/a.md", "A"),
      1,
    );
    const { lints } = resolveTodoDeps(todos);
    expect(lints).toEqual([]);
    expect(todos[1].deps).toEqual([todos[0].id]);
    expect(todos[1].effectiveStatus).toBe("blocked");
    expect(todos[1].blockedBy).toEqual([todos[0].id]);
    // completing the dependency should unblock purely by recomputation
    todos[0].status = "done";
    resolveTodoDeps(todos);
    expect(todos[1].effectiveStatus).toBe("todo");
    expect(todos[1].blockedBy).toEqual([]);
  });

  test("manual (blocked) status is distinct from computed blocking", () => {
    const todos = extractTodos("@@todo(blocked) [waiting on external reviewer]", note("/notes/a.md", "A"), 1);
    resolveTodoDeps(todos);
    expect(todos[0].status).toBe("blocked");
    expect(todos[0].effectiveStatus).toBe("blocked");
    expect(todos[0].blockedBy).toEqual([]);
  });

  test("ambiguous and broken refs lint but never block", () => {
    const todos = extractTodos(
      [
        '@@todo [draft section] {after: "nonexistent task"}',
        "@@todo [draft intro]",
        "@@todo [draft conclusion]",
        "@@todo [depends on draft] {after: draft}",
      ].join("\n"),
      note("/notes/a.md", "A"),
      1,
    );
    const { lints } = resolveTodoDeps(todos);
    expect(lints).toMatchObject([
      { kind: "broken-ref", ref: "nonexistent task" },
      { kind: "ambiguous-ref", ref: "draft" },
    ]);
    expect(todos[0].effectiveStatus).toBe("todo");
    expect(todos[3].effectiveStatus).toBe("todo");
  });

  test("cross-file refs resolve against the target note's todos", async () => {
    await withVault(async (root) => {
      await writeFile(join(root, "a.md"), "---\nid: a\n---\n# A\n\n@@todo [depends] {after: \"[[B]]::write proof\"}\n", "utf8");
      await writeFile(join(root, "b.md"), "---\nid: b\n---\n# B\n\n@@todo(doing) [write proof]\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({});
      expect(agenda.lints).toEqual([]);
      const dependent = agenda.todos.find((t: any) => t.text === "depends");
      const dep = agenda.todos.find((t: any) => t.text === "write proof");
      expect(dependent.deps).toEqual([dep.id]);
      expect(dependent.effectiveStatus).toBe("blocked");
    });
  });

  test("blocks is the reverse of after: the blocking todo's target gains it as a dependency", () => {
    const todos = extractTodos(
      [
        '@@todo(doing) [write proof of lemma] {blocks: "write up final draft"}',
        "@@todo [write up final draft]",
      ].join("\n"),
      note("/notes/a.md", "A"),
      1,
    );
    const { lints } = resolveTodoDeps(todos);
    expect(lints).toEqual([]);
    expect(todos[1].deps).toEqual([todos[0].id]);
    expect(todos[1].effectiveStatus).toBe("blocked");
    expect(todos[1].blockedBy).toEqual([todos[0].id]);
  });

  test("after and blocks combine without duplicating a dependency", () => {
    const todos = extractTodos(
      [
        '@@todo(doing) [write proof of lemma] {blocks: "write up final draft"}',
        '@@todo [write up final draft] {after: "write proof of lemma"}',
      ].join("\n"),
      note("/notes/a.md", "A"),
      1,
    );
    resolveTodoDeps(todos);
    expect(todos[1].deps).toEqual([todos[0].id]);
  });

  test("a broken blocks ref lints but never blocks", () => {
    const todos = extractTodos('@@todo [orphan blocker] {blocks: "nonexistent task"}', note("/notes/a.md", "A"), 1);
    const { lints } = resolveTodoDeps(todos);
    expect(lints).toMatchObject([{ kind: "broken-ref", ref: "nonexistent task", via: "blocks" }]);
    expect(todos[0].effectiveStatus).toBe("todo");
  });

  test("blocks participates in cycle detection alongside after", async () => {
    await withVault(async (root) => {
      await writeFile(
        join(root, "a.md"),
        [
          "---\nid: a\n---\n# A\n",
          "@@todo [first] {blocks: second}",
          "@@todo [second] {after: first, blocks: first}",
          "",
        ].join("\n"),
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ includeGantt: true });
      expect(agenda.lints.some((lint: { kind?: string }) => lint.kind === "cycle")).toBe(true);
    });
  });
});

describe("dependency resolution (stable ids)", () => {
  test("after: #id resolves directly against the id index", () => {
    const todos = extractTodos(
      ["@@todo(doing) [write proof of lemma] {id: abc123}", '@@todo [write up final draft] {after: "#abc123"}'].join("\n"),
      note("/notes/a.md", "A"),
      1,
    );
    const { lints } = resolveTodoDeps(todos);
    expect(lints).toEqual([]);
    expect(todos[0].id).toBe("#abc123");
    expect(todos[1].deps).toEqual(["#abc123"]);
    expect(todos[1].effectiveStatus).toBe("blocked");
  });

  test("blocks: #id is the reverse of after: #id", () => {
    const todos = extractTodos(
      ['@@todo(doing) [write proof of lemma] {id: abc123, blocks: "#def456"}', "@@todo [write up final draft] {id: def456}"].join("\n"),
      note("/notes/a.md", "A"),
      1,
    );
    const { lints } = resolveTodoDeps(todos);
    expect(lints).toEqual([]);
    expect(todos[1].deps).toEqual(["#abc123"]);
    expect(todos[1].effectiveStatus).toBe("blocked");
  });

  test("a broken #id ref lints but never blocks", () => {
    const todos = extractTodos('@@todo [orphan] {after: "#nonexistent"}', note("/notes/a.md", "A"), 1);
    const { lints } = resolveTodoDeps(todos);
    expect(lints).toMatchObject([{ kind: "broken-ref", ref: "#nonexistent", via: "after" }]);
    expect(todos[0].effectiveStatus).toBe("todo");
  });

  test("a duplicate id falls back to a positional id on the second occurrence and lints", () => {
    const todos = extractTodos(
      ["@@todo [first] {id: dup1}", "@@todo [second] {id: dup1}"].join("\n"),
      note("/notes/a.md", "A"),
      1,
    );
    expect(todos[0].id).toBe("#dup1");
    expect(todos[1].id).toBe("#dup1"); // both extracted with the raw id before dedup runs
    const { lints } = resolveTodoDeps(todos);
    expect(lints).toMatchObject([{ kind: "duplicate-id", ref: "#dup1" }]);
    // resolveTodoDeps mutates in place: the second occurrence falls back to file:offset
    expect(todos[0].id).toBe("#dup1");
    expect(todos[1].id).not.toBe("#dup1");
    expect(todos[1].id).toContain(":");
  });

  test("an #id reference survives the target todo's title text changing entirely", () => {
    const before = extractTodos(
      ["@@todo(doing) [original title] {id: abc123}", '@@todo [depends] {after: "#abc123"}'].join("\n"),
      note("/notes/a.md", "A"),
      1,
    );
    resolveTodoDeps(before);
    expect(before[1].deps).toEqual(["#abc123"]);

    const renamed = extractTodos(
      ["@@todo(doing) [a completely different title now] {id: abc123}", '@@todo [depends] {after: "#abc123"}'].join("\n"),
      note("/notes/a.md", "A"),
      1,
    );
    const { lints } = resolveTodoDeps(renamed);
    expect(lints).toEqual([]);
    expect(renamed[1].deps).toEqual(["#abc123"]);
    expect(renamed[1].effectiveStatus).toBe("blocked");
  });
});

describe("stable id minting (ensureTodoId / createTodo)", () => {
  test("createTodo mints a fresh id for a brand-new todo", async () => {
    await withVault(async (root) => {
      const result = await createTodo({ file: join(root, "inbox.md"), text: "buy milk" });
      expect(result.todo.id).toMatch(/^#[a-z0-9]{6}$/);
      const content = await readFile(join(root, "inbox.md"), "utf8");
      expect(content).toMatch(/@@todo \[buy milk\]\s*\{id=[a-z0-9]{6}\}/);
    });
  });

  test("ensureTodoId mints an id for a todo that has none, and is idempotent afterward", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(file, "---\nid: a\n---\n# A\n\n@@todo [no id yet]\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const todo = (await buildAgenda({ includePlanning: true })).todos.find((t: any) => t.text === "no id yet");
      expect(todo.id).not.toMatch(/^#/);

      const minted = await ensureTodoId({ file, index: todo.index, source: todo.source });
      expect(minted.changed).toBe(true);
      expect(minted.id).toMatch(/^#[a-z0-9]{6}$/);

      const again = await ensureTodoId({ file, index: minted.from, source: minted.nextSource });
      expect(again.changed).toBe(false);
      expect(again.id).toBe(minted.id);
    });
  });
});

describe("urgency ordering", () => {
  test("priority and deadline proximity dominate; computed-blocked sorts last", () => {
    const todayMs = new Date(2026, 6, 6).getTime();
    const todos = extractTodos(
      [
        "@@todo(doing) [urgent] {priority: A, due: 2026-07-01}",
        "@@todo [later] {due: 2026-08-01}",
        "@@todo [blocked one] {after: something else}",
        "@@todo [something else]",
      ].join("\n"),
      note("/n/a.md", "A"),
      1,
    );
    const [overdueA, lowPrioFuture, blocked] = todos;
    resolveTodoDeps(todos);
    for (const t of todos) t.urgency = todoUrgency(t, todayMs);
    expect(overdueA.urgency).toBeGreaterThan(lowPrioFuture.urgency);
    expect(lowPrioFuture.urgency).toBeGreaterThan(blocked.urgency);
  });
});

describe("agenda bucketing", () => {
  test("deadline/warning/overdue/scheduled/sched-carry/log entries land in the right buckets", async () => {
    await withVault(async (root) => {
      const today = new Date();
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const in3 = new Date(today); in3.setDate(in3.getDate() + 3);
      const ago2 = new Date(today); ago2.setDate(ago2.getDate() - 2);
      const schedAgo1 = new Date(today); schedAgo1.setDate(schedAgo1.getDate() - 1);

      await writeFile(
        join(root, "a.md"),
        [
          "---\nid: a\n---\n# A\n",
          `@@todo [near deadline] {ddl: ${iso(in3)}, warn: 5d}`,
          `@@todo [overdue task] {ddl: ${iso(ago2)}}`,
          `@@todo [carried sched] {sche: ${iso(schedAgo1)}}`,
          `@@todo(done) [closed one] {done: ${iso(today)}}`,
          "",
        ].join("\n"),
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ days: 7 });
      const todayBucket = agenda.days.find((d: any) => d.date === agenda.range.today);
      const kinds = todayBucket.entries.map((e: any) => e.kind);
      expect(kinds).toContain("warning");
      expect(kinds).toContain("overdue");
      expect(kinds).toContain("sched-carry");
      expect(kinds).toContain("log");
      const deadlineBucket = agenda.days.find((d: any) => d.date === iso(in3));
      expect(deadlineBucket.entries.map((e: any) => e.kind)).toContain("deadline");
      expect(agenda.logByDay[agenda.range.today]).toBe(1);
      expect(agenda.stats.overdue).toBe(1);
    });
  });

  test("time-grid: timed entries sort ascending by time before untimed entries", async () => {
    await withVault(async (root) => {
      const today = new Date();
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const ago2 = new Date(today); ago2.setDate(ago2.getDate() - 2);
      await writeFile(
        join(root, "a.md"),
        [
          "---\nid: a\n---\n# A\n",
          `@@todo [afternoon slot] {sche: "${iso(today)} 14:00"}`,
          `@@todo [morning slot] {sche: "${iso(today)} 09:00"}`,
          `@@todo(doing) [overdue, high urgency] {priority: A, ddl: ${iso(ago2)}}`,
          "",
        ].join("\n"),
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ days: 1 });
      const todayBucket = agenda.days.find((d: any) => d.date === agenda.range.today);
      const scheduled = todayBucket.entries.filter((e: any) => e.kind === "scheduled");
      expect(scheduled.map((e: any) => e.time)).toEqual(["09:00", "14:00"]);
      // timed entries always sort ahead of untimed ones, regardless of urgency
      const lastTimedIndex = todayBucket.entries.map((e: any) => Boolean(e.time)).lastIndexOf(true);
      const firstUntimedIndex = todayBucket.entries.map((e: any) => !e.time).indexOf(true);
      expect(firstUntimedIndex).toBeGreaterThan(lastTimedIndex);
    });
  });

  test("a repeating deadline projects virtual occurrences into future day buckets", async () => {
    await withVault(async (root) => {
      const today = new Date();
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const in2 = new Date(today); in2.setDate(in2.getDate() + 2);
      const in9 = new Date(today); in9.setDate(in9.getDate() + 9);
      await writeFile(
        join(root, "a.md"),
        [
          "---\nid: a\n---\n# A\n",
          `@@todo(doing) [weekly standup] {ddl: ${iso(in2)}, repeat: +1w}`,
          "",
        ].join("\n"),
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ days: 14 });
      const nextWeekBucket = agenda.days.find((d: any) => d.date === iso(in9));
      const repeatEntries = nextWeekBucket.entries.filter((e: any) => e.kind === "repeat" && e.virtual === true);
      expect(repeatEntries).toHaveLength(1);
      // the anchor occurrence itself is a normal (non-virtual) deadline entry
      const anchorBucket = agenda.days.find((d: any) => d.date === iso(in2));
      expect(anchorBucket.entries.some((e: any) => e.kind === "deadline" && !e.virtual)).toBe(true);
    });
  });

  test("a cancelled repeating todo does not project future occurrences", async () => {
    await withVault(async (root) => {
      const today = new Date();
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const in2 = new Date(today); in2.setDate(in2.getDate() + 2);
      await writeFile(
        join(root, "a.md"),
        [
          "---\nid: a\n---\n# A\n",
          `@@todo(cancelled) [dropped habit] {ddl: ${iso(in2)}, repeat: +1d}`,
          "",
        ].join("\n"),
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ days: 14 });
      const repeatEntries = agenda.days.flatMap((d: any) => d.entries).filter((e: any) => e.kind === "repeat");
      expect(repeatEntries).toEqual([]);
    });
  });

  test("a daily repeater anchored years in the past still projects into the requested window", async () => {
    // Regression: expandRepeatOccurrences' 366-iteration guard used to count
    // steps from the raw anchor, so a short-period repeater anchored more
    // than 366 steps before the window exhausted the guard before ever
    // reaching it — silently producing zero occurrences.
    await withVault(async (root) => {
      await writeFile(
        join(root, "a.md"),
        [
          "---\nid: a\n---\n# A\n",
          '@@todo(doing) [old daily habit] {sche: "2020-01-01 09:30", repeat: +1d}',
          "",
        ].join("\n"),
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ days: 7 });
      const repeatEntries = agenda.days.flatMap((d: any) => d.entries).filter((e: any) => e.kind === "repeat");
      // One virtual occurrence per day of the window except the anchor day
      // itself (the first bucket may carry the real, non-virtual entry
      // instead) — at minimum every subsequent day must have one.
      expect(repeatEntries.length).toBeGreaterThanOrEqual(6);
      expect(repeatEntries.every((e: any) => e.time === "09:30")).toBe(true);
    });
  });

  test("a monthly repeater anchored years in the past fast-forwards using the same clamping semantics as single-step iteration", async () => {
    await withVault(async (root) => {
      await writeFile(
        join(root, "a.md"),
        [
          "---\nid: a\n---\n# A\n",
          "@@todo(doing) [old monthly review] {sche: 2020-01-31, repeat: +1m}",
          "",
        ].join("\n"),
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      // A wide enough window (400 days) that it must contain at least one
      // occurrence regardless of today's date relative to day-31 clamping.
      const agenda = await buildAgenda({ days: 400 });
      const repeatEntries = agenda.days.flatMap((d: any) => d.entries).filter((e: any) => e.kind === "repeat");
      expect(repeatEntries.length).toBeGreaterThan(0);
    });
  });

  test("a repeater anchored inside the window is unaffected by the fast-forward path", async () => {
    await withVault(async (root) => {
      const today = new Date();
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const in1 = new Date(today); in1.setDate(in1.getDate() + 1);
      await writeFile(
        join(root, "a.md"),
        [
          "---\nid: a\n---\n# A\n",
          `@@todo(doing) [fresh daily] {sche: ${iso(in1)}, repeat: +1d}`,
          "",
        ].join("\n"),
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ days: 5 });
      const repeatEntries = agenda.days.flatMap((d: any) => d.entries).filter((e: any) => e.kind === "repeat");
      expect(repeatEntries.length).toBeGreaterThanOrEqual(3);
    });
  });

  test("a repeater anchored beyond the window produces no occurrences and does not hang", async () => {
    await withVault(async (root) => {
      const today = new Date();
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const farFuture = new Date(today); farFuture.setDate(farFuture.getDate() + 400);
      await writeFile(
        join(root, "a.md"),
        [
          "---\nid: a\n---\n# A\n",
          `@@todo(doing) [far future] {sche: ${iso(farFuture)}, repeat: +1d}`,
          "",
        ].join("\n"),
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ days: 7 });
      const repeatEntries = agenda.days.flatMap((d: any) => d.entries).filter((e: any) => e.kind === "repeat");
      expect(repeatEntries).toEqual([]);
    });
  });
});

describe("completeTodo repeater roll", () => {
  test("completing a repeating todo rolls ddl forward, resets status, records done+log", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(file, "---\nid: a\n---\n# A\n\n@@todo(doing) [water plants] {due: 2026-07-01, repeat: +1w}\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const before = (await getTodos("")).todos[0];
      const result = await completeTodo({ file, id: before.id, index: before.index, source: before.source, text: before.text });
      expect(result.changed).toBe(true);
      const content = await readFile(file, "utf8");
      expect(content).toMatch(/@@todo \[water plants\]/);
      expect(content).toContain("due=2026-07-08");
      expect(content).toMatch(/done=\d{4}-\d{2}-\d{2}/);
      expect(content).toMatch(/log=\d{4}-\d{2}-\d{2}/);
      const after = (await getTodos("")).todos[0];
      expect(after.status).toBe("todo");
    });
  });

  test("completing a non-repeating todo just marks it done with a done date", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(file, "---\nid: a\n---\n# A\n\n@@todo [one-off] {due: 2026-07-01}\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const before = (await getTodos("")).todos[0];
      await completeTodo({ file, id: before.id, index: before.index, source: before.source, text: before.text });
      const after = (await getTodos("")).todos[0];
      expect(after.status).toBe("done");
      expect(after.canon.done).toMatch(/\d{4}-\d{2}-\d{2}/);
    });
  });

  test("completing a repeating block todo rolls dates and preserves block attrs", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(file, [
        "---",
        "id: a",
        "---",
        "# A",
        "",
        "@@todo(doing) [weekly review] {",
        "  project: iso-202603",
        "  due: 2026-07-01",
        "  scheduled: 2026-07-01",
        "  repeat: +1w",
        "  progress: 50",
        "}",
        "",
      ].join("\n"), "utf8");
      await syncRoamDb(null, { mode: "full" });
      const before = (await getTodos("")).todos[0];
      await completeTodo({ file, id: before.id, index: before.index, source: before.source, text: before.text });
      const content = await readFile(file, "utf8");
      expect(content).toContain("@@todo [weekly review] {");
      expect(content).toContain("due: 2026-07-08");
      expect(content).toContain("scheduled: 2026-07-08");
      expect(content).toContain("project: iso-202603");
      expect(content).toMatch(/done: \d{4}-\d{2}-\d{2}/);
      expect((await getTodos("")).todos[0]).toMatchObject({
        status: "todo",
        canon: { ddl: "2026-07-08", sche: "2026-07-08", project: "iso-202603" },
      });
    });
  });
});

describe("patchTodo alias-preserving writes", () => {
  test("reuses the existing alias and only introduces canonical keys for new args", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(file, "---\nid: a\n---\n# A\n\n@@todo [ship it] {due: 2026-07-07}\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const before = (await getTodos("")).todos[0];
      await patchTodo({ file, id: before.id, index: before.index, source: before.source, text: before.text, ddl: "2026-07-09", prio: "A" });
      const content = await readFile(file, "utf8");
      expect(content).toContain("due=2026-07-09");
      expect(content).toContain("prio=A");
      expect(content).not.toContain("ddl=");
    });
  });

  test("patching an itodo preserves the itodo command name", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(file, "---\nid: a\n---\n# A\n\n@@itodo(doing) [ship it] {due: 2026-07-07}\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const before = (await getTodos("")).todos[0];
      expect(before.command).toBe("itodo");
      await patchTodo({ file, id: before.id, index: before.index, source: before.source, text: before.text, status: "done", ddl: "2026-07-09" });
      const content = await readFile(file, "utf8");
      expect(content).toContain("@@itodo(done) [ship it]");
      expect(content).toContain("due=2026-07-09");
      expect(content).not.toContain("@@todo(done)");
    });
  });

  test("afterAdd appends a dep ref with &", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(file, "---\nid: a\n---\n# A\n\n@@todo [second task] {after: first}\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const before = (await getTodos("")).todos[0];
      await patchTodo({ file, id: before.id, index: before.index, source: before.source, text: before.text, afterAdd: "third" });
      const content = await readFile(file, "utf8");
      expect(content).toMatch(/after=.*first.*third|after=.*third.*first/);
    });
  });

  test("afterAdd appends to a block todo dependency list", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(file, "---\nid: a\n---\n# A\n\n@@todo [second task] {\n  after: first\n}\n", "utf8");
      await syncRoamDb(null, { mode: "full" });
      const before = (await getTodos("")).todos[0];
      await patchTodo({ file, id: before.id, index: before.index, source: before.source, text: before.text, afterAdd: "third" });
      const content = await readFile(file, "utf8");
      expect(content).toMatch(/after: .*first.*third|after: .*third.*first/);
    });
  });
});

describe("planning project and Gantt model", () => {
  test("groups block todos under explicit projects and exposes milestones", async () => {
    await withVault(async (root) => {
      await writeFile(join(root, "iso.md"), [
        "---",
        "id: iso",
        "---",
        "# ISO",
        "",
        "@@project(active) [ISO 202603] {",
        "  project: iso-202603",
        "  goal: Submit tensor paper",
        "}",
        "",
        "@@todo(doing) [write graph tensor proof] {",
        "  project: iso-202603",
        "  sche: 2026-07-06",
        "  end: 2026-07-10",
        "  progress: 25",
        "}",
        "",
        "@@milestone [advisor check] {",
        "  project: iso-202603",
        "  date: 2026-07-15",
        "}",
        "",
      ].join("\n"), "utf8");
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ includePlanning: true, includeGantt: true, days: 30 });
      expect(agenda.projects).toMatchObject([{ title: "ISO 202603", args: { project: "iso-202603" } }]);
      expect(agenda.milestones).toMatchObject([{ title: "advisor check", args: { project: "iso-202603", date: "2026-07-15" } }]);
      expect(agenda.gantt.tasks).toMatchObject([
        { name: "write graph tensor proof", project: "iso-202603", start: "2026-07-06", end: "2026-07-10", progress: 25 },
      ]);
      expect(agenda.gantt.milestones).toMatchObject([
        { name: "advisor check", project: "iso-202603", date: "2026-07-15" },
      ]);
      expect(agenda.gantt.lanes).toMatchObject([
        { key: "iso-202603", start: "2026-07-06", end: "2026-07-10", childTaskIds: [agenda.gantt.tasks[0].id] },
      ]);
      expect(agenda.projectModel).toMatchObject([
        { key: "iso-202603", title: "ISO 202603", total: 1, doing: 1, progress: 0 },
      ]);
    });
  });

  test("file meta project is the default planning project for items without args", async () => {
    await withVault(async (root) => {
      await writeFile(join(root, "graph.md"), [
        "#+begin meta",
        "id: graph",
        "title: Graph Tensor",
        "project: iso-202603",
        "#+end meta",
        "",
        "# Graph Tensor",
        "",
        "@@project(active) [ISO 202603 tensor paper] {}",
        "@@todo(doing) [clean definitions] {effort: 2h}",
        "@@milestone [proof freeze] {date: 2026-07-17}",
        "",
      ].join("\n"), "utf8");
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ includePlanning: true, includeGantt: true, days: 30 });
      expect(agenda.projects).toMatchObject([{ title: "ISO 202603 tensor paper", args: { project: "iso-202603" } }]);
      expect(agenda.todos.find((todo: any) => todo.text === "clean definitions")).toMatchObject({
        canon: { project: "iso-202603", effort: "2h" },
      });
      expect(agenda.milestones).toMatchObject([{ title: "proof freeze", args: { project: "iso-202603", date: "2026-07-17" } }]);
      expect(agenda.projectModel).toMatchObject([
        { key: "iso-202603", title: "ISO 202603 tensor paper", total: 1, doing: 1, effortMinutes: 120 },
      ]);
      expect(agenda.gantt.milestones).toMatchObject([{ name: "proof freeze", project: "iso-202603" }]);
    });
  });

  test("project progress rolls up from child todo completion when not set explicitly", async () => {
    await withVault(async (root) => {
      await writeFile(join(root, "p.md"), [
        "---\nid: p\n---\n# P\n",
        "@@project(active) [Side Project] { project: side }",
        "@@todo(done) [task one] { project: side }",
        "@@todo(done) [task two] { project: side }",
        "@@todo [task three] { project: side }",
        "@@todo(cancelled) [task four] { project: side }",
        "",
      ].join("\n"), "utf8");
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ includePlanning: true });
      const model = agenda.projectModel.find((p: any) => p.key === "side");
      // 2 done out of 3 non-cancelled (cancelled is excluded from the base) = 67%
      expect(model).toMatchObject({ total: 4, done: 2, open: 1, cancelled: 1, progress: 67 });
    });
  });

  test("unprojected note todos do not synthesize project cards or analysis project keys", async () => {
    await withVault(async (root) => {
      await writeFile(join(root, "graph.md"), [
        "---\nid: graph\n---\n# Graph Tensor\n",
        "@@itodo(doing) [clean definitions] {sche: 2026-07-07}",
        "@@itodo [check proof]",
        '@@clock [clean definitions] {from: "2026-07-07 09:00", to: "2026-07-07 09:30"}',
        "@@milestone [local note marker] {date: 2026-07-10}",
        "",
      ].join("\n"), "utf8");
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ includePlanning: true, includeGantt: true });
      expect(agenda.todos.map((todo: any) => todo.text)).toContain("clean definitions");
      expect(agenda.projectModel).toEqual([]);
      expect(agenda.clocktable.byProject).toEqual({});
      expect(agenda.gantt.backlog.find((task: any) => task.name === "clean definitions")).toMatchObject({ project: "" });
      expect(agenda.gantt.milestones).toMatchObject([{ name: "local note marker", project: "" }]);
      expect(JSON.stringify(agenda)).not.toContain("Graph Tensor (");
    });
  });

  test("an explicit project progress key wins over the computed rollup", async () => {
    await withVault(async (root) => {
      await writeFile(join(root, "p.md"), [
        "---\nid: p\n---\n# P\n",
        "@@project(active) [Manual Progress] { project: manual, progress: 90 }",
        "@@todo [only task] { project: manual }",
        "",
      ].join("\n"), "utf8");
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ includePlanning: true });
      const model = agenda.projectModel.find((p: any) => p.key === "manual");
      expect(model.progress).toBe(90);
    });
  });

  test("project rollup includes effort and clocked minutes from its todos", async () => {
    await withVault(async (root) => {
      await writeFile(join(root, "p.md"), [
        "---\nid: p\n---\n# P\n",
        "@@project(active) [Timed Project] { project: timed }",
        '@@todo(doing) [tracked task] { project: timed, effort: 2h }',
        '@@clock [tracked task] {from: "2026-07-07 09:00", to: "2026-07-07 09:45"}',
        "",
      ].join("\n"), "utf8");
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ includePlanning: true });
      const model = agenda.projectModel.find((p: any) => p.key === "timed");
      expect(model).toMatchObject({ effortMinutes: 120, clockedMinutes: 45 });
    });
  });

  test("agenda-only dates do not Gantt-lint, but explicit end without start does", async () => {
    await withVault(async (root) => {
      await writeFile(join(root, "p.md"), [
        "---\nid: p\n---\n# P\n",
        "@@todo(doing) [collect references] { project: paper }",
        "@@todo(doing) [send reminder] { project: paper, ddl: 2026-07-09 }",
        "@@todo(doing) [draft timeline] { project: paper, sche: 2026-07-07 }",
        "@@todo(doing) [finish orphaned bar] { project: paper, end: 2026-07-12 }",
        "",
      ].join("\n"), "utf8");
      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ includeGantt: true });
      expect(agenda.gantt.backlog).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "collect references", start: "", end: "" }),
        expect.objectContaining({ name: "send reminder", start: "", end: "2026-07-09" }),
        expect.objectContaining({ name: "draft timeline", start: "2026-07-07", end: "" }),
        expect.objectContaining({ name: "finish orphaned bar", start: "", end: "2026-07-12" }),
      ]));
      expect(agenda.lints).toMatchObject([
        { kind: "missing-gantt-date", ref: "finish orphaned bar", message: "Partially scheduled Gantt tasks need both sche/start and end/ddl" },
      ]);
      expect(agenda.lints.some((lint: { ref?: string }) => lint.ref === "collect references")).toBe(false);
      expect(agenda.lints.some((lint: { ref?: string }) => lint.ref === "send reminder")).toBe(false);
      expect(agenda.lints.some((lint: { ref?: string }) => lint.ref === "draft timeline")).toBe(false);
    });
  });
});

describe("planning cache", () => {
  test("createTodo appends an agenda-visible todo to inbox by default", async () => {
    await withVault(async (root) => {
      const today = new Date();
      const due = new Date(today);
      due.setDate(due.getDate() + 1);
      const dateString = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const dueDate = dateString(due);
      const created = await createTodo({ text: "Draft agenda capture", ddl: dueDate, prio: "A" });
      expect(created).toMatchObject({ ok: true, createdFile: true, path: "inbox.md" });
      const content = await readFile(join(root, "inbox.md"), "utf8");
      expect(content).toContain("@@todo [Draft agenda capture]");
      expect(content).toContain(`ddl=${dueDate}`);
      expect(content).toContain("prio=A");

      await syncRoamDb(null, { mode: "full" });
      const agenda = await buildAgenda({ from: dateString(today), days: 3 });
      const todo = agenda.todos.find((item: any) => item.text === "Draft agenda capture");
      expect(todo).toMatchObject({ status: "todo", canon: { ddl: dueDate, prio: "A" } });
      expect(agenda.days.some((day: any) => day.entries.some((entry: any) => entry.todoId === todo.id))).toBe(true);
    });
  });

  test("planningItemsForNote memoizes parsed nodes instead of re-reading the file from disk on every agenda request", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(
        file,
        "---\nid: a\n---\n# A\n\n@@project(active) [Original Project] {area: tooling}\n\n@@todo [first task] {project: original-project}\n",
        "utf8",
      );
      await syncRoamDb(null, { mode: "full" });
      const first = await buildAgenda({ includeGantt: true });
      expect(first.projects).toMatchObject([{ title: "Original Project" }]);

      // Mutate the file directly on disk, bypassing patchTodo/updateNote and
      // markNotesDirty — the noteCache must not notice on its own.
      await writeFile(
        file,
        "---\nid: a\n---\n# A\n\n@@project(active) [Mutated Project] {area: tooling}\n\n@@todo [first task] {project: original-project}\n",
        "utf8",
      );

      const second = await buildAgenda({ includeGantt: true });
      expect(second.projects).toMatchObject([{ title: "Original Project" }]);
    });
  });

  test("persists parsed planning and agenda payload cache under stateRoot", async () => {
    await withVault(async (root) => {
      const file = join(root, "a.md");
      await writeFile(
        file,
        "---\nid: a\n---\n# A\n\n@@project(active) [Cached Project] {area: tooling}\n\n@@todo [cached task] {project: cached-project}\n",
        "utf8",
      );

      const first = await buildAgenda({ includeGantt: true });
      expect(first.projects).toMatchObject([{ title: "Cached Project" }]);

      const raw = JSON.parse(await readFile(join(root, "state", "cache", "agenda-cache.json"), "utf8"));
      expect(raw.files[file].planning.projects).toMatchObject([{ title: "Cached Project" }]);
      expect(Object.keys(raw.payloads).length).toBeGreaterThan(0);

      configure({ root, workspaceRoot: root, stateRoot: join(root, "state"), tmpRoot: join(root, "tmp") });
      const second = await buildAgenda({ includeGantt: true });
      expect(second.projects).toMatchObject([{ title: "Cached Project" }]);
    });
  });
});

describe("depRefForTodo", () => {
  test("generates the shortest unique word-boundary prefix", () => {
    const [a, b] = extractTodos(
      ["@@todo [write introduction section]", "@@todo [write conclusion section]"].join("\n"),
      note("/n/a.md", "A"),
      1,
    );
    const ref = depRefForTodo(a, [a, b], b);
    expect(ref).toBe("write introduction");
  });

  test("prefixes cross-file refs with [[Title]]::", () => {
    const a = extractTodos("@@todo [unique target text]", note("/n/a.md", "A"), 1)[0];
    const b = extractTodos("@@todo [source task]", note("/n/b.md", "B"), 1)[0];
    const ref = depRefForTodo(a, [a], b);
    expect(ref).toBe("[[A]]::unique");
  });
});
