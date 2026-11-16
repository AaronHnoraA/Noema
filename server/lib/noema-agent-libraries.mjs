// Every Agent sees the same Skills.  The Skill Manager's agent catalog (packs
// marked `agent_catalog`) is what Noema discloses to the sessions it starts;
// here the same Skills are linked into each native Agent library, so an Agent
// started anywhere (a terminal, another app) uses the system instead of its own
// habits.  Contract: docs/noema/design/capabilities.md, "Agent libraries".
//
// Which libraries take part is data: a global `sources` entry with
// `export: true`.  No Agent brand is named here; every library holds Agent
// Skills (a directory with SKILL.md), so a link is the whole installation.
//
// Ownership is explicit.  Only links this manager made, recorded in its ledger
// under Emacs `var/`, are ever changed or removed.  Anything else in a library
// (the Agent's official Skills, ones the person installed) is listed and left
// exactly as it is; a name taken by such an entry is a reported conflict.
import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { catalogSkills } from "./agent-skills.mjs";
import { globalCapabilityPaths, resolveProjectCapabilities } from "./noema-capabilities.mjs";

export const DEFAULT_LEDGER = resolve(import.meta.dirname, "../../../../var/noema/agent-libraries.json");
const LEDGER_VERSION = 1;

const inside = (parent, child) => { const rest = relative(parent, child); return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest)); };
const exists = (path) => lstat(path).then(() => true, () => false);
const real = (path) => realpath(path).catch(() => null);

async function readLedger(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    if (data?.version === LEDGER_VERSION && data.libraries && typeof data.libraries === "object") return data;
  } catch {}
  return { version: LEDGER_VERSION, libraries: {} };
}

async function writeLedger(file, ledger) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  await rename(temporary, file);
}

/** The Skills every Agent should see: the agent catalog of the global scope,
 * each with the real directory that holds its SKILL.md. */
async function catalogDirectories(options) {
  const resolution = await resolveProjectCapabilities({ ...options, scope: "global", includeAgentCatalog: true,
    requestedSkills: [], requestedPacks: [] });
  const { chosen } = catalogSkills(resolution);
  const wanted = new Map();
  const problems = [];
  for (const skill of resolution.skills) {
    if (!chosen.has(skill.id)) continue;
    const file = skill.source?.path;
    const directory = file && isAbsolute(file) ? await real(dirname(file)) : null;
    if (!skill.enabled || !skill.validation?.valid || !directory) problems.push({ id: skill.id, reason: "not an installed, valid Skill" });
    else wanted.set(skill.id, directory);
  }
  return { wanted, problems };
}

/** The libraries that take part: global sources marked `export: true`. */
async function exportLibraries(options) {
  const { configFile } = globalCapabilityPaths(options);
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const base = dirname(configFile);
  return (config.sources ?? []).filter((source) => source.export === true && source.skills?.length)
    .map((source) => ({ id: source.id, link: isAbsolute(source.skills[0]) ? source.skills[0] : resolve(base, source.skills[0]) }));
}

/**
 * Compare, and with APPLY reconcile, every exporting library with the agent
 * catalog.  Returns per library what is linked, what changed, what was left
 * alone (`native`) and what could not be done (`conflicts`).
 */
export async function agentLibraries({ apply = false, ledgerFile = DEFAULT_LEDGER, ...options } = {}) {
  const { wanted, problems } = await catalogDirectories(options);
  const ledger = await readLedger(ledgerFile);
  const report = [];
  for (const library of await exportLibraries(options)) {
    let directory = await real(library.link);
    const row = { id: library.id, directory: directory ?? library.link, state: "ready",
      linked: [], created: [], updated: [], removed: [], native: [], conflicts: [] };
    report.push(row);
    if (!directory) {
      // A library whose Agent is installed but has no Skills yet is created, as installing one would.
      const target = (await readlink(library.link).catch(() => null)) ?? library.link;
      const absolute = isAbsolute(target) ? target : resolve(dirname(library.link), target);
      if (!(await exists(dirname(absolute)))) { row.state = "absent"; continue; }
      row.state = "new";
      row.directory = absolute;
      if (!apply) { row.created.push(...wanted.keys()); continue; }
      await mkdir(absolute, { recursive: true });
      directory = await real(absolute);
      row.directory = directory;
    }
    const managed = { ...(ledger.libraries[directory] ?? {}) };
    const names = new Set((await readdir(directory)).filter((name) => !name.startsWith(".tmp-")));
    for (const [id, source] of wanted) {
      const path = join(directory, id);
      // A Skill read from this very library is already the Agent's own.
      if (inside(directory, source)) { row.linked.push(id); continue; }
      const stat = await lstat(path).catch(() => null);
      if (!stat) {
        row.created.push(id);
        if (apply) { await symlink(source, path, "dir"); managed[id] = source; }
        continue;
      }
      if (!stat.isSymbolicLink()) { row.conflicts.push({ id, reason: "the Agent has its own entry with this name; left untouched" }); continue; }
      const current = await readlink(path);
      if ((await real(path)) === source) { row.linked.push(id); managed[id] = current; continue; }
      if (managed[id] === current) {
        row.updated.push(id);
        if (apply) { await rm(path); await symlink(source, path, "dir"); managed[id] = source; }
        continue;
      }
      row.conflicts.push({ id, reason: `an existing link not made by Noema points to ${current}; left untouched` });
    }
    for (const [id, recorded] of Object.entries(managed)) {
      if (wanted.has(id)) continue;
      const path = join(directory, id);
      const stat = await lstat(path).catch(() => null);
      // Remove only the link this manager made, exactly as it made it.
      if (stat?.isSymbolicLink() && (await readlink(path)) === recorded) {
        row.removed.push(id);
        if (apply) await rm(path);
      }
      if (apply || !stat) delete managed[id];
    }
    const own = new Set([...Object.keys(managed), ...row.created, ...row.linked]);
    row.native = [...names].filter((name) => !own.has(name) && !row.conflicts.some((item) => item.id === name)).sort();
    if (apply) {
      if (Object.keys(managed).length) ledger.libraries[directory] = managed;
      else delete ledger.libraries[directory];
    }
  }
  if (apply) await writeLedger(ledgerFile, ledger);
  return { applied: apply, skills: [...wanted.keys()].sort(), problems, libraries: report };
}
