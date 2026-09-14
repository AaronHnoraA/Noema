import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiRouter } from "../server/infrastructure/api-router.mjs";
import { createResearchApiHandlers } from "../server/Features/Research/api.mjs";
import { createKernelResearchProvider } from "../server/lib/kernel-research-provider.mjs";
import {
  createResearchCell,
  createResearchNotebook,
  createResearchNotebookService,
  deleteResearchCell,
  deleteResearchWorkNode,
  findResearchRepositoryRoot,
  parseResearchNotebook,
  readResearchNotebookFile,
  researchCellKind,
  researchGraphProjection,
  setResearchRelation,
  setResearchState,
  clearResearchOutputs,
  migrateResearchNotebookD023,
  migrateResearchNotebookFile,
  upsertResearchRunResult,
  updateResearchCell,
  validateResearchNotebook,
  writeResearchNotebookFile,
} from "../server/lib/research-notebook.mjs";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "noema-research-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function chain() {
  let notebook = createResearchNotebook({ title: "Mixing time" });
  const q = createResearchCell(notebook, { kind: "question", title: "Improve bound", source: "Can O(n log n) become O(n)?" });
  notebook = q.notebook;
  const w = createResearchCell(notebook, { kind: "work", title: "Spectral", lineageParent: q.cell.id });
  notebook = w.notebook;
  const k = createResearchCell(notebook, { kind: "checkpoint", title: "Reversibility invalid", lineageParent: w.cell.id });
  notebook = k.notebook;
  const r = createResearchCell(notebook, { kind: "work", title: "Repair", lineageParent: k.cell.id });
  notebook = r.notebook;
  const a = createResearchCell(notebook, { kind: "work", title: "Alternative", lineageParent: k.cell.id });
  notebook = a.notebook;
  return {
    notebook,
    ids: { q: q.workNode.id, w: w.workNode.id, k: k.workNode.id, r: r.workNode.id, a: a.workNode.id },
    cellIds: { q: q.cell.id, w: w.cell.id, k: k.cell.id, r: r.cell.id, a: a.cell.id },
  };
}

function meta(notebook: any, id: string) {
  return notebook.cells.find((cell: any) => cell.id === id)?.metadata?.noema_research;
}

function workNode(notebook: any, id: string) {
  return notebook.metadata.noema_research.work_nodes.find((node: any) => node.id === id);
}

describe("kernel research provider", () => {
  test("posts JSON to the kernel and maps kernel errors", async () => {
    const requests: any[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/status")) {
        return new Response(JSON.stringify({ code: -1, msg: "boom", data: null }), { status: 200 });
      }
      const data = url.endsWith("/events") ? { events: [{ seq: 2 }] }
        : url.endsWith("/cell/resolve") ? { notebookId: "nb", cellId: "c-1", path: "a.noema", revision: "sha256:1" }
          : { cells: 1 };
      return new Response(JSON.stringify({ code: 0, msg: "", data }), { status: 200 });
    };
    const provider = createKernelResearchProvider({ baseUrl: "http://127.0.0.1:9/", fetchImpl });
    expect(await provider.index({ root: "/r", path: "a.noema", actor: "emacs", reason: "sync" })).toEqual({ cells: 1 });
    expect(requests[0]).toEqual({
      url: "http://127.0.0.1:9/api/noema/research/index",
      body: { root: "/r", path: "a.noema", actor: "emacs", reason: "sync" },
    });
    expect(await provider.events({ root: "/r", notebookId: "nb" })).toEqual([{ seq: 2 }]);
	await expect(provider.resolveCell({ root: "/r", notebookId: "nb", cellId: "c-1" })).resolves.toMatchObject({ path: "a.noema" });
	expect(requests.at(-1)).toEqual({
	  url: "http://127.0.0.1:9/api/noema/research/cell/resolve",
	  body: { root: "/r", notebookId: "nb", cellId: "c-1" },
	});
    await expect(provider.status({ root: "/r", path: "a.noema" })).rejects.toMatchObject({ message: "boom", statusCode: 502 });
    expect(() => createKernelResearchProvider({ baseUrl: "" })).toThrow(/baseUrl/);
  });

  test("exposes session and history endpoints without reshaping exact fragments", async () => {
    const requests: any[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push({ url, body });
      let data: any = { id: "ses_1" };
      if (url.endsWith("/session/list")) data = { sessions: [{ id: "ses_1" }] };
      if (url.endsWith("/history/search")) data = { hits: [{ id: "hist_1", excerpt: "exact" }] };
      if (url.endsWith("/history/peek") || url.endsWith("/history/read")) data = { id: body.id, content: "exact fragment" };
      if (url.endsWith("/proposal/begin-accept")) data = { proposal: { id: "prop_1", status: "accepting", version: 2 } };
      if (url.endsWith("/corpus/search")) data = { hits: [{ blockId: "ablk_1", excerpt: "exact" }] };
      if (url.endsWith("/corpus/block/read")) data = { id: body.id, content: "exact source span" };
      if (url.endsWith("/corpus/index") || url.endsWith("/corpus/index-files")) data = { parsedFiles: 1, inferenceCalls: 0 };
      if (url.endsWith("/artifact/link/list")) data = { links: [{ workNodeId: body.workNodeId, sourceUri: "noema://file/src/a.py" }] };
      return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    };
    const provider = createKernelResearchProvider({ baseUrl: "http://127.0.0.1:9", fetchImpl });
    await expect(provider.promoteSession({ root: "/r", session: { adapter: "magent" } })).resolves.toEqual({ id: "ses_1" });
    await expect(provider.sessions({ root: "/r" })).resolves.toEqual([{ id: "ses_1" }]);
    await expect(provider.searchHistory({ root: "/r", query: "exact" })).resolves.toEqual([{ id: "hist_1", excerpt: "exact" }]);
    await expect(provider.peekHistory({ root: "/r", id: "hist_1" })).resolves.toMatchObject({ content: "exact fragment" });
    await expect(provider.readHistory({ root: "/r", id: "hist_1" })).resolves.toMatchObject({ content: "exact fragment" });
    await expect(provider.beginProposalAcceptance({ root: "/r", review: {
      proposalId: "prop_1", expectedVersion: 1, reviewedBy: "human:test",
    } })).resolves.toMatchObject({ proposal: { status: "accepting", version: 2 } });
	await expect(provider.indexArtifactCorpus({ root: "/r", index: { workstreamId: "ws_1", relativeRoot: "docs" } }))
	  .resolves.toMatchObject({ parsedFiles: 1, inferenceCalls: 0 });
	await expect(provider.indexArtifactFiles({ root: "/r", index: { workstreamId: "ws_1", paths: ["docs/a.md"] } }))
	  .resolves.toMatchObject({ parsedFiles: 1 });
	await expect(provider.searchArtifactBlocks({ root: "/r", search: { workstreamId: "ws_1", query: "exact" } }))
	  .resolves.toEqual([{ blockId: "ablk_1", excerpt: "exact" }]);
	await expect(provider.readArtifactBlock({ root: "/r", id: "ablk_1" })).resolves.toMatchObject({ content: "exact source span" });
    await expect(provider.artifactLinks({ root: "/r", workNodeId: "wn_1" }))
      .resolves.toEqual([{ workNodeId: "wn_1", sourceUri: "noema://file/src/a.py" }]);
    expect(requests.map(({ url }) => url.replace("http://127.0.0.1:9/api/noema/research/", ""))).toEqual([
	  "session/promote", "session/list", "history/search", "history/peek", "history/read", "proposal/begin-accept",
	  "corpus/index", "corpus/index-files", "corpus/search", "corpus/block/read", "artifact/link/list",
    ]);
  });
});

describe("research notebook model", () => {
  test("validates document default agents", () => {
    expect(createResearchNotebook({ defaultAgent: "opencode" }).metadata.noema_research.default_agent).toBe("opencode");
    expect(() => createResearchNotebook({ defaultAgent: "bad agent" })).toThrow(/Invalid default agent/);
    const invalid = createResearchNotebook();
    invalid.metadata.noema_research.default_agent = "bad agent";
    expect(validateResearchNotebook(invalid).errors.map((entry: any) => entry.code)).toContain("default-agent");
  });

  test("deterministically migrates legacy cell-owned graph metadata", () => {
    const legacy = {
      cells: [
        { cell_type: "markdown", id: "c-q", metadata: { noema_research: { kind: "question", title: "Q" } }, source: "Why?" },
        { cell_type: "markdown", id: "c-w", metadata: { noema_research: {
          kind: "work", title: "Try", state: "active", lineage: ["c-q"], depends: ["c-q"],
        } }, source: "Do it" },
        { cell_type: "markdown", id: "c-r", metadata: { noema_research: {
          kind: "result", of: "c-w", run_id: "run_old",
        } }, source: "Done" },
      ],
      metadata: { noema_research: {
        schema: "noema.research-notebook/1", notebook_id: "nb_legacy", workstream_id: "ws_legacy", title: "Legacy",
      } },
      nbformat: 4, nbformat_minor: 5,
    };
    const first = parseResearchNotebook(JSON.stringify(legacy));
    const second = parseResearchNotebook(JSON.stringify(legacy));
    expect(first.metadata.noema_research.schema).toBe("noema.work-document/2");
    expect(first.metadata.noema_research.work_nodes).toEqual(second.metadata.noema_research.work_nodes);
    expect(first.metadata.noema_research.dependencies).toEqual(second.metadata.noema_research.dependencies);
    const work = first.metadata.noema_research.work_nodes.find((node: any) => node.kind === "work");
    expect(work).toMatchObject({ title: "Try", state: "active" });
    expect(meta(first, "c-w")).toEqual({ work_node_id: work.id });
    expect(first.cells.some((cell: any) => cell.id === "c-r")).toBe(false);
    const workCell = first.cells.find((cell: any) => cell.id === "c-w");
    expect(workCell).toMatchObject({ cell_type: "code", execution_count: null });
    expect(workCell.outputs[0].data["application/vnd.noema.run+json"]).toMatchObject({ run_id: "run_old" });
    expect(meta(first, "c-w").lineage).toBeUndefined();
    expect(validateResearchNotebook(first).ok).toBe(true);
  });

  test("creates standard nbformat notebooks outside the sidecar namespace", () => {
    const { notebook, ids, cellIds } = chain();
    const parsed = parseResearchNotebook(JSON.stringify(notebook));
    expect(parsed.metadata.noema).toBeUndefined();
    expect(parsed.metadata.noema_research.schema).toBe("noema.work-document/2");
    expect(parsed.nbformat_minor).toBe(5);
    expect(parsed.metadata.kernelspec).toBeUndefined();
    expect(parsed.metadata.language_info).toBeUndefined();
    expect(parsed.cells.find((cell: any) => cell.id === cellIds.w)).toMatchObject({
      cell_type: "code", execution_count: null, outputs: [],
    });
    expect(parsed.cells.map((cell: any) => cell.id)).toContain(cellIds.w);
    for (const cell of notebook.cells) expect(cell.id).toMatch(/^c-[0-9a-f]{12}$/);
    expect(meta(notebook, cellIds.w)).toEqual({ work_node_id: ids.w });
    expect(workNode(notebook, ids.w)).toMatchObject({ kind: "work", state: "open" });
    expect(notebook.metadata.noema_research.dependencies).toContainEqual(expect.objectContaining({ from: ids.q, to: ids.w, type: "lineage" }));
    expect(validateResearchNotebook(notebook)).toMatchObject({ ok: true, errors: [] });
    expect(() => parseResearchNotebook(JSON.stringify({
      cells: [], metadata: { noema: { source_file: "note.md" } }, nbformat: 4, nbformat_minor: 5,
    }))).toThrow(/research notebook/);
  });

  test("work storage is not a programming-language cell", () => {
    const { notebook, ids } = chain();
    expect(() => createResearchCell(notebook, { kind: "code", source: "print('evidence')", workNodeId: ids.w }))
      .toThrow(/Unsupported cell kind/);
    const raw = notebook.cells.find((cell: any) => meta(notebook, cell.id)?.work_node_id === ids.w);
    raw.metadata.noema_research.kind = "work";
    expect(researchCellKind(raw, notebook)).toBe("work");
    expect(validateResearchNotebook(notebook).errors).toContainEqual(expect.objectContaining({
      code: "cell-graph-metadata", cellId: raw.id,
    }));
    delete raw.metadata.noema_research.kind;
    expect(validateResearchNotebook(notebook)).toMatchObject({ ok: true, errors: [] });
  });

  test("renaming a cell keeps every edge that references it", () => {
    const { notebook, ids, cellIds } = chain();
    const renamed = updateResearchCell(notebook, cellIds.w, { title: "Spectral proof route" }).notebook;
    const projection = researchGraphProjection(renamed);
    expect(projection.nodes.find((node: any) => node.id === ids.w)?.title).toBe("Spectral proof route");
    expect(projection.edges).toContainEqual({ from: ids.q, to: ids.w, type: "lineage" });
    expect(projection.edges).toContainEqual({ from: ids.w, to: ids.k, type: "lineage" });
  });

  test("the combined WorkNode dependency graph stays acyclic", () => {
    const { notebook, ids } = chain();
    const dependent = setResearchRelation(notebook, ids.r, "depends", [ids.a]).notebook;
    expect(() => setResearchRelation(dependent, ids.a, "depends", [ids.r])).toThrow(/cycle/);
    expect(() => setResearchRelation(notebook, ids.q, "depends", [ids.q])).toThrow(/own WorkNode/);
    expect(() => setResearchRelation(notebook, ids.q, "lineage", [ids.r])).toThrow(/cycle/);
  });

  test("Cell and WorkNode have independent identity and deletion", () => {
    const { notebook, ids, cellIds } = chain();
    const withResult = upsertResearchRunResult(notebook, {
      workId: ids.w, runId: "run_delete", status: "completed", content: "done",
    }).notebook;
    const dependent = setResearchRelation(withResult, ids.r, "depends", [ids.w]).notebook;
    const detached = deleteResearchCell(dependent, cellIds.w);
    expect(detached.removed).toEqual([cellIds.w]);
    expect(detached.orphanedWorkNodeIds).toEqual([ids.w]);
    expect(workNode(detached.notebook, ids.w)).toBeTruthy();
    expect(researchGraphProjection(detached.notebook).edges).toContainEqual({ from: ids.w, to: ids.k, type: "lineage" });
    expect(researchGraphProjection(detached.notebook).nodes.find((node: any) => node.id === ids.w))
      .toMatchObject({ cellId: null, orphaned: true });

    const removed = deleteResearchWorkNode(detached.notebook, ids.w);
    expect(removed.removedWorkNodeId).toBe(ids.w);
    expect(removed.removedCells).toHaveLength(0);
    expect(workNode(removed.notebook, ids.w)).toBeUndefined();
    expect(researchGraphProjection(removed.notebook).edges.some((edge: any) => edge.from === ids.w || edge.to === ids.w)).toBe(false);
  });

  test("work state, outcome and drop reasons are validated", () => {
    const { notebook, ids } = chain();
    const dropped = setResearchState(notebook, ids.w, { state: "dropped", reason: "uniform gap unavailable" }).notebook;
    expect(workNode(dropped, ids.w)).toMatchObject({ state: "dropped", dropped_reason: "uniform gap unavailable" });
    const reopened = setResearchState(dropped, ids.w, { state: "active", outcome: "inconclusive" }).notebook;
    expect(workNode(reopened, ids.w).dropped_reason).toBeUndefined();
    expect(workNode(reopened, ids.w).outcome).toBe("inconclusive");
    expect(() => setResearchState(notebook, ids.q, { state: "done" })).toThrow(/work WorkNodes/);
    expect(() => setResearchState(notebook, ids.w, { state: "finished" })).toThrow(/Unsupported/);
  });

  test("terminal runs replace the bound work output without creating Result cells", () => {
    const { notebook, ids } = chain();
    const first = upsertResearchRunResult(notebook, {
      workId: ids.w, runId: "run_0199", status: "completed", content: "The gap is real.",
    }).notebook;
    const result = first.cells.find((cell: any) => meta(first, cell.id)?.work_node_id === ids.w);
    expect(result).toMatchObject({ cell_type: "code", execution_count: null });
    expect(result.outputs[0].data["text/markdown"]).toContain("The gap is real.");
    expect(result.outputs[0].data["application/vnd.noema.run+json"]).toMatchObject({ run_id: "run_0199" });
    expect(first.cells.some((cell: any) => meta(first, cell.id)?.kind === "result")).toBe(false);
    const replaced = upsertResearchRunResult(first, {
      workId: ids.w, runId: "run_0199", status: "completed", content: "The gap is quantified.",
    }).notebook;
    const latest = replaced.cells.find((cell: any) => cell.id === result.id);
    expect(latest.outputs).toHaveLength(1);
    expect(latest.outputs[0].data["text/markdown"]).toContain("quantified");
    const cleared = clearResearchOutputs(replaced, { cellId: result.id });
    expect(cleared.notebook.cells.find((cell: any) => cell.id === result.id).outputs).toEqual([]);
  });

  test("folding contracts only the exclusive subtree and protects the focus path", () => {
    const { notebook, ids } = chain();
    const side = createResearchCell(notebook, { kind: "work", title: "Numerics", lineageParent: ids.q });
    const graph = setResearchRelation(side.notebook, ids.r, "depends", [side.cell.id]).notebook;

    const folded = researchGraphProjection(graph, { folds: [ids.w] });
    const visible = folded.nodes.map((node: any) => node.id);
    expect(visible).toEqual(expect.arrayContaining([ids.q, ids.w, side.workNode.id]));
    expect(visible).not.toContain(ids.k);
    expect(folded.nodes.find((node: any) => node.id === ids.w)?.folded).toMatchObject({ hidden: 3 });
    expect(folded.edges).toContainEqual({ from: side.workNode.id, to: ids.w, type: "depends" });

    const focused = researchGraphProjection(graph, { folds: [ids.w], focus: ids.r });
    const lens = focused.nodes.map((node: any) => node.id);
    expect(lens).toEqual(expect.arrayContaining([ids.q, ids.w, ids.k, ids.r]));
    expect(lens).not.toContain(ids.a);
    expect(focused.focus).toBe(ids.r);
  });

  test("validation separates warnings from errors", () => {
    const { notebook, ids } = chain();
    const broken = structuredClone(notebook);
    broken.metadata.noema_research.dependencies.push({ id: "dep_bad", from: "wn_missing", to: ids.w, type: "lineage" });
    broken.cells.push({ cell_type: "markdown", id: "c-r-1", metadata: { noema_research: { kind: "result", work_node_id: ids.q } }, source: "" });
    const report = validateResearchNotebook(broken);
    expect(report.warnings.map((entry: any) => entry.code)).toContain("dangling-relation");
    expect(report.errors.map((entry: any) => entry.code)).toContain("cell-graph-metadata");
    expect(report.ok).toBe(false);
  });

  test("D-023 migration extracts programming code and is idempotent", () => {
    const { notebook, ids, cellIds } = chain();
    notebook.metadata.kernelspec = { name: "python3" };
    notebook.metadata.language_info = { name: "python" };
    const prompt = notebook.cells.find((cell: any) => cell.id === cellIds.w);
    prompt.cell_type = "markdown";
    delete prompt.execution_count;
    delete prompt.outputs;
    notebook.cells.splice(notebook.cells.indexOf(prompt) + 1, 0, {
      cell_type: "code", id: "c-demo-scaling", execution_count: 1,
      metadata: { noema_research: { work_node_id: ids.w } }, outputs: [{ output_type: "stream", text: "ok" }],
      source: "print('scale')\n",
    });
    const migrated = migrateResearchNotebookD023(notebook);
    expect(migrated.validation.ok).toBe(true);
    expect(migrated.extractions).toEqual([expect.objectContaining({ path: "experiments/scaling.py", source: "print('scale')\n" })]);
    expect(migrated.notebook.metadata.kernelspec).toBeUndefined();
    expect(migrated.notebook.cells.find((cell: any) => cell.id === cellIds.w)).toMatchObject({ cell_type: "code", outputs: [] });
    expect(migrated.notebook.cells.find((cell: any) => cell.id === "c-demo-scaling").metadata.noema).toBeUndefined();
    const second = migrateResearchNotebookD023(migrated.notebook);
    expect(second.changed).toBe(false);
    expect(second.extractions).toEqual([]);
  });
});

describe("research notebook files", () => {
  test("explicitly persists a kernel-free legacy document exactly once", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "legacy.noema");
      const legacy = {
        cells: [
          { cell_type: "markdown", id: "c-work", metadata: { noema_research: {
            kind: "work", title: "Legacy work",
          } }, source: "Do the work." },
          { cell_type: "markdown", id: "c-result", metadata: { noema_research: {
            kind: "result", of: "c-work", run_id: "run_legacy",
          } }, source: "Legacy answer." },
        ],
        metadata: { noema_research: {
          schema: "noema.research-notebook/1", notebook_id: "nb_legacy_file",
          workstream_id: "ws_legacy_file", title: "Legacy file",
        } },
        nbformat: 4, nbformat_minor: 5,
      };
      const original = `${JSON.stringify(legacy, null, 2)}\n`;
      await writeFile(file, original);

      const first = await migrateResearchNotebookFile(file);
      expect(first).toMatchObject({ migrated: true, backup: `${file}.pre-d023.bak`, extractions: [] });
      expect(await readFile(`${file}.pre-d023.bak`, "utf8")).toBe(original);
      const persisted = JSON.parse(await readFile(file, "utf8"));
      expect(persisted.metadata.noema_research.schema).toBe("noema.work-document/2");
      expect(persisted.cells).toHaveLength(1);
      expect(persisted.cells[0]).toMatchObject({ cell_type: "code", execution_count: null });
      expect(persisted.cells[0].outputs[0].data["application/vnd.noema.run+json"].run_id).toBe("run_legacy");

      const second = await migrateResearchNotebookFile(file);
      expect(second).toMatchObject({ migrated: false, backup: null, extractions: [] });
    });
  });

  test("atomic writes detect revision conflicts and keep unknown metadata", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "research", "bound.noema");
      const { notebook } = chain();
      notebook.cells[0].metadata.custom = { kept: true };
      const written = await writeResearchNotebookFile(file, notebook, { create: true });
      await expect(writeResearchNotebookFile(file, notebook, { create: true })).rejects.toMatchObject({ statusCode: 409 });
      const loaded = await readResearchNotebookFile(file);
      expect(loaded.revision).toBe(written.revision);
      expect(loaded.notebook.cells[0].metadata.custom).toEqual({ kept: true });
      expect((await readFile(file, "utf8")).endsWith("\n")).toBe(true);

      await writeFile(file, (await readFile(file, "utf8")).replace("Improve bound", "Changed elsewhere"), "utf8");
      await expect(writeResearchNotebookFile(file, loaded.notebook, { expectedRevision: loaded.revision }))
        .rejects.toMatchObject({ statusCode: 409, code: "ERR_RESEARCH_REVISION" });

      const invalid = structuredClone(loaded.notebook);
      invalid.metadata.noema_research.work_nodes[0].kind = "task";
      await expect(writeResearchNotebookFile(file, invalid)).rejects.toMatchObject({ statusCode: 422 });
      await expect(readResearchNotebookFile(join(dir, "missing.noema"))).rejects.toMatchObject({ statusCode: 404 });
      await expect(readResearchNotebookFile(join(dir, "ordinary.ipynb"))).rejects.toMatchObject({
        statusCode: 400, code: "ERR_RESEARCH_PATH",
      });
    });
  });

  test("the service writes, indexes, and reconciles stale indexes", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "noema.toml"), "schema = 1\nrepository_id = \"019fb75f-96ce-733d-8d29-0e1555a1cba6\"\n");
      const calls: any[] = [];
      let stale = false;
      const indexer = {
        index: async (args: any) => {
          calls.push(["index", args]);
          return { cells: 0 };
        },
        status: async (args: any) => {
          calls.push(["status", args]);
          return { stale };
        },
        events: async (args: any) => {
          calls.push(["events", args]);
          return [{ seq: 1 }];
        },
      };
      const service = createResearchNotebookService({ getIndexer: () => indexer });
      const file = join(dir, "research", "bound.noema");

      const created = await service.create({ file, title: "Bound", defaultAgent: "opencode" });
      expect(created.root).toBe(dir);
      expect(created.notebook.metadata.noema_research.default_agent).toBe("opencode");
      expect(calls[0]).toEqual(["index", { root: dir, path: "research/bound.noema", actor: "node", reason: "notebook.create" }]);

      const cell = await service.createCell({ file, kind: "question", title: "Q", expectedRevision: created.revision, actor: "emacs" });
      expect(cell.cell.kind).toBe("question");
      expect(calls.at(-1)).toEqual(["index", { root: dir, path: "research/bound.noema", actor: "emacs", reason: "cell.create" }]);
      await expect(service.updateCell({ file, cellId: cell.cell.id, patch: { title: "Q2" }, expectedRevision: created.revision }))
        .rejects.toMatchObject({ statusCode: 409 });

      stale = true;
      const snapshot = await service.snapshot({ file });
      expect(calls.at(-1)?.[1]?.reason).toBe("reconcile");
      expect(snapshot.projection.nodes).toHaveLength(1);
      expect(snapshot.cells[0]).toMatchObject({ kind: "question", title: "Q" });

      const events = await service.events({ file, after: 3 });
      expect(events.events).toEqual([{ seq: 1 }]);
      expect(calls.at(-1)?.[1]).toMatchObject({ root: dir, after: 3, limit: 200 });
    });
  });

  test("index failures never lose a write, and read-only hosts refuse writes", async () => {
    await withTempDir(async (dir) => {
      const service = createResearchNotebookService({
        getIndexer: () => ({
          index: async () => {
            throw new Error("kernel down");
          },
          status: async () => ({ stale: false }),
          events: async () => [],
        }),
      });
      const file = join(dir, "n.noema");
      const created = await service.create({ file, title: "N" });
      expect(created.indexError).toBe("kernel down");
      expect((await readResearchNotebookFile(file)).notebook.metadata.noema_research.title).toBe("N");

      const router = new ApiRouter().register(createResearchApiHandlers(service), "research");
      const snapshot = await router.call("aaronnote:api:research:notebook:snapshot", [{ file }]);
      expect(snapshot).toMatchObject({ type: "research", ok: true, revision: created.revision });

      const readOnly = new ApiRouter().register(createResearchApiHandlers(createResearchNotebookService({ allowWrite: false })));
      await expect(readOnly.call("aaronnote:api:research:cell:create", [{ file, kind: "work" }])).rejects.toMatchObject({ statusCode: 403 });
      await expect(router.call("aaronnote:api:research:notebook:snapshot", [{ file: "relative.noema" }])).rejects.toMatchObject({ statusCode: 400 });
      expect(await findResearchRepositoryRoot(file)).toBeNull();
    });
  });
});
