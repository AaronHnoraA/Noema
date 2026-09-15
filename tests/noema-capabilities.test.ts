import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applySkillDiff, createSkillDiff } from "../server/lib/noema-skill-diff.mjs";
import {
  assertRunnableCapabilities,
  installProjectSkill,
  mutateProjectCapability,
  projectCapabilityConfig,
  prepareProjectSkill,
  resolveProjectCapabilities,
  resolvedMCPServersForRun,
  resolvedSkillsForRun,
} from "../server/lib/noema-capabilities.mjs";

async function withTree(run: (tree: { root: string; home: string; builtin: string }) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "noema-capabilities-"));
  const root = join(parent, "project");
  const home = join(parent, "home");
  const builtin = join(parent, "builtin");
  try {
    await Promise.all([mkdir(root), mkdir(home), mkdir(builtin)]);
    await writeFile(join(root, "noema.toml"), 'schema = 1\nrepository_id = "0199"\n');
    await run({ root, home, builtin });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function writeJSON(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSkill(directory: string, id: string, body: string): Promise<void> {
  const path = join(directory, id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${id}\ndescription: ${id} instructions\n---\n\n${body}\n`);
}

describe("Noema capability resolution", () => {
  test("unified diffs preserve global sources, apply with patch and freeze at run resolution", async () => withTree(async ({ root, home, builtin }) => {
    const globals = join(home, ".emacs.d", "etc", "noema", "skills");
    await writeSkill(globals, "proof", "Shared proof rules");
    const options = { root, userHome: home, builtinSkillDirectory: builtin, environment: {} };
    const original = await readFile(join(globals, "proof", "SKILL.md"), "utf8");
    const patch = await prepareProjectSkill({ ...options, id: "proof", operation: "patch" });
    expect(patch.path).toBe(join(await realpath(root), ".agents", "skill-patches", "proof", "skill.patch"));
    expect(await readFile(patch.path, "utf8")).toBe("");
    expect(await readFile(join(patch.directory, "PATCH-BASE.md"), "utf8")).toBe(original);
    await writeFile(patch.path, await createSkillDiff(original, original + "\nProject proof refinement\n"));
    const project = await resolveProjectCapabilities({ ...options, requestedSkills: ["proof"], includeContent: true });
    const skill = project.skills.find((item) => item.id === "proof")!;
    expect(skill).toMatchObject({ source: { scope: "global" }, validation: { valid: true },
      patches: [{ scope: "project", file: expect.stringContaining("skill-patches/proof/skill.patch") }] });
    expect(skill.effective.content).toContain("Project proof refinement");
    expect(Buffer.from(resolvedSkillsForRun(project).items[0].contentBase64, "base64").toString()).toContain("Project proof refinement");
    expect((await resolveProjectCapabilities({ ...options, scope: "global", includeContent: true })).skills[0].effective.content).toBe(original);
    expect(await readFile(join(globals, "proof", "SKILL.md"), "utf8")).toBe(original);
    await writeFile(join(globals, "proof", "SKILL.md"), original + "\nUpstream changed\n");
    expect((await resolveProjectCapabilities(options)).skills[0].validation.valid).toBe(false);
    await writeFile(join(globals, "proof", "SKILL.md"), original);
    expect((await prepareProjectSkill({ ...options, id: "proof", operation: "patch" })).path).toContain("skill-patches/proof/skill.patch");
    await expect(prepareProjectSkill({ ...options, id: "proof", operation: "copy" })).rejects.toThrow(/Remove the project patch/);
    await mutateProjectCapability({ root, type: "skill", id: "proof", patch: null });
    expect((await resolveProjectCapabilities({ ...options, includeContent: true })).skills[0].effective.content).toBe(original);
    expect(await readFile(patch.path, "utf8")).toContain("Project proof refinement");
  }));

  test("patch rejects malformed, stale, multi-file and frontmatter-renaming diffs", async () => withTree(async ({ root, home, builtin }) => {
    const base = "one\ntwo\nthree\n";
    const hash = createHash("sha256").update(base).digest("hex");
    const diff = await createSkillDiff(base, "one\nrefined\nthree\n");
    expect(await applySkillDiff(base, diff, hash)).toBe("one\nrefined\nthree\n");
    expect(await applySkillDiff(base, diff, hash)).toBe("one\nrefined\nthree\n");
    await expect(applySkillDiff(base, diff + diff, hash)).rejects.toThrow();
    await expect(applySkillDiff(base, diff.replace("-two", "-absent"), hash)).rejects.toThrow(/did not apply/);
    await expect(applySkillDiff(base, diff.replaceAll("SKILL.md", "../../escape"), hash)).rejects.toThrow();
    await expect(applySkillDiff(base, "1c\nmalicious\n.\n", hash)).rejects.toThrow();
    await writeSkill(join(home, ".emacs.d", "etc", "noema", "skills"), "proof", "Global");
    const options = { root, userHome: home, builtinSkillDirectory: builtin, environment: {} };
    const patch = await prepareProjectSkill({ ...options, id: "proof", operation: "patch" });
    const original = await readFile(join(patch.directory, "PATCH-BASE.md"), "utf8");
    await writeFile(patch.path, await createSkillDiff(original, original.replace("name: proof", "name: wrong")));
    expect((await resolveProjectCapabilities(options)).skills[0].validation.valid).toBe(false);
  }));

  test("explicit Patch upgrades a legacy full-document override without losing its edits", async () => withTree(async ({ root, home, builtin }) => {
    await writeSkill(join(home, ".emacs.d", "etc", "noema", "skills"), "proof", "Global");
    const options = { root, userHome: home, builtinSkillDirectory: builtin, environment: {} };
    const directory = join(root, ".agents", "skill-patches", "proof");
    await mkdir(directory, { recursive: true });
    const oldFile = join(directory, "SKILL.md");
    const edited = '---\nname: proof\ndescription: proof instructions\n---\n\nUser refinement\n';
    await writeFile(oldFile, edited);
    await mutateProjectCapability({ root, type: "skill", id: "proof", patch: { content_file: ".agents/skill-patches/proof/SKILL.md" } });
    const patch = await prepareProjectSkill({ ...options, id: "proof", operation: "patch" });
    expect(await readFile(patch.path, "utf8")).toContain("+User refinement");
    expect(await readFile(oldFile, "utf8")).toBe(edited);
    expect((await resolveProjectCapabilities({ ...options, includeContent: true })).skills[0].effective.content).toBe(edited);
  }));

  test("copying global Skills creates independent files and resources, including symlinks", async () => withTree(async ({ root, home, builtin }) => {
    const globals = join(home, "global-skills");
    await writeSkill(globals, "proof", "Global");
    await writeFile(join(home, "shared-reference.txt"), "Reference original");
    await symlink(join(home, "shared-reference.txt"), join(globals, "proof", "reference.txt"));
    const options = { root, userHome: home, builtinSkillDirectory: builtin, globalSkillDirectory: globals, environment: {} };
    const copy = await prepareProjectSkill({ ...options, id: "proof", operation: "copy" });
    await writeFile(join(copy.directory, "reference.txt"), "Local edited");
    expect(await readFile(join(home, "shared-reference.txt"), "utf8")).toBe("Reference original");
    await writeFile(copy.path, '---\nname: proof\ndescription: local\n---\nLocal proof');
    const local = (await resolveProjectCapabilities({ ...options, includeContent: true })).skills.find((item) => item.id === "proof")!;
    expect(local.source?.scope).toBe("project");
    expect(local.effective.content).toContain("Local proof");
    await expect(prepareProjectSkill({ ...options, id: "proof", operation: "copy" })).rejects.toThrow(/already has a local/);
    await expect(prepareProjectSkill({ ...options, id: "proof", operation: "patch" })).rejects.toThrow(/already has a local/);
  }));

  test("invalid patch files fail closed, and symlinks cannot read outside the project", async () => withTree(async ({ root, home, builtin }) => {
    await writeSkill(join(home, ".emacs.d", "etc", "noema", "skills"), "proof", "Global");
    const options = { root, userHome: home, builtinSkillDirectory: builtin, environment: {} };
    await mutateProjectCapability({ root, type: "skill", id: "proof", patch: { content_file: "../secret" } });
    expect((await resolveProjectCapabilities(options)).skills[0].validation.valid).toBe(false);
    await mkdir(join(root, ".agents", "skill-patches"), { recursive: true });
    await writeFile(join(home, "secret"), "should not be read");
    await symlink(join(home, "secret"), join(root, ".agents", "skill-patches", "bad.md"));
    await mutateProjectCapability({ root, type: "skill", id: "proof", patch: { content_file: ".agents/skill-patches/bad.md" } });
    const result = await resolveProjectCapabilities(options);
    expect(result.skills[0].validation.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain("should not be read");
    await writeFile(join(root, ".agents", "skill-patches", "wrong.md"), '---\nname: wrong\n---\nWrong');
    await mutateProjectCapability({ root, type: "skill", id: "proof", patch: { content_file: ".agents/skill-patches/wrong.md" } });
    expect((await resolveProjectCapabilities(options)).skills[0].validation.valid).toBe(false);
  }));

  test("global management needs no project and writes only the global library", async () => withTree(async ({ root, home, builtin }) => {
    const options = { scope: "global" as const, userHome: home, builtinSkillDirectory: builtin, environment: {} };
    await writeSkill(join(root, ".agents", "skills"), "local-only", "Local");
    const projectConfig = '{"schema":"noema.capabilities/1","skills":{"disabled":["proof"]}}';
    await writeFile(join(root, "noema-capabilities.json"), projectConfig);
    const globalConfig = join(home, ".emacs.d", "etc", "noema", "capabilities.json");
    expect(await projectCapabilityConfig(undefined, options)).toMatchObject({ projectRoot: null, exists: false, configFile: globalConfig });
    const installed = await installProjectSkill({ ...options, id: "proof", description: "Proof writing" });
    expect(installed.path).toBe(join(home, ".emacs.d", "etc", "noema", "skills", "proof", "SKILL.md"));
    await expect(installProjectSkill({ ...options, id: "proof" })).rejects.toThrow();
    await mutateProjectCapability({ ...options, type: "skill", id: "proof", enabled: true, patch: { description: "Global patch" } });
    await mutateProjectCapability({ ...options, type: "mcp", id: "remote", definition: { type: "http", url: "https://example.test/mcp" }, enabled: false });
    const result = await resolveProjectCapabilities({ ...options, root: "/a/nonexistent/project" });
    expect(result).toMatchObject({ scope: "global", projectRoot: null, configFile: globalConfig });
    expect(result.scopes.map((item) => item.name)).toEqual(["builtin", "global"]);
    expect(result.skills.map((item) => item.id)).toEqual(["proof"]);
    expect(result.skills[0]).toMatchObject({ enabled: true, patches: [{ scope: "global" }], source: { path: installed.path } });
    expect(result.mcps.map((item) => item.id)).toEqual(["remote"]);
    expect(await readFile(join(root, "noema-capabilities.json"), "utf8")).toBe(projectConfig);
    const project = await resolveProjectCapabilities({ ...options, root, scope: "project" });
    expect(project.skills.find((item) => item.id === "proof")?.enabled).toBe(false);
    expect(project.skills.find((item) => item.id === "local-only")).toBeDefined();
    expect(project.mcps.find((item) => item.id === "noema")).toBeDefined();
  }));

  test("reads linked native libraries without copying configs or inheriting automatic MCP startup", async () => withTree(async ({ root, home, builtin }) => {
    const globalDir = join(home, ".emacs.d", "etc", "noema");
    await mkdir(globalDir, { recursive: true });
    await writeSkill(join(home, "codex-skills"), "linked-proof", "See references/guide.md.");
    await symlink(join(home, "codex-skills"), join(globalDir, "linked-skills"));
    const native = join(home, "config.toml");
    const original = '[mcp_servers.example]\nurl = "https://example.test/mcp"\nenabled = true\n[mcp_servers.example.http_headers]\nX-Client = "codex"\n';
    await writeFile(native, original);
    await symlink(native, join(globalDir, "codex.toml"));
    await writeJSON(join(globalDir, "capabilities.json"), {
      schema: "noema.capabilities/1", sources: [{ id: "codex", format: "codex", config: "codex.toml", skills: ["linked-skills"] }],
    });
    const options = { root, userHome: home, builtinSkillDirectory: builtin, environment: {} };
    const result = await resolveProjectCapabilities(options);
    expect(result.skills.find((item) => item.id === "linked-proof")).toMatchObject({ selectable: true, source: { scope: "external-codex" } });
    expect(result.mcps.find((item) => item.id === "example")).toMatchObject({ enabled: false, validation: { valid: true },
      effective: { config: { headers: [{ name: "X-Client", value: "codex" }] } } });
    await mutateProjectCapability({ root, type: "mcp", id: "example", enabled: true });
    expect((await resolveProjectCapabilities(options)).active.mcps).toContain("example");
    expect(await readFile(native, "utf8")).toBe(original);
    const selected = resolvedSkillsForRun(await resolveProjectCapabilities({ ...options, requestedSkills: ["linked-proof"], includeContent: true }));
    expect(Buffer.from(selected.items[0].contentBase64, "base64").toString()).toContain(join(globalDir, "linked-skills", "linked-proof"));
    expect(selected.items[0].sha256).not.toBe(selected.skills[0].sha256);
  }));

  test("global config and Skill roots can be overridden independently", async () => withTree(async ({ root, home, builtin }) => {
    const globalConfigPath = join(home, "config", "global.json");
    const directory = join(home, "library");
    await writeSkill(directory, "portable", "Portable instructions.");
    await writeJSON(globalConfigPath, { schema: "noema.capabilities/1", skills: {}, mcp: {} });
    const resolution = await resolveProjectCapabilities({ root, builtinSkillDirectory: builtin,
      environment: { NOEMA_GLOBAL_CAPABILITIES: globalConfigPath, NOEMA_GLOBAL_SKILLS: directory } });
    expect(resolution.skills.find((item) => item.id === "portable")?.source?.scope).toBe("global");
    expect(resolution.scopes.find((scope) => scope.name === "global")?.skillDirectories).toEqual([directory]);
  }));

  test("completion distinguishes available Skills from explicit disables and invalid definitions", async () => withTree(async ({ root, home, builtin }) => {
    await writeSkill(join(root, ".agents", "skills"), "available", "Available for per-Run selection.");
    await writeSkill(join(root, ".agents", "skills"), "blocked", "Explicitly disabled.");
    await writeJSON(join(root, "noema-capabilities.json"), {
      schema: "noema.capabilities/1", skills: { disabled: ["blocked"], enabled: ["missing"] }, mcp: {},
    });
    const resolution = await resolveProjectCapabilities({ root, userHome: home, builtinSkillDirectory: builtin });
    expect(resolution.skills.find((item) => item.id === "available")).toMatchObject({ enabled: false, selectable: true });
    expect(resolution.skills.find((item) => item.id === "blocked")).toMatchObject({ enabled: false, selectable: false });
    expect(resolution.skills.find((item) => item.id === "missing")).toMatchObject({ selectable: false });
  }));

  test("creates and imports complete Skills without overwriting existing directories", async () => withTree(async ({ root, home, builtin }) => {
    const created = await installProjectSkill({ root, id: "created", description: "Review: proofs" });
    expect(await readFile(created.path, "utf8")).toContain('description: "Review: proofs"');
    await expect(installProjectSkill({ root, id: "created" })).rejects.toThrow();
    await expect(installProjectSkill({ root, id: "../escape" })).rejects.toThrow(/valid Skill/);
    await writeSkill(builtin, "imported", "Instructions.");
    await mkdir(join(builtin, "imported", "scripts"));
    await writeFile(join(builtin, "imported", "scripts", "helper.sh"), "supporting resource");
    const imported = await installProjectSkill({ root, sourceDirectory: join(builtin, "imported") });
    expect(imported.id).toBe("imported");
    expect(await readFile(join(imported.path, "..", "scripts", "helper.sh"), "utf8")).toBe("supporting resource");
    const resolution = await resolveProjectCapabilities({ root, userHome: home, builtinSkillDirectory: builtin });
    expect(resolution.skills.find((item) => item.id === "created")).toMatchObject({ selectable: true });
  }));

  test("resolves a global Skill through company and project patches with inspectable provenance", async () => withTree(async ({ root, home, builtin }) => {
    await writeSkill(join(home, ".emacs.d", "etc", "noema", "skills"), "proof-review", "Use the base proof checklist.");
    const company = join(root, "shared", "company-capabilities.json");
    await writeJSON(company, {
      schema: "noema.capabilities/1",
      skills: { patches: { "proof-review": { content_append: "Apply the company lemma rubric.", configuration: { audience: "research" } } } },
    });
    await writeJSON(join(root, "noema-capabilities.json"), {
      schema: "noema.capabilities/1",
      extends: [{ scope: "company", path: "shared/company-capabilities.json" }],
      skills: {
        enabled: ["proof-review"],
        patches: { "proof-review": { content_append: "Require an explicit counterexample search.", configuration: { strict: true } } },
      },
      mcp: {},
    });

    const resolution = await resolveProjectCapabilities({
      root, userHome: home, builtinSkillDirectory: builtin, includeContent: true,
    });
    const skill = resolution.skills.find((item: any) => item.id === "proof-review") as any;
    expect(skill).toMatchObject({
      enabled: true,
      source: { scope: "global" },
      validation: { valid: true },
      effective: { configuration: { audience: "research", strict: true } },
    });
    expect(skill.effective.content).toContain("Use the base proof checklist.");
    expect(skill.effective.content).toContain("Apply the company lemma rubric.");
    expect(skill.effective.content).toContain("Require an explicit counterexample search.");
    expect(skill.patches.map((item: any) => item.scope)).toEqual(["company", "project"]);
    expect(skill.selectedBy.at(-1)).toMatchObject({ scope: "project", enabled: true });
    expect(resolution.scopes.map((scope: any) => scope.name)).toEqual(["builtin", "global", "company", "project"]);

    const frozen = resolvedSkillsForRun(assertRunnableCapabilities(resolution));
    expect(frozen.skills[0]).toMatchObject({ id: "proof-review", scope: "global" });
    expect(Buffer.from(frozen.items[0].contentBase64, "base64").toString()).toContain("counterexample search");
  }));

  test("a project definition wins deterministically and records the shadowed source", async () => withTree(async ({ root, home, builtin }) => {
    await writeSkill(builtin, "review", "Built-in review.");
    await writeSkill(join(home, ".emacs.d", "etc", "noema", "skills"), "review", "Global review.");
    await writeSkill(join(root, "shared", "skills"), "review", "Company review.");
    await writeSkill(join(root, ".agents", "skills"), "review", "Project review.");
    await writeJSON(join(root, "shared", "company.json"), {
      schema: "noema.capabilities/1",
      skills: { directories: ["skills"] },
      mcp: {},
    });
    await writeJSON(join(root, "noema-capabilities.json"), {
      schema: "noema.capabilities/1",
      extends: [{ scope: "company", path: "shared/company.json" }],
      skills: { enabled: ["review"] },
      mcp: {},
    });
    const resolution = await resolveProjectCapabilities({ root, userHome: home, builtinSkillDirectory: builtin, includeContent: true });
    const skill = resolution.skills.find((item: any) => item.id === "review") as any;
    expect(skill.source.scope).toBe("project");
    expect(skill.effective.content).toContain("Project review.");
    expect(skill.effective.content).not.toContain("Global review.");
    expect(skill.shadowedDefinitions.map((source: any) => source.scope)).toEqual(["builtin", "global", "company"]);
  }));

  test("keeps MCP definition/configuration separate from observed runtime state", async () => withTree(async ({ root, home, builtin }) => {
    await writeJSON(join(root, "noema-capabilities.json"), {
      schema: "noema.capabilities/1",
      skills: {},
      mcp: {
        servers: [{ id: "local-tools", command: "/usr/bin/env", args: ["node", "server.mjs"], env: [] }],
        enabled: ["local-tools"],
        patches: { "local-tools": { config: { args: ["node", "patched.mjs"], env: [{ name: "MODE", value: "test" }] } } },
      },
    });
    const resolution = await resolveProjectCapabilities({
      root, userHome: home, builtinSkillDirectory: builtin, runtimeDescriptor: { mcpUrl: "http://127.0.0.1:43128/mcp" },
    });
    const local = resolution.mcps.find((item: any) => item.id === "local-tools") as any;
    const noema = resolution.mcps.find((item: any) => item.id === "noema") as any;
    expect(local).toMatchObject({ enabled: true, runtime: {
      state: "not-observed", availability: "available", running: null, observed: false,
    } });
    expect(local.effective.config).toMatchObject({ command: "/usr/bin/env", args: ["node", "patched.mjs"] });
    expect(noema).toMatchObject({ enabled: true, runtime: { state: "available", observed: true } });
    expect(resolvedMCPServersForRun(resolution)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "noema", type: "http" }),
      expect.objectContaining({ name: "local-tools", command: "/usr/bin/env" }),
    ]));
  }));

  test("a narrower shared patch can repair an inherited MCP definition", async () => withTree(async ({ root, home, builtin }) => {
    await writeJSON(join(home, ".emacs.d", "etc", "noema", "capabilities.json"), {
      schema: "noema.capabilities/1",
      skills: {},
      mcp: { servers: [{ id: "remote", type: "http" }], enabled: ["remote"] },
    });
    await writeJSON(join(root, "shared", "company.json"), {
      schema: "noema.capabilities/1",
      skills: {},
      mcp: { patches: { remote: { config: { url: "https://mcp.example.test", headers: [] } } } },
    });
    await writeJSON(join(root, "noema-capabilities.json"), {
      schema: "noema.capabilities/1",
      extends: [{ scope: "company", path: "shared/company.json" }],
      skills: {}, mcp: {},
    });
    const resolution = await resolveProjectCapabilities({ root, userHome: home, builtinSkillDirectory: builtin });
    expect(resolution.mcps.find((item: any) => item.id === "remote")).toMatchObject({
      enabled: true, source: { scope: "global" }, validation: { valid: true },
      effective: { config: { type: "http", url: "https://mcp.example.test" } },
      patches: [expect.objectContaining({ scope: "company" })],
    });
  }));

  test("reports unavailable runtime state and permits an explicit project disable", async () => withTree(async ({ root, home, builtin }) => {
    const unavailable = await resolveProjectCapabilities({ root, userHome: home, builtinSkillDirectory: builtin });
    expect(unavailable.mcps.find((item: any) => item.id === "noema")).toMatchObject({
      enabled: true, runtime: { state: "unavailable", availability: "unavailable", observed: true },
    });
    expect(resolvedMCPServersForRun(unavailable)).toEqual([]);

    await mutateProjectCapability({ root, type: "mcp", id: "noema", enabled: false });
    const disabled = await resolveProjectCapabilities({
      root, userHome: home, builtinSkillDirectory: builtin,
      runtimeDescriptor: { mcpUrl: "http://127.0.0.1:43128/mcp" },
    });
    expect(disabled.mcps.find((item: any) => item.id === "noema")).toMatchObject({
      enabled: false, runtime: { state: "available" },
    });
    expect(disabled.active.mcps).not.toContain("noema");
  }));

  test("blocks an enabled stdio MCP whose executable is unavailable", async () => withTree(async ({ root, home, builtin }) => {
    await writeJSON(join(root, "noema-capabilities.json"), {
      schema: "noema.capabilities/1",
      skills: {},
      mcp: {
        servers: [{ id: "missing-tools", command: "/definitely/missing/noema-mcp", args: [], env: [] }],
        enabled: ["missing-tools"],
      },
    });
    const resolution = await resolveProjectCapabilities({ root, userHome: home, builtinSkillDirectory: builtin });
    expect(resolution.mcps.find((item: any) => item.id === "missing-tools")).toMatchObject({
      enabled: true,
      validation: { valid: true },
      runtime: { state: "not-observed", availability: "unavailable", observed: false },
    });
    expect(resolvedMCPServersForRun(resolution)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "missing-tools" }),
    ]));
    expect(() => assertRunnableCapabilities(resolution)).toThrow(/missing-tools is unavailable/);
  }));

  test("reports an explicitly requested unknown Skill as an actionable error", async () => withTree(async ({ root, home, builtin }) => {
    const resolution = await resolveProjectCapabilities({
      root, userHome: home, builtinSkillDirectory: builtin, requestedSkills: ["missing-skill"],
    });
    expect(resolution.skills).toEqual([expect.objectContaining({
      id: "missing-skill", enabled: true,
      validation: expect.objectContaining({ valid: false }),
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "unknown-capability" })]),
    })]);
    expect(() => assertRunnableCapabilities(resolution)).toThrow(/missing-skill/);
  }));

  test("an explicit project disable blocks a per-Run @@skill request", async () => withTree(async ({ root, home, builtin }) => {
    await writeSkill(join(root, ".agents", "skills"), "restricted", "Use restricted instructions.");
    await writeJSON(join(root, "noema-capabilities.json"), {
      schema: "noema.capabilities/1",
      skills: { disabled: ["restricted"] },
      mcp: {},
    });
    const resolution = await resolveProjectCapabilities({
      root, userHome: home, builtinSkillDirectory: builtin, requestedSkills: ["restricted"],
    });
    expect(resolution.skills.find((item: any) => item.id === "restricted")).toMatchObject({
      enabled: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "disabled-capability-requested" })]),
    });
    expect(() => assertRunnableCapabilities(resolution)).toThrow(/requested by @@skill but disabled/);
  }));

  test("reports conflicting selection in one scope deterministically", async () => withTree(async ({ root, home, builtin }) => {
    await writeSkill(join(root, ".agents", "skills"), "conflicted", "Conflicted instructions.");
    await writeJSON(join(root, "noema-capabilities.json"), {
      schema: "noema.capabilities/1",
      skills: { enabled: ["conflicted"], disabled: ["conflicted"] },
      mcp: {},
    });
    const resolution = await resolveProjectCapabilities({ root, userHome: home, builtinSkillDirectory: builtin });
    expect(resolution.skills.find((item: any) => item.id === "conflicted")).toMatchObject({
      enabled: false,
      validation: { valid: false },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "selection-conflict" })]),
    });
  }));

  test("surfaces unknown ids declared only in project configuration", async () => withTree(async ({ root, home, builtin }) => {
    await writeJSON(join(root, "noema-capabilities.json"), {
      schema: "noema.capabilities/1",
      skills: { enabled: ["not-installed"] },
      mcp: {},
    });
    const resolution = await resolveProjectCapabilities({ root, userHome: home, builtinSkillDirectory: builtin });
    expect(resolution.skills).toEqual([expect.objectContaining({
      id: "not-installed", enabled: true, validation: expect.objectContaining({ valid: false }),
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "unknown-capability" })]),
    })]);
    expect(() => assertRunnableCapabilities(resolution)).toThrow(/not-installed/);
  }));

  test("rejects malformed project configuration with source and field", async () => withTree(async ({ root, home, builtin }) => {
    await writeJSON(join(root, "noema-capabilities.json"), {
      schema: "noema.capabilities/1",
      skills: { enabled: "not-an-array" },
      mcp: {},
    });
    await expect(resolveProjectCapabilities({ root, userHome: home, builtinSkillDirectory: builtin }))
      .rejects.toMatchObject({
        code: "ERR_NOEMA_CAPABILITY_CONFIG",
        details: { source: expect.stringMatching(/noema-capabilities\.json$/), field: "skills.enabled" },
      });
  }));

  test("mutates only the project selection/patch document and resolves the result", async () => withTree(async ({ root, home, builtin }) => {
    await writeSkill(join(root, ".agents", "skills"), "noema-api", "Use semantic Elisp.");
    await mutateProjectCapability({ root, type: "skill", id: "noema-api", enabled: true,
      patch: { content_append: "Call noema-current-project first." } });
    const stored = JSON.parse(await readFile(join(root, "noema-capabilities.json"), "utf8"));
    expect(stored.skills).toMatchObject({ enabled: ["noema-api"], disabled: [],
      patches: { "noema-api": { content_append: "Call noema-current-project first." } } });
    const resolution = await resolveProjectCapabilities({ root, userHome: home, builtinSkillDirectory: builtin, includeContent: true });
    expect(resolution.skills.find((item: any) => item.id === "noema-api")).toMatchObject({ enabled: true });
    await mutateProjectCapability({ root, type: "skill", id: "noema-api", enabled: false, patch: null });
    const disabled = await resolveProjectCapabilities({ root, userHome: home, builtinSkillDirectory: builtin });
    expect(disabled.skills.find((item: any) => item.id === "noema-api")).toMatchObject({ enabled: false, patches: [] });

    const beforeMCP = JSON.parse(await readFile(join(root, "noema-capabilities.json"), "utf8"));
    beforeMCP.mcp.servers = { existing: { command: "existing-server", args: [], env: [] } };
    await writeJSON(join(root, "noema-capabilities.json"), beforeMCP);
    await mutateProjectCapability({
      root, type: "mcp", id: "added", enabled: true,
      definition: { command: "added-server", args: [], env: [] },
    });
    const withMCP = JSON.parse(await readFile(join(root, "noema-capabilities.json"), "utf8"));
    expect(withMCP.mcp.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "existing", command: "existing-server" }),
      expect.objectContaining({ id: "added", command: "added-server" }),
    ]));
  }));
});
