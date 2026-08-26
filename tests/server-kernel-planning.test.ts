import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore Server facade modules live outside the TS app graph.
import { configure, configurePlanningProvider } from "../server/lib/state.mjs";
// @ts-ignore Server facade modules live outside the TS app graph.
import { buildAgenda, buildAttributeView, getTodos } from "../server/lib/index.mjs";

const roots: string[] = [];

afterEach(async () => {
  configurePlanningProvider(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production todo/agenda kernel planning projection", () => {
  test("does not revive the canonical Node planning kernel when Go is unavailable", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "noema-required-go-planning-"));
    const notes = join(workspace, "notes");
    const file = join(notes, "project.md");
    roots.push(workspace);
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Project\n\n@@todo [Node fallback must stay retired]\n", "utf8");
    configure({ root: notes, workspaceRoot: workspace, stateRoot: join(workspace, "state"), requireGoCore: true });
    configurePlanningProvider(null);

    await expect(buildAttributeView({ file, source: "columns: text" }))
      .rejects.toMatchObject({ statusCode: 503 });
  });

  test("uses the joined Go workspace projection while retaining the host response model", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "noema-kernel-agenda-"));
    const notes = join(workspace, "notes");
    const file = join(notes, "project.md");
    roots.push(workspace);
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Project\n\n@@todo [disk parser must not win]\n\nDisk block {#0198fc34-7b32-7a11-8cb4-6c40e3b33d68 status=disk}\n", "utf8");
    configure({ root: notes, workspaceRoot: workspace, stateRoot: join(workspace, "state") });

    let singleReads = 0;
    let workspaceReads = 0;
    let evaluations = 0;
    let attributeEvaluations = 0;
    let attributeRequest: any = null;
    const node = {
      kind: "todo", status: "doing", title: "kernel-owned planning", attrs: { due: "tomorrow", project: "Noema" },
      attrsRaw: "{due: tomorrow, project: Noema}", shape: "inline",
      span: { from: 11, to: 83, line: 3, column: 1 },
      raw: "@@todo(doing) [kernel-owned planning] {due: tomorrow, project: Noema}", diagnostics: [],
    };
    configurePlanningProvider({
      owns(candidate: string) { return candidate === file; },
      async workspaceProjection({ includeProperties = false } = {}) {
        workspaceReads++;
        return { documents: [{
          file, path: "/project.md", mtimeMs: 123,
          note: { id: "project", key: "project", title: "Project", file, path: "project.md", project: "Noema", mtimeMs: 123 },
          nodes: [node],
          blocks: includeProperties ? [{
            canonicalId: "0198fc34-7b32-7a11-8cb4-6c40e3b33d68",
            line: 5, index: 48, kind: "block", text: "kernel-owned block",
            properties: { status: "draft", owner: "Go" },
          }] : [],
          duplicateDefinitionIds: [],
        }] };
      },
      async read() { singleReads++; return { file, nodes: [node] }; },
      async evaluateAgenda(todos: any[], _todayMs: number, options: any) {
        evaluations++;
        return {
          todos: todos.map((todo) => ({ id: todo.id, deps: [], effectiveStatus: todo.status, blockedBy: [], urgency: 777 })),
          lints: [{ kind: "kernel-evaluation", message: "computed by Go" }],
          gantt: options.includeGantt ? { tasks: [], backlog: [{ id: "kernel-gantt" }], milestones: [], lanes: [], lints: [{ kind: "kernel-gantt", message: "computed by Go" }] } : null,
          clocks: [],
          clocktable: options.includePlanning ? { tasks: [{ todoId: "kernel-clock" }], byDay: {}, byProject: {}, running: null } : null,
          projectModel: options.includePlanning ? [{ id: "kernel-project" }] : null,
          clockLints: options.includePlanning ? [{ kind: "kernel-clock", message: "computed by Go" }] : [],
          view: { range: { from: "2026-08-25", to: "2026-08-25", today: "2026-08-25" }, days: [{ date: "2026-08-25", entries: [{ kind: "kernel-day" }] }], logByDay: { "2026-08-25": 1 }, stats: { open: 0, doing: 1, done: 0, cancelled: 0, blocked: 0, overdue: 0 } },
        };
      },
      async evaluateAttributeView(request: any) {
        attributeEvaluations++;
        attributeRequest = request;
        return { title: "Kernel table", source: "todo", columns: [{ key: "text", label: "Task" }], rows: [{ id: "#kernel", kind: "todo", file, line: 3, cells: [{ key: "text", value: "from Go" }] }], total: 1, truncated: false, diagnostics: [] };
      },
    });

    const todos = await getTodos("");
    expect(todos).toMatchObject({ source: "scan", todos: [{ text: "kernel-owned planning", status: "doing", args: { project: "Noema" } }] });
    expect(todos.todos.some((todo: { text: string }) => todo.text === "disk parser must not win")).toBe(false);

    const agenda = await buildAgenda({ includePlanning: true, includeGantt: true, days: 2 });
    expect(agenda.todos).toMatchObject([{ text: "kernel-owned planning", status: "doing", urgency: 777 }]);
    expect(agenda.projects).toEqual([]);
    expect(agenda.evaluationSource).toBe("kernel-agenda");
    expect(agenda.lints).toEqual(expect.arrayContaining([{ kind: "kernel-evaluation", message: "computed by Go" }]));
    expect(agenda.gantt.backlog).toEqual([{ id: "kernel-gantt" }]);
    expect(agenda.clocktable.tasks).toEqual([{ todoId: "kernel-clock" }]);
    expect(agenda.projectModel).toEqual([{ id: "kernel-project" }]);
    expect(agenda.days).toEqual([{ date: "2026-08-25", entries: [{ kind: "kernel-day" }] }]);
    expect(agenda.logByDay).toEqual({ "2026-08-25": 1 });
    expect(agenda.lints).toEqual(expect.arrayContaining([{ kind: "kernel-gantt", message: "computed by Go" }]));
    expect(agenda.lints).toEqual(expect.arrayContaining([{ kind: "kernel-clock", message: "computed by Go" }]));
    expect(singleReads).toBe(0);
    expect(evaluations).toBe(1);

    const attributeView = await buildAttributeView({ title: "Kernel table", source: "columns: text" });
    expect(attributeView).toMatchObject({ evaluationSource: "kernel-attribute-view", title: "Kernel table", rows: [{ cells: [{ value: "from Go" }] }] });
    expect(attributeRequest.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "todo", text: "kernel-owned planning" }),
    ]));
    expect(attributeRequest.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "prose", text: "kernel-owned block", status: "draft", canon: { status: "draft", owner: "Go" } }),
    ]));
    expect(workspaceReads).toBeGreaterThanOrEqual(3);
    expect(attributeEvaluations).toBe(1);
  });
});
