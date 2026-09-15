import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { createHash } from "node:crypto";
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
import {
  createResearchCell,
  createResearchNotebook,
  createResearchNotebookService,
  readResearchNotebookFile,
  setResearchRelation,
  upsertResearchRunOutput,
  writeResearchNotebookFile,
} from "../server/lib/research-notebook.mjs";

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
  test("route preview uses unsaved lineage changes and shares one runtime snapshot", async () => withProject(async (root) => {
    let notebook = createResearchNotebook({ title: "Preview", defaultAgent: "codex" });
    const parent = createResearchCell(notebook, { kind: "work", title: "Read", source: "@@agent(opencode)\nRead." });
    const child = createResearchCell(parent.notebook, { kind: "work", title: "Review", source: "Review.", lineageParent: parent.workNode.id });
    notebook = child.notebook;
    const file = join(root, "preview.noema");
    await writeResearchNotebookFile(file, notebook, { create: true });
    notebook.cells.find((cell) => cell.id === parent.cell.id)!.source = "@@agent(claude)\nRead.";
    const runs = vi.fn(async () => []);
    const service = createResearchRuntimeService({ getProvider: () => ({ runs }) as any });
    const result = await service.resolveSessions({ root, file, notebook, cellIds: [parent.cell.id, child.cell.id] });
    expect(result.sessions.map((item: { agent: string }) => item.agent)).toEqual(["claude", "claude"]);
    expect(runs).toHaveBeenCalledTimes(1);
    expect((await readResearchNotebookFile(file)).notebook.cells.find((cell) => cell.id === parent.cell.id)!.source).toContain("opencode");
  }));

  test("completion check targets the exact worker without sending another prompt", async () => withProject(async (root) => {
    const provider = { run: vi.fn(async () => ({ id: "r", sessionId: "s", status: "running" })),
      expireLeases: vi.fn(async () => ({ interrupted: [] })) };
    const deliverWorkerCommand = vi.fn(() => true);
    const service = createResearchRuntimeService({ getProvider: () => provider as any, deliverWorkerCommand });
    const handlers = createResearchApiHandlers(service);
    await expect(handlers["aaronnote:api:research:run:check-completion"]({ root, runId: "r" }))
      .resolves.toMatchObject({ detection: "requested", delivered: true });
    expect(deliverWorkerCommand).toHaveBeenCalledExactlyOnceWith({ type: "run-check-completion", root, runId: "r", sessionId: "s" });
    expect((await service.checkRunCompletion({ root })).detection).toBe("no-run");
  }));

  test("completion checks do not invent success when the worker is unreachable", async () => withProject(async (root) => {
    const service = createResearchRuntimeService({ getProvider: () => ({
      run: async () => ({ id: "r", status: "running" }),
    }) as any, deliverWorkerCommand: () => false });
    await expect(service.checkRunCompletion({ root, runId: "r" }))
      .resolves.toMatchObject({ detection: "worker-unavailable", run: { status: "running" } });
  }));

  test("lease reconciliation is throttled and lost workers become interrupted, not completed", async () => withProject(async (root) => {
    let status = "running";
    const expireLeases = vi.fn(async () => { status = "interrupted"; return { interrupted: [{ id: "r", status }] }; });
    const service = createResearchRuntimeService({ getProvider: () => ({ expireLeases,
      run: async () => ({ id: "r", status }), liveRun: async () => ({ run: { id: "r", status }, events: [], seq: 0 }),
    }) as any });
    expect((await service.run({ root, runId: "r" })).run.status).toBe("interrupted");
    await service.liveRun({ root, runId: "r" });
    await service.run({ root, runId: "r" });
    expect(expireLeases).toHaveBeenCalledTimes(1);
  }));

  test("terminal recheck recovers saved output but cannot overwrite a newer run", async () => withProject(async (root) => {
    await writeFile(join(root, "bound.noema"), "{}");
    let latestId = "r";
    const run = { id: "r", notebookId: "nb", cellId: "c", workstreamId: "ws", status: "completed" };
    const queueNotebookWriteback = vi.fn(async (body) => body.writeback);
    const provider = { run: async () => run, runs: async () => [{ ...run, id: latestId }],
      resolveCell: async () => ({ path: "bound.noema" }), queueNotebookWriteback,
      liveRun: async () => ({ events: [{ type: "run.status.changed", payload: { result_text: "verified answer" } }], seq: 3 }),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    expect((await service.checkRunCompletion({ root, runId: "r" })).detection).toBe("terminal");
    expect(queueNotebookWriteback).toHaveBeenCalledWith(expect.objectContaining({ writeback: expect.objectContaining({
      runId: "r", output: expect.objectContaining({ content: "verified answer", status: "completed" }),
    }) }));
    latestId = "new";
    expect((await service.checkRunCompletion({ root, runId: "r" })).result).toEqual({ skipped: "newer-run" });
    expect(queueNotebookWriteback).toHaveBeenCalledTimes(1);
  }));

  test("global channels force global scope even with conflicting project arguments", async () => {
    const mutateCapability = vi.fn(async () => ({}));
    const handlers = createResearchApiHandlers({ mutateCapability });
    await handlers["aaronnote:api:research:capability:global:mutate"]({ scope: "project", cwd: "/project" });
    expect(mutateCapability).toHaveBeenCalledWith({ scope: "global", cwd: "/project" });
  });

  test("global capability APIs ignore project context and do not require a provider until explicit probe", async () => withProject(async (root) => {
    const configPath = join(root, "global", "capabilities.json");
    vi.stubEnv("NOEMA_GLOBAL_CAPABILITIES", configPath);
    vi.stubEnv("NOEMA_GLOBAL_SKILLS", join(root, "global", "skills"));
    const probeMCP = vi.fn(async () => ({ state: "passed", tools: [] }));
    const getProvider = vi.fn(() => ({ probeMCP }) as any);
    const service = createResearchRuntimeService({ getProvider, defaultRoot: "/nonexistent" });
    try {
      expect((await service.capabilities({ scope: "global", cwd: "/nonexistent" })).capabilities.scope).toBe("global");
      expect((await service.capabilityConfig({ scope: "global" })).capabilityConfig.configFile).toBe(configPath);
      const installed = await service.installSkill({ scope: "global", id: "test-proof" });
      expect(installed.skill.path).toBe(join(root, "global", "skills", "test-proof", "SKILL.md"));
      await service.mutateCapability({ scope: "global", type: "mcp", id: "remote", enabled: false,
        definition: { type: "http", url: "https://example.test/mcp" } });
      expect(getProvider).not.toHaveBeenCalled();
      await service.probeMCP({ scope: "global", id: "remote" });
      expect(probeMCP).toHaveBeenCalledWith({ scope: "global", root: join(root, "global"),
        config: expect.objectContaining({ name: "remote" }) });
      await expect(service.capabilities({ scope: "invalid" })).rejects.toThrow(/scope/);
    } finally { vi.unstubAllEnvs(); }
  }));

  test("lists one project directory for completion and rejects escapes", async () => withProject(async (root) => {
    await writeFile(join(root, "nested", "notes.txt"), "notes");
    const service = createResearchRuntimeService();
    expect((await service.capabilityFiles({ root, directory: "nested" })).files).toEqual(["notes.txt"]);
    await expect(service.capabilityFiles({ root, directory: ".." })).rejects.toThrow(/escapes/);
  }));

  test("MCP probes use freshly resolved project configuration without enabling or invoking tools", async () => withProject(async (root) => {
    await writeFile(join(root, "noema-capabilities.json"), JSON.stringify({
      schema: "noema.capabilities/1", skills: {}, mcp: {
        servers: [{ id: "remote", type: "http", url: "https://example.test/mcp" }],
        disabled: ["remote"], patches: { remote: { config: { headers: [{ name: "X-Test", value: "yes" }] } } },
      },
    }));
    const probeMCP = vi.fn(async () => ({ state: "passed", tools: [] }));
    const service = createResearchRuntimeService({ getProvider: () => ({ probeMCP }) as any });
    const before = await import("node:fs/promises").then((fs) => fs.readFile(join(root, "noema-capabilities.json"), "utf8"));
    const result = await service.probeMCP({ root, id: "remote", config: { command: "ignored-input" } });
    expect(result.probe.state).toBe("passed");
    expect(probeMCP).toHaveBeenCalledWith({ root, config: expect.objectContaining({
      name: "remote", type: "http", url: "https://example.test/mcp", headers: [{ name: "X-Test", value: "yes" }],
    }) });
    expect(await import("node:fs/promises").then((fs) => fs.readFile(join(root, "noema-capabilities.json"), "utf8"))).toBe(before);
    await expect(service.probeMCP({ root, id: "unknown" })).rejects.toThrow(/Unknown MCP/);
  }));

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
    const work = createResearchCell(notebook, { kind: "work", title: "Attempt", source: [
      "@@agent(codex)", "@@session(continue)", "@@ctx(lineage)", "@@ctx(file:notes/known.md)",
      "@@skill(proof-review)", "", "Try the spectral route.",
    ].join("\n"), lineageParent: question.cell.id });
    notebook = work.notebook;
    const file = join(researchDir, "bound.noema");
    await writeResearchNotebookFile(file, notebook, { create: true });
    const provider = {
      index: vi.fn(async () => ({ cells: 2 })),
      sessions: vi.fn(async () => [{ id: "ses_warm", state: "warm", executionTarget: root }]),
      runs: vi.fn(async () => [{ id: "run_previous", sessionId: "ses_warm", workNodeId: work.workNode.id }]),
      prepareRun: vi.fn(async ({ run }) => ({ id: "run_1", ...run })),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const prepared = await service.prepareRun({ file, cellId: work.cell.id, cwd: root, capabilities: { network: "deny" } });
    expect(prepared.run).toMatchObject({
      id: "run_1", sessionId: "ses_warm", sourceKind: "work-cell", workNodeId: work.workNode.id,
    });
    expect(prepared.routing).toMatchObject({ mode: "continued", policy: "continue", sessionId: "ses_warm" });
    expect(prepared.spec).toMatchObject({
      schema: "noema.run-spec/1", project_id: "0199",
      agent: { id: "codex", transport: "acp", command: "codex-acp", version: "unknown" }, session_policy: "continue",
      source: { notebook_id: notebook.metadata.noema_research.notebook_id, cell_id: work.cell.id, work_node_id: work.workNode.id },
      capabilities: {
        read_project: "allow", write_project: "allow", execute: "allow", network: "deny",
        write_outside_project: "ask", credentials: "deny",
      },
      skills: [expect.objectContaining({ id: "proof-review", path: ".agents/skills/proof-review/SKILL.md" })],
    });
    expect(prepared.spec.prompt).toBe("Try the spectral route.");
    expect(prepared.spec.prompt_sha256).toBe(`sha256:${createHash("sha256").update("Try the spectral route.").digest("hex")}`);
    expect(prepared.spec.prompt_sha256).not.toBe(prepared.spec.source.cell_source_sha256);
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
    expect(provider.index).toHaveBeenCalledWith({
      root, path: "research/bound.noema", actor: "node", reason: "run.prepare",
    });

	const rolloverProvider = {
	  ...provider,
	  runs: vi.fn(async () => [{
		id: "run_previous", sessionId: "ses_warm", workNodeId: work.workNode.id,
		status: "completed", notebookId: notebook.metadata.noema_research.notebook_id,
	  }]),
	  sessionContext: vi.fn(async () => ({ usage: { contextUsed: 900, contextSize: 1000 } })),
	  requestSessionCompaction: vi.fn(async () => ({ id: "compact_auto", status: "pending" })),
	  liveRun: vi.fn(async () => ({ events: [{
		seq: 5, type: "run.status.changed", payload: { handoff_artifact_id: "art_handoff" },
	  }], seq: 5 })),
	  readArtifact: vi.fn(async () => ({
		artifact: { id: "art_handoff", mediaType: "text/markdown" },
		dataBase64: Buffer.from("x".repeat(32 * 1024)).toString("base64"),
	  })),
	};
	const rolloverService = createResearchRuntimeService({ getProvider: () => rolloverProvider as any });
	const rolled = await rolloverService.prepareRun({ file, cellId: work.cell.id, cwd: root });
	expect(rolled.routing).toMatchObject({
	  mode: "fork-reconstructed", sessionId: "", parentSessionId: "ses_warm",
	  compaction: { id: "compact_auto" },
	});
	expect(rolled.spec.session.compaction_id).toBe("compact_auto");
	const checkpoint = rolled.contextItems.find((item: any) => item.ref === "handoff:run_previous");
	expect(checkpoint?.truncated).toBe(true);
	expect(Buffer.from(checkpoint.contentBase64, "base64").byteLength).toBeLessThanOrEqual(16 * 1024);
  }));

  test("builds an agent RunSpec from multi-scope Skills, project patches, @@skill, and MCPs", async () => withProject(async (root) => {
    await mkdir(join(root, "research"));
    const sharedSkills = join(root, "shared", "skills", "project-method");
    await mkdir(sharedSkills, { recursive: true });
    await writeFile(join(sharedSkills, "SKILL.md"), [
      "---", "name: project-method", "description: Shared project method", "---", "",
      "Use the shared project method.", "",
    ].join("\n"));
    await writeFile(join(root, "shared", "company.json"), `${JSON.stringify({
      schema: "noema.capabilities/1",
      skills: {
        directories: ["skills"],
        patches: { "project-method": { content_append: "Apply the company review rubric." } },
      },
      mcp: {},
    }, null, 2)}\n`);
    await writeFile(join(root, "noema-capabilities.json"), `${JSON.stringify({
      schema: "noema.capabilities/1",
      extends: [{ scope: "company", path: "shared/company.json" }],
      skills: {
        enabled: ["project-method"],
        patches: { "project-method": { content_append: "Use the patched project invariant.", configuration: { mode: "strict" } } },
      },
      mcp: {
        servers: [{ id: "project-tools", command: "/usr/bin/env", args: ["node", "tools.mjs"], env: [] }],
        enabled: ["project-tools"],
      },
    }, null, 2)}\n`);
    let notebook = createResearchNotebook({ title: "Capabilities", defaultAgent: "codex" });
    const work = createResearchCell(notebook, { kind: "work", title: "Use project environment", source: [
      "@@skill(project-method)", "", "Apply the project method.",
    ].join("\n") });
    notebook = work.notebook;
    const file = join(root, "research", "capabilities.noema");
    await writeResearchNotebookFile(file, notebook, { create: true });
    const provider = {
      runs: vi.fn(async () => []),
      prepareRun: vi.fn(async ({ run }) => ({ id: "run_capabilities", ...run })),
    };
    const service = createResearchRuntimeService({
      getProvider: () => provider as any,
      getRuntimeDescriptor: () => ({ mcpUrl: "http://127.0.0.1:43128/mcp" }),
    });
    const prepared = await service.prepareRun({ file, cellId: work.cell.id, cwd: root });
    expect(prepared.spec.skills).toEqual([expect.objectContaining({
      id: "project-method", scope: "company", configuration: { mode: "strict" },
      patches: [expect.objectContaining({ scope: "company" }), expect.objectContaining({ scope: "project" })],
    })]);
    expect(prepared.spec.prompt).toBe("Apply the project method.");
    expect(prepared.spec.mcp_servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "noema", type: "http" }),
      expect.objectContaining({ name: "project-tools", command: "/usr/bin/env" }),
    ]));
    expect(prepared.spec.capability_environment.active).toEqual({
      skills: ["project-method"], mcps: ["noema", "project-tools"],
    });
    expect(prepared.spec.capability_environment.skills.map((item: any) => item.id)).toEqual(["project-method"]);
    expect(prepared.spec.capability_environment.mcps.map((item: any) => item.id).sort()).toEqual(["noema", "project-tools"]);
    expect(prepared.contextItems.map((item: any) => item.ref)).toContain("skill:project-method");
    expect(Buffer.from(prepared.contextItems.find((item: any) => item.ref === "skill:project-method").contentBase64, "base64").toString())
      .toContain("company review rubric");
    expect(Buffer.from(prepared.contextItems.find((item: any) => item.ref === "skill:project-method").contentBase64, "base64").toString())
      .toContain("patched project invariant");
  }));

  test("selects agents by directive, document default, then request default", async () => withProject(async (root) => {
    await mkdir(join(root, "research"));
    let notebook = createResearchNotebook({ title: "Agents", defaultAgent: "opencode" });
    const directed = createResearchCell(notebook, { kind: "work", title: "Directed", source: "@@agent(claude)\n\nReview it." });
    notebook = directed.notebook;
    const inherited = createResearchCell(notebook, { kind: "work", title: "Inherited", source: "Review again." });
    notebook = inherited.notebook;
    const file = join(root, "research", "agents.noema");
    await writeResearchNotebookFile(file, notebook, { create: true });
    const provider = {
      runs: vi.fn(async () => []),
      prepareRun: vi.fn(async ({ run }) => ({ id: `run_${run.cellId}`, ...run })),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const first = await service.prepareRun({ file, cellId: directed.cell.id, cwd: root, agent: "codex" });
    const second = await service.prepareRun({ file, cellId: inherited.cell.id, cwd: root, agent: "codex" });
    expect(first.spec.agent.id).toBe("claude");
    expect(second.spec.agent.id).toBe("opencode");
  }));

  test("deduplicates depends and result context without parsing output directives", async () => withProject(async (root) => {
    await mkdir(join(root, "research"));
    let notebook = createResearchNotebook({ title: "Outputs", defaultAgent: "codex" });
    const evidence = createResearchCell(notebook, { kind: "work", title: "Evidence", source: "Find evidence." });
    notebook = evidence.notebook;
    notebook = upsertResearchRunOutput(notebook, {
      workId: evidence.workNode.id,
      runId: "run_evidence",
      agent: "pi",
      status: "completed",
      content: "@@agent(pi)\n\nPersisted evidence.",
    }).notebook;
    const synthesis = createResearchCell(notebook, {
      kind: "work",
      title: "Synthesis",
      source: `@@ctx(depends)\n@@ctx(result:${evidence.workNode.id})\n\nSynthesize it.`,
    });
    notebook = setResearchRelation(synthesis.notebook, synthesis.workNode.id, "depends", [evidence.workNode.id]).notebook;
    const file = join(root, "research", "outputs.noema");
    await writeResearchNotebookFile(file, notebook, { create: true });
    const provider = {
      runs: vi.fn(async () => []),
      prepareRun: vi.fn(async ({ run }) => ({ id: "run_synthesis", ...run })),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const prepared = await service.prepareRun({ file, cellId: synthesis.cell.id, cwd: root, agent: "claude" });
    // A new conversation first learns where it runs.
    expect(prepared.contextItems[0].ref).toBe("project");
    prepared.contextItems = prepared.contextItems.slice(1);
    expect(prepared.spec.agent.id).toBe("codex");
    expect(prepared.contextItems.map((item: any) => item.ref)).toEqual([
      `result:${evidence.workNode.id}`,
    ]);
    expect(prepared.contextItems.map((item: any) => Buffer.from(item.contentBase64, "base64").toString()))
      .toEqual(["@@agent(pi)\n\nPersisted evidence."]);
  }));

  test("counts duplicate file references only once against the context budget", async () => withProject(async (root) => {
    await writeFile(join(root, "context.md"), "x".repeat(35_000));
    const file = join(root, "read.noema");
    const work = createResearchCell(createResearchNotebook({ title: "Read", defaultAgent: "codex" }), {
      kind: "work", title: "Read", source: "@@ctx(file:context.md)\n@@ctx(file:./context.md)\n\nSummarize the attached text.",
    });
    await writeResearchNotebookFile(file, work.notebook, { create: true });
    const provider = { runs: vi.fn(async () => []), prepareRun: vi.fn(async ({ run }) => ({ id: "run_dedup", ...run })) };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const prepared = await service.prepareRun({ file, cellId: work.cell.id, cwd: root, agent: "codex" });
    expect(prepared.contextItems).toHaveLength(2);
    expect(Buffer.from(prepared.contextItems[1].contentBase64, "base64").byteLength).toBe(35_000);
  }));

  test("executes only the four strict .prompt directives and treats later lookalikes as data", async () => withProject(async (root) => {
    await mkdir(join(root, "prompts"));
    await mkdir(join(root, "notes"));
    await installProjectSkill(root, "proof-review");
    await writeFile(join(root, "notes", "known.md"), "Known input.\n");
    const file = join(root, "prompts", "proof.prompt");
    await writeFile(file, [
      "@agent(codex)",
      "@session(fresh)",
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
    expect(prepared.routing.policy).toBe("fresh");
    expect(prepared.spec.prompt).toBe("Investigate the bound.\n@agent(pi)");
    expect(prepared.contextItems).toHaveLength(2);
    expect(Buffer.from(prepared.contextItems[0].contentBase64, "base64").toString()).toBe("Known input.\n");
    expect(() => parseResearchPrompt("@budget(10)\nBody")).toThrow(/Unsupported/);
    expect(() => parseResearchPrompt("@@agent(codex)\n@@agent(claude)\nBody")).toThrow(/Conflicting/);
    expect(parseResearchPrompt("@@agent(codex)\n\nBody\n@@agent(pi)").prompt).toBe("Body\n@@agent(pi)");
  }));

  test("freezes note, artifact, and latest Handoff context with one shared limit", async () => withProject(async (root) => {
    await mkdir(join(root, "prompts"));
    const file = join(root, "prompts", "context.prompt");
    await writeFile(file, "@agent(codex)\n@session(continue)\n@workstream(ws_context)\n\nUse explicit evidence.");
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

  test("keeps legacy Result compatibility for reconstructed forks", async () => withProject(async (root) => {
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
    await writeFile(file, `${JSON.stringify(notebook, null, 2)}\n`);
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
    expect(prepared.contextItems[0].ref).toBe("project");
    prepared.contextItems = prepared.contextItems.slice(1);
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
    for (const suffix of ["cache:status", "cache:maintain", "cell:resolve", "capability:list", "capability:config", "capability:mutate", "run:prepare", "run:cancel", "run:fail-preparing", "run:live", "artifact:read", "artifact:import", "corpus:index", "corpus:index-files", "corpus:search", "corpus:block-read", "worker:lease", "worker:attach", "worker:start", "worker:events", "worker:permission", "worker:input", "permission:decide", "input:get", "input:respond", "attention:list", "proposal:create", "supervisor:propose", "proposal:get", "proposal:list", "proposal:review", "finding:get", "finding:list", "research-ir:list", "problem-model:list", "export:create", "task:create", "task:list", "task:transition", "job:create", "job:list", "job:claim", "job:start", "job:lease-renew", "job:lease-expire", "job:complete", "job:fail", "job:unresolved", "job:retry", "invocation:list", "scheduler-worker:register", "scheduler-worker:list", "delegation:create", "delegation:list", "orchestration:snapshot", "session:promote", "session:list", "session:get", "session:context", "session:compact", "session:takeover", "session:handback", "history:index", "history:search", "history:peek", "history:read"]) {
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

  test("a Run cancelled before dispatch writes its cancellation to the cell", async () => withProject(async (root) => {
    const file = join(root, "research", "bound.noema");
    await mkdir(join(root, "research"));
    await writeFile(file, "{}");
    let pending: Record<string, unknown> | null = null;
    const provider = {
      requestRunCancellation: vi.fn(async ({ cancellation }) => ({
        id: cancellation.runId, notebookId: "nb_1", cellId: "c-work", workNodeId: "wn-work", status: "cancelled",
      })),
      resolveCell: vi.fn(async () => ({ notebookId: "nb_1", cellId: "c-work", path: "research/bound.noema" })),
      queueNotebookWriteback: vi.fn(async ({ writeback }) => {
        pending = { ...writeback, state: "pending", attempts: 0 };
        return pending;
      }),
      claimNotebookWritebacks: vi.fn(async () => {
        if (!pending) return [];
        const claimed = { ...pending, state: "writing", attempts: 1 };
        pending = null;
        return [claimed];
      }),
      completeNotebookWriteback: vi.fn(async ({ writeback }) => writeback),
    };
    const notebooks = { writeRunOutput: vi.fn(async (body) => ({ cell: { id: "c-work" }, ...body })) };
    const service = createResearchRuntimeService({
      getProvider: () => provider as any, getNotebookService: () => notebooks,
    });
    await expect(service.cancelRun({ root, runId: "run_early", requestedBy: "web" }))
      .resolves.toMatchObject({ run: { status: "cancelled" }, result: { cell: { id: "c-work" } }, resultError: null });
    expect(notebooks.writeRunOutput).toHaveBeenCalledWith(expect.objectContaining({
      file: await realpath(file), cellId: "c-work", runId: "run_early", status: "cancelled",
    }));
  }));

  test("persists a pre-dispatch failure as the cell output", async () => withProject(async (root) => {
    const file = join(root, "research", "bound.noema");
    await mkdir(join(root, "research"));
    await writeFile(file, "{}");
    let pending: Record<string, unknown> | null = null;
    const provider = {
      failPreparedRun: vi.fn(async ({ failure }) => ({
        id: failure.runId, notebookId: "nb_1", cellId: "c-work", workNodeId: "wn-work", status: "failed",
      })),
      queueNotebookWriteback: vi.fn(async ({ writeback }) => {
        pending = { ...writeback, state: "pending", attempts: 0 };
        return pending;
      }),
      claimNotebookWritebacks: vi.fn(async () => {
        if (!pending) return [];
        const claimed = { ...pending, state: "writing", attempts: 1 };
        pending = null;
        return [claimed];
      }),
      completeNotebookWriteback: vi.fn(async ({ writeback }) => writeback),
    };
    const notebooks = { writeRunOutput: vi.fn(async (body) => ({ cell: { id: "c-work" }, ...body })) };
    const service = createResearchRuntimeService({
      getProvider: () => provider as any,
      getNotebookService: () => notebooks,
    });
    await expect(service.failPreparingRun({
      root, notebookFile: file, runId: "run_boot", failureReason: "ACP dispatch failed: adapter missing",
    })).resolves.toMatchObject({ run: { id: "run_boot", status: "failed" }, result: { cell: { id: "c-work" } }, resultError: null });
    expect(notebooks.writeRunOutput).toHaveBeenCalledWith(expect.objectContaining({
      file: await realpath(file), cellId: "c-work", runId: "run_boot", status: "failed",
      content: "ACP dispatch failed: adapter missing",
    }));
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

  test("a completion winning the cancel race returns the durable outcome", async () => withProject(async (root) => {
    const deliverWorkerCommand = vi.fn(() => true);
    const service = createResearchRuntimeService({ getProvider: () => ({
      requestRunCancellation: async () => { throw new Error("already completed"); },
      run: async () => ({ id: "r", status: "completed" }),
    }) as any, deliverWorkerCommand });
    await expect(service.cancelRun({ root, runId: "r" })).resolves.toMatchObject({ run: { status: "completed" }, delivered: false });
    expect(deliverWorkerCommand).not.toHaveBeenCalled();
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
	let pending: Record<string, unknown> | null = null;
    const provider = {
      reportWorkerEvents: vi.fn(async () => [{ id: "evt_1" }]),
      run: vi.fn(async () => ({
        id: "run_1", notebookId: "nb_1", cellId: "c-work", workNodeId: "wn-work", status: "completed",
      })),
	  queueNotebookWriteback: vi.fn(async ({ writeback }) => {
		pending = { ...writeback, state: "pending", attempts: 0 };
		return pending;
	  }),
	  claimNotebookWritebacks: vi.fn(async () => {
		if (!pending) return [];
		const claimed = { ...pending, state: "writing", attempts: 1 };
		pending = null;
		return [claimed];
	  }),
	  completeNotebookWriteback: vi.fn(async ({ writeback }) => writeback),
    };
    const notebooks = { writeRunOutput: vi.fn(async (body) => ({ cell: { id: "c-work" }, ...body })) };
    const service = createResearchRuntimeService({
      getProvider: () => provider as any,
      getNotebookService: () => notebooks,
    });
    const reply = await service.workerEvents({
      root, notebookFile: file, runId: "run_1", sessionId: "ses_1", owner: "emacs:1", epoch: 1,
      events: [{ type: "run.status.changed", payload: { status: "completed", result_text: "A bounded proof." } }],
    });
    expect(reply).toMatchObject({ events: [{ id: "evt_1" }], result: { cell: { id: "c-work" } }, resultError: null });
    expect(notebooks.writeRunOutput).toHaveBeenCalledWith(expect.objectContaining({
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
    // D-035: agent-shell transcripts, Pi state and work documents are not work products.
    await mkdir(join(root, ".agent-shell", "transcripts"), { recursive: true });
    await writeFile(join(root, ".agent-shell", "transcripts", "2026-09-15.md"), "transcript\n");
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "settings.json"), "{}\n");
    await writeFile(join(root, "scratch.noema"), "{}\n");

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

	test("runs a Python project file without an agent and links generated artifacts", async () => withProject(async (root) => {
	  const researchDir = join(root, "research");
	  await mkdir(researchDir);
	  let notebook = createResearchNotebook({ title: "Local experiment" });
	  const work = createResearchCell(notebook, { kind: "work", title: "Run experiment", source: "Execute the project experiment." });
	  notebook = work.notebook;
	  const file = join(researchDir, "experiment.noema");
	  await writeResearchNotebookFile(file, notebook, { create: true });
	  const script = join(root, "experiment.py");
	  await writeFile(script, "from pathlib import Path\nprint('answer=42')\nPath('generated.txt').write_text('artifact')\n");
	  let durableRun: any;
	  const provider = {
		index: vi.fn(async () => ({})),
		prepareRun: vi.fn(async ({ run }: any) => {
		  durableRun = { id: "run_project_py", ...run, status: "preparing" };
		  return durableRun;
		}),
		startLocalRun: vi.fn(async () => ({ ...durableRun, status: "running" })),
		reportLocalRunEvents: vi.fn(async ({ events }: any) => events.events),
		importArtifact: vi.fn(async () => ({ id: "art_generated" })),
	  };
	  const service = createResearchRuntimeService({ getProvider: () => provider as any });
	  const started = await service.runProjectFile({
		file, cellId: work.cell.id, root, projectFile: script, interpreter: "python3", confirmed: true,
	  });
	  expect(started).toMatchObject({ run: { id: "run_project_py", sourceKind: "project-file", status: "running" } });
	  expect(started.spec).toMatchObject({
		source: { kind: "project-file", file: "experiment.py", notebook_file: "research/experiment.noema",
		  work_node_id: work.workNode.id },
		executor: { kind: "python", command: "python3" },
		capabilities: { execute: "allow", write_project: "allow", network: "ask" },
	  });
	  await vi.waitFor(() => expect(provider.reportLocalRunEvents.mock.calls.flatMap((call: any) => call[0].events.events)
		.some((event: any) => event.type === "run.status.changed" && event.payload.status === "completed")).toBe(true));
	  const reported = provider.reportLocalRunEvents.mock.calls.flatMap((call: any) => call[0].events.events);
	  expect(reported.some((event: any) => event.type === "run.content.segment" && event.payload.text.includes("answer=42"))).toBe(true);
	  expect(reported.some((event: any) => event.type === "run.artifact.detected" && event.payload.path === "generated.txt")).toBe(true);
	  expect(provider.importArtifact).toHaveBeenCalledWith(expect.objectContaining({
		artifact: expect.objectContaining({ runId: "run_project_py", sourceUri: "noema://file/generated.txt" }),
	  }));
	}));

	test("records Jupyter project-file MIME outputs on the same Run", async () => withProject(async (root) => {
	  const researchDir = join(root, "research");
	  await mkdir(researchDir);
	  let notebook = createResearchNotebook({ title: "Notebook experiment" });
	  const work = createResearchCell(notebook, { kind: "work", title: "Run notebook", source: "Execute all cells." });
	  notebook = work.notebook;
	  const file = join(researchDir, "owner.noema");
	  const projectNotebook = join(root, "experiment.ipynb");
	  await writeResearchNotebookFile(file, notebook, { create: true });
	  await writeFile(projectNotebook, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }));
	  let durableRun: any;
	  const provider = {
		index: vi.fn(async () => ({})),
		prepareRun: vi.fn(async ({ run }: any) => {
		  durableRun = { id: "run_project_ipynb", ...run, status: "preparing" };
		  return durableRun;
		}),
		startLocalRun: vi.fn(async () => ({ ...durableRun, status: "running" })),
		reportLocalRunEvents: vi.fn(async ({ events }: any) => events.events),
		importArtifact: vi.fn(async () => ({ id: "art_notebook" })),
	  };
	  const jupyter = { documentExecute: vi.fn(async () => ({ ok: true, results: [{
		outputs: [{ output_type: "display_data", data: { "text/html": "<b>42</b>", "text/plain": "42" }, metadata: {} }],
	  }] })) };
	  const service = createResearchRuntimeService({
		getProvider: () => provider as any, getJupyterService: () => jupyter as any,
	  });
	  await service.runProjectFile({ file, cellId: work.cell.id, root, projectFile: projectNotebook, confirmed: true });
	  await vi.waitFor(() => expect(provider.reportLocalRunEvents.mock.calls.flatMap((call: any) => call[0].events.events)
		.some((event: any) => event.type === "run.status.changed")).toBe(true));
	  expect(jupyter.documentExecute).toHaveBeenCalledWith(expect.objectContaining({
		scriptFile: projectNotebook, projectRoot: root, mode: "all",
	  }));
	  expect(provider.reportLocalRunEvents.mock.calls.flatMap((call: any) => call[0].events.events))
		.toContainEqual(expect.objectContaining({ type: "run.jupyter.outputs", payload: { outputs: [expect.objectContaining({ output_type: "display_data" })] } }));
	}));

  test("fails closed for Pi denied capabilities without an external sandbox", async () => withProject(async (root) => {
    const researchDir = join(root, "research");
    await mkdir(researchDir);
    let notebook = createResearchNotebook({ title: "Bound" });
    const work = createResearchCell(notebook, { kind: "work", title: "Attempt", source: "@@agent(pi)\n\nInspect safely." });
    notebook = work.notebook;
    const file = join(researchDir, "bound.noema");
    await writeResearchNotebookFile(file, notebook, { create: true });
    const service = createResearchRuntimeService({ getProvider: () => ({ sessions: async () => [] }) as any });
    await expect(service.prepareRun({ file, cellId: work.cell.id, cwd: root, capabilities: { network: "deny" } }))
      .rejects.toMatchObject({ code: "ERR_RESEARCH_CAPABILITY" });
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
