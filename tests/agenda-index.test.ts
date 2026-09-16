import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchNotebook, createResearchCell, createResearchNotebookService, setResearchAgenda } from "../server/lib/research-notebook.mjs";
import { workAgendaPlanning } from "../shared/work-agenda.mjs";
// @ts-ignore Node source module
import { createAgendaIndex, listDocuments } from "../server/lib/agenda-index.mjs";
// @ts-ignore Node source module
import { agendaMarkdownDocument, buildAgendaFromPlanning, configure, patchTodo, createTodo, ensureTodoId, clockIn, clockOut } from "../server/lib/runtime.mjs";

async function fixture(run: (context: any) => Promise<void>, options: any = {}) {
  const root = await mkdtemp(join(tmpdir(), "noema-native-agenda-"));
  const knowledge = join(root, "knowledge");
  const project = join(root, "project");
  await mkdir(knowledge); await mkdir(project);
  configure({ root: knowledge, workspaceRoot: root, stateRoot: join(root, "state"), tmpRoot: join(root, "tmp") });
  const watchers: any[] = [];
  let parses = 0;
  let evaluations = 0;
  const notebooks = createResearchNotebookService();
  const service = createAgendaIndex({
    knowledgeRoot: knowledge,
    parseDocument: (doc: any) => { parses++; return doc.file.endsWith(".noema")
      ? workAgendaPlanning(JSON.parse(doc.content), doc) : agendaMarkdownDocument(doc); },
    evaluate: (planning: any, body: any, options: any) => {
      evaluations++;
      return buildAgendaFromPlanning(planning, body, { ...options, requireKernel: false });
    },
    watch: (options: any) => {
      const handle = { ...options, closed: false, close() { this.closed = true; } };
      watchers.push(handle); return handle;
    },
    now: () => new Date(2026, 8, 15, 12).getTime(),
    mutate: (todo: any, patch: any) => patchTodo({ ...patch, file: todo.file, selectorId: todo.id.startsWith("#") ? todo.id : "",
      index: todo.index, source: todo.source, expectedSource: todo.source, expectedRevision: todo.sourceRef.revision }),
    create: createTodo,
    ensureId: (todo: any, options: any) => ensureTodoId({ file: todo.file, index: todo.index, source: todo.source,
      expectedSource: todo.source, expectedRevision: todo.sourceRef.revision }, options),
    startClock: (todo: any, options: any) => todo.sourceKind === "work-node"
      ? notebooks.setAgenda({ file: todo.file, workNodeId: todo.workNodeId,
        expectedRevision: `sha256:${todo.sourceRef.revision}`, patch: { op: "clock-in" } })
      : clockIn({ file: todo.file, index: todo.index, source: todo.source,
      expectedSource: todo.source, expectedRevision: todo.sourceRef.revision }, options),
    stopClock: (body: any, options: any) => body.sourceKind === "work-node"
      ? notebooks.setAgenda({ file: body.file, workNodeId: body.workNodeId,
        expectedRevision: `sha256:${body.revision}`, patch: { op: "clock-out", clockId: body.clockId } })
      : clockOut(body, options),
    ...options,
  });
  try { await run({ root, knowledge, project, service, watchers, counts: () => ({ parses, evaluations }) }); }
  finally { service.close(); await rm(root, { recursive: true, force: true }); }
}
const task = (title: string, id = "abc123") => `@@todo [${title}]{id: ${id}, sche: 2026-09-15 10:00, ddl: 2026-09-16}`;

describe("native Agenda scope index", () => {
  test("a disconnected scope removes stale tasks, preserves knowledge, and recovers on a source event", async () => {
    let offline = false;
    await fixture(async ({knowledge, project, service, watchers}) => {
      await writeFile(join(knowledge, "task.md"), task("Knowledge"));
      await writeFile(join(project, "task.md"), task("Project"));
      const scope = await service.enter({root:project});
      expect((await service.queryActive()).todos.length).toBe(2);
      offline = true;
      watchers.find((watch: any) => watch.root === scope.root).onFullRescan();
      const disconnected = await service.queryActive();
      expect(disconnected.todos.map((todo: any) => todo.text)).toEqual(["Knowledge"]);
      expect(disconnected.errors).toHaveLength(1);
      offline = false;
      watchers.find((watch: any) => watch.root === scope.root).onFullRescan();
      const recovered = await service.queryActive();
      expect(recovered.todos.length).toBe(2);
      expect(recovered.errors).toEqual([]);
    }, {list: (root: string, options: any) => {
      if (offline && root.endsWith('/project')) throw new Error('Source disconnected');
      return listDocuments(root, options);
    }});
  });

  test("hands clocks between identical WorkNode titles and Markdown across active scopes", () => fixture(async ({ knowledge, project, service, watchers }) => {
    const first = createResearchCell(createResearchNotebook(), { kind: "work", title: "Same", source: "First prompt." });
    const second = createResearchCell(first.notebook, { kind: "work", title: "Same", source: "Second prompt." });
    let notebook = second.notebook;
    for (const node of notebook.metadata.noema_research.work_nodes) notebook = setResearchAgenda(notebook, node.id, {}).notebook;
    const original = structuredClone(notebook);
    const file = join(project, "work.noema");
    await writeFile(file, JSON.stringify(notebook));
    await writeFile(join(knowledge, "task.md"), task("Markdown"));
    const scope = await service.enter({ root: project });
    const query = () => service.queryActive({ includePlanning: true });
    const find = async (nodeId: string) => (await query()).todos.find((todo: any) => todo.workNodeId === nodeId);
    await service.clockIn(locator(await find(first.workNode.id)));
    expect((await query()).clocktable.running.todoId).toBe((await find(first.workNode.id)).uid);
    const bytes = await readFile(file, "utf8");
    expect(await service.clockIn(locator(await find(first.workNode.id)))).toMatchObject({ changed: false });
    expect(await readFile(file, "utf8")).toBe(bytes);
    await service.clockIn(locator(await find(second.workNode.id)));
    const snapshot = await query();
    expect(snapshot.clocktable.runningClocks).toHaveLength(1);
    expect(snapshot.clocktable.running.todoId).toBe((await find(second.workNode.id)).uid);
    expect(snapshot.lints.filter((lint: any) => lint.kind.includes("clock"))).toEqual([]);
    const markdown = snapshot.todos.find((todo: any) => todo.sourceKind === "markdown");
    await service.clockIn(locator(markdown));
    expect((await query()).clocktable.running.todoId).toBe(markdown.uid);
    const disk = JSON.parse(await readFile(file, "utf8"));
    expect(disk.cells.map((cell: any) => cell.metadata)).toEqual(original.cells.map((cell: any) => cell.metadata));
    expect(disk.cells.every((cell: any) => cell.source.includes("@@clock [Same]"))).toBe(true);
    expect(disk.metadata.noema_research.dependencies).toEqual(original.metadata.noema_research.dependencies);
    expect(disk.metadata.noema_research.work_nodes.every((node: any) => node.agenda === undefined)).toBe(true);
    await service.clockIn(locator(await find(first.workNode.id)));
    const running = (await query()).clocktable.running;
    await service.clockOut(running);
    expect((await query()).clocktable.running).toBeNull();
    await expect(service.clockOut(running)).rejects.toThrow("changed");
    expect(watchers).toHaveLength(2);
    await service.leave({ id: scope.id });
    expect(service.status().owners).toHaveLength(1);
  }));
  test("only knowledge is resident; project leases release watchers and cached documents", () => fixture(async ({ knowledge, project, service, watchers }) => {
    await writeFile(join(knowledge, "note.md"), task("knowledge"));
    await writeFile(join(project, "note.md"), task("project"));
    expect((await service.query()).todos.map((t: any) => t.text)).toEqual(["knowledge"]);
    expect(watchers).toHaveLength(1);
    const scope = await service.enter({ root: project, lease: "a" });
    await service.enter({ root: project, lease: "b" });
    expect(watchers).toHaveLength(2);
    const combined = await service.query({ scopes: ["knowledge", scope.id] });
    expect(combined.todos).toHaveLength(2);
    expect(new Set(combined.todos.map((t: any) => t.uid)).size).toBe(2);
    expect([...new Set(combined.days[0].entries.map((e: any) => e.todoId))].sort()).toEqual(combined.todos.map((t: any) => t.uid).sort());
    await service.leave({ id: scope.id, lease: "a" });
    expect(watchers[1].closed).toBe(false);
    await service.leave({ id: scope.id, lease: "b" });
    expect(watchers[1].closed).toBe(true);
    expect(service.status().owners).toHaveLength(1);
    await expect(service.query({ scopes: [scope.id] })).rejects.toThrow("inactive");
    expect((await service.query()).todos).toHaveLength(1);
  }));

  test("entered project DAG includes WorkNodes without Agenda and disappears on leave", () => fixture(async ({ project, service }) => {
    const first = createResearchCell(createResearchNotebook({ title: "Whole project DAG" }),
      { kind: "work", title: "Scheduled branch", source: "Plan the scheduled branch." });
    const second = createResearchCell(first.notebook,
      { kind: "work", title: "Research-only branch", source: "Keep this branch outside the task list." });
    const notebook = setResearchAgenda(second.notebook, first.workNode.id,
      { sche: "2026-09-16 09:00" }).notebook;
    await writeFile(join(project, "whole-project.noema"), JSON.stringify(notebook));

    const scope = await service.enter({ root: project });
    const active = await service.queryActive({ includePlanning: true });
    expect(active.todos.filter((todo: any) => todo.sourceKind === "work-node")).toHaveLength(1);
    expect(active.dag.nodes.filter((node: any) => node.sourceKind === "work-node")
      .map((node: any) => node.workNodeId).sort()).toEqual([first.workNode.id, second.workNode.id].sort());
    expect(active.dag.nodes.find((node: any) => node.workNodeId === second.workNode.id).hasAgenda).toBe(false);

    await service.leave({ id: scope.id });
    const resident = await service.queryActive({ includePlanning: true });
    expect(resident.dag.nodes.some((node: any) => node.workNodeId === first.workNode.id
      || node.workNodeId === second.workNode.id)).toBe(false);
  }));

  test("hot queries perform no parsing/evaluation; events reread only changed documents", () => fixture(async ({ knowledge, service, counts, watchers }) => {
    const file = join(knowledge, "a.md");
    await writeFile(file, task("A"));
    await writeFile(join(knowledge, "b.md"), task("B", "abc124"));
    await service.query();
    const before = counts();
    for (let i = 0; i < 20; i++) await service.query();
    expect(counts()).toEqual(before);
    await writeFile(file, task("edited"));
    watchers[0].onBatch([file]);
    const result = await service.query();
    expect(counts().parses).toBe(before.parses + 1);
    expect(result.todos.map((t: any) => t.text)).toContain("edited");
    await rm(file); watchers[0].onBatch([file]);
    expect((await service.query()).todos).toHaveLength(1);
  }));

  test("vault-contained project is a projection, without a second watch or duplicate rows", () => fixture(async ({ knowledge, service, watchers }) => {
    const sub = join(knowledge, "sub"); await mkdir(sub);
    await writeFile(join(sub, "a.md"), task("nested"));
    const scope = await service.enter({ root: sub });
    expect((await service.query({ scopes: ["knowledge", scope.id] })).todos).toHaveLength(1);
    expect(watchers).toHaveLength(1);
    expect((await service.query({ scopes: [scope.id] })).todos[0].scopeId).toBe(scope.id);
    await service.leave({ id: scope.id });
    expect(watchers[0].closed).toBe(false);
  }));

  test("explicit completion writes Markdown, preserves environment and rejects stale retries", () => fixture(async ({ knowledge, service }) => {
    const file = join(knowledge, "a.md");
    await writeFile(file, `#+begin theorem\n${task("proof")}\n#+end\n`);
    const todo = (await service.query()).todos[0];
    const request = { scopeId: "knowledge", uid: todo.uid, revision: todo.sourceRef.revision, patch: { op: "complete" } };
    await service.patch(request);
    expect(await readFile(file, "utf8")).toContain("@@todo(done)");
    expect(await readFile(file, "utf8")).toContain("#+begin theorem");
    await expect(service.patch(request)).rejects.toThrow("changed");
  }));

  test("concurrent external edits are guarded inside the serialized Markdown writer", () => fixture(async ({ knowledge, service }) => {
    const file = join(knowledge, "a.md"); await writeFile(file, task("before"));
    const todo = (await service.query()).todos[0];
    // Deliberately no notification: optimistic validation must still happen at write time.
    await writeFile(file, task("external"));
    await expect(service.patch({ scopeId: "knowledge", uid: todo.uid, revision: todo.sourceRef.revision, patch: { op: "complete" } })).rejects.toThrow("changed");
    expect(await readFile(file, "utf8")).toBe(task("external"));
  }));

  test("linked directories and ignored trees are not discovered as project roots", () => fixture(async ({ knowledge, project, service }) => {
    await writeFile(join(project, "a.md"), task("outside"));
    await symlink(project, join(knowledge, "linked"));
    await mkdir(join(knowledge, "node_modules"));
    await writeFile(join(knowledge, "node_modules", "a.md"), task("dependency"));
    expect((await service.query()).todos).toHaveLength(0);
  }));

  test("duplicate stable IDs remain distinct and cannot accidentally edit a different task", () => fixture(async ({ knowledge, service }) => {
    await writeFile(join(knowledge, "a.md"), `${task("first")}\n${task("second")}\n`);
    const snapshot = await service.query();
    expect(snapshot.todos).toHaveLength(2);
    expect(new Set(snapshot.todos.map((todo: any) => todo.uid)).size).toBe(2);
    const todo = snapshot.todos[1];
    await expect(service.patch({ scopeId: "knowledge", uid: todo.uid, revision: todo.sourceRef.revision, patch: { op: "complete" } })).rejects.toThrow("duplicated");
  }));
});

const locator = (todo: any) => ({ scopeId: todo.scopeId, uid: todo.uid, revision: todo.sourceRef.revision });

describe("scoped Agenda editing", () => {
  test("merges same-named projects, clocks, Gantt and source identities across active scopes", () => fixture(async ({ knowledge, project, service }) => {
    const content = `@@project(active) [Paper]{project: paper}
@@todo [Proof]{id: abc123, project: paper, sche: 2026-09-15, end: 2026-09-16}
@@clock [Proof]{task: #abc123, from: 2026-09-15 09:00, to: 2026-09-15 10:00}
`;
    await writeFile(join(knowledge, "a.md"), content);
    await writeFile(join(project, "a.md"), content);
    await service.enter({ root: project });
    const result = await service.queryActive({ includePlanning: true, includeGantt: true });
    expect(result.projectModel).toHaveLength(2);
    expect(new Set(result.projectModel.map((item: any) => item.key)).size).toBe(2);
    expect(result.projectModel.map((item: any) => item.sourceKey)).toEqual(["paper", "paper"]);
    expect(result.clocktable.tasks).toHaveLength(2);
    expect(result.clocktable.byDay["2026-09-15"]).toBe(120);
    expect(result.gantt.tasks).toHaveLength(2);
    expect(result.gantt.tasks.map((item: any) => item.id).sort()).toEqual(result.todos.map((item: any) => item.uid).sort());
    for (const task of result.gantt.tasks) expect(task.source).toMatchObject({ uid: task.id, revision: expect.any(String) });
  }));

  test("batch rebases its own same-file edits and refuses external revisions", () => fixture(async ({ knowledge, service }) => {
    const file = join(knowledge, "batch.md");
    await writeFile(file, "@@todo [First]\n@@todo [Second]\n");
    const original = await service.query();
    const result = await service.batch({ items: original.todos.map(locator), patch: { op: "complete" } });
    expect(result.succeeded).toBe(2);
    expect((await readFile(file, "utf8")).match(/@@todo\(done\)/g)).toHaveLength(2);
    expect((await service.batch({ items: original.todos.map(locator), patch: { status: "todo" } })).succeeded).toBe(0);
  }));

  test("capture stays inside its active scope and never writes a work document", () => fixture(async ({ knowledge, project, service }) => {
    const scope = await service.enter({ root: project });
    const created = await service.capture({ scopeId: scope.id, text: "Project capture" });
    expect(created.file).toBe(join(scope.root, "inbox.md"));
    expect(created.todo.scopeId).toBe(scope.id);
    expect(created.todo.id).toBe(created.todo.uid);
    expect((await service.query()).todos).toHaveLength(0);
    await expect(service.capture({ scopeId: scope.id, file: join(knowledge, "escape.md"), text: "bad" })).rejects.toThrow("inside");
    await expect(service.capture({ scopeId: scope.id, file: "work.noema", text: "bad" })).rejects.toThrow("Markdown");
    await service.leave({ id: scope.id });
    await expect(service.capture({ scopeId: scope.id, text: "inactive" })).rejects.toThrow("inactive");
  }));

  test("dependency ID minting preserves a neighbouring task and is scope bounded", () => fixture(async ({ project, service }) => {
    const file = join(project, "tasks.md");
    await writeFile(file, "@@todo [Target]\n@@todo [Source]\n");
    const scope = await service.enter({ root: project });
    const snapshot = await service.query({ scopes: [scope.id] });
    const source = snapshot.todos.find((todo: any) => todo.text === "Source");
    const target = snapshot.todos.find((todo: any) => todo.text === "Target");
    await service.dependency({ source: locator(source), target: locator(target) });
    const next = await service.query({ scopes: [scope.id] });
    expect(next.todos.find((todo: any) => todo.text === "Source").deps).toEqual([next.todos.find((todo: any) => todo.text === "Target").uid]);
  }));

  test("clock writes target an active project with no global scan fallback", () => fixture(async ({ knowledge, project, service }) => {
    await writeFile(join(knowledge, "a.md"), task("vault"));
    await writeFile(join(project, "a.md"), task("project"));
    const scope = await service.enter({ root: project });
    const todo = (await service.query({ scopes: [scope.id] })).todos[0];
    await service.clockIn(locator(todo));
    const snapshot = await service.queryActive({ includePlanning: true });
    const running = snapshot.clocktable.running;
    expect(running.scopeId).toBe(scope.id);
    expect(running.uid).toEqual(expect.any(String));
    await service.clockOut(running);
    expect((await service.queryActive({ includePlanning: true })).clocktable.running).toBeNull();
    expect(await readFile(join(knowledge, "a.md"), "utf8")).not.toContain("@@clock");
    await expect(service.clockOut(running)).rejects.toThrow("changed");
  }));
});


describe("Agenda source exclusions", () => {
  test("prunes Lean dependencies and all hidden descendants before parsing or handling events", () => fixture(async ({ knowledge, service, watchers, counts }) => {
    const hidden = join(knowledge, ".lake", "packages", "mathlib", ".lake", "packages", "Cli");
    await mkdir(hidden, { recursive: true });
    await writeFile(join(hidden, "README.md"), task("dependency"));
    await writeFile(join(knowledge, ".hidden.md"), task("hidden"));
    await writeFile(join(knowledge, "real.md"), task("real"));
    const snapshot = await service.query();
    expect(snapshot.todos.map((todo: any) => todo.text)).toEqual(["real"]);
    expect(snapshot.errors).toEqual([]);
    expect(counts().parses).toBe(1);
    expect(watchers[0].isRelevant(".lake/packages/mathlib/README.md")).toBe(false);
    expect(watchers[0].isDirectoryRelevant(".lake/packages")).toBe(false);
    const version = service.status().version;
    service.invalidate([join(hidden, "README.md")]);
    expect(service.status().version).toBe(version);
    expect((await service.query()).errors).toEqual([]);
  }));

  test("exclusions apply to custom files and directories, while an explicitly entered root may have hidden ancestors", () => fixture(async ({ knowledge, project, service, watchers }) => {
    await mkdir(join(knowledge, "archive"));
    await writeFile(join(knowledge, "archive", "old.md"), task("archive"));
    await writeFile(join(knowledge, "auto.generated.md"), task("generated"));
    await writeFile(join(knowledge, "scratch.md"), task("scratch"));
    await writeFile(join(knowledge, "keep.md"), task("keep"));
    expect((await service.query()).todos.map((todo: any) => todo.text)).toEqual(["keep"]);
    expect(watchers[0].isDirectoryRelevant("archive")).toBe(false);
    expect(watchers[0].isRelevant("auto.generated.md")).toBe(false);
    const nested = join(project, ".config", "emacs");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "tasks.md"), task("emacs"));
    const scope = await service.enter({ root: nested });
    expect((await service.query({ scopes: [scope.id] })).todos.map((todo: any) => todo.text)).toEqual(["emacs"]);
    await expect(service.capture({ text: "invisible", file: "scratch.md" })).rejects.toThrow("inside");
  }, { excludePatterns: ["archive/**", "**/*.generated.md", "scratch.md"] }));

  test("identical id-less tasks are not confused by batch positional shifts", () => fixture(async ({ knowledge, service }) => {
    const file = join(knowledge, "same.md");
    const content = "@@todo [Same]\n@@todo [Same]\n";
    await writeFile(file, content);
    const result = await service.batch({ items: (await service.query()).todos.map(locator), patch: { op: "complete" } });
    expect(result.succeeded).toBe(0);
    expect(await readFile(file, "utf8")).toBe(content);
  }));
});


test("a stale clock-in destination does not stop the running clock", () => fixture(async ({ knowledge, project, service }) => {
  const currentFile = join(knowledge, "current.md");
  const targetFile = join(project, "target.md");
  await writeFile(currentFile, task("Current"));
  await writeFile(targetFile, task("Target"));
  const scope = await service.enter({ root: project });
  await service.clockIn(locator((await service.query()).todos[0]));
  const target = (await service.query({ scopes: [scope.id] })).todos[0];
  // Even unrelated source text counts as a changed file revision.
  await writeFile(targetFile, `External edit\n${task("Target")}`);
  await expect(service.clockIn(locator(target))).rejects.toThrow("source changed");
  const clocks = (await service.query({ includePlanning: true })).clocks;
  expect(clocks.filter((clock: any) => clock.args.from && !clock.args.to)).toHaveLength(1);
  expect(await readFile(targetFile, "utf8")).not.toContain("@@clock");
}));


describe("Agenda literal sources and writes", () => {
  test("a moved task cannot be patched through its old identity or new code position", () => fixture(async ({knowledge, service}) => {
    const file = join(knowledge, "task.md"), raw = task("Live");
    await writeFile(file, raw);
    const original = (await service.query()).todos[0];
    const code = "```md\n" + raw + "\n```\n";
    await writeFile(file, code);
    service.invalidate([file]);
    expect((await service.query()).todos).toEqual([]);
    await expect(patchTodo({file, selectorId: original.nativeId, index: code.indexOf(raw), source: raw, op: "complete"})).rejects.toThrow("not found");
    expect(await readFile(file, "utf8")).toBe(code);
  }));

  test("capture rejects an unclosed fence before saving", () => fixture(async ({knowledge, service}) => {
    const file = join(knowledge, "inbox.md"), source = "# Inbox\n\n```md\nexample";
    await writeFile(file, source);
    await expect(service.capture({file: "inbox.md", text: "Captured"})).rejects.toThrow(/literal|code block/i);
    expect(await readFile(file, "utf8")).toBe(source);
    expect((await service.query()).todos).toEqual([]);
  }));

  test("clock examples cannot be stopped through a positional selector", () => fixture(async ({knowledge}) => {
    const file = join(knowledge, "example.md"), raw = "@@clock [Example]{from: 2026-09-16 10:00}";
    const source = "```md\n" + raw + "\n```\n";
    await writeFile(file, source);
    await expect(clockOut({file, index: source.indexOf(raw), source: raw}, {strict: true})).rejects.toThrow("no longer running");
    expect(await readFile(file, "utf8")).toBe(source);
  }));
});

describe('capture templates use the native source owner',()=>{
  test('catalog reads do not initialize scopes and capture applies defaults in the selected project',()=>fixture(async({service,project,counts})=>{
    const catalog=service.captureTemplates();
    expect(service.status().scopes).toEqual([]);
    expect(counts().parses).toBe(0);
    const scope=await service.enter({root:project});
    const result=await service.capture({templateId:'review',templateRevision:catalog.revision,scopeId:scope.id,text:'Review proof'});
    expect(result.file).toBe(join(scope.root,'reviews.md'));
    expect(result.todo).toMatchObject({text:'Review proof',canon:{prio:'A',effort:'30m',repeat:'+1w'}});
    expect(await readFile(result.file,'utf8')).toContain('@@todo [Review proof]');
    await service.leave({id:scope.id});
    await expect(service.capture({templateId:'review',templateRevision:catalog.revision,scopeId:scope.id,text:'Inactive'})).rejects.toThrow('inactive');
  },{captureTemplates:[{id:'review',name:'Review',file:'reviews.md',fields:['text'],defaults:{prio:'A',effort:'30m',repeat:'+1w'}}]}));

  test('template targets obey source exclusions before any parsing',()=>fixture(async({service,counts})=>{
    const catalog=service.captureTemplates();
    await expect(service.capture({templateId:'excluded',templateRevision:catalog.revision,scopeId:'knowledge',text:'Hidden'})).rejects.toThrow('inside');
    expect(counts().parses).toBe(0);
  },{captureTemplates:[{id:'excluded',name:'Excluded',file:'archive/inbox.md'}],excludePatterns:['archive/**']}));
});
