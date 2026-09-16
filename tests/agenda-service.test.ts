import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-ignore Headless host modules.
import { createAgendaService } from "../server/lib/agenda-service.mjs";
// @ts-ignore Headless host modules.
import { createAgendaClockStore } from "../server/lib/agenda-clock-store.mjs";
// @ts-ignore Existing native Markdown writers/evaluator.
import { configure, agendaMarkdownDocument, buildAgendaFromPlanning, clockIn, clockOut } from "../server/lib/runtime.mjs";
import { createResearchNotebook, createResearchCell, createResearchNotebookService, setResearchAgenda } from "../server/lib/research-notebook.mjs";
import { workAgendaPlanning } from "../shared/work-agenda.mjs";

const locator = (todo: any) => ({ uid: todo.uid, scopeId: todo.scopeId, revision: todo.sourceRef.revision });
async function fixture(run: (context: any) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "noema-durable-clock-")));
  const knowledge = join(root, "knowledge"), project = join(root, "project"), database = join(root, "state", "clocks.sqlite");
  await mkdir(knowledge); await mkdir(project);
  configure({ root: knowledge, workspaceRoot: root, stateRoot: join(root, "state"), tmpRoot: join(root, "tmp") });
  let time = new Date(2026, 8, 16, 9).getTime(), inactive = false, projectReads = 0, sourceWrites = 0;
  const instances: any[] = [], watchers: any[] = [];
  const notebooks = createResearchNotebookService();
  function guard(file: string) {
    if (file === project || file.startsWith(`${project}/`)) {
      if (inactive) throw new Error("Inactive project IO");
      projectReads++;
    }
  }
  function open(overrides: any = {}) {
    const service = createAgendaService({
      knowledgeRoot: knowledge, clockStore: overrides.clockStore || createAgendaClockStore(database), now: () => time,
      canonicalRoot: async (file: string) => { guard(file); return realpath(file); },
      read: async (file: string) => {
        guard(file);
        const content = await readFile(file, "utf8");
        return { content, revision: createHash("sha256").update(content).digest("hex"), mtimeMs: time };
      },
      watch: (options: any) => {
        guard(options.root);
        const watcher = { ...options, closed: false, close() { this.closed = true; } };
        watchers.push(watcher); return watcher;
      },
      parseDocument: (doc: any) => doc.file.endsWith(".noema") ? workAgendaPlanning(JSON.parse(doc.content), doc) : agendaMarkdownDocument(doc),
      evaluate: (planning: any, body: any, options: any) => buildAgendaFromPlanning(planning, body, { ...options, requireKernel: false }),
      startClock: async (todo: any, options: any) => {
        guard(todo.file); sourceWrites++;
        if (todo.sourceKind === "work-node") return notebooks.setAgenda({ file: todo.file, workNodeId: todo.workNodeId,
          expectedRevision: `sha256:${todo.sourceRef.revision}`, patch: { op: "clock-in", clockId: options.clockId, at: options.at } });
        return clockIn({ file: todo.file, index: todo.index, source: todo.source, expectedSource: todo.source, expectedRevision: todo.sourceRef.revision }, options);
      },
      stopClock: async (body: any, options: any) => {
        guard(body.file); sourceWrites++;
        if (body.sourceKind === "work-node") return notebooks.setAgenda({ file: body.file, workNodeId: body.workNodeId,
          expectedRevision: `sha256:${body.revision}`, patch: { op: "clock-out", clockId: body.clockId, at: options.at } });
        return clockOut(body, options);
      },
      ...overrides,
    });
    instances.push(service); return service;
  }
  try { await run({ knowledge, project, database, open, watchers,
    inactive: (value: boolean) => { inactive = value; }, time: (hour: number) => { time = new Date(2026, 8, 16, hour).getTime(); },
    counts: () => ({ projectReads, sourceWrites }) }); }
  finally { for (const instance of instances) await instance.close(); await rm(root, { recursive: true, force: true }); }
}

describe("durable Agenda clock references", () => {
  for (const kind of ["markdown", "work-node"]) test(`${kind}: restart and inactive stop do no project IO; re-entry uses the original stop time`, () => fixture(async (ctx) => {
    const file = join(ctx.project, kind === "markdown" ? "task.md" : "work.noema");
    const created = createResearchCell(createResearchNotebook(), { kind: "work", title: "Proof", source: "Keep the prompt" });
    created.notebook = setResearchAgenda(created.notebook, created.workNode.id, {}).notebook;
    await writeFile(file, kind === "markdown" ? "@@todo [Proof]{id: abc123}\n" : JSON.stringify(created.notebook));
    let service = ctx.open();
    let scope = await service.enter({ root: ctx.project });
    const todo = (await service.query({ scopes: [scope.id] })).todos[0];
    await service.clockIn(locator(todo));
    await service.leave({ id: scope.id });
    await service.close();
    expect(ctx.watchers.filter((w: any) => w.root === ctx.project).every((w: any) => w.closed)).toBe(true);
    ctx.inactive(true);
    const before = ctx.counts();
    service = ctx.open();
    ctx.time(10);
    const snapshot = await service.query();
    expect(snapshot.todos).toEqual([]);
    expect(snapshot.clocktable.running.inactive).toBe(true);
    const receipt = await service.clockOut(snapshot.clocktable.running);
    expect(receipt.deferred).toBe(true);
    expect((await service.query()).clocktable.pendingWrites[0].to).toBe("2026-09-16 10:00");
    expect(ctx.counts()).toEqual(before);
    ctx.inactive(false); ctx.time(12);
    scope = await service.enter({ root: ctx.project });
    expect(scope.changedPaths).toEqual([file]);
    const finished = await service.query({ scopes: [scope.id], includePlanning: true });
    expect(finished.clocktable.running).toBeNull();
    expect(finished.clocktable.pendingWrites).toEqual([]);
    expect(finished.clocktable.tasks[0].minutes).toBe(60);
    if (kind === "work-node") {
      const disk = JSON.parse(await readFile(file, "utf8"));
      expect(disk.cells[0].source).toContain("@@clock [Proof]");
      expect(disk.cells[0].source).toContain("Keep the prompt");
      expect(disk.cells[0].metadata).toEqual(created.notebook.cells[0].metadata);
    }
    else expect(finished.clocks[0].args.to).toBe("2026-09-16 10:00");
  }));

  test("deferred stop rebases an unchanged clock after unrelated edits and waits for unsaved buffers", () => fixture(async (ctx) => {
    const file = join(ctx.project, "task.md");
    await writeFile(file, "@@todo [Proof]{id: abc123}\n");
    const service = ctx.open(), scope = await service.enter({ root: ctx.project });
    await service.clockIn(locator((await service.queryActive()).todos[0]));
    await service.leave({ id: scope.id });
    ctx.time(10);
    await service.clockOut((await service.query()).clocktable.running);
    await writeFile(file, `# Unrelated new heading\n${await readFile(file, "utf8")}`);
    const entered = await service.enter({ root: ctx.project, protectedFiles: [file] });
    expect(entered.changedPaths).toEqual([]);
    expect((await service.queryActive()).clocktable.pendingWrites).toHaveLength(1);
    ctx.time(12);
    const waiting = await service.queryActive({ includePlanning: true });
    expect(waiting.clocktable.tasks[0].minutes).toBe(60);
    expect(waiting.clocktable.intentAdjusted).toBe(true);
    expect((await service.retryClocks()).changedPaths).toEqual([file]);
    const content = await readFile(file, "utf8");
    expect(content).toContain("# Unrelated new heading");
    expect((await service.queryActive({ includePlanning: true })).clocks[0].args.to).toBe("2026-09-16 10:00");
  }));

  test("changed clock intervals remain conflicts until the source is repaired", () => fixture(async (ctx) => {
    const file = join(ctx.project, "task.md");
    await writeFile(file, "@@todo [Proof]{id: abc123}\n");
    const service = ctx.open(), scope = await service.enter({ root: ctx.project });
    await service.clockIn(locator((await service.queryActive()).todos[0]));
    await service.leave({ id: scope.id }); ctx.time(10);
    await service.clockOut((await service.query()).clocktable.running);
    const original = await readFile(file, "utf8");
    const changed = original.replace("from: 2026-09-16 09:00", "from: 2026-09-16 09:05");
    await writeFile(file, changed);
    await service.enter({ root: ctx.project });
    expect(await readFile(file, "utf8")).toBe(changed);
    expect((await service.queryActive()).clocktable.pendingWrites[0].message).toContain("changed");
    await writeFile(file, original); service.invalidate([file]);
    expect((await service.retryClocks()).pending).toBe(0);
  }));

  test("the journal rejects a stale host commit rather than losing another host's receipt", async () => {
    await fixture(async (ctx) => {
      const first = createAgendaClockStore(ctx.database), second = createAgendaClockStore(ctx.database);
      try {
        const a = first.read(), b = second.read();
        first.commit(a, [{ id: "a", file: "/task.md", scopeId: "knowledge", root: "/", from: "2026-09-16 09:00", phase: "running" }]);
        expect(() => second.commit(b, [])).toThrow("another host");
        expect(second.read().records).toHaveLength(1);
      } finally { first.close(); second.close(); }
    });
  });

  test("switching to knowledge stops an inactive project's clock without reading it, after validating the destination", () => fixture(async (ctx) => {
    await writeFile(join(ctx.project, "task.md"), "@@todo [Project]{id: abc123}\n");
    const note = join(ctx.knowledge, "task.md");
    await writeFile(note, "@@todo [Knowledge]{id: abc124}\n");
    const service = ctx.open(), scope = await service.enter({ root: ctx.project });
    const projectTodo = (await service.queryActive()).todos.find((todo: any) => todo.text === "Project");
    await service.clockIn(locator(projectTodo)); await service.leave({ id: scope.id });
    ctx.inactive(true); ctx.time(10);
    const old = (await service.query()).todos[0];
    await writeFile(note, "@@todo [Knowledge edited]{id: abc124}\n");
    await expect(service.clockIn(locator(old))).rejects.toThrow("changed");
    expect((await service.query()).clocktable.pendingWrites).toEqual([]);
    service.invalidate([note]);
    const before = ctx.counts().projectReads;
    await service.clockIn(locator((await service.query()).todos[0]));
    const after = await service.query();
    expect(after.clocktable.running.text).toBe("Knowledge edited");
    expect(after.clocktable.pendingWrites[0].text).toBe("Project");
    expect(ctx.counts().projectReads).toBe(before);
    const store = createAgendaClockStore(ctx.database);
    try {
      const revision = store.read().revision;
      for (let i = 0; i < 10; i++) await service.query();
      expect(store.read().revision).toBe(revision);
    } finally { store.close(); }
  }));

  test("a completed source write with a lost reply is recovered by its journaled clock ID", () => fixture(async (ctx) => {
    const file = join(ctx.project, "task.md");
    await writeFile(file, "@@todo [Proof]{id: abc123}\n");
    let service = ctx.open({ startClock: async (todo: any, options: any) => {
      await clockIn({ file: todo.file, index: todo.index, source: todo.source, expectedRevision: todo.sourceRef.revision }, options);
      throw new Error("Lost source acknowledgement");
    } });
    await service.enter({ root: ctx.project });
    await expect(service.clockIn(locator((await service.queryActive()).todos[0]))).rejects.toThrow("Lost source acknowledgement");
    await service.close();
    service = ctx.open();
    await service.enter({ root: ctx.project });
    const snapshot = await service.queryActive({ includePlanning: true });
    expect(snapshot.clocks).toHaveLength(1);
    expect(snapshot.clocktable.runningClocks).toHaveLength(1);
    expect(snapshot.clocktable.running.pending).toBe(false);
  }));

  test("an intent commit failure prevents the source clock write", () => fixture(async (ctx) => {
    const file = join(ctx.knowledge, "task.md");
    await writeFile(file, "@@todo [Proof]{id: abc123}\n");
    const store = createAgendaClockStore(ctx.database);
    const service = ctx.open({ clockStore: { ...store, commit: () => { throw new Error("Journal unavailable"); } } });
    await expect(service.clockIn(locator((await service.query()).todos[0]))).rejects.toThrow("Journal unavailable");
    expect(ctx.counts().sourceWrites).toBe(0);
    expect(await readFile(file, "utf8")).not.toContain("@@clock");
  }));

  test("a source stop survives a lost journal acknowledgement without a second source write", () => fixture(async (ctx) => {
    await writeFile(join(ctx.knowledge, "task.md"), "@@todo [Proof]{id: abc123}\n");
    const store = createAgendaClockStore(ctx.database);
    let failClear = true;
    let service = ctx.open({ clockStore: { ...store, commit: (state: any, records: any[]) => {
      if (!records.length && failClear) { failClear = false; throw new Error("Lost acknowledgement"); }
      return store.commit(state, records);
    } } });
    await service.clockIn(locator((await service.query()).todos[0])); ctx.time(10);
    await service.clockOut((await service.query()).clocktable.running);
    await service.close();
    const writes = ctx.counts().sourceWrites;
    service = ctx.open();
    const snapshot = await service.query({ includePlanning: true });
    expect(snapshot.clocktable.pendingWrites).toEqual([]);
    expect(snapshot.clocktable.tasks[0].minutes).toBe(60);
    expect(ctx.counts().sourceWrites).toBe(writes);
  }));

  test("an unconfirmed start is visible and can explicitly keep the saved source state", () => fixture(async (ctx) => {
    const file = join(ctx.knowledge, "task.md");
    await writeFile(file, "@@todo [Proof]{id: abc123}\n");
    const service = ctx.open({ startClock: () => { throw new Error("Source unavailable"); } });
    await expect(service.clockIn(locator((await service.query()).todos[0]))).rejects.toThrow("Source unavailable");
    const snapshot = await service.query();
    expect(snapshot.clocktable.running.pending).toBe(true);
    await expect(service.clockIn(locator(snapshot.todos[0]))).rejects.toThrow("unconfirmed");
    await service.keepClockSource(snapshot.clocktable.running);
    expect((await service.query()).clocktable.running).toBeNull();
    expect(await readFile(file, "utf8")).not.toContain("@@clock");
  }));

  test("host protection covers Web-originated writes and never queries inactive source buffers", () => fixture(async (ctx) => {
    const file = join(ctx.project, "task.md");
    await writeFile(file, "@@todo [Proof]{id: abc123}\n");
    let protectedSource = false;
    const consulted: string[] = [];
    const service = ctx.open({ isSourceProtected: (file: string) => { consulted.push(file); return protectedSource; } });
    const scope = await service.enter({ root: ctx.project });
    await service.clockIn(locator((await service.queryActive()).todos[0]));
    await service.leave({ id: scope.id }); ctx.time(10);
    const calls = consulted.length;
    await service.clockOut((await service.query()).clocktable.running);
    expect(consulted).toHaveLength(calls);
    protectedSource = true;
    const entered = await service.enter({ root: ctx.project });
    expect(entered.changedPaths).toEqual([]);
    expect((await service.queryActive()).clocktable.pendingWrites[0].message).toContain("modified source buffer");
    protectedSource = false;
    expect((await service.retryClocks()).changedPaths).toEqual([file]);
  }));
});
