import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createResearchNotebook, createResearchCell, setResearchAgenda, setResearchRelation, setResearchState,
  researchWorkNodeSummary, validateResearchNotebook, createResearchNotebookService,
  writeResearchNotebookFile } from "../server/lib/research-notebook.mjs";
import { workAgendaPlanning, validateWorkAgenda, validateWorkClocks } from "../shared/work-agenda.mjs";
import { extractWorkAgendaDirective } from "../shared/work-agenda.mjs";
// @ts-ignore Native Node evaluator boundary.
import { resolveClockRefs, buildClockModel } from "../server/lib/runtime.mjs";

function fixture() {
  const first = createResearchCell(createResearchNotebook({ title: "DAG Agenda" }), { kind: "work", title: "Proof", source: "@@agent(codex)\nExplore the proof." });
  const second = createResearchCell(first.notebook, { kind: "checkpoint", title: "Review", lineageParent: first.workNode.id });
  let notebook = setResearchAgenda(second.notebook, first.workNode.id, { sche: "2026-09-15 09:00", prio: "A" }).notebook;
  notebook = setResearchAgenda(notebook, second.workNode.id, {}).notebook;
  notebook.cells[0].outputs = [{ output_type: "stream", name: "stdout", text: "@@todo [This is data]\n@@agenda malicious" }];
  return { notebook, first: first.workNode.id, second: second.workNode.id };
}

describe("native WorkNode Agenda", () => {
  test("native clock attribution survives renaming and never falls back to a title or another file", () => {
    let { notebook, first } = fixture();
    notebook = setResearchAgenda(notebook, first, { clocks: [{ id: "closed", from: "2026-09-16 09:00", to: "2026-09-16 10:15" }] }).notebook;
    const file = "/project/work.noema";
    const planning = workAgendaPlanning(notebook, { file });
    planning.todos[0].text = "Renamed";
    planning.todos[1].text = "Proof";
    const clocks = [...planning.clocks, { ...planning.clocks[0], nativeTodoId: "missing" }, { ...planning.clocks[0], file: "/other/work.noema" }];
    const result = resolveClockRefs(clocks, planning.todos);
    expect(clocks.map((clock: any) => clock.todoId)).toEqual([`${file}#${first}`, "", ""]);
    expect(result.lints.filter((lint: any) => lint.kind === "broken-clock-ref")).toHaveLength(2);
    expect(buildClockModel(clocks, planning.todos, []).tasks.find((task: any) => task.todoId === `${file}#${first}`).minutes).toBe(75);
  });
  test("clock history and progress preserve node state, DAG, prompts, outputs and input ownership", () => {
    const { notebook, first } = fixture();
    const before = structuredClone(notebook);
    const started = setResearchAgenda(notebook, first, { op: "clock-in", clockId: "session_1", at: "2026-09-16 09:00" }).notebook;
    expect(() => setResearchAgenda(started, first, null)).toThrow("Stop the running clock");
    expect(() => setResearchAgenda(started, first, { op: "clock-in" })).toThrow("already has a running clock");
    expect(() => setResearchAgenda(started, first, { op: "clock-out", clockId: "session_1", at: "2026-09-16 08:00" })).toThrow("at or after");
    const stopped = setResearchAgenda(started, first, { op: "clock-out", clockId: "session_1", at: "2026-09-16 10:15" }).notebook;
    const updated = setResearchAgenda(stopped, first, { progress: 37.5 }).notebook;
    const node = updated.metadata.noema_research.work_nodes[0];
    const agenda = researchWorkNodeSummary(updated, first).agenda;
    expect(node.agenda).toBeUndefined();
    expect(agenda).toMatchObject({ progress: "37.5", clocks: [{ id: "session_1", from: "2026-09-16 09:00", to: "2026-09-16 10:15" }] });
    expect(node.state).toBe(before.metadata.noema_research.work_nodes[0].state);
    expect(updated.cells[0].outputs).toEqual(before.cells[0].outputs);
    expect(updated.cells[0].metadata).toEqual(before.cells[0].metadata);
    expect(updated.cells[0].source).toContain("@@clock [Proof]");
    expect(updated.cells[0].source).toContain("id=session_1");
    expect(updated.metadata.noema_research.dependencies).toEqual(before.metadata.noema_research.dependencies);
    expect(notebook).toEqual(before);
    expect(setResearchAgenda(updated, first, { op: "complete" }).workNode.agenda?.clocks).toEqual(agenda!.clocks);
    expect(() => setResearchAgenda(stopped, first, { op: "clock-out", clockId: "session_1" })).toThrow("no longer running");
  });
  test("clock metadata rejects invalid times, duplicate IDs and multiple open intervals", () => {
    const clock = { id: "one", from: "2026-09-16 09:00" };
    for (const value of [null, {}, [null], [{}], [clock, clock], [clock, { ...clock, id: "two" }],
      [{ ...clock, id: "bad/id" }], [{ ...clock, from: "2026-02-30 09:00" }], [{ ...clock, from: "2026-09-16" }],
      [{ ...clock, to: null }], [{ ...clock, to: "2026-09-16 08:00" }], [{ ...clock, extra: true }]]) {
      expect(validateWorkClocks(value).length).toBeGreaterThan(0);
    }
    expect(validateWorkClocks([{ ...clock, to: clock.from }, { ...clock, id: "two" }])).toEqual([]);
    for (const progress of ["-1", "101", "NaN", "1e2", 30]) expect(validateWorkAgenda({ progress }, "work").length).toBeGreaterThan(0);
    expect(validateWorkAgenda({ progress: "37.5", clocks: [] }, "work")).toEqual([]);
  });
  test("only a WorkNode with a primary Cell and visible directive becomes a task; outputs never become tasks", () => {
    const { notebook, first, second } = fixture();
    const extra = structuredClone(notebook.cells[0]); extra.id = "another-cell";
    notebook.cells.push(extra);
    notebook.cells = notebook.cells.filter((cell: any) => cell.metadata.noema_research.work_node_id !== second);
    const planning = workAgendaPlanning(notebook, { file: "/project/work.noema" });
    expect(planning.todos).toHaveLength(1);
    expect(planning.todos[0].cellIds).toHaveLength(2);
    expect(planning.todos.map((t: any) => t.workNodeId)).toEqual([first]);
    expect(planning.dag.nodes.map((node: any) => node.workNodeId)).toEqual([first, second]);
    expect(planning.dag.edges).toEqual([expect.objectContaining({
      from: `/project/work.noema#${first}`,
      to: `/project/work.noema#${second}`,
      type: "lineage",
    })]);
    expect(validateResearchNotebook(notebook).errors).toEqual([]);
  });
  test("lineage does not block; depends requires completion and a dropped parent stays unresolved", () => {
    let { notebook, first, second } = fixture();
    const project = () => workAgendaPlanning(notebook, { file: "/project/work.noema" }).todos;
    expect(project()[1].status).toBe("todo");
    notebook = setResearchRelation(notebook, second, "depends", [first]).notebook;
    expect(project()[1].status).toBe("blocked");
    notebook = setResearchState(notebook, first, { state: "dropped", outcome: "dead_end" }).notebook;
    expect(project()[1].nativeBlockedBy).toEqual([first]);
    notebook = setResearchState(notebook, first, { state: "done", outcome: "refuted" }).notebook;
    expect(project()[1].status).toBe("todo");
  });
  test("completion preserves DAG, all prompts, outputs and the scientific outcome", () => {
    const { notebook, first } = fixture();
    const before = structuredClone(notebook);
    const next = setResearchAgenda(notebook, first, { op: "complete" }).notebook;
    expect(next.cells[0].outputs).toEqual(before.cells[0].outputs);
    expect(next.cells[0].source).toContain("done: 2026-09-16");
    expect(next.metadata.noema_research.dependencies).toEqual(before.metadata.noema_research.dependencies);
    expect(next.metadata.noema_research.work_nodes[0].state).toBe("done");
    expect(researchWorkNodeSummary(next, first).agenda?.prio).toBe("A");
    expect(notebook).toEqual(before);
    const removed = setResearchAgenda(next, first, null).notebook;
    expect(removed.metadata.noema_research.work_nodes[0].agenda).toBeUndefined();
    expect(extractWorkAgendaDirective(removed.cells[0].source)).toBeNull();
    expect(removed.cells[0].source).toContain("@@agent(codex)");
  });
  test("question/checkpoint planning state is separate from work state", () => {
    const { notebook, second } = fixture();
    const next = setResearchAgenda(notebook, second, { op: "complete" }).notebook;
    expect(researchWorkNodeSummary(next, second).agenda?.status).toBe("done");
    expect(next.metadata.noema_research.work_nodes[1].state).toBeUndefined();
    expect(validateResearchNotebook(next).errors).toEqual([]);
  });
  test("rejects unsupported metadata and conflicting task state", () => {
    for (const agenda of [null, [], { sche: "yesterday" }, { prio: "urgent" }, { effort: "nonsense" }, { status: "done" }, { repeat: "+1d" }, { agent: "codex" }]) {
      expect(validateWorkAgenda(agenda, "work").length).toBeGreaterThan(0);
    }
    expect(validateWorkAgenda({ effort: "0m", sche: "2026-09-15", project: "Proof" }, "work")).toEqual([]);
  });
  test("host mutation is serialized with document saves and uses the source revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-work-agenda-"));
    try {
      const file = join(root, "work.noema");
      const { notebook, first } = fixture();
      const original = await writeResearchNotebookFile(file, notebook, { create: true });
      const service = createResearchNotebookService();
      const updated = await service.setAgenda({ file, workNodeId: first, expectedRevision: original.revision, patch: { ddl: "2026-09-20" } });
      expect(updated.workNode.agenda.ddl).toBe("2026-09-20");
      await expect(service.setAgenda({ file, workNodeId: first, expectedRevision: original.revision, patch: { op: "complete" } })).rejects.toMatchObject({ statusCode: 409 });
      const disk = JSON.parse(await readFile(file, "utf8"));
      expect(disk.cells[0].source).toContain("ddl: 2026-09-20");
      expect(disk.cells[0].outputs).toEqual(notebook.cells[0].outputs);
      expect(disk.metadata.noema_research.work_nodes[0].agenda).toBeUndefined();
      expect(disk.metadata.noema_research.dependencies).toEqual(notebook.metadata.noema_research.dependencies);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
