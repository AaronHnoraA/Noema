// @vitest-environment node
// Contract: docs/noema/design/capabilities.md, "Agent libraries" (A1-A5).
import { afterEach, beforeEach, expect, test } from "@voidzero-dev/vite-plus-test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLibraries } from "../server/lib/noema-agent-libraries.mjs";

let base: string;
let options: any;
const skill = (directory: string, id: string) => {
  mkdirSync(join(directory, id), { recursive: true });
  writeFileSync(join(directory, id, "SKILL.md"), `---\nname: ${id}\ndescription: A Skill for testing the agent libraries, long enough to be usable.\n---\n\n# ${id}\n`);
};
const config = (packs: Record<string, any>, sources: any[]) => writeFileSync(join(base, "etc/capabilities.json"), JSON.stringify({
  schema: "noema.capabilities/1", sources, packs: { definitions: packs } }));
const run = (apply = false) => agentLibraries({ ...options, apply });
const library = (result: any, id: string) => result.libraries.find((row: any) => row.id === id);

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "agent-libraries-")));
  for (const dir of ["etc", "global", "builtin", "home", "agentA/skills", "agentB"]) mkdirSync(join(base, dir), { recursive: true });
  skill(join(base, "global"), "shared-skill");
  skill(join(base, "builtin"), "system-skill");
  skill(join(base, "global"), "quiet-skill");
  // The Agent's own official Skill, and one the person installed by hand.
  mkdirSync(join(base, "agentA/skills/.system"), { recursive: true });
  skill(join(base, "agentA/skills"), "official-skill");
  options = { globalConfigPath: join(base, "etc/capabilities.json"), globalSkillDirectory: join(base, "global"),
    builtinSkillDirectory: join(base, "builtin"), userHome: join(base, "home"), environment: {},
    ledgerFile: join(base, "var/agent-libraries.json") };
  config({ everyone: { agent_catalog: true, members: ["shared-skill", "system-skill"] }, quiet: { members: ["quiet-skill"] } }, [
    { id: "agent-a", format: "codex", skills: [join(base, "agentA/skills"), join(base, "agentA/skills/.system")], export: true },
    { id: "agent-b", format: "claude", skills: [join(base, "agentB/skills")], export: true },
    { id: "reader", format: "codex", skills: [join(base, "global")] },
  ]);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

test("A1 the agent catalog is linked into every exporting library, and only there", async () => {
  const preview = await run();
  expect(preview.skills).toEqual(["shared-skill", "system-skill"]);
  expect(library(preview, "agent-a")).toMatchObject({ state: "ready", created: ["shared-skill", "system-skill"] });
  expect(library(preview, "agent-b")).toMatchObject({ state: "new" });
  expect(preview.libraries.map((row: any) => row.id)).toEqual(["agent-a", "agent-b"]);
  expect(existsSync(join(base, "agentA/skills/shared-skill"))).toBe(false);
  await run(true);
  expect(readlinkSync(join(base, "agentA/skills/shared-skill"))).toBe(join(base, "global/shared-skill"));
  expect(readlinkSync(join(base, "agentB/skills/system-skill"))).toBe(join(base, "builtin/system-skill"));
  expect(existsSync(join(base, "agentA/skills/quiet-skill"))).toBe(false);
  const again = await run(true);
  expect(library(again, "agent-a")).toMatchObject({ created: [], linked: ["shared-skill", "system-skill"] });
});

test("A2 the Agent's own entries are listed and never touched", async () => {
  // The Agent's own copy of a catalog Skill is the one it already reads.
  skill(join(base, "agentA/skills"), "system-skill");
  // A name the Agent uses for something else is a conflict, not overwritten.
  writeFileSync(join(base, "agentA/skills/shared-skill"), "the Agent's own file");
  const row = library(await run(true), "agent-a");
  expect(row.native).toEqual([".system", "official-skill"]);
  expect(row.linked).toEqual(["system-skill"]);
  expect(row.conflicts).toEqual([{ id: "shared-skill", reason: "the Agent has its own entry with this name; left untouched" }]);
  expect(lstatSync(join(base, "agentA/skills/system-skill")).isSymbolicLink()).toBe(false);
  expect(lstatSync(join(base, "agentA/skills/shared-skill")).isFile()).toBe(true);
  expect(existsSync(join(base, "agentA/skills/official-skill/SKILL.md"))).toBe(true);
});

test("A3 a foreign link is reported, an equal one adopted", async () => {
  symlinkSync(join(base, "elsewhere"), join(base, "agentA/skills/shared-skill"));
  symlinkSync(join(base, "builtin/system-skill"), join(base, "agentA/skills/system-skill"));
  const row = library(await run(true), "agent-a");
  expect(row.conflicts.map((item: any) => item.id)).toEqual(["shared-skill"]);
  expect(readlinkSync(join(base, "agentA/skills/shared-skill"))).toBe(join(base, "elsewhere"));
  expect(row.linked).toEqual(["system-skill"]);
});

test("A4 leaving the catalog removes only the links the manager made", async () => {
  await run(true);
  symlinkSync(join(base, "global/quiet-skill"), join(base, "agentA/skills/hand-made"));
  config({ everyone: { agent_catalog: true, members: ["system-skill"] } }, [
    { id: "agent-a", format: "codex", skills: [join(base, "agentA/skills")], export: true }]);
  const preview = await run();
  expect(library(preview, "agent-a").removed).toEqual(["shared-skill"]);
  expect(existsSync(join(base, "agentA/skills/shared-skill"))).toBe(true);
  const row = library(await run(true), "agent-a");
  expect(row.removed).toEqual(["shared-skill"]);
  expect(existsSync(join(base, "agentA/skills/shared-skill"))).toBe(false);
  expect(readlinkSync(join(base, "agentA/skills/hand-made"))).toBe(join(base, "global/quiet-skill"));
  expect(row.native).toContain("hand-made");
});

test("A5 a library whose Agent is not installed is absent and nothing is created", async () => {
  config({ everyone: { agent_catalog: true, members: ["shared-skill"] } }, [
    { id: "agent-c", format: "pi", skills: [join(base, "not-installed/skills")], export: true }]);
  const result = await run(true);
  expect(library(result, "agent-c")).toMatchObject({ state: "absent", created: [] });
  expect(existsSync(join(base, "not-installed"))).toBe(false);
});
