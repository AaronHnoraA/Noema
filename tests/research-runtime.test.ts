import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchApiHandlers } from "../server/Features/Research/api.mjs";
import {
  createResearchRuntimeService,
  defaultResearchHistorySources,
  findResearchProjectRoot,
  manualTUICommand,
  parseResearchPrompt,
} from "../server/lib/research-runtime.mjs";
import { createResearchCell, createResearchNotebook, createResearchNotebookService, readResearchNotebookFile, writeResearchNotebookFile } from "../server/lib/research-notebook.mjs";

async function withProject<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "noema-runtime-"));
  try {
    await writeFile(join(root, "noema.toml"), "schema = 1\nrepository_id = \"0199\"\n");
    await mkdir(join(root, "nested"));
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function installProjectSkill(root: string, id: string): Promise<void> {
  const directory = join(root, ".agents", "skills", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `# ${id}\n\nUse the project method.\n`);
}

describe("research runtime service", () => {
  test("promotes a native session against the containing Noema repository", async () => withProject(async (root) => {
    const provider = {
      promoteSession: vi.fn(async ({ session }) => ({ id: "ses_1", ...session })),
      sessions: vi.fn(async () => [{ id: "ses_1" }]),
      session: vi.fn(async () => ({ id: "ses_1" })),
      indexHistory: vi.fn(async () => ({ records: 3, sources: [] })),
      searchHistory: vi.fn(async () => [{ id: "hist_1" }]),
      peekHistory: vi.fn(async () => ({ id: "hist_1", content: "short" })),
      readHistory: vi.fn(async () => ({ id: "hist_1", content: "full" })),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const promoted = await service.promoteSession({
      cwd: join(root, "nested"), agent: "codex", native_session_id: "native-1", title: "Existing work",
      startedAt: "2026-09-12T01:00:00Z", capabilities: { resume: true },
    });
    expect(promoted).toMatchObject({ id: "ses_1", adapter: "codex", nativeSessionId: "native-1" });
    expect(provider.promoteSession).toHaveBeenCalledWith({
      root,
      session: expect.objectContaining({
        adapter: "codex", transport: "acp", nativeSessionId: "native-1",
        executionTarget: join(root, "nested"), startedAt: "2026-09-12T01:00:00Z",
      }),
    });
    await expect(service.sessions({ root })).resolves.toEqual({ root, sessions: [{ id: "ses_1" }] });
    await expect(service.searchHistory({ root, query: "bound", source: "codex" })).resolves.toEqual({ root, hits: [{ id: "hist_1" }] });
    expect(provider.searchHistory).toHaveBeenCalledWith({ root, query: "bound", projectRoot: root, source: "codex", limit: 20 });
    await expect(service.peekHistory({ root, id: "hist_1" })).resolves.toMatchObject({ record: { content: "short" } });
    await expect(service.readHistory({ root, id: "hist_1" })).resolves.toMatchObject({ record: { content: "full" } });
  }));

  test("freezes declared context and routes a work-cell Run deterministically", async () => withProject(async (root) => {
    const researchDir = join(root, "research");
    const notesDir = join(root, "notes");
    await mkdir(researchDir);
    await mkdir(notesDir);
    await installProjectSkill(root, "proof-review");
    await writeFile(join(notesDir, "known.md"), "Known lemma.\n");
    let notebook = createResearchNotebook({ title: "Bound" });
    const question = createResearchCell(notebook, { kind: "question", title: "Question", source: "Can this be improved?" });
    notebook = question.notebook;
    const work = createResearchCell(notebook, { kind: "work", title: "Attempt", source: "Try the spectral route.", lineageParent: question.cell.id });
    notebook = work.notebook;
    const workCell = notebook.cells.find((cell: any) => cell.id === work.cell.id);
    workCell.metadata.noema_research.context = ["lineage", "file:notes/known.md"];
    workCell.metadata.noema_research.executor = { agent: "codex", skills: ["proof-review"], capabilities: { network: "deny" } };
    const file = join(researchDir, "bound.noema");
    await writeResearchNotebookFile(file, notebook, { create: true });
    const provider = {
      sessions: vi.fn(async () => [{ id: "ses_warm", state: "warm", executionTarget: root }]),
      prepareRun: vi.fn(async ({ run }) => ({ id: "run_1", ...run })),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const prepared = await service.prepareRun({ file, cellId: work.cell.id, cwd: root });
    expect(prepared.run).toMatchObject({
      id: "run_1", sessionId: "ses_warm", sourceKind: "work-cell", workNodeId: work.workNode.id,
    });
    expect(prepared.routing).toMatchObject({ mode: "continued", policy: "continue", sessionId: "ses_warm" });
    expect(prepared.spec).toMatchObject({
      schema: "noema.run-spec/1", project_id: "0199",
      agent: { id: "codex", transport: "acp", command: "codex-acp", version: "unknown" }, session_policy: "continue",
      source: { notebook_id: notebook.metadata.noema_research.notebook_id, cell_id: work.cell.id, work_node_id: work.workNode.id },
      capabilities: {
        read_project: "allow", write_project: "ask", execute: "ask", network: "deny",
        write_outside_project: "deny", credentials: "deny",
      },
      skills: [expect.objectContaining({ id: "proof-review", path: ".agents/skills/proof-review/SKILL.md" })],
    });
    expect(prepared.spec.context).toHaveLength(3);
    expect(prepared.spec.context.map((item: any) => item.ref)).toEqual([`cell:${question.cell.id}`, "file:notes/known.md", "skill:proof-review"]);
    expect(Buffer.from(prepared.contextItems[1].contentBase64, "base64").toString("utf8")).toBe("Known lemma.\n");
    expect(provider.prepareRun).toHaveBeenCalledWith({
      root,
      run: expect.objectContaining({
        workstreamId: notebook.metadata.noema_research.workstream_id,
        sessionId: "ses_warm",
        workNodeId: work.workNode.id,
        contextItems: expect.arrayContaining([expect.objectContaining({ ref: "file:notes/known.md" })]),
      }),
    });
  }));

  test("executes only the four strict .prompt directives and treats later lookalikes as data", async () => withProject(async (root) => {
    await mkdir(join(root, "prompts"));
    await mkdir(join(root, "notes"));
    await installProjectSkill(root, "proof-review");
    await writeFile(join(root, "notes", "known.md"), "Known input.\n");
    const file = join(root, "prompts", "proof.prompt");
    await writeFile(file, [
      "@agent(codex)",
      "@ctx(file:notes/known.md)",
      "@skill(proof-review)",
      "@workstream(ws_prompt)",
      "",
      "Investigate the bound.",
      "@agent(pi)",
    ].join("\n"));
    const provider = {
      sessions: vi.fn(async () => []),
      prepareRun: vi.fn(async ({ run }) => ({ id: "run_prompt", ...run })),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const prepared = await service.prepareRun({ promptFile: file, cwd: root });
    expect(prepared.spec).toMatchObject({
      agent: { id: "codex", transport: "acp" }, workstream_id: "ws_prompt",
      skills: [expect.objectContaining({ id: "proof-review" })],
      source: { kind: "prompt-file", file: "prompts/proof.prompt" },
    });
    expect(prepared.spec.prompt).toBe("Investigate the bound.\n@agent(pi)");
    expect(prepared.contextItems).toHaveLength(2);
    expect(Buffer.from(prepared.contextItems[0].contentBase64, "base64").toString()).toBe("Known input.\n");
    expect(() => parseResearchPrompt("@budget(10)\nBody")).toThrow(/Unsupported/);
  }));

  test("freezes note, artifact, and latest Handoff context with one shared limit", async () => withProject(async (root) => {
    await mkdir(join(root, "prompts"));
    const file = join(root, "prompts", "context.prompt");
    await writeFile(file, "@agent(codex)\n@workstream(ws_context)\n\nUse explicit evidence.");
    const readArtifact = vi.fn(async ({ id }) => ({
      artifact: { id, mediaType: "text/markdown; charset=utf-8" },
      dataBase64: Buffer.from(id === "art_evidence" ? "Artifact evidence" : "Latest handoff").toString("base64"),
    }));
    const provider = {
      sessions: vi.fn(async () => [{ id: "ses_context", state: "warm", executionTarget: root }]),
      runs: vi.fn(async () => [{ id: "run_previous", status: "completed" }]),
      liveRun: vi.fn(async () => ({ seq: 4, events: [{ seq: 4, type: "run.status.changed", payload: { handoff_artifact_id: "art_handoff" } }] })),
      readArtifact,
      prepareRun: vi.fn(async ({ run }) => ({ id: "run_context", ...run })),
    };
    const resolveKnowledgeNote = vi.fn(async () => ({ content: "Knowledge note", disclosure: "", uri: "noema://note/note_1" }));
    const service = createResearchRuntimeService({ getProvider: () => provider as any, resolveKnowledgeNote });
    const prepared = await service.prepareRun({ promptFile: file, cwd: root,
      context: ["note:note_1", "artifact:art_evidence", "handoff.latest"] });
    expect(prepared.contextItems.map((item: any) => item.ref)).toEqual(["note:note_1", "artifact:art_evidence", "handoff.latest"]);
    expect(prepared.contextItems.map((item: any) => Buffer.from(item.contentBase64, "base64").toString())).toEqual([
      "Knowledge note", "Artifact evidence", "Latest handoff",
    ]);
    expect(resolveKnowledgeNote).toHaveBeenCalledWith("note_1", root);
    expect(readArtifact).toHaveBeenCalledTimes(2);
  }));

  test("refuses local_only knowledge notes before preparing a Run", async () => withProject(async (root) => {
    await mkdir(join(root, "prompts"));
    const file = join(root, "prompts", "private.prompt");
    await writeFile(file, "@agent(codex)\n@workstream(ws_context)\n\nDo not leak.");
    const provider = { sessions: vi.fn(async () => []), prepareRun: vi.fn() };
    const service = createResearchRuntimeService({
      getProvider: () => provider as any,
      resolveKnowledgeNote: async () => ({ content: "CANARY", disclosure: "local_only" }),
    });
    await expect(service.prepareRun({ promptFile: file, cwd: root, context: ["note:private"] }))
      .rejects.toMatchObject({ code: "ERR_RESEARCH_DISCLOSURE" });
    expect(provider.prepareRun).not.toHaveBeenCalled();
  }));

  test("labels reconstructed forks and freezes the parent Result plus Handoff", async () => withProject(async (root) => {
    const researchDir = join(root, "research");
    await mkdir(researchDir);
    let notebook = createResearchNotebook({ title: "Fork" });
    const work = createResearchCell(notebook, { kind: "work", title: "Attempt", source: "Try another route." });
    notebook = work.notebook;
    notebook.cells.push({
      cell_type: "markdown", id: "c-result-parent",
      metadata: { noema_research: { kind: "result", work_node_id: work.workNode.id, run_id: "run_parent" } },
      source: "## Result\n\nParent result.",
    });
    const file = join(researchDir, "fork.noema");
    await writeResearchNotebookFile(file, notebook, { create: true });
    const provider = {
      session: vi.fn(async () => ({
        id: "ses_parent", workstreamId: notebook.metadata.noema_research.workstream_id,
        adapter: "codex", executionTarget: root, nativeSessionId: "native-parent",
        capabilities: { sessionFork: false },
      })),
      runs: vi.fn(async () => [{
        id: "run_parent", sessionId: "ses_parent", status: "completed",
        notebookId: notebook.metadata.noema_research.notebook_id, cellId: work.cell.id, workNodeId: work.workNode.id,
      }]),
      liveRun: vi.fn(async () => ({
        run: { id: "run_parent", status: "completed" }, seq: 9,
        events: [{ seq: 9, type: "run.status.changed", payload: { handoff_artifact_id: "art_handoff" } }],
      })),
      readArtifact: vi.fn(async () => ({
        artifact: { id: "art_handoff", mediaType: "text/markdown; charset=utf-8" },
        dataBase64: Buffer.from("Parent handoff.").toString("base64"),
      })),
      prepareRun: vi.fn(async ({ run }) => ({ id: "run_child", ...run })),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const prepared = await service.prepareRun({
      file, cellId: work.cell.id, cwd: root, sessionPolicy: "fork", parentSessionId: "ses_parent",
    });
    expect(prepared.routing.mode).toBe("fork-reconstructed");
    expect(prepared.spec.fork_mode).toBe("reconstructed");
    expect(prepared.spec.fork_notice).toContain("No hidden parent conversation");
    expect(prepared.contextItems.map((item: any) => item.ref)).toEqual([
      `result:${work.workNode.id}`, "handoff:run_parent",
    ]);
    expect(Buffer.from(prepared.contextItems[1].contentBase64, "base64").toString()).toBe("Parent handoff.");
  }));

  test("routes corpus reconciliation, bounded updates, search, and exact block reads", async () => withProject(async (root) => {
	const provider = {
	  indexArtifactCorpus: vi.fn(async ({ index }) => ({ ...index, parsedFiles: 2, inferenceCalls: 0 })),
	  indexArtifactFiles: vi.fn(async ({ index }) => ({ ...index, parsedFiles: 1, inferenceCalls: 0 })),
	  searchArtifactBlocks: vi.fn(async () => [{ blockId: "ablk_1", excerpt: "exact" }]),
	  readArtifactBlock: vi.fn(async ({ id }) => ({ id, content: "exact source span" })),
	};
	const service = createResearchRuntimeService({ getProvider: () => provider as any });
	await expect(service.indexArtifactCorpus({ root, workstream_id: "ws_corpus", relative_root: "docs" }))
	  .resolves.toMatchObject({ root, index: { workstreamId: "ws_corpus", relativeRoot: "docs", parsedFiles: 2, inferenceCalls: 0 } });
	expect(provider.indexArtifactCorpus).toHaveBeenCalledWith({ root, index: {
	  workstreamId: "ws_corpus", relativeRoot: "docs", actor: "human:local-corpus",
	} });
	await expect(service.indexArtifactFiles({ root, workstreamId: "ws_corpus", paths: ["docs/a.md", ""] }))
	  .resolves.toMatchObject({ index: { parsedFiles: 1 } });
	expect(provider.indexArtifactFiles).toHaveBeenCalledWith({ root, index: {
	  workstreamId: "ws_corpus", paths: ["docs/a.md"], actor: "human:local-corpus",
	} });
	await expect(service.searchArtifactBlocks({ root, workstreamId: "ws_corpus", query: "exact", limit: 5000 }))
	  .resolves.toMatchObject({ hits: [{ blockId: "ablk_1" }] });
	expect(provider.searchArtifactBlocks).toHaveBeenCalledWith({ root, search: {
	  workstreamId: "ws_corpus", query: "exact", limit: 1000,
	} });
	await expect(service.readArtifactBlock({ root, block_id: "ablk_1" }))
	  .resolves.toMatchObject({ block: { id: "ablk_1", content: "exact source span" } });
  }));

  test("discovers only history roots that exist and registers every channel", async () => withProject(async (root) => {
    const userHome = join(root, "home");
    await mkdir(join(root, ".agent-shell", "transcripts"), { recursive: true });
    await mkdir(join(userHome, ".codex", "sessions"), { recursive: true });
    await mkdir(join(userHome, ".config", "emacs", "var", "noema-interaction", "magent", "sessions"), { recursive: true });
    expect(await defaultResearchHistorySources(root, { userHome, env: {} })).toEqual([
      { kind: "agent-shell", path: join(root, ".agent-shell", "transcripts"), projectRoot: root },
      { kind: "magent", path: join(userHome, ".config", "emacs", "var", "noema-interaction", "magent", "sessions"), projectRoot: root },
      { kind: "codex", path: join(userHome, ".codex", "sessions"), projectRoot: root },
    ]);
    expect(await findResearchProjectRoot(join(root, "nested"))).toBe(root);
    const handlers = createResearchApiHandlers({} as any);
    for (const suffix of ["cell:resolve", "run:prepare", "run:cancel", "run:fail-preparing", "run:live", "artifact:read", "artifact:import", "corpus:index", "corpus:index-files", "corpus:search", "corpus:block-read", "worker:lease", "worker:attach", "worker:start", "worker:events", "worker:permission", "worker:input", "permission:decide", "input:get", "input:respond", "attention:list", "proposal:create", "supervisor:propose", "proposal:get", "proposal:list", "proposal:review", "finding:get", "finding:list", "research-ir:list", "problem-model:list", "export:create", "task:create", "task:list", "task:transition", "job:create", "job:list", "job:claim", "job:start", "job:lease-renew", "job:lease-expire", "job:complete", "job:fail", "job:unresolved", "job:retry", "invocation:list", "scheduler-worker:register", "scheduler-worker:list", "delegation:create", "delegation:list", "orchestration:snapshot", "session:promote", "session:list", "session:get", "session:takeover", "session:handback", "history:index", "history:search", "history:peek", "history:read"]) {
      expect(handlers[`aaronnote:api:research:${suffix}`]).toBeTypeOf("function");
    }
  }));

	test("resolves cell deep links against the configured repository without trusting a URL path", async () => withProject(async (root) => {
	  const file = join(root, "research", "linked.noema");
	  await mkdir(join(root, "research"));
	  let notebook = createResearchNotebook({ title: "Linked" });
	  notebook.metadata.noema_research.notebook_id = "nb_link";
	  const created = createResearchCell(notebook, { kind: "work", title: "Linked cell" });
	  notebook = created.notebook;
	  notebook.cells[0].id = "c-link";
	  const written = await writeResearchNotebookFile(file, notebook, { create: true });
	  const provider = {
		resolveCell: vi.fn(async () => ({ notebookId: "nb_link", cellId: "c-link", path: "research/linked.noema", revision: "sha256:abc" })),
	  };
	  const service = createResearchRuntimeService({ getProvider: () => provider as any, defaultRoot: root });
	  await expect(service.resolveCell({ notebookId: "nb_link", cellId: "c-link" })).resolves.toEqual({
		root, notebookId: "nb_link", cellId: "c-link", file: await realpath(file),
		path: "research/linked.noema", revision: written.revision, indexedRevision: "sha256:abc",
	  });
	  expect(provider.resolveCell).toHaveBeenCalledWith({ root, notebookId: "nb_link", cellId: "c-link" });
	}));

  test("forwards pre-dispatch failures to the kernel authority", async () => withProject(async (root) => {
    const provider = {
      failPreparedRun: vi.fn(async ({ failure }) => ({ id: failure.runId, status: "failed", failureReason: failure.failureReason })),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    await expect(service.failPreparingRun({ root, runId: "run_boot", failureReason: "adapter missing" })).resolves.toMatchObject({
      root, run: { id: "run_boot", status: "failed", failureReason: "adapter missing" },
    });
    expect(provider.failPreparedRun).toHaveBeenCalledWith({
      root, failure: { runId: "run_boot", failureReason: "adapter missing" },
    });
  }));

  test("projects Attention without changing pending state", async () => withProject(async (root) => {
    const provider = {
      attention: vi.fn(async () => ({
        permissions: [{ id: "perm_1", state: "pending", version: 1 }],
		inputRequests: [{ id: "input_1", state: "pending", prompt: "Choose" }],
        inputRuns: [{ id: "run_1", status: "waiting_input" }],
        proposals: [
          { id: "prop_1", status: "pending", kind: "finding.create", payload: { disclosure: "project" } },
          { id: "prop_private", status: "pending", kind: "finding.create", payload: { disclosure: "local_only", statement: "CANARY" } },
        ],
      })),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    await expect(service.attention({ cwd: join(root, "nested") })).resolves.toEqual({
      root,
      permissions: [{ id: "perm_1", state: "pending", version: 1 }],
	  inputRequests: [{ id: "input_1", state: "pending", prompt: "Choose" }],
      inputRuns: [{ id: "run_1", status: "waiting_input" }],
      proposals: [
        { id: "prop_1", status: "pending", kind: "finding.create", payload: { disclosure: "project" } },
        { id: "prop_private", status: "pending", kind: "finding.create", payload: { disclosure: "local_only", statement: "CANARY" } },
      ],
    });
    await expect(service.attention({ root, disclosureView: "remote" })).resolves.toMatchObject({
      proposals: [{ id: "prop_1" }],
    });
    expect(provider.attention).toHaveBeenCalledWith({ root });
  }));

  test("keeps adapter output pending and materializes a deterministic ghost cell only during human review", async () => withProject(async (root) => {
    const researchDir = join(root, "research");
    await mkdir(researchDir);
    const notebook = createResearchNotebook({ title: "Proposal" });
    notebook.metadata.noema_research.notebook_id = "nb_proposal";
    notebook.metadata.noema_research.workstream_id = "ws_proposal";
    const file = join(researchDir, "proposal.noema");
    const written = await writeResearchNotebookFile(file, notebook, { create: true });
    let stored: any = null;
    const provider = {
      createProposal: vi.fn(async ({ proposal }) => {
        stored = { id: "prop_1", status: "pending", version: 1, ...proposal };
        return stored;
      }),
      proposal: vi.fn(async () => stored),
      beginProposalAcceptance: vi.fn(async ({ review }) => {
        stored = { ...stored, status: "accepting", reviewedBy: review.reviewedBy,
          reviewedPayload: review.editedPayload ?? stored.payload, version: 2 };
        return { proposal: stored };
      }),
      reviewProposal: vi.fn(async ({ review }) => {
        stored = { ...stored, status: review.decision === "accept" ? "accepted" : "rejected",
          acceptedRef: review.acceptedRef, version: stored.version + 1 };
        return { proposal: stored };
      }),
      proposals: vi.fn(async () => [stored]),
      finding: vi.fn(async () => ({ id: "finding_1" })),
      findings: vi.fn(async () => [{ id: "finding_1" }]),
      researchIR: vi.fn(async () => [{ version: 1 }]),
      problemModels: vi.fn(async () => [{ version: 2 }]),
      createWorkstreamExport: vi.fn(async () => ({ artifact: { id: "art_export", kind: "workstream-export" } })),
    };
    const indexer = { index: vi.fn(async () => ({ cells: 1 })), status: vi.fn(), events: vi.fn() };
    const notebooks = createResearchNotebookService({ getIndexer: () => indexer as any });
    const service = createResearchRuntimeService({ getProvider: () => provider as any, getNotebookService: () => notebooks });

    const proposed = await service.createProposal({
      root, clientRequestId: "magent-turn-7", workstreamId: "ws_proposal", kind: "cell.create",
      proposedBy: "agent:magent:curator", sourceAdapter: "magent/gptel",
      payload: { cell: { file: "research/proposal.noema", notebookId: "nb_proposal", expectedRevision: written.revision,
        kind: "work", title: "Ghost route", source: "Investigate the route." } },
    });
    expect(proposed.proposal).toMatchObject({ id: "prop_1", status: "pending", payload: { cell: { cellId: expect.stringMatching(/^c-prop-/) } } });
    expect((await readResearchNotebookFile(file)).notebook.cells).toHaveLength(0);

    const reviewed = await service.reviewProposal({ root, proposalId: "prop_1", decision: "accept", expectedVersion: 1, reviewedBy: "human:test" });
    const cellId = stored.payload.cell.cellId;
    expect(reviewed).toMatchObject({ materialized: { cell: { id: cellId, kind: "work" } }, proposal: { status: "accepted" } });
    expect(provider.reviewProposal).toHaveBeenLastCalledWith({ root, review: expect.objectContaining({
      proposalId: "prop_1", acceptedRef: `noema://cell/nb_proposal/${cellId}`, expectedVersion: 2,
    }) });
    expect(provider.beginProposalAcceptance).toHaveBeenCalledWith({ root, review: expect.objectContaining({
      proposalId: "prop_1", expectedVersion: 1, reviewedBy: "human:test",
    }) });
    expect((await readResearchNotebookFile(file)).notebook.cells).toHaveLength(1);

    provider.reviewProposal.mockClear();
    const reconciled = await service.reviewProposal({ root, proposalId: "prop_1", decision: "accept", expectedVersion: 1, reviewedBy: "human:test" });
    expect(reconciled.materialized).toMatchObject({ reconciled: true });
    expect(provider.reviewProposal).not.toHaveBeenCalled();
    expect((await readResearchNotebookFile(file)).notebook.cells).toHaveLength(1);

    await expect(service.proposals({ root, workstreamId: "ws_proposal" })).resolves.toMatchObject({ proposals: [{ id: "prop_1" }] });
    await expect(service.finding({ root, id: "finding_1" })).resolves.toMatchObject({ finding: { id: "finding_1" } });
    await expect(service.findings({ root, includeLocal: true })).resolves.toMatchObject({ findings: [{ id: "finding_1" }] });
    await expect(service.researchIR({ root, workstreamId: "ws_proposal" })).resolves.toMatchObject({ versions: [{ version: 1 }] });
    await expect(service.problemModels({ root, workstreamId: "ws_proposal" })).resolves.toMatchObject({ versions: [{ version: 2 }] });
    await expect(service.exportWorkstream({ root, workstreamId: "ws_proposal" })).resolves.toMatchObject({
      export: { artifact: { id: "art_export", kind: "workstream-export" } },
    });
    expect(provider.createWorkstreamExport).toHaveBeenCalledWith({ root, export: {
      workstreamId: "ws_proposal", exportedBy: "human:local", includeLocalOnly: false,
    } });

    provider.createProposal.mockClear();
    provider.beginProposalAcceptance.mockClear();
    provider.reviewProposal.mockClear();
    const supervised = await service.supervisorProposal({
      root, proposal: { clientRequestId: "pi-supervisor-1", workstreamId: "ws_proposal",
        kind: "task.create", payload: { title: "Check another route" },
        proposedBy: "spoofed", sourceAdapter: "spoofed" },
    });
    expect(supervised.proposal).toMatchObject({ status: "pending", proposedBy: "agent:pi:supervisor", sourceAdapter: "pi-supervisor-hook" });
    expect(provider.createProposal).toHaveBeenCalledWith({ root, proposal: expect.objectContaining({
      proposedBy: "agent:pi:supervisor", sourceAdapter: "pi-supervisor-hook", kind: "task.create",
    }) });
    expect(provider.beginProposalAcceptance).not.toHaveBeenCalled();
    expect(provider.reviewProposal).not.toHaveBeenCalled();
    await expect(service.supervisorProposal({ root, proposal: {
      clientRequestId: "pi-supervisor-bad", workstreamId: "ws_proposal", kind: "task.create",
      payload: { title: "Bad" }, decision: "accept",
    } })).rejects.toMatchObject({ code: "ERR_RESEARCH_PROPOSAL" });
  }));

  test("projects the authoritative orchestration lifecycle without inventing worker state", async () => withProject(async (root) => {
    const task = { id: "task_1", workstreamId: "ws_demo", state: "open", version: 1 };
    const job = { id: "job_1", taskId: task.id, state: "queued", version: 1 };
    const worker = { id: "worker:demo:deterministic", kind: "deterministic", state: "available" };
    const lease = { jobId: job.id, invocationId: "inv_1", workerId: worker.id, token: "lease_secret", epoch: 1 };
    const provider = {
      createTask: vi.fn(async () => task), tasks: vi.fn(async () => [task]), transitionTask: vi.fn(async () => ({ ...task, state: "completed", version: 2 })),
      createJob: vi.fn(async () => job), jobs: vi.fn(async () => [job]),
      registerSchedulerWorker: vi.fn(async () => worker), schedulerWorkers: vi.fn(async () => [worker]),
      claimJob: vi.fn(async () => ({ job: { ...job, state: "claimed" }, invocation: { id: "inv_1" }, lease })),
      startJob: vi.fn(async () => ({ ...job, state: "running" })), renewJobLease: vi.fn(async () => lease),
      expireJobLeases: vi.fn(async () => ({ jobs: [] })),
      completeJob: vi.fn(async () => ({ job: { ...job, state: "completed" }, invocation: { id: "inv_1", result: { status: "completed" } } })),
      invocations: vi.fn(async () => [{ id: "inv_1", result: { status: "completed" } }]),
      createDelegation: vi.fn(async () => ({ id: "del_1", parentTaskId: "task_parent", childTaskId: task.id, childJobIds: [job.id] })),
      delegations: vi.fn(async () => [{ id: "del_1" }]),
      proposals: vi.fn(async () => []),
      events: vi.fn(async () => [
        { id: 1, workstream_id: "ws_demo", type: "job.queued" },
        { id: 2, workstream_id: "ws_other", type: "job.queued" },
      ]),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    await expect(service.createTask({ root, workstreamId: "ws_demo", clientRequestId: "create-task",
      task: { title: "Test", objective: "Exercise the scheduler", disclosure: "project" } }))
      .resolves.toEqual({ root, task });
    await expect(service.createJob({ root, workstreamId: "ws_demo", clientRequestId: "create-job",
      job: { taskId: task.id, kind: "tests.run" } })).resolves.toEqual({ root, job });
    await service.registerSchedulerWorker({ root, worker });
    const claimed = await service.claimJob({ root, jobId: job.id, workerId: worker.id,
      claimRequestId: "claim-1", executionMode: "deterministic" });
    expect(claimed).toMatchObject({ root, invocation: { id: "inv_1" }, lease: { epoch: 1 } });
    expect(provider.claimJob).toHaveBeenCalledWith({ root, claim: expect.objectContaining({
      jobId: job.id, workerId: worker.id, claimRequestId: "claim-1", executionMode: "deterministic",
    }) });
    await service.startJob({ root, ...lease });
    await service.expireJobLeases({ root, workstreamId: "ws_demo" });
    expect(provider.expireJobLeases).toHaveBeenCalledWith({ root, workstreamId: "ws_demo" });
    await service.completeJob({ root, ...lease, result: { exitCode: 0 }, usage: {
      inputTokens: 0, outputTokens: 0, costMicrousd: 0, inferenceCalls: 0,
    } });
    expect(provider.completeJob).toHaveBeenCalledWith({ root, completion: expect.objectContaining({
      jobId: job.id, invocationId: "inv_1", token: "lease_secret", result: { exitCode: 0 },
    }) });
    await expect(service.orchestrationSnapshot({ root, workstreamId: "ws_demo" })).resolves.toMatchObject({
      root, workstreamId: "ws_demo", tasks: [task], jobs: [job], workers: [worker], delegations: [{ id: "del_1" }],
      proposals: [], events: [{ id: 1, workstream_id: "ws_demo", type: "job.queued" }],
    });
    expect(provider.tasks).toHaveBeenCalledWith({ root, workstreamId: "ws_demo", limit: 1000, includeLocal: true });
  }));

  test("fails closed without a project manifest or kernel", async () => {
    const outside = await mkdtemp(join(tmpdir(), "noema-no-project-"));
    try {
      await expect(findResearchProjectRoot(outside)).rejects.toMatchObject({ code: "ERR_RESEARCH_ROOT" });
      const service = createResearchRuntimeService({ getProvider: () => null });
      await expect(service.sessions({ root: outside })).rejects.toMatchObject({ code: "ERR_RESEARCH_ROOT" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("records cancellation before delivering it to the physical worker", async () => withProject(async (root) => {
    const provider = {
      requestRunCancellation: vi.fn(async ({ cancellation }) => ({ id: cancellation.runId, sessionId: "ses_1", status: "running" })),
    };
    const delivered: any[] = [];
    const service = createResearchRuntimeService({
      getProvider: () => provider as any,
      deliverWorkerCommand: (command) => { delivered.push(command); return true; },
    });
    await expect(service.cancelRun({ root, runId: "run_1", requestedBy: "web" })).resolves.toMatchObject({
      run: { id: "run_1", status: "running" }, delivered: true,
    });
    expect(provider.requestRunCancellation).toHaveBeenCalledWith({ root, cancellation: { runId: "run_1", requestedBy: "web" } });
    expect(delivered).toEqual([expect.objectContaining({ type: "run-cancel", root, runId: "run_1", sessionId: "ses_1" })]);
  }));

  test("downlinks permission and input decisions with their authoritative epoch", async () => withProject(async (root) => {
    const provider = {
      decidePermission: vi.fn(async () => ({
        id: "perm_1", runId: "run_1", sessionId: "ses_1", optionId: "allow_once", epoch: 7, state: "resolved",
      })),
      respondInput: vi.fn(async () => ({
        id: "input_1", nativeRequestId: "native_1", runId: "run_1", sessionId: "ses_1",
        answer: { choice: "spectral" }, epoch: 7, state: "resolved",
      })),
      inputRequest: vi.fn(async () => ({ id: "input_1", state: "pending" })),
    };
    const delivered: any[] = [];
    const service = createResearchRuntimeService({
      getProvider: () => provider as any,
      deliverWorkerCommand: (command) => { delivered.push(command); return true; },
    });
    await expect(service.decidePermission({
      root, permissionId: "perm_1", optionId: "allow_once", expectedVersion: 1, decidedBy: "mobile",
    })).resolves.toMatchObject({ delivered: true });
    await expect(service.inputRequest({ root, requestId: "input_1" })).resolves.toMatchObject({ request: { state: "pending" } });
    await expect(service.respondInput({
      root, runId: "run_1", requestId: "input_1", answer: { choice: "spectral" }, answeredBy: "mobile",
    })).resolves.toMatchObject({ delivered: true });
    expect(delivered).toEqual([
      expect.objectContaining({ type: "permission-decision", permissionId: "perm_1", epoch: 7 }),
      expect.objectContaining({ type: "input-response", requestId: "input_1", nativeRequestId: "native_1", epoch: 7 }),
    ]);
  }));

  test("uses only locally verified native resume commands for PTY takeover", async () => withProject(async (root) => {
    expect(manualTUICommand({ adapter: "codex", transport: "acp", nativeSessionId: "codex-id" }))
      .toEqual(["codex", "resume", "codex-id"]);
    expect(manualTUICommand({ adapter: "claude-code", transport: "acp", nativeSessionId: "claude-id" }))
      .toEqual(["claude", "--resume", "claude-id"]);
    expect(manualTUICommand({ adapter: "opencode", transport: "acp", nativeSessionId: "open-id" }))
      .toEqual(["opencode", "--session", "open-id"]);
    expect(() => manualTUICommand({ adapter: "pi", transport: "acp", nativeSessionId: "pi-id" }))
      .toThrow(/no verified/);

    const provider = {
      session: vi.fn(async () => ({
        id: "ses_1", adapter: "codex", transport: "acp", nativeSessionId: "native_1", version: 4,
      })),
      beginManualIntervention: vi.fn(async ({ intervention }) => ({ id: "manual_1", state: "active", version: 1, ...intervention })),
      endManualIntervention: vi.fn(async ({ intervention }) => ({ id: intervention.interventionId, state: "ended", version: 2 })),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    await expect(service.takeoverSession({ root, sessionId: "ses_1" })).resolves.toMatchObject({
      command: ["codex", "resume", "native_1"], intervention: { id: "manual_1", state: "active" },
    });
    expect(provider.beginManualIntervention).toHaveBeenCalledWith({
      root, intervention: {
        sessionId: "ses_1", command: ["codex", "resume", "native_1"], startedBy: "emacs", expectedVersion: 4,
      },
    });
    await expect(service.handbackSession({
      root, interventionId: "manual_1", expectedVersion: 1, reason: "return",
    })).resolves.toMatchObject({ intervention: { id: "manual_1", state: "ended" } });
  }));

  test("writes terminal worker output back through the notebook authority", async () => withProject(async (root) => {
    const file = join(root, "research", "bound.noema");
    await mkdir(join(root, "research"));
    await writeFile(file, "{}");
    const provider = {
      reportWorkerEvents: vi.fn(async () => [{ id: "evt_1" }]),
      run: vi.fn(async () => ({
        id: "run_1", notebookId: "nb_1", cellId: "c-work", workNodeId: "wn-work", status: "completed",
      })),
    };
    const notebooks = { writeRunResult: vi.fn(async (body) => ({ cell: { id: "c-result" }, ...body })) };
    const service = createResearchRuntimeService({
      getProvider: () => provider as any,
      getNotebookService: () => notebooks,
    });
    const reply = await service.workerEvents({
      root, notebookFile: file, runId: "run_1", sessionId: "ses_1", owner: "emacs:1", epoch: 1,
      events: [{ type: "run.status.changed", payload: { status: "completed", result_text: "A bounded proof." } }],
    });
    expect(reply).toMatchObject({ events: [{ id: "evt_1" }], result: { cell: { id: "c-result" } }, resultError: null });
    expect(notebooks.writeRunResult).toHaveBeenCalledWith(expect.objectContaining({
      file: await realpath(file), notebookId: "nb_1", workId: "wn-work", runId: "run_1", status: "completed", content: "A bounded proof.",
    }));
  }));

  test("associates ordinary files changed by an agent Run with its stable WorkNode", async () => withProject(async (root) => {
    const researchDir = join(root, "research");
    await mkdir(researchDir);
    let notebook = createResearchNotebook({ title: "Artifacts" });
    const work = createResearchCell(notebook, {
      kind: "work", title: "Implement baseline", source: "Create src/baseline.py.",
    });
    notebook = work.notebook;
    const file = join(researchDir, "artifacts.noema");
    await writeResearchNotebookFile(file, notebook, { create: true });
    const provider = {
      sessions: vi.fn(async () => []),
      prepareRun: vi.fn(async ({ run }) => ({ id: "run_artifacts", ...run })),
      importArtifact: vi.fn(async (_request: any) => ({ id: "art_baseline" })),
      reportWorkerEvents: vi.fn(async ({ events }: any) => events.events),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const prepared = await service.prepareRun({ file, cellId: work.cell.id, cwd: root });
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "baseline.py"), "print('baseline')\n");
    await mkdir(join(root, ".agent"), { recursive: true });
    await writeFile(join(root, ".agent", "runtime-noise.log"), "ignore me\n");

    const reply = await service.workerEvents({
      root, runId: prepared.run.id, sessionId: "ses_artifacts", owner: "emacs:1", epoch: 1,
      events: [{ type: "run.status.changed", payload: { status: "completed" } }],
    });

    expect(provider.importArtifact).toHaveBeenCalledTimes(1);
    expect(provider.importArtifact).toHaveBeenCalledWith({
      root,
      artifact: expect.objectContaining({
        kind: "run-file",
        runId: "run_artifacts",
        workstreamId: notebook.metadata.noema_research.workstream_id,
        sourceUri: "noema://file/src/baseline.py",
        metadata: expect.objectContaining({
          path: "src/baseline.py", change: "created", run_id: "run_artifacts",
          work_node_id: work.workNode.id, cell_id: work.cell.id,
        }),
      }),
    });
    expect(Buffer.from(provider.importArtifact.mock.calls[0][0].artifact.contentBase64, "base64").toString())
      .toBe("print('baseline')\n");
    expect(provider.reportWorkerEvents.mock.calls[0][0].events.events).toEqual([
      { type: "run.artifact.detected", payload: {
        artifact_id: "art_baseline", path: "src/baseline.py", change: "created", work_node_id: work.workNode.id,
      } },
      { type: "run.status.changed", payload: { status: "completed" } },
    ]);
    expect(reply.artifactErrors).toEqual([]);
  }));

  test("fails closed for Pi denied capabilities without an external sandbox", async () => withProject(async (root) => {
    const researchDir = join(root, "research");
    await mkdir(researchDir);
    let notebook = createResearchNotebook({ title: "Bound" });
    const work = createResearchCell(notebook, { kind: "work", title: "Attempt", source: "Inspect safely." });
    notebook = work.notebook;
    const cell = notebook.cells.find((candidate: any) => candidate.id === work.cell.id);
    cell.metadata.noema_research.executor = { agent: "pi", capabilities: { network: "deny" } };
    const file = join(researchDir, "bound.noema");
    await writeResearchNotebookFile(file, notebook, { create: true });
    const service = createResearchRuntimeService({ getProvider: () => ({ sessions: async () => [] }) as any });
    await expect(service.prepareRun({ file, cellId: work.cell.id, cwd: root })).rejects.toMatchObject({ code: "ERR_RESEARCH_CAPABILITY" });
  }));

  test("never places a local_only canary in a RunSpec or provider request", async () => withProject(async (root) => {
    const researchDir = join(root, "research");
    await mkdir(researchDir);
    const canary = "NOEMA_LOCAL_ONLY_CANARY_8d87a0";
    let notebook = createResearchNotebook({ title: "Private" });
    const work = createResearchCell(notebook, { kind: "work", title: "Private work", source: canary });
    notebook = work.notebook;
    const cell = notebook.cells.find((candidate: any) => candidate.id === work.cell.id);
    cell.metadata.noema_research.disclosure = "local_only";
    const file = join(researchDir, "private.noema");
    await writeResearchNotebookFile(file, notebook, { create: true });
    const captured: any[] = [];
    const provider = {
      sessions: vi.fn(async (...args: any[]) => { captured.push(args); return []; }),
      prepareRun: vi.fn(async (...args: any[]) => { captured.push(args); return {}; }),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    await expect(service.prepareRun({ file, cellId: work.cell.id, cwd: root })).rejects.toMatchObject({
      code: "ERR_RESEARCH_DISCLOSURE",
    });
    expect(provider.sessions).not.toHaveBeenCalled();
    expect(provider.prepareRun).not.toHaveBeenCalled();
    expect(JSON.stringify(captured)).not.toContain(canary);
  }));
});
