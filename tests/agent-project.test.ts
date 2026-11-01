// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentMemorySearch, agentProjectMaintain, agentProjectStatus } from "../server/lib/agent-project.mjs";
import { searchHyMemory } from "../server/lib/hy-memory-bridge.mjs";

let directory: string, project: string;
const manifest = `[project]\nid = "demo"\n`;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-project-"));
  project = join(directory, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "noema.toml"), manifest);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const cache = { totalBytes: 10, pressure: false };
const withStore = () => {
  mkdirSync(join(project, ".agent"));
  writeFileSync(join(project, ".agent/state.sqlite"), "");
};

test("C52 status outside a Project names no cache and creates nothing", async () => {
  const call = vi.fn();
  const status = await agentProjectStatus({ root: directory }, { call });
  expect(status.project).toBeNull();
  expect(status.cache).toBeNull();
  expect(status.memory.scope).toBe(directory);
  expect(call).not.toHaveBeenCalled();
});

test("C52 a Project without a store is read without creating one", async () => {
  const call = vi.fn();
  const status = await agentProjectStatus({ root: join(project, "src") }, { call });
  expect(status.project).toMatchObject({ root: project, id: "demo", workspace: project });
  expect(status.cache).toBeNull();
  expect(call).not.toHaveBeenCalled();
  expect(existsSync(join(project, ".agent"))).toBe(false);
  await expect(agentProjectMaintain({ root: project }, { call })).resolves.toEqual({ root: project, cache: null });
});

test("C52 status and maintenance go through the kernel's cache channels", async () => {
  withStore();
  const call = vi.fn(async () => ({ cache }));
  const status = await agentProjectStatus({ root: project }, { call });
  expect(status.cache).toEqual(cache);
  expect(status.project.stateDirectory).toBe(join(project, ".agent"));
  expect(call).toHaveBeenLastCalledWith("noema:api:research:cache:status", [{ root: project }]);
  await agentProjectMaintain({ root: join(project, "src") }, { call });
  expect(call).toHaveBeenLastCalledWith("noema:api:research:cache:maintain", [{ root: project }]);
  await expect(agentProjectMaintain({ root: directory }, { call })).rejects.toMatchObject({ statusCode: 404 });
  await expect(agentProjectStatus({ root: "relative" }, { call })).rejects.toMatchObject({ statusCode: 400 });
});

test("C52 explicit recall uses the Project scope and keeps unknown distinct from empty", async () => {
  const search = vi.fn(async () => ({ state: "suspended", items: [] }));
  const result = await agentMemorySearch({ root: join(project, "src"), query: "cache" }, { search });
  expect(search).toHaveBeenCalledWith(project, "cache");
  expect(result).toMatchObject({ scope: project, state: "suspended" });
  expect(result.trust).toContain("unverified");
  await expect(agentMemorySearch({ root: project, query: " " }, { search })).rejects.toMatchObject({ statusCode: 400 });
});

test("C52 an unconfigured bridge is unknown, not an empty answer", async () => {
  const python = join(directory, "python"), config = join(directory, "memory.env");
  writeFileSync(config, "MEMORY_EMBEDDER_BASE_URL=x\nMEMORY_EMBEDDER_MODEL=x\nMEMORY_EMBEDDER_API_KEY=x\n");
  const script = (body: string) => { writeFileSync(python, `#!/bin/sh\ncat >/dev/null\n${body}\n`, { mode: 0o755 }); };
  const saved = { ...process.env };
  process.env.NOEMA_HY_MEMORY_PYTHON = python;
  process.env.NOEMA_HY_MEMORY_CONFIG = config;
  try {
    script(`echo '{"items":[],"configured":false}'`);
    expect(await searchHyMemory(project, "q")).toEqual({ state: "unconfigured", items: [] });
    script(`echo '{"items":[{"content":"kept"},{"content":7}]}'`);
    expect(await searchHyMemory(project, "q")).toEqual({ state: "ok", items: [{ content: "kept" }] });
    script(`echo '{"items":[]}'`);
    expect((await searchHyMemory(project, "q")).state).toBe("ok");
    script("exit 3");
    expect((await searchHyMemory(project, "q")).state).toBe("suspended");
    expect((await searchHyMemory(project, "q")).state).toBe("suspended");
  } finally { process.env = saved; }
});

test.each(['{}', '{"items":null}', '{"items":{}}', 'null', 'not json'])(
  "C52 malformed memory output suspends recall instead of claiming an empty result: %s", async (output) => {
    const python = join(directory, "python"), config = join(directory, "memory.env");
    writeFileSync(config, "MEMORY_EMBEDDER_BASE_URL=x\nMEMORY_EMBEDDER_MODEL=x\nMEMORY_EMBEDDER_API_KEY=x\n");
    writeFileSync(python, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${output}'\n`, { mode: 0o755 });
    const saved = { ...process.env };
    process.env.NOEMA_HY_MEMORY_PYTHON = python;
    process.env.NOEMA_HY_MEMORY_CONFIG = config;
    try {
      vi.resetModules();
      const { searchHyMemory: search } = await import("../server/lib/hy-memory-bridge.mjs");
      expect((await search(project, "q")).state).toBe("suspended");
    } finally { process.env = saved; }
  });
