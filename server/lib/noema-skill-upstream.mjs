import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { globalCapabilityPaths } from "./noema-capabilities.mjs";
import { createSkillDiff } from "./noema-skill-diff.mjs";

// Upstream version control for the global Skill library.  `skills.lock.json`
// beside the library directory (`NOEMA_GLOBAL_SKILLS`) is the only record of where a Skill
// came from; the library directory itself stays a plain tree versioned by
// whatever repository holds it (the vault, by default).  Network work happens only on explicit
// install/check/update requests, never on resolution or completion.

export const SKILL_LOCK_SCHEMA = "noema.skill-library-lock/1";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 120_000;
const HISTORY_LIMIT = 20;
const IGNORED = new Set(["__pycache__", ".DS_Store", ".git"]);
const lockQueues = new Map();

function upstreamError(message, code = "ERR_NOEMA_SKILL_UPSTREAM", details = {}) {
  return Object.assign(new Error(message), { statusCode: 422, code, details });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** `owner/repo` is shorthand for GitHub; anything else is a git URL or path. */
export function upstreamURL(repository) {
  const value = String(repository || "").trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return `https://github.com/${value.replace(/\.git$/, "")}.git`;
  if (!value || value.startsWith("-")) throw upstreamError("A Skill upstream needs a repository");
  return value;
}

function normalizedPath(path) {
  const value = String(path || ".").trim().replace(/^\/+|\/+$/g, "") || ".";
  if (value.split("/").some((part) => part === ".." || part.startsWith("-"))) {
    throw upstreamError(`Invalid upstream Skill path: ${path}`);
  }
  return value;
}

function git(args, { cwd, timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, {
      cwd, timeout, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(upstreamError(`git ${args[0]} failed: ${String(stderr || error.message).trim().split("\n").at(-1)}`,
          "ERR_NOEMA_SKILL_UPSTREAM", { args }));
      } else resolvePromise(String(stdout));
    });
  });
}

/** The lock sits beside the Skill library it describes, under the same VCS. */
export function skillLockPath(options = {}) {
  return join(dirname(globalCapabilityPaths(options).skillDirectory), "skills.lock.json");
}

export async function readSkillLock(options = {}) {
  const path = skillLockPath(options);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { path, lock: { schema: SKILL_LOCK_SCHEMA, skills: [] } };
    throw error;
  }
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    throw upstreamError(`Malformed Skill lock ${path}: ${error.message}`);
  }
  if (lock?.schema !== SKILL_LOCK_SCHEMA || !Array.isArray(lock.skills)) {
    throw upstreamError(`Skill lock ${path} must use schema ${SKILL_LOCK_SCHEMA} with a skills array`);
  }
  return { path, lock };
}

/** Serialize read-modify-write of one lock file. */
async function updateLock(options, mutate) {
  const path = skillLockPath(options);
  const previous = lockQueues.get(path) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const { lock } = await readSkillLock(options);
    const result = await mutate(lock);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`);
    await rename(temporary, path);
    return result;
  });
  lockQueues.set(path, operation);
  try {
    return await operation;
  } finally {
    if (lockQueues.get(path) === operation) lockQueues.delete(path);
  }
}

async function listFiles(directory, base = directory) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED.has(entry.name) || entry.name.endsWith(".pyc")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, base));
    else files.push({ path, relative: relative(base, path).split(sep).join("/"), symlink: entry.isSymbolicLink() });
  }
  return files;
}

/** Content identity of an installed Skill tree, ignoring caches. */
export async function skillTreeDigest(directory) {
  const hash = createHash("sha256");
  for (const file of await listFiles(directory)) {
    const content = file.symlink ? `link:${await readlink(file.path)}` : await readFile(file.path);
    hash.update(`${file.relative}\0${sha256(content)}\n`);
  }
  return hash.digest("hex");
}

async function fileDigests(directory) {
  const result = new Map();
  for (const file of await listFiles(directory)) result.set(file.relative, sha256(await readFile(file.path)));
  return result;
}

function frontmatterField(text, field) {
  const match = /^---\n([\s\S]*?)\n---/.exec(String(text).replace(/\r\n?/g, "\n"));
  const value = match && new RegExp(`^${field}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m").exec(match[1]);
  return value ? value[1].trim() : "";
}

function parseName(text) {
  return frontmatterField(text, "name");
}

/**
 * Fetch one Skill directory at TARGET (a ref or commit) into a temporary
 * checkout.  Only the Skill path and a repository-root licence are checked
 * out; symlinks are refused so a fetched tree cannot pull in local files.
 */
async function fetchUpstream({ repository, target, path }) {
  const url = upstreamURL(repository);
  const skillPath = normalizedPath(path);
  const parent = await mkdtemp(join(tmpdir(), "noema-skill-upstream-"));
  const cleanup = () => rm(parent, { recursive: true, force: true });
  try {
    const repo = join(parent, "repo");
    await git(["init", "-q", repo]);
    await git(["remote", "add", "origin", url], { cwd: repo });
    const wanted = String(target || "HEAD");
    try {
      await git(["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", wanted], { cwd: repo });
    } catch {
      // Some servers refuse shallow fetches of an arbitrary commit.
      await git(["fetch", "-q", "--filter=blob:none", "origin", wanted], { cwd: repo });
    }
    const commit = (await git(["rev-parse", "FETCH_HEAD"], { cwd: repo })).trim();
    await git(["checkout", "-q", "FETCH_HEAD", "--", skillPath], { cwd: repo });
    const directory = resolve(repo, skillPath);
    const files = await listFiles(directory);
    if (!files.some((file) => file.relative === "SKILL.md")) {
      throw upstreamError(`${repository}@${commit.slice(0, 12)} has no SKILL.md at ${skillPath}`);
    }
    const link = files.find((file) => file.symlink);
    if (link) throw upstreamError(`Upstream Skill contains a symlink (${link.relative}); refusing to install it`);
    let license = "";
    if (!files.some((file) => /^LICEN[CS]E/i.test(file.relative))) {
      const root = (await git(["ls-tree", "--name-only", "FETCH_HEAD"], { cwd: repo })).split("\n");
      license = root.find((name) => /^LICEN[CS]E(\.[A-Za-z]+)?$/i.test(name)) || "";
      if (license && skillPath !== ".") {
        await git(["checkout", "-q", "FETCH_HEAD", "--", license], { cwd: repo });
        if ((await lstat(join(repo, license))).isFile()) await cp(join(repo, license), join(directory, license));
      }
    }
    const content = await readFile(join(directory, "SKILL.md"), "utf8");
    const id = parseName(content) || basename(skillPath === "." ? repository.replace(/\.git$/, "") : skillPath);
    if (!ID_PATTERN.test(id)) throw upstreamError(`Upstream Skill has an invalid name: ${id}`);
    return { id, commit, directory, content, path: skillPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function localState(entry, skillDirectory) {
  const directory = join(skillDirectory, entry.id);
  let content;
  try {
    content = await readFile(join(directory, "SKILL.md"));
  } catch {
    return { state: "missing", directory };
  }
  if (entry.skill_sha256 && sha256(content) !== entry.skill_sha256) return { state: "modified", directory };
  if (entry.tree_sha256 && await skillTreeDigest(directory) !== entry.tree_sha256) return { state: "modified", directory };
  return { state: "clean", directory };
}

async function remoteCommit(entry) {
  const ref = String(entry.ref || "HEAD");
  if (COMMIT_PATTERN.test(ref)) return ref;
  const output = await git(["ls-remote", upstreamURL(entry.repository), ref], { timeout: 30_000 });
  const line = output.split("\n").find(Boolean);
  if (!line) throw upstreamError(`${entry.repository} has no ref ${ref}`);
  return line.split(/\s+/)[0];
}

async function inBatches(items, size, run) {
  const results = [];
  for (let index = 0; index < items.length; index += size) {
    results.push(...await Promise.all(items.slice(index, index + size).map(run)));
  }
  return results;
}

/**
 * Report every locked Skill's local state.  With CHECK, also ask each
 * upstream (once per repository/ref) whether a newer commit exists.
 */
export async function skillUpstreamStatus({ check = false, ids, ...options } = {}) {
  const { skillDirectory } = globalCapabilityPaths(options);
  const { path, lock } = await readSkillLock(options);
  const selected = lock.skills.filter((entry) => !ids || ids.includes(entry.id));
  const remotes = new Map();
  if (check) {
    const keys = [...new Set(selected.map((entry) => `${entry.repository}\0${entry.ref || "HEAD"}`))];
    await inBatches(keys, 4, async (key) => {
      const [repository, ref] = key.split("\0");
      try {
        remotes.set(key, { commit: await remoteCommit({ repository, ref }) });
      } catch (error) {
        remotes.set(key, { error: error.message });
      }
    });
  }
  const skills = [];
  for (const entry of selected) {
    const local = await localState(entry, skillDirectory);
    const remote = remotes.get(`${entry.repository}\0${entry.ref || "HEAD"}`);
    skills.push({
      id: entry.id, repository: entry.repository, ref: entry.ref || "HEAD", commit: entry.commit, path: entry.path,
      license: entry.license || "", local: local.state, directory: local.directory,
      history: entry.history || [],
      ...(entry.helpers ? { helpers: entry.helpers } : {}),
      ...(remote?.commit ? { latest: remote.commit, updateAvailable: remote.commit !== entry.commit } : {}),
      ...(remote?.error ? { checkError: remote.error } : {}),
    });
  }
  return { lockFile: path, skillDirectory, checked: Boolean(check), skills };
}

async function installTree(source, destination) {
  const incoming = join(dirname(destination), `.${basename(destination)}.incoming-${process.pid}-${Date.now()}`);
  await cp(source, incoming, { recursive: true, errorOnExist: true, force: false });
  return incoming;
}

/** Install a new global Skill from REPOSITORY/PATH at REF and lock it. */
export async function installUpstreamSkill({ repository, ref = "HEAD", path = ".", commit, license = "", ...options } = {}) {
  const { skillDirectory } = globalCapabilityPaths(options);
  const { lock } = await readSkillLock(options);
  const fetched = await fetchUpstream({ repository, target: commit || ref, path });
  try {
    if (lock.skills.some((entry) => entry.id === fetched.id)) {
      throw upstreamError(`Skill ${fetched.id} is already locked; use update instead`, "ERR_NOEMA_SKILL_EXISTS");
    }
    const destination = join(skillDirectory, fetched.id);
    await mkdir(skillDirectory, { recursive: true });
    try {
      await lstat(destination);
      throw upstreamError(`${destination} already exists; it is not overwritten`, "ERR_NOEMA_SKILL_EXISTS");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const incoming = await installTree(fetched.directory, destination);
    await rename(incoming, destination);
    const entry = {
      id: fetched.id, repository: String(repository).trim(), ref: String(ref || "HEAD"), commit: fetched.commit,
      path: fetched.path,
      ...((license || frontmatterField(fetched.content, "license")) ? { license: license || frontmatterField(fetched.content, "license") } : {}),
      skill_sha256: sha256(await readFile(join(destination, "SKILL.md"))),
      tree_sha256: await skillTreeDigest(destination),
      installed_at: today(),
    };
    await updateLock(options, (current) => {
      current.skills = [...current.skills.filter((item) => item.id !== entry.id), entry];
    });
    return { id: fetched.id, path: join(destination, "SKILL.md"), entry };
  } finally {
    await fetched.cleanup();
  }
}

/**
 * Move locked Skill ID to its upstream's current commit, or to COMMIT for a
 * pin or rollback.  A locally edited Skill is refused unless FORCE: local
 * refinements belong in project patches, not in the shared library copy.
 * DRY-RUN returns the SKILL.md diff and file changes without writing.
 */
export async function updateUpstreamSkill({ id, commit, force = false, dryRun = false, ...options } = {}) {
  const { skillDirectory } = globalCapabilityPaths(options);
  const { lock } = await readSkillLock(options);
  const entry = lock.skills.find((item) => item.id === id);
  if (!entry) throw upstreamError(`Skill ${id} has no upstream lock entry`, "ERR_NOEMA_SKILL_UNLOCKED");
  if (commit !== undefined && !COMMIT_PATTERN.test(String(commit))) throw upstreamError(`Invalid commit: ${commit}`);
  const local = await localState(entry, skillDirectory);
  if (local.state === "modified" && !force && !dryRun) {
    throw upstreamError(`Skill ${id} was edited locally since ${String(entry.commit).slice(0, 12)}; `
      + "move the edit into a project patch, or update with force to discard it", "ERR_NOEMA_SKILL_MODIFIED");
  }
  const fetched = await fetchUpstream({ repository: entry.repository, target: commit || entry.ref || "HEAD", path: entry.path });
  try {
    if (fetched.id !== id) throw upstreamError(`Upstream now names this Skill ${fetched.id}, not ${id}; install it separately`);
    const warnings = entry.helpers ? [`Helper checkout ${entry.helpers} is not updated by this action`] : [];
    const current = local.state !== "missing" ? await fileDigests(local.directory) : new Map();
    const next = await fileDigests(fetched.directory);
    const files = {
      added: [...next.keys()].filter((name) => !current.has(name)),
      removed: [...current.keys()].filter((name) => !next.has(name)),
      changed: [...next.keys()].filter((name) => current.has(name) && current.get(name) !== next.get(name)),
    };
    const unchanged = fetched.commit === entry.commit && local.state === "clean";
    const oldContent = local.state === "missing" ? "" : await readFile(join(local.directory, "SKILL.md"), "utf8");
    const diff = unchanged ? "" : await createSkillDiff(oldContent, fetched.content);
    const summary = { id, from: entry.commit, to: fetched.commit, local: local.state, files, diff, warnings };
    if (dryRun || unchanged) return { ...summary, updated: false, state: unchanged ? "current" : "available" };
    const destination = join(skillDirectory, id);
    const incoming = await installTree(fetched.directory, destination);
    const previous = join(skillDirectory, `.${id}.previous-${process.pid}-${Date.now()}`);
    let moved = false;
    try {
      if (local.state !== "missing") {
        await rename(destination, previous);
        moved = true;
      }
      await rename(incoming, destination);
    } catch (error) {
      if (moved) await rename(previous, destination).catch(() => {});
      await rm(incoming, { recursive: true, force: true });
      throw error;
    }
    if (moved) await rm(previous, { recursive: true, force: true });
    const updated = {
      skill_sha256: sha256(await readFile(join(destination, "SKILL.md"))),
      tree_sha256: await skillTreeDigest(destination),
      commit: fetched.commit,
      updated_at: today(),
    };
    await updateLock(options, (currentLock) => {
      const target = currentLock.skills.find((item) => item.id === id);
      if (!target) throw upstreamError(`Skill ${id} left the lock during update`);
      target.history = [...(target.history || []), {
        commit: target.commit, skill_sha256: target.skill_sha256, replaced_at: updated.updated_at,
        ...(local.state === "modified" ? { discarded_local_edit: true } : {}),
      }].slice(-HISTORY_LIMIT);
      Object.assign(target, updated);
    });
    return { ...summary, updated: true, state: "updated" };
  } finally {
    await fetched.cleanup();
  }
}
