import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PARTITIONS = Object.freeze(["public", "private"]);
const NOTE_EXTENSIONS = new Set([".md", ".markdown", ".typ"]);
const IGNORED_DIRECTORIES = new Set([
  ".git", ".direnv", ".lake", ".noema", ".venv", "node_modules",
  "__pycache__", ".ipynb_checkpoints", ".pytest_cache", ".mypy_cache", ".ruff_cache",
]);

function apiError(message, statusCode = 400, code = "ERR_WIKI") {
  return Object.assign(new Error(message), { statusCode, code });
}

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function cleanPartition(value) {
  const partition = String(value || "").trim().toLowerCase();
  if (!PARTITIONS.includes(partition)) throw apiError("partition must be public or private");
  return partition;
}

function cleanRepoName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name === "." || name === "..") {
    throw apiError("Invalid repository name");
  }
  return name;
}

function cleanRelativePath(value) {
  const raw = String(value || "").trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!raw) return "";
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw apiError("Invalid repository-relative path");
  }
  return parts.join("/");
}

export function expandNoemaPath(value, fallback = join(homedir(), "Documents", "Noema")) {
  const raw = String(value || fallback).trim();
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return resolve(raw);
}

export function wikiLayout(value) {
  return String(value || "").trim().toLowerCase() === "wiki" ? "wiki" : "legacy";
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function hasGitMetadata(path) {
  return existsSync(join(path, ".git"));
}

export async function discoverWikiRepositories(rootValue) {
  const root = expandNoemaPath(rootValue);
  const repositories = [];
  const diagnostics = [];
  for (const partition of PARTITIONS) {
    const partitionRoot = join(root, partition);
    if (!(await isDirectory(partitionRoot))) {
      diagnostics.push({
        code: "missing-partition",
        severity: "info",
        partition,
        path: partitionRoot,
        message: `Missing ${partition}/ directory`,
      });
      continue;
    }
    const entries = await readdir(partitionRoot, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
      const path = join(partitionRoot, entry.name);
      if (!hasGitMetadata(path)) {
        diagnostics.push({
          code: "non-git-directory",
          severity: "warning",
          partition,
          path,
          name: entry.name,
          message: `${partition}/${entry.name} is not indexed because it is not a Git repository`,
        });
        continue;
      }
      repositories.push({
        id: `${partition}/${entry.name}`,
        name: entry.name,
        partition,
        path,
        public: partition === "public",
      });
    }
  }
  return { root, layout: "wiki", repositories, diagnostics };
}

async function walkNotes(root) {
  const files = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && NOTE_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(file);
    }
  }
  await walk(root);
  return files;
}

function parseList(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.startsWith("[") && text.endsWith("]")) {
    return text.slice(1, -1).split(",").map((part) => part.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  }
  return text.split(",").map((part) => part.trim()).filter(Boolean);
}

function metadata(content) {
  const fields = {};
  const meta = content.match(/^\s*#\+begin\s+meta\s*\r?\n([\s\S]*?)\r?\n\s*#\+end\s+meta/im)?.[1];
  const front = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)?.[1];
  for (const line of String(front || meta || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][\w-]*):\s*(.*?)\s*$/);
    if (!match) continue;
    fields[match[1].toLowerCase()] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return fields;
}

function titleFor(file, content, meta) {
  return String(meta.title || content.match(/^#+\s+(.+)$/m)?.[1] || content.match(/^=+\s+(.+)$/m)?.[1]
    || basename(file, extname(file))).trim();
}

function wikiLinks(content) {
  const links = [];
  const source = String(content).replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const match of source.matchAll(/(?<!\\)\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g)) {
    const target = String(match[1] || "").trim();
    if (target) links.push({ target, label: String(match[2] || "").trim() });
  }
  return links;
}

function canonicalTitle(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase();
}

function disambiguation(note) {
  return `${note.partition}/${note.repository}/${note.repositoryPath}`;
}

function resolveWikiRelationships(notes) {
  const byTitle = new Map();
  const byId = new Map();
  for (const note of notes) {
    if (note.id) byId.set(canonicalTitle(note.id), note);
    for (const value of [note.title, ...note.aliases]) {
      const key = canonicalTitle(value);
      if (!key) continue;
      const bucket = byTitle.get(key) || [];
      bucket.push(note);
      byTitle.set(key, bucket);
    }
  }
  const wanted = new Map();
  const ambiguous = [];
  for (const note of notes) {
    note.refs = [];
    note.unresolvedLinks = [];
    for (const link of note.wikiLinks) {
      const stable = String(link.target).match(/^roam:\/\/(?:id\/)?(.+)$/i)?.[1];
      const candidates = stable
        ? (byId.get(canonicalTitle(stable)) ? [byId.get(canonicalTitle(stable))] : [])
        : (byTitle.get(canonicalTitle(link.target)) || []);
      if (candidates.length === 1) {
        const target = candidates[0];
        if (target.file !== note.file) {
          note.refs.push(target.id);
          target.backlinks.push(note.id);
        }
      } else if (candidates.length === 0) {
        note.unresolvedLinks.push(link.target);
        const key = canonicalTitle(link.target);
        const current = wanted.get(key) || { title: link.target, references: [] };
        current.references.push({ sourceId: note.id, sourceTitle: note.title, sourceFile: note.file });
        wanted.set(key, current);
      } else {
        ambiguous.push({
          sourceId: note.id,
          sourceTitle: note.title,
          target: link.target,
          candidates: candidates.map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
            file: candidate.file,
            location: disambiguation(candidate),
          })),
        });
      }
    }
    note.refs = [...new Set(note.refs)];
    note.unresolvedLinks = [...new Set(note.unresolvedLinks)];
  }
  for (const note of notes) note.backlinks = [...new Set(note.backlinks)];
  const duplicates = [...byTitle.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([title, items]) => ({
      title,
      candidates: items.map((item) => ({ id: item.id, title: item.title, file: item.file, location: disambiguation(item) })),
    }));
  return {
    notes,
    reports: {
      wanted: [...wanted.values()].sort((a, b) => a.title.localeCompare(b.title)),
      ambiguous,
      duplicates,
    },
  };
}

async function noteForFile(file, repository, workspaceRoot) {
  const content = await readFile(file, "utf8");
  const info = await stat(file);
  const meta = metadata(content);
  const workspacePath = relative(workspaceRoot, file).split(sep).join("/");
  const repositoryPath = relative(repository.path, file).split(sep).join("/");
  const title = titleFor(file, content, meta);
  const id = String(meta.id || `path:${workspacePath}`);
  return {
    key: id,
    id,
    title,
    aliases: parseList(meta.aliases),
    tags: parseList(meta.tags),
    private: repository.partition === "private" || String(meta.private).toLowerCase() === "true",
    file,
    path: workspacePath,
    link: workspacePath,
    repositoryPath,
    repository: repository.name,
    repositoryId: repository.id,
    partition: repository.partition,
    mtimeMs: info.mtimeMs,
    size: info.size,
    wikiLinks: wikiLinks(content),
    refs: [],
    backlinks: [],
  };
}

export async function buildWikiIndex(rootValue, options = {}) {
  const root = expandNoemaPath(rootValue);
  const layout = wikiLayout(options.layout);
  if (layout === "legacy") {
    const repository = { id: "legacy", name: "Legacy", partition: "private", path: root, public: false };
    const files = await walkNotes(root);
    const notes = await Promise.all(files.map((file) => noteForFile(file, repository, root)));
    const related = resolveWikiRelationships(notes);
    const index = {
      type: "wiki-index",
      root,
      layout,
      repositories: [repository],
      diagnostics: [{
        code: "legacy-layout",
        severity: "info",
        path: root,
        message: "Legacy single-repository layout is active; no files are moved automatically",
      }],
      ...related,
    };
    await persistWikiIndex(index);
    return index;
  }
  const discovered = await discoverWikiRepositories(root);
  const noteGroups = await Promise.all(discovered.repositories.map(async (repository) => {
    const files = await walkNotes(repository.path);
    return await Promise.all(files.map((file) => noteForFile(file, repository, root)));
  }));
  const index = {
    type: "wiki-index",
    ...discovered,
    ...resolveWikiRelationships(noteGroups.flat()),
  };
  await persistWikiIndex(index);
  return index;
}

function sql(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

export function wikiDatabaseFile(rootValue) {
  return join(expandNoemaPath(rootValue), ".noema", "wiki.db");
}

export async function persistWikiIndex(index) {
  const dbFile = wikiDatabaseFile(index.root);
  const dbDir = dirname(dbFile);
  const temp = join(dbDir, `.wiki.db.tmp-${process.pid}-${Date.now()}`);
  await mkdir(dbDir, { recursive: true });
  const statements = [
    "PRAGMA journal_mode=DELETE;",
    "BEGIN;",
    "CREATE TABLE IF NOT EXISTS repositories (id text primary key, partition text not null, name text not null, path text not null);",
    "CREATE TABLE IF NOT EXISTS pages (id text primary key, title text not null, file text not null unique, workspace_path text not null, repository_id text not null, partition text not null, private integer not null, mtime real not null);",
    "CREATE TABLE IF NOT EXISTS aliases (page_id text not null, alias text not null);",
    "CREATE TABLE IF NOT EXISTS links (source_id text not null, target_id text, target_title text not null, status text not null);",
    "CREATE INDEX IF NOT EXISTS wiki_pages_title_idx ON pages(title);",
    "CREATE INDEX IF NOT EXISTS wiki_aliases_alias_idx ON aliases(alias);",
    "CREATE INDEX IF NOT EXISTS wiki_links_target_idx ON links(target_id);",
    "DELETE FROM links;", "DELETE FROM aliases;", "DELETE FROM pages;", "DELETE FROM repositories;",
  ];
  for (const repository of index.repositories) {
    statements.push(`INSERT INTO repositories VALUES (${sql(repository.id)}, ${sql(repository.partition)}, ${sql(repository.name)}, ${sql(repository.path)});`);
  }
  const noteById = new Map(index.notes.map((note) => [note.id, note]));
  for (const note of index.notes) {
    statements.push(`INSERT OR REPLACE INTO pages VALUES (${[
      sql(note.id), sql(note.title), sql(note.file), sql(note.path), sql(note.repositoryId),
      sql(note.partition), note.private ? "1" : "0", Number(note.mtimeMs) || 0,
    ].join(", ")});`);
    for (const alias of note.aliases) {
      statements.push(`INSERT INTO aliases VALUES (${sql(note.id)}, ${sql(alias)});`);
    }
    for (const targetId of note.refs) {
      const target = noteById.get(targetId);
      statements.push(`INSERT INTO links VALUES (${sql(note.id)}, ${sql(targetId)}, ${sql(target?.title || "")}, 'resolved');`);
    }
    for (const target of note.unresolvedLinks) {
      statements.push(`INSERT INTO links VALUES (${sql(note.id)}, NULL, ${sql(target)}, 'missing');`);
    }
  }
  statements.push("COMMIT;");
  try {
    await execFileAsync("sqlite3", [temp, statements.join("\n")], { cwd: index.root, maxBuffer: 1024 * 1024 * 8 });
    await rename(temp, dbFile);
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, dbFile, message: "sqlite3 is unavailable" };
    throw error;
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return { ok: true, dbFile };
}

export function resolveWikiLink(index, targetValue) {
  const target = String(targetValue || "").trim();
  const stable = target.match(/^roam:\/\/(?:id\/)?(.+)$/i)?.[1];
  const key = canonicalTitle(stable || target);
  const candidates = index.notes.filter((note) =>
    stable
      ? canonicalTitle(note.id) === key
      : [note.title, ...(note.aliases || [])].some((value) => canonicalTitle(value) === key));
  return {
    type: "wiki-link",
    target,
    status: candidates.length === 1 ? "resolved" : candidates.length > 1 ? "ambiguous" : "missing",
    candidates: candidates.map((note) => ({
      id: note.id, title: note.title, file: note.file, path: note.path,
      repositoryId: note.repositoryId, partition: note.partition,
    })),
  };
}

export async function initWikiWorkspace(rootValue) {
  const root = expandNoemaPath(rootValue);
  await Promise.all([
    mkdir(join(root, "public"), { recursive: true }),
    mkdir(join(root, "private"), { recursive: true }),
    mkdir(join(root, ".noema"), { recursive: true }),
  ]);
  return await discoverWikiRepositories(root);
}

export async function initWikiRepository(rootValue, partitionValue, nameValue) {
  const root = expandNoemaPath(rootValue);
  const partition = cleanPartition(partitionValue);
  const name = cleanRepoName(nameValue);
  const partitionRoot = join(root, partition);
  const path = join(partitionRoot, name);
  await mkdir(partitionRoot, { recursive: true });
  if (existsSync(path)) throw apiError(`Repository destination already exists: ${partition}/${name}`, 409);
  await mkdir(path);
  await execFileAsync("git", ["init", path], { cwd: root });
  return { ok: true, repository: { id: `${partition}/${name}`, name, partition, path } };
}

export async function cloneWikiRepository(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const partition = cleanPartition(body.partition);
  const name = cleanRepoName(body.name);
  const remote = String(body.remote || "").trim();
  if (!remote || /^-/.test(remote)) throw apiError("A Git remote is required");
  const partitionRoot = join(root, partition);
  const path = join(partitionRoot, name);
  await mkdir(partitionRoot, { recursive: true });
  if (existsSync(path)) throw apiError(`Repository destination already exists: ${partition}/${name}`, 409);
  await execFileAsync("git", ["clone", "--", remote, path], { cwd: root, maxBuffer: 1024 * 1024 * 8 });
  return { ok: true, repository: { id: `${partition}/${name}`, name, partition, path } };
}

async function repositoryFromId(root, id) {
  const [partitionValue, nameValue, ...extra] = String(id || "").split("/");
  if (extra.length) throw apiError("Invalid repository id");
  const partition = cleanPartition(partitionValue);
  const name = cleanRepoName(nameValue);
  const path = join(root, partition, name);
  if (!inside(root, path) || !(await isDirectory(path)) || !hasGitMetadata(path)) {
    throw apiError(`Unknown Wiki repository: ${partition}/${name}`, 404);
  }
  return { id: `${partition}/${name}`, name, partition, path };
}

async function git(repository, args) {
  try {
    return await execFileAsync("git", ["-C", repository.path, ...args], { maxBuffer: 1024 * 1024 * 8 });
  } catch (error) {
    throw apiError(String(error?.stderr || error?.message || "Git command failed").trim(), 409, "ERR_WIKI_GIT");
  }
}

export async function wikiRepositoryStatus(rootValue, repositoryId) {
  const root = expandNoemaPath(rootValue);
  const repository = await repositoryFromId(root, repositoryId);
  const [{ stdout: statusText }, { stdout: branchText }, remote] = await Promise.all([
    git(repository, ["status", "--porcelain=v1", "--branch"]),
    git(repository, ["branch", "--show-current"]),
    git(repository, ["remote", "get-url", "origin"]).catch(() => ({ stdout: "" })),
  ]);
  return {
    ok: true,
    repository,
    branch: branchText.trim(),
    remote: remote.stdout.trim(),
    clean: !statusText.split(/\r?\n/).some((line) => line && !line.startsWith("##")),
    status: statusText.trim(),
  };
}

export async function runWikiGitAction(rootValue, actionValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const repository = await repositoryFromId(root, body.repositoryId);
  const action = String(actionValue || "");
  if (action === "pull") await git(repository, ["pull", "--ff-only"]);
  else if (action === "push") await git(repository, ["push"]);
  else if (action === "commit") {
    const message = String(body.message || "").trim();
    if (!message) throw apiError("Commit message is required");
    const paths = Array.isArray(body.paths) ? body.paths.map(cleanRelativePath).filter(Boolean) : [];
    if (!paths.length) throw apiError("Select at least one repository-relative path to commit");
    await git(repository, ["add", "--", ...paths]);
    await git(repository, ["commit", "-m", message, "--", ...paths]);
  } else {
    throw apiError(`Unsupported Git action: ${action}`);
  }
  return await wikiRepositoryStatus(root, repository.id);
}

function slugify(value) {
  return String(value || "page").normalize("NFKD").toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "") || "page";
}

export async function createWikiPage(rootValue, layoutValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const layout = wikiLayout(layoutValue);
  const title = String(body.title || "").trim();
  if (!title) throw apiError("Page title is required");
  let repository;
  if (layout === "legacy") {
    repository = { id: "legacy", name: "Legacy", partition: "private", path: root };
  } else {
    repository = await repositoryFromId(root, body.repositoryId);
  }
  const directory = cleanRelativePath(body.directory || "");
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const pattern = String(body.filenamePattern || "{slug}.md")
    .replaceAll("{slug}", slugify(title))
    .replaceAll("{title}", title)
    .replaceAll("{date}", new Date().toISOString().slice(0, 10))
    .replaceAll("{timestamp}", timestamp);
  const requested = cleanRelativePath(body.filename || pattern);
  const filename = NOTE_EXTENSIONS.has(extname(requested).toLowerCase()) ? requested : `${requested}.md`;
  const file = resolve(repository.path, directory, filename);
  if (!inside(repository.path, file)) throw apiError("New page must stay inside its repository");
  if (existsSync(file)) throw apiError("A page already exists at that location", 409);
  const id = String(body.id || `${timestamp}-${randomUUID().slice(0, 8)}`);
  const tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : parseList(body.tags);
  const content = [
    "#+begin meta",
    `id: ${id}`,
    `title: ${title}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `kind: ${String(body.kind || "note").trim() || "note"}`,
    `tags: ${tags.join(", ")}`,
    "refs: ",
    ...(repository.partition === "private" ? ["private: true"] : []),
    "#+end meta",
    "",
    `# ${title}`,
    "",
  ].join("\n");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, { encoding: "utf8", flag: "wx" });
  return { ok: true, file, id, title, repositoryId: repository.id, partition: repository.partition };
}

export function publicWikiNotes(index) {
  return index.layout === "wiki"
    ? index.notes.filter((note) => note.partition === "public" && note.private !== true)
    : [];
}
