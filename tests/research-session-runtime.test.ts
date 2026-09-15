import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchRuntimeService } from "../server/lib/research-runtime.mjs";
import { createResearchCell, createResearchNotebook, writeResearchNotebookFile } from "../server/lib/research-notebook.mjs";

async function withProject<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "noema-session-runtime-"));
  try {
    await writeFile(join(root, "noema.toml"), "schema = 1\nrepository_id = \"0199\"\n");
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function lineageDocument(root: string) {
  let notebook = createResearchNotebook({ title: "Named sessions" });
  const a = createResearchCell(notebook, { kind: "work", title: "Baseline", source: "Fit the baseline." });
  notebook = a.notebook;
  const b = createResearchCell(notebook, { kind: "work", title: "Add features", source: "Add features.", lineageParent: a.workNode.id });
  notebook = b.notebook;
  const c = createResearchCell(notebook, { kind: "work", title: "Ablate", source: "Ablate.", lineageParent: a.workNode.id });
  notebook = c.notebook;
  const pinned = createResearchCell(notebook, { kind: "work", title: "Pinned", source: "@@session(helper)\n\nUse helper." });
  notebook = pinned.notebook;
  const file = join(root, "work.noema");
  await writeResearchNotebookFile(file, notebook, { create: true });
  return { file, a, b, c, pinned };
}

function providerFor(root: string, a: any, overrides: Record<string, unknown> = {}) {
  const session = { id: "ses_a", state: "warm", executionTarget: root, adapter: "codex", nativeSessionId: "native-a", capabilities: {} };
  return {
    index: vi.fn(async () => ({})),
    sessionNames: vi.fn(async () => [{
      name: "baseline", agent: "codex", sessionId: "ses_a", aliases: [], state: "active", openRun: false,
      lastRun: { workNodeId: a.workNode.id },
    }, { name: "helper", agent: "codex", sessionId: "", aliases: [], state: "active", openRun: false }]),
    runs: vi.fn(async () => [{ id: "run_a", workNodeId: a.workNode.id, sessionId: "ses_a", sessionName: "baseline" }]),
    session: vi.fn(async () => session),
    sessions: vi.fn(async () => [session]),
    liveRun: vi.fn(async () => ({ events: [], seq: 0 })),
    prepareRun: vi.fn(async ({ run }) => ({ id: "run_new", ...run })),
    ...overrides,
  };
}

describe("D-031 named session routing in prepareRun", () => {
  test("a lineage child continues the parent's named session and freezes the name", async () => withProject(async (root) => {
    const { file, a, b } = await lineageDocument(root);
    const provider = providerFor(root, a);
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const prepared = await service.prepareRun({ file, cellId: b.cell.id, cwd: root });
    expect(prepared.routing).toMatchObject({ mode: "continued", sessionId: "ses_a" });
    expect(prepared.spec.session).toMatchObject({ name: "baseline", derivation: { rule: "lineage-continue" } });
    expect(provider.prepareRun).toHaveBeenCalledWith({
      root, run: expect.objectContaining({ sessionId: "ses_a", sessionName: expect.objectContaining({ name: "baseline", origin: "derived" }) }),
    });
  }));

  test("a busy named session is refused for a Run but reported by the dry run", async () => withProject(async (root) => {
    const { file, a, b } = await lineageDocument(root);
    const names = await providerFor(root, a).sessionNames();
    names[0].openRun = true;
    names[0].lastRun = { workNodeId: a.workNode.id };
    const provider = providerFor(root, a, { sessionNames: vi.fn(async () => names) });
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    // A busy head makes a lineage child branch instead of queueing behind it.
    const branched = await service.prepareRun({ file, cellId: b.cell.id, cwd: root });
    expect(branched.routing.sessionName).toMatchObject({ name: "baseline/add-features", parentName: "baseline" });
    await expect(service.prepareRun({ file, cellId: b.cell.id, cwd: root, sessionPolicy: "baseline" }))
      .rejects.toMatchObject({ code: "ERR_RESEARCH_SESSION_BUSY" });
    const resolved = await service.resolveSessions({ file, cwd: root, cellIds: [b.cell.id] });
    expect(resolved.sessions[0]).toMatchObject({ cellId: b.cell.id, name: "baseline/add-features", mode: "fork-reconstructed" });
  }));

  test("a sibling branch forks with lineage context and a lost session is rebuilt under its name", async () => withProject(async (root) => {
    const { file, a, b, c } = await lineageDocument(root);
    const names = await providerFor(root, a).sessionNames();
    names[0].lastRun = { workNodeId: b.workNode.id };
    const provider = providerFor(root, a, { sessionNames: vi.fn(async () => names) });
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const branch = await service.prepareRun({ file, cellId: c.cell.id, cwd: root });
    expect(branch.routing).toMatchObject({ mode: "fork-reconstructed", parentSessionId: "ses_a" });
    expect(branch.spec.session).toMatchObject({ name: "baseline/ablate", parent_name: "baseline" });
    expect(branch.spec.fork_mode).toBe("reconstructed");
    expect(branch.spec.context.map((item: any) => item.ref)).toContain(`cell:${a.cell.id}`);

    const lost = providerFor(root, a, {
      session: vi.fn(async () => ({ id: "ses_a", state: "lost", executionTarget: root, adapter: "codex", capabilities: {} })),
    });
    const rebuilt = await createResearchRuntimeService({ getProvider: () => lost as any })
      .prepareRun({ file, cellId: a.cell.id, cwd: root });
    expect(rebuilt.routing).toMatchObject({ mode: "fork-reconstructed", parentSessionId: "ses_a" });
    expect(rebuilt.routing.sessionName.name).toBe("baseline");
  }));

  test("a written @@session outranks a coordinator-requested name", async () => withProject(async (root) => {
    const { file, a, pinned } = await lineageDocument(root);
    const provider = providerFor(root, a);
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const prepared = await service.prepareRun({ file, cellId: pinned.cell.id, cwd: root, sessionName: "baseline" });
    expect(prepared.routing.sessionName).toMatchObject({ name: "helper", origin: "user" });
    expect(prepared.routing.mode).toBe("fresh");
  }));

  test("coordinator endpoint and name binding channels keep Pi narrow", async () => withProject(async (root) => {
    const provider = { bindSessionName: vi.fn(async ({ intent }) => intent) };
    const service = createResearchRuntimeService({
      getProvider: () => provider as any,
      getRuntimeDescriptor: () => ({ mcpUrl: "http://127.0.0.1:1/mcp" }),
    });
    await expect(service.coordinatorEndpoint()).resolves.toEqual({
      mcpUrl: "http://127.0.0.1:1/mcp", coordinatorUrl: "http://127.0.0.1:1/mcp/coordinator",
    });
    await expect(service.bindSessionName({ cwd: root, name: "pi", agent: "pi", sessionId: "ses_pi" }))
      .resolves.toMatchObject({ name: { name: "pi", origin: "system" } });
    await expect(service.bindSessionName({ cwd: root, name: "helper", sessionId: "ses_h" }))
      .resolves.toMatchObject({ name: { name: "helper", origin: "user" } });
    await expect(service.bindSessionName({ cwd: root, name: "helper", sessionId: "nope" }))
      .rejects.toMatchObject({ code: "ERR_RESEARCH_SESSION_NAME" });
  }));
});
