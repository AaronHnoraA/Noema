// @vitest-environment node
import { expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { listAgentSkills, readAgentSkill } from "../server/lib/agent-skills.mjs";
import extension from "../resources/pi/extensions/noema-manager/index";

async function tree(run: (root: string, options: any) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "pi-skills-"));
  const root = join(temporary, "project"), library = join(temporary, "skills"), builtin = join(temporary, "builtin");
  try {
    await Promise.all([mkdir(root), mkdir(library), mkdir(builtin)]);
    const globalConfigPath = join(temporary, "global.json");
    await writeFile(globalConfigPath, JSON.stringify({ schema: "noema.capabilities/1" }));
    for (const id of ["ops", "helper"])
      await mkdir(join(library, id));
    await writeFile(join(library, "ops/SKILL.md"), "---\nname: ops\ndescription: Manage an existing Agent\nnoema:\n  requires: [helper]\n---\nPrivate body loaded only on demand.\n");
    await writeFile(join(library, "helper/SKILL.md"), "---\nname: helper\ndescription: Context helper\n---\nA dependency.\n");
    await run(root, { environment: {}, userHome: temporary, globalConfigPath,
      globalSkillDirectory: library, builtinSkillDirectory: builtin });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test("Pi catalog discloses descriptors and dependencies, then reads one patched Skill", async () => {
  await tree(async (root, options) => {
    await writeFile(join(root, "noema-capabilities.json"), JSON.stringify({ schema: "noema.capabilities/1",
      skills: { patches: { ops: { content_append: "Project-specific instructions." } } } }));
    const catalog = await listAgentSkills({ root, requestedSkills: ["ops"] }, options);
    expect(catalog.skills.map((item: any) => item.id).sort()).toEqual(["helper", "ops"]);
    expect(catalog.skills.find((item: any) => item.id === "ops").description).toContain("existing Agent");
    expect(JSON.stringify(catalog)).not.toContain("Private body");
    const one = await readAgentSkill({ root, id: "ops", requestedSkills: [] }, options);
    expect(one.content).toContain("Private body");
    expect(one.content).toContain("Project-specific instructions.");
    expect(one.source).toContain("ops/SKILL.md");
    expect(one.digest).toMatch(/^sha256:/);
  });
});

test("Pi respects project disables and does not replace them with the global definition", async () => {
  await tree(async (root, options) => {
    await writeFile(join(root, "noema-capabilities.json"), JSON.stringify({ schema: "noema.capabilities/1",
      skills: { disabled: ["ops"] } }));
    const catalog = await listAgentSkills({ root, requestedSkills: ["ops"] }, options);
    expect(catalog.skills.some((item: any) => item.id === "ops")).toBe(false);
    await expect(readAgentSkill({ root, id: "ops", requestedSkills: [] }, options)).rejects.toMatchObject({ statusCode: 409 });
    await expect(readAgentSkill({ root, id: "missing", requestedSkills: [] }, options)).rejects.toMatchObject({ statusCode: 404 });
  });
});

test("Pi follows pack membership edited in the existing Skill manager, without its own list", async () => {
  await tree(async (root, options) => {
    const savePack = async (members: string[]) => writeFile(options.globalConfigPath, JSON.stringify({
      schema: "noema.capabilities/1", packs: { definitions: { "noema-emacs": { members, agent_catalog: true } } },
    }));
    await savePack(["ops"]);
    const before = await listAgentSkills({ root }, options);
    expect(before.packs.map((pack: any) => pack.id)).toEqual(["noema-emacs"]);
    expect(before.skills.map((item: any) => item.id).sort()).toEqual(["helper", "ops"]);
    await savePack(["helper"]);
    const after = await listAgentSkills({ root }, options);
    expect(after.skills.map((item: any) => item.id)).toEqual(["helper"]);
    await writeFile(options.globalConfigPath, JSON.stringify({ schema: "noema.capabilities/1",
      packs: { definitions: { "noema-emacs": { members: ["ops"], agent_catalog: true } }, disabled: ["noema-emacs"] } }));
    expect((await listAgentSkills({ root }, options)).skills).toEqual([]);
  });
});

test("C19 catalog carries each pack's preamble and omits globally enabled strangers", async () => {
  await tree(async (root, options) => {
    await writeFile(options.globalConfigPath, JSON.stringify({ schema: "noema.capabilities/1",
      skills: { enabled: ["helper"] },
      packs: { definitions: {
        "noema-emacs": { members: ["ops"], preamble: "Repository rules win.", agent_catalog: true },
        "domain": { members: ["stranger"] } } } }));
    await mkdir(join(options.globalSkillDirectory, "stranger"));
    await writeFile(join(options.globalSkillDirectory, "stranger/SKILL.md"),
      "---\nname: stranger\ndescription: Unrelated domain tool\n---\nBody.\n");
    const global = JSON.parse((await readFile(options.globalConfigPath, "utf8")));
    global.skills.enabled.push("stranger");
    await writeFile(options.globalConfigPath, JSON.stringify(global));
    const catalog = await listAgentSkills({ root }, options);
    expect(catalog.packs).toEqual([{ id: "noema-emacs", members: ["ops"], preamble: "Repository rules win." }]);
    expect(catalog.skills.map((item: any) => item.id).sort()).toEqual(["helper", "ops"]);
    const read = await readAgentSkill({ root, id: "stranger" }, options);
    expect(read.content).toContain("Body.");
    const explicit = await listAgentSkills({ root, requestedPacks: ["domain"] }, options);
    expect(explicit.packs.map((pack: any) => pack.id)).toEqual(["domain"]);
  });
});

test.each(["emacs", "/tmp/project/"])("Pi injects a scoped catalog without a native read tool: %s", async (scope) => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-extension-"));
  const saved = { ...process.env };
  let request: any;
  const server = createServer(async (incoming, response) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    request = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ skills: [{ id: "ops", description: "Agent operations" }] }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const descriptor = join(temporary, "host.json");
    await writeFile(descriptor, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${address.port}` }));
    process.env.NOEMA_HOST_DESCRIPTOR = descriptor;
    process.env.NOEMA_PI_SOURCE = process.cwd();
    process.env.NOEMA_PI_SCOPE = scope;
    const handlers = new Map<string, Function>();
    let active = ["bash"];
    extension({ on: (event: string, handler: Function) => handlers.set(event, handler),
      getAllTools: () => [{ name: "bash" }, { name: "mcp__noema-api__noema_api" }],
      getActiveTools: () => active, setActiveTools: (tools: string[]) => { active = tools; } });
    await handlers.get("session_start")!();
    expect(request).toBeUndefined();
    const result = await handlers.get("before_agent_start")!({ systemPrompt: "Base" }, { cwd: "/tmp/elsewhere" });
    expect(result.systemPrompt).toContain("Agent operations");
    expect(active).toEqual(["mcp__noema-api__noema_api"]);
    const operation = request.args[0];
    expect(operation.channel).toBe("noema:api:agent:skill:list");
    expect(operation.args[0]).toEqual(scope === "emacs"
      ? { scope: "global" } : { root: scope });
  } finally {
    process.env = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});

test("C19 the catalog is what the pack library marks, and a pack's own flag is validated", async () => {
  await tree(async (root, options) => {
    await writeFile(options.globalConfigPath, JSON.stringify({ schema: "noema.capabilities/1",
      packs: { definitions: { marked: { members: ["ops"], agent_catalog: true }, plain: { members: ["helper"] } } } }));
    const catalog = await listAgentSkills({ root }, options);
    expect(catalog.packs.map((pack: any) => pack.id)).toEqual(["marked"]);
    await writeFile(join(root, "noema-capabilities.json"), JSON.stringify({ schema: "noema.capabilities/1",
      packs: { definitions: { plain: { members: ["helper"], agent_catalog: true } } } }));
    expect((await listAgentSkills({ root }, options)).packs.map((pack: any) => pack.id)).toEqual(["marked", "plain"]);
    await writeFile(options.globalConfigPath, JSON.stringify({ schema: "noema.capabilities/1",
      packs: { definitions: { marked: { members: ["ops"], agent_catalog: "yes" } } } }));
    await expect(listAgentSkills({ root }, options)).rejects.toThrow(/agent_catalog/);
  });
});

test("C19 catalog flags follow project patches, overrides and disables", async () => {
  await tree(async (root, options) => {
    await writeFile(options.globalConfigPath, JSON.stringify({ schema: "noema.capabilities/1",
      packs: { definitions: { marked: { members: ["ops"], agent_catalog: true }, plain: { members: ["helper"] } } } }));
    const saveProject = async (packs: any) => writeFile(join(root, "noema-capabilities.json"),
      JSON.stringify({ schema: "noema.capabilities/1", packs }));
    await saveProject({ patches: { marked: { agent_catalog: false }, plain: { agent_catalog: true } } });
    expect((await listAgentSkills({ root }, options)).packs.map((pack: any) => pack.id)).toEqual(["plain"]);
    await saveProject({ definitions: { marked: { members: ["ops"] } } });
    expect((await listAgentSkills({ root }, options)).packs).toEqual([]);
    await saveProject({ patches: { marked: { agent_catalog: null } } });
    expect((await listAgentSkills({ root }, options)).packs).toEqual([]);
    await saveProject({ disabled: ["marked"] });
    expect(await listAgentSkills({ root }, options)).toMatchObject({ packs: [], skills: [], diagnostics: [] });
    const explicit = await listAgentSkills({ root, requestedPacks: ["marked"] }, options);
    expect(explicit.diagnostics).toContainEqual(expect.objectContaining({ id: "marked", code: "disabled-capability-requested" }));
    await saveProject({ patches: { marked: { agent_catalog: "yes" } } });
    await expect(listAgentSkills({ root }, options)).rejects.toThrow(/agent_catalog/);
  });
});

test("C19 follows only the chosen Skills' dependency closure and related diagnostics", async () => {
  await tree(async (root, options) => {
    await writeFile(options.globalConfigPath, JSON.stringify({ schema: "noema.capabilities/1", skills: { enabled: ["ops"] } }));
    expect(await listAgentSkills({ root }, options)).toMatchObject({ skills: [], diagnostics: [] });
    await writeFile(options.globalConfigPath, JSON.stringify({ schema: "noema.capabilities/1",
      packs: { definitions: { domain: { members: ["ops"] } }, enabled: ["domain"] } }));
    expect(await listAgentSkills({ root }, options)).toMatchObject({ packs: [], skills: [], diagnostics: [] });
    // A project extension is an explicit project choice, even with a custom scope name.
    await writeFile(join(root, "team.json"), JSON.stringify({ schema: "noema.capabilities/1", skills: { enabled: ["ops"] } }));
    await writeFile(join(root, "noema-capabilities.json"), JSON.stringify({ schema: "noema.capabilities/1",
      extends: [{ scope: "team", path: "team.json" }] }));
    expect((await listAgentSkills({ root }, options)).skills.map((skill: any) => skill.id).sort()).toEqual(["helper", "ops"]);
    await writeFile(join(options.globalSkillDirectory, "helper/SKILL.md"),
      "---\nname: helper\ndescription: Context helper\nnoema:\n  requires: [missing]\n---\nHelper.\n");
    const selected = await listAgentSkills({ root }, options);
    expect(selected.skills).toEqual([]);
    expect(selected.diagnostics).toContainEqual(expect.objectContaining({ id: "helper", code: "skill-dependency-missing" }));
    await writeFile(join(root, "noema-capabilities.json"), JSON.stringify({ schema: "noema.capabilities/1" }));
    expect(await listAgentSkills({ root }, options)).toMatchObject({ skills: [], diagnostics: [] });
  });
});

test("C19 dependency aliases use canonical ids even when already globally enabled", async () => {
  await tree(async (root, options) => {
    await writeFile(join(options.globalSkillDirectory, "helper/SKILL.md"),
      "---\nname: canonical-helper\ndescription: Context helper\n---\nHelper.\n");
    await writeFile(options.globalConfigPath, JSON.stringify({ schema: "noema.capabilities/1",
      skills: { enabled: ["canonical-helper"] } }));
    const result = await listAgentSkills({ root, requestedSkills: ["ops"] }, options);
    expect(result.skills.map((skill: any) => skill.id).sort()).toEqual(["canonical-helper", "ops"]);
    expect(result.diagnostics).toEqual([]);
  });
});

test("what Pi carries on every turn stays small", async () => {
  const { readFile } = await import("node:fs/promises");
  const prompt = await readFile(join(process.cwd(), "resources/pi/SYSTEM.md"), "utf8");
  expect(prompt.length).toBeLessThanOrEqual(4_300);
});

test("a Skill's body stays small enough to read for one question", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const skills = join(process.cwd(), "resources/skills");
  for (const id of await readdir(skills)) {
    const text = await readFile(join(skills, id, "SKILL.md"), "utf8").catch(() => "");
    expect([id, text.length <= 3_200]).toEqual([id, true]);
  }
});

test("the catalog stays small: descriptions and preambles have budgets", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const skills = join(process.cwd(), "resources/skills");
  for (const id of await readdir(skills)) {
    const text = await readFile(join(skills, id, "SKILL.md"), "utf8").catch(() => "");
    const description = /^description: (.*)$/m.exec(text)?.[1] ?? "";
    expect([id, description.length <= 260]).toEqual([id, true]);
  }
  const config = await readFile(join(process.cwd(), "../../etc/noema/capabilities.json"), "utf8").catch(() => null);
  if (config === null) return;
  const packs = Object.entries(JSON.parse(config).packs.definitions) as Array<[string, any]>;
  const carried = packs.filter(([, pack]) => pack.agent_catalog).map(([id, pack]) => [id, (pack.preamble ?? "").length]);
  for (const [id, length] of carried) expect([id, length <= 320]).toEqual([id, true]);
});
