import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import { isUuidV7, newNoemaId } from "../../shared/identity.mjs";
import {
  normalizeWikiNamespace, qualifiedWikiTitle, scanWikiLinks, splitQualifiedWikiTarget,
} from "../../shared/wiki-link.mjs";
import { diffRoamFile, fileHistory, restoreFileFromCommit } from "./roam-git.mjs";

const execFileAsync = promisify(execFile);
const PARTITIONS = Object.freeze(["public", "private"]);
const NOTE_EXTENSIONS = new Set([".md", ".markdown"]);
const REPOSITORY_MANIFEST = "noema.toml";
const WIKI_SCHEMA_VERSION = 6;
const REPOSITORY_GITIGNORE = [
  ".DS_Store",
  ".direnv/",
  ".noema/",
  ".lake/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".ruff_cache/",
  ".sage/",
  ".venv/",
  "__pycache__/",
  ".ipynb_checkpoints/",
  "node_modules/",
  "",
].join("\n");
const IGNORED_DIRECTORIES = new Set([
  ".git", ".direnv", ".lake", ".noema", ".venv", "node_modules",
  "__pycache__", ".ipynb_checkpoints", ".pytest_cache", ".mypy_cache", ".ruff_cache",
]);
const IGNORED_FILES = new Set([".DS_Store"]);

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

function cleanWikiNamespace(value, fallback = "") {
  const namespace = normalizeWikiNamespace(value || fallback);
  if (!namespace || namespace.length > 240 || /[\[\]|#:\u0000-\u001f]/u.test(namespace)) {
    throw apiError("Namespace must contain valid slash-separated names without colon, brackets, pipe, or #");
  }
  return namespace;
}

function cleanRelativePath(value) {
  const raw = String(value || "").trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!raw) return "";
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || IGNORED_DIRECTORIES.has(part))) {
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

function provisionalKey(...values) {
  return `provisional:${createHash("sha256").update(values.join("\0")).digest("hex").slice(0, 24)}`;
}

function parseRepositoryManifest(text) {
  const schema = Number(String(text || "").match(/^\s*schema\s*=\s*(\d+)\s*$/m)?.[1] || 0);
  const repositoryId = String(text || "").match(/^\s*repository_id\s*=\s*["']([^"']+)["']\s*$/m)?.[1]?.trim() || "";
  const namespace = normalizeWikiNamespace(String(text || "").match(/^\s*namespace\s*=\s*["']([^"']+)["']\s*$/m)?.[1] || "");
  const namespaceAliases = parseList(String(text || "").match(/^\s*namespace_aliases\s*=\s*(.+?)\s*$/m)?.[1] || "");
  return { schema, repositoryId, namespace, namespaceAliases };
}

async function repositoryManifest(path) {
  const file = join(path, REPOSITORY_MANIFEST);
  try {
    const parsed = parseRepositoryManifest(await readFile(file, "utf8"));
    return {
      file,
      exists: true,
      schema: parsed.schema,
      repositoryId: parsed.repositoryId,
      namespace: parsed.namespace,
      namespaceAliases: parsed.namespaceAliases,
      managed: parsed.schema === 1 && isUuidV7(parsed.repositoryId),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { file, exists: false, schema: 0, repositoryId: "", namespace: "", namespaceAliases: [], managed: false };
  }
}

async function ensureRepositoryManifest(path) {
  const current = await repositoryManifest(path);
  if (current.managed) return current;
  if (current.exists) {
    throw apiError(`${REPOSITORY_MANIFEST} must contain schema = 1 and a UUIDv7 repository_id`, 409, "ERR_WIKI_REPOSITORY_IDENTITY");
  }
  const repositoryId = newNoemaId("repository");
  await writeFile(
    current.file,
    `schema = 1\nrepository_id = "${repositoryId}"\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return { ...current, schema: 1, repositoryId, managed: true };
}

async function ensureRepositoryGitIgnore(path) {
  const file = join(path, ".gitignore");
  if (existsSync(file)) return file;
  await writeFile(file, REPOSITORY_GITIGNORE, { encoding: "utf8", flag: "wx" });
  return file;
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
      const manifest = await repositoryManifest(path);
      const repositoryUid = manifest.repositoryId || provisionalKey("repository", partition, entry.name);
      if (!manifest.managed) {
        diagnostics.push({
          code: "missing-repository-manifest",
          severity: "warning",
          partition,
          path: manifest.file,
          name: entry.name,
          message: `${partition}/${entry.name} needs a committed ${REPOSITORY_MANIFEST} before its repository identity can be shared`,
        });
      }
      repositories.push({
        id: `${partition}/${entry.name}`,
        uid: repositoryUid,
        identityStatus: manifest.managed ? "managed" : "provisional",
        name: entry.name,
        namespace: manifest.namespace || normalizeWikiNamespace(entry.name),
        qualifiedNamespace: `${partition}/${manifest.namespace || normalizeWikiNamespace(entry.name)}`,
        namespaceAliases: [...new Set([entry.name, ...(manifest.namespaceAliases || [])].map(normalizeWikiNamespace).filter(Boolean))],
        partition,
        path,
        public: partition === "public",
      });
    }
  }
  return { root, layout: "wiki", repositories, diagnostics };
}

async function walkFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (entry.isFile() && IGNORED_FILES.has(entry.name)) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files.push(file);
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

function replaceMetaField(content, key, value) {
  const block = content.match(/^\s*#\+begin\s+meta\s*\r?\n([\s\S]*?)\r?\n\s*#\+end\s+meta/im);
  if (!block || block.index == null) return content;
  const field = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*).*$`, "im");
  let nextBlock;
  if (field.test(block[0])) nextBlock = block[0].replace(field, `$1${value}`);
  else nextBlock = block[0].replace(/\r?\n\s*#\+end\s+meta/i, `\n${key}: ${value}\n#+end meta`);
  return `${content.slice(0, block.index)}${nextBlock}${content.slice(block.index + block[0].length)}`;
}

function titleFor(file, content, meta) {
  return String(meta.title || content.match(/^#+\s+(.+)$/m)?.[1] || content.match(/^=+\s+(.+)$/m)?.[1]
    || basename(file, extname(file))).trim();
}

function wikiLinks(content) {
  const links = [];
  const source = String(content).replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const match of scanWikiLinks(source)) links.push({ target: match.target, label: match.label });
  for (const match of source.matchAll(/\[[^\]\n]*\]\((roam:\/\/[^)\s]+)\)/gi)) {
    links.push({ target: String(match[1] || "").trim(), label: "" });
  }
  return links;
}

function blockIds(content) {
  const ids = [];
  for (const match of String(content).matchAll(/\{#([A-Za-z0-9][A-Za-z0-9._:-]{2,127})\}/g)) {
    ids.push({ id: match[1], kind: "anchor", offset: match.index || 0 });
  }
  for (const match of String(content).matchAll(/\{[^{}\n]*\bid\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._:-]{2,127})["']?[^{}\n]*\}/g)) {
    ids.push({ id: match[1], kind: "planning", offset: match.index || 0 });
  }
  return [...new Map(ids.map((item) => [item.id, item])).values()];
}

function dependencyRefs(content, noteFile, repository) {
  const refs = [];
  const add = (raw, kind) => {
    const value = String(raw || "").trim().replace(/^["<]|[">]$/g, "");
    if (!value || /^(?:[a-z][a-z0-9+.-]*:|#|@@)/i.test(value)) return;
    const file = resolve(dirname(noteFile), value.split(/[?#]/, 1)[0]);
    if (!inside(repository.path, file)) {
      refs.push({ kind, raw: value, status: "outside-repository", path: "" });
      return;
    }
    refs.push({
      kind,
      raw: value,
      status: existsSync(file) ? "resolved" : "missing",
      path: relative(repository.path, file).split(sep).join("/"),
    });
  };
  for (const match of String(content).matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) add(match[1], "asset");
  for (const match of String(content).matchAll(/^\s*#\+include:\s+([^\n]+)$/gim)) add(match[1], "include");
  return refs;
}

function canonicalTitle(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase();
}

function disambiguation(note) {
  return `${note.fullTitle || qualifiedWikiTitle(note.qualifiedNamespace, note.title)} · ${note.repositoryPath}`;
}

function namespaceKeys(note) {
  const aliases = note.namespaceAliases || [];
  return new Set([
    note.namespace,
    note.qualifiedNamespace,
    note.repository,
    note.repositoryId,
    ...aliases,
    ...aliases.map((alias) => `${note.partition}/${normalizeWikiNamespace(alias)}`),
  ].map((value) => canonicalTitle(normalizeWikiNamespace(value))).filter(Boolean));
}

function titleCandidates(notes, byTitle, targetValue, source = null) {
  const target = String(targetValue || "").trim();
  const stable = target.match(/^roam:\/\/(?:id\/)?(.+)$/i)?.[1];
  if (stable) return notes.filter((note) => canonicalTitle(note.id) === canonicalTitle(stable));
  const knownNamespaces = notes.flatMap((note) => [note.namespace, note.qualifiedNamespace, ...(note.namespaceAliases || [])]);
  const parsed = splitQualifiedWikiTarget(target, knownNamespaces);
  const candidates = byTitle.get(canonicalTitle(parsed.title)) || [];
  if (parsed.qualified) {
    const scope = canonicalTitle(parsed.namespace);
    return candidates.filter((note) => namespaceKeys(note).has(scope));
  }
  if (source) {
    const local = candidates.filter((note) => note.repositoryId === source.repositoryId);
    if (local.length === 1) return local;
  }
  return candidates;
}

function resolveWikiRelationships(notes) {
  const byTitle = new Map();
  const byId = new Map();
  const duplicateIds = [];
  for (const note of notes) {
    if (note.id && note.identityStatus !== "provisional") {
      const key = canonicalTitle(note.id);
      const previous = byId.get(key);
      if (previous) duplicateIds.push({
        id: note.id,
        candidates: [previous, note].map((item) => ({
          id: item.id, title: item.title, file: item.file, location: disambiguation(item),
        })),
      });
      else byId.set(key, note);
    }
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
      const candidates = titleCandidates(notes, byTitle, link.target, note);
      if (candidates.length === 1) {
        const target = candidates[0];
        if (target.file !== note.file) {
          note.refs.push(target.id);
          target.backlinks.push(note.id);
        }
      } else if (candidates.length === 0) {
        note.unresolvedLinks.push(link.target);
        const parsed = splitQualifiedWikiTarget(link.target, notes.flatMap((item) => [item.namespace, item.qualifiedNamespace]));
        const resolvedNamespace = parsed.namespace || note.namespace;
        const key = canonicalTitle(qualifiedWikiTitle(resolvedNamespace, parsed.title));
        const current = wanted.get(key) || {
          title: parsed.title,
          namespace: resolvedNamespace,
          qualifiedTitle: parsed.qualified ? link.target : qualifiedWikiTitle(note.namespace, link.target),
          references: [],
        };
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
  const byQualifiedTitle = new Map();
  for (const note of notes) {
    for (const value of [note.title, ...note.aliases]) {
      const key = canonicalTitle(qualifiedWikiTitle(note.qualifiedNamespace, value));
      const bucket = byQualifiedTitle.get(key) || [];
      bucket.push(note);
      byQualifiedTitle.set(key, bucket);
    }
  }
  const duplicates = [...byQualifiedTitle.entries()]
    .filter(([, items]) => new Set(items.map((item) => item.file)).size > 1)
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
      duplicateIds,
    },
  };
}

function openWikiNoteCache(rootValue) {
  const file = wikiDatabaseFile(rootValue);
  if (!existsSync(file)) return null;
  try {
    const db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version || 0);
    if (version !== WIKI_SCHEMA_VERSION) { db.close(); return null; }
    const lookup = db.prepare("SELECT snapshot_json FROM note_cache WHERE repository_id=? AND path=? AND repository_uid=? AND size=? AND mtime=?");
    return { db, lookup };
  } catch {
    return null;
  }
}

async function noteForFile(file, repository, workspaceRoot, cache = null, infoValue = null) {
  const info = infoValue || await stat(file);
  const workspacePath = relative(workspaceRoot, file).split(sep).join("/");
  const repositoryPath = relative(repository.path, file).split(sep).join("/");
  const repositoryCacheIdentity = [
    repository.uid || repository.id,
    repository.namespace || repository.name,
    ...(repository.namespaceAliases || []),
  ].join("|");
  const cached = cache?.lookup.get(repository.id, repositoryPath, repositoryCacheIdentity, info.size, info.mtimeMs);
  if (cached?.snapshot_json) {
    try {
      return { ...JSON.parse(String(cached.snapshot_json)), file, path: workspacePath, workspacePath, cacheHit: true };
    } catch {}
  }
  const content = await readFile(file, "utf8");
  const meta = metadata(content);
  const title = titleFor(file, content, meta);
  const namespace = normalizeWikiNamespace(meta.namespace || repository.namespace || repository.name);
  const qualifiedNamespace = `${repository.partition}/${namespace}`;
  const pageNamespaceAliases = parseList(meta.namespace_aliases).map(normalizeWikiNamespace).filter(Boolean);
  const persistedId = String(meta.id || "").trim();
  const id = persistedId || provisionalKey(repository.uid || repository.id, repositoryPath);
  const blocks = blockIds(content);
  const dependencies = dependencyRefs(content, file, repository);
  return {
    key: id,
    pageKey: `${repository.uid || repository.id}:${repositoryPath}`,
    id,
    title,
    namespace,
    qualifiedNamespace,
    qualifiedTitle: qualifiedWikiTitle(namespace, title),
    fullTitle: qualifiedWikiTitle(qualifiedNamespace, title),
    namespaceSource: meta.namespace ? "page" : "repository",
    namespaceAliases: [...new Set([
      ...pageNamespaceAliases,
      ...(meta.namespace ? [] : [
        repository.name,
        repository.id,
        repository.qualifiedNamespace,
        ...(repository.namespaceAliases || []),
      ]),
    ].map(normalizeWikiNamespace).filter(Boolean))],
    kind: String(meta.kind || "page"),
    redirectTo: String(meta.redirect_to || meta.redirect || ""),
    identityStatus: persistedId ? (/^\d{14}-/.test(persistedId) || !/^[0-9a-f-]{36}$/i.test(persistedId) ? "legacy" : "managed") : "provisional",
    aliases: parseList(meta.aliases),
    tags: parseList(meta.tags),
    private: repository.partition === "private" || String(meta.private).toLowerCase() === "true",
    file,
    path: workspacePath,
    link: workspacePath,
    repositoryPath,
    repository: repository.name,
    repositoryId: repository.id,
    repositoryUid: repository.uid || repository.id,
    partition: repository.partition,
    mtimeMs: info.mtimeMs,
    size: info.size,
    blocks,
    dependencies,
    wikiLinks: wikiLinks(content),
    searchText: content,
    refs: [],
    backlinks: [],
  };
}

async function repositoryFileInventory(repository) {
  const paths = await walkFiles(repository.path);
  let statusText = "";
  try {
    statusText = (await execFileAsync(
      "git", ["-C", repository.path, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { maxBuffer: 1024 * 1024 * 16 },
    )).stdout;
  } catch {}
  const statuses = new Map();
  const entries = String(statusText).split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    statuses.set(path, code.trim() || "clean");
    if ((code.includes("R") || code.includes("C")) && entries[index + 1]) index++;
  }
  return await Promise.all(paths.map(async (file) => {
    const info = await stat(file);
    const repositoryPath = relative(repository.path, file).split(sep).join("/");
    return {
      repositoryId: repository.id,
      repositoryUid: repository.uid,
      partition: repository.partition,
      file,
      path: `${repository.id}/${repositoryPath}`,
      repositoryPath,
      name: basename(file),
      ext: extname(file).replace(/^\./, "").toLowerCase(),
      size: info.size,
      mtimeMs: info.mtimeMs,
      kind: NOTE_EXTENSIONS.has(extname(file).toLowerCase()) ? "note" : "file",
      gitStatus: statuses.get(repositoryPath) || "clean",
    };
  }));
}

export async function buildWikiIndex(rootValue, options = {}) {
  const root = expandNoemaPath(rootValue);
  const layout = wikiLayout(options.layout);
  if (layout === "legacy") {
    const repository = {
      id: "legacy", uid: "legacy", identityStatus: "legacy",
      name: "Legacy", namespace: "Legacy", qualifiedNamespace: "private/Legacy", namespaceAliases: ["legacy"],
      partition: "private", path: root, public: false,
    };
    const cache = openWikiNoteCache(root);
    let inventory;
    let notes;
    try {
      inventory = await repositoryFileInventory(repository);
      notes = await Promise.all(inventory
        .filter((item) => item.kind === "note")
        .map((item) => noteForFile(item.file, repository, root, cache, item)));
    } finally {
      cache?.db.close();
    }
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
      files: inventory,
      directories: directoryInventory(inventory),
      ...related,
    };
    index.generation = wikiIndexGeneration(index);
    await persistWikiIndex(index);
    return index;
  }
  const discovered = await discoverWikiRepositories(root);
  const cache = openWikiNoteCache(root);
  let indexedRepositories;
  try {
    indexedRepositories = await Promise.all(discovered.repositories.map(async (repository) => {
      const inventory = await repositoryFileInventory(repository);
      const notes = await Promise.all(inventory
        .filter((item) => item.kind === "note")
        .map((item) => noteForFile(item.file, repository, root, cache, item)));
      return { inventory, notes };
    }));
  } finally {
    cache?.db.close();
  }
  const noteGroups = indexedRepositories.map((item) => item.notes);
  const inventories = indexedRepositories.flatMap((item) => item.inventory);
  const related = resolveWikiRelationships(noteGroups.flat());
  for (const duplicate of related.reports.duplicateIds) {
    discovered.diagnostics.push({
      code: "duplicate-page-id",
      severity: "error",
      message: `Page id ${duplicate.id} is present in multiple files`,
    });
  }
  const index = {
    type: "wiki-index",
    ...discovered,
    files: inventories,
    directories: directoryInventory(inventories),
    ...related,
  };
  index.generation = wikiIndexGeneration(index);
  await persistWikiIndex(index);
  return index;
}

function directoryInventory(files) {
  const paths = new Map();
  for (const file of files) {
    const parts = String(file.repositoryPath || "").split("/").filter(Boolean);
    for (let index = 0; index < Math.max(1, parts.length); index++) {
      const relativePath = parts.slice(0, index).join("/");
      const key = `${file.repositoryId}:${relativePath}`;
      const entry = paths.get(key) || {
        repositoryId: file.repositoryId,
        partition: file.partition,
        path: relativePath,
        name: relativePath.split("/").at(-1) || file.repositoryId.split("/").at(-1),
        fileCount: 0,
      };
      entry.fileCount++;
      paths.set(key, entry);
    }
  }
  return [...paths.values()].sort((a, b) => `${a.repositoryId}/${a.path}`.localeCompare(`${b.repositoryId}/${b.path}`));
}

function wikiIndexGeneration(index) {
  const digest = createHash("sha256");
  digest.update(String(index.layout || "wiki"));
  for (const repository of index.repositories || []) {
    digest.update(`\0r:${repository.uid || repository.id}:${repository.identityStatus || ""}`);
  }
  for (const file of index.files || []) {
    digest.update(`\0f:${file.repositoryUid || file.repositoryId}:${file.repositoryPath}:${file.size}:${file.mtimeMs}`);
  }
  return digest.digest("hex").slice(0, 20);
}

export function wikiDatabaseFile(rootValue) {
  return join(expandNoemaPath(rootValue), ".noema", "wiki.db");
}

export async function persistWikiIndex(index) {
  const dbFile = wikiDatabaseFile(index.root);
  const dbDir = dirname(dbFile);
  await mkdir(dbDir, { recursive: true });
  const db = new DatabaseSync(dbFile, { timeout: 5000 });
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=5000;");
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version || 0);
    if (version !== WIKI_SCHEMA_VERSION) {
      db.exec(`
        DROP TABLE IF EXISTS pages_fts;
        DROP TABLE IF EXISTS pages_fts_trigram;
        DROP TABLE IF EXISTS repositories;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS pages;
        DROP TABLE IF EXISTS blocks;
        DROP TABLE IF EXISTS aliases;
        DROP TABLE IF EXISTS tags;
        DROP TABLE IF EXISTS links;
        DROP TABLE IF EXISTS dependencies;
        DROP TABLE IF EXISTS diagnostics;
        DROP TABLE IF EXISTS wiki_meta;
        DROP TABLE IF EXISTS note_cache;
        CREATE TABLE repositories (location_id text primary key, repository_id text not null, identity_status text not null, partition text not null, name text not null, namespace text not null, qualified_namespace text not null, namespace_aliases text not null, path text not null);
        CREATE TABLE files (repository_id text not null, path text not null, file text not null unique, kind text not null, extension text not null, size integer not null, mtime real not null, git_status text not null, primary key(repository_id, path));
        CREATE TABLE pages (page_key text primary key, page_id text not null, identity_status text not null, title text not null, namespace text not null, qualified_namespace text not null, namespace_source text not null, kind text not null, file text not null unique, workspace_path text not null, repository_path text not null, repository_id text not null, partition text not null, private integer not null, redirect_to text not null, mtime real not null);
        CREATE TABLE blocks (block_id text not null, page_key text not null, kind text not null, source_offset integer not null, primary key(page_key, block_id));
        CREATE TABLE aliases (page_key text not null, alias text not null);
        CREATE TABLE tags (page_key text not null, tag text not null);
        CREATE TABLE links (source_key text not null, target_id text, target_title text not null, status text not null);
        CREATE TABLE dependencies (source_key text not null, kind text not null, raw_target text not null, target_path text not null, status text not null);
        CREATE TABLE diagnostics (code text not null, severity text not null, message text not null, path text not null);
        CREATE TABLE wiki_meta (key text primary key, value text not null);
        CREATE TABLE note_cache (repository_id text not null, path text not null, repository_uid text not null, size integer not null, mtime real not null, snapshot_json text not null, primary key(repository_id, path));
        CREATE VIRTUAL TABLE pages_fts USING fts5(page_key UNINDEXED, title, aliases, tags, path, body, tokenize='unicode61 remove_diacritics 2');
        CREATE VIRTUAL TABLE pages_fts_trigram USING fts5(page_key UNINDEXED, title, aliases, tags, path, body, tokenize='trigram case_sensitive 0');
        CREATE INDEX wiki_pages_id_idx ON pages(page_id);
        CREATE INDEX wiki_pages_title_idx ON pages(title);
        CREATE INDEX wiki_pages_namespace_idx ON pages(qualified_namespace, title);
        CREATE INDEX wiki_pages_repository_idx ON pages(repository_id, repository_path);
        CREATE INDEX wiki_aliases_alias_idx ON aliases(alias);
        CREATE INDEX wiki_tags_tag_idx ON tags(tag);
        CREATE INDEX wiki_links_target_idx ON links(target_id);
        CREATE INDEX wiki_files_kind_idx ON files(kind, repository_id, path);
        PRAGMA user_version=${WIKI_SCHEMA_VERSION};
      `);
    }
    db.exec("CREATE TEMP TABLE IF NOT EXISTS wiki_seen_pages (page_key text primary key)");
    const insertRepository = db.prepare("INSERT INTO repositories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertFile = db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertPage = db.prepare("INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(page_key) DO UPDATE SET page_id=excluded.page_id, identity_status=excluded.identity_status, title=excluded.title, namespace=excluded.namespace, qualified_namespace=excluded.qualified_namespace, namespace_source=excluded.namespace_source, kind=excluded.kind, file=excluded.file, workspace_path=excluded.workspace_path, repository_path=excluded.repository_path, repository_id=excluded.repository_id, partition=excluded.partition, private=excluded.private, redirect_to=excluded.redirect_to, mtime=excluded.mtime");
    const insertAlias = db.prepare("INSERT INTO aliases VALUES (?, ?)");
    const insertTag = db.prepare("INSERT INTO tags VALUES (?, ?)");
    const insertBlock = db.prepare("INSERT OR REPLACE INTO blocks VALUES (?, ?, ?, ?)");
    const insertLink = db.prepare("INSERT INTO links VALUES (?, ?, ?, ?)");
    const insertDependency = db.prepare("INSERT INTO dependencies VALUES (?, ?, ?, ?, ?)");
    const insertDiagnostic = db.prepare("INSERT INTO diagnostics VALUES (?, ?, ?, ?)");
    const insertFts = db.prepare("INSERT INTO pages_fts VALUES (?, ?, ?, ?, ?, ?)");
    const insertTrigram = db.prepare("INSERT INTO pages_fts_trigram VALUES (?, ?, ?, ?, ?, ?)");
    const insertSeenPage = db.prepare("INSERT OR REPLACE INTO wiki_seen_pages VALUES (?)");
    const deleteFts = db.prepare("DELETE FROM pages_fts WHERE page_key=?");
    const deleteTrigram = db.prepare("DELETE FROM pages_fts_trigram WHERE page_key=?");
    const upsertCache = db.prepare("INSERT INTO note_cache VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id, path) DO UPDATE SET repository_uid=excluded.repository_uid, size=excluded.size, mtime=excluded.mtime, snapshot_json=excluded.snapshot_json");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TEMP TABLE IF NOT EXISTS wiki_seen_pages (page_key text primary key); DELETE FROM wiki_seen_pages; DELETE FROM repositories; DELETE FROM files; DELETE FROM blocks; DELETE FROM aliases; DELETE FROM tags; DELETE FROM links; DELETE FROM dependencies; DELETE FROM diagnostics;");
      for (const repository of index.repositories) {
        insertRepository.run(
          repository.id, repository.uid || repository.id, repository.identityStatus || "legacy", repository.partition,
          repository.name, repository.namespace || repository.name, repository.qualifiedNamespace || `${repository.partition}/${repository.name}`,
          JSON.stringify(repository.namespaceAliases || []), repository.path,
        );
      }
      for (const file of index.files || []) {
        insertFile.run(file.repositoryId, file.repositoryPath, file.file, file.kind, file.ext, Number(file.size) || 0, Number(file.mtimeMs) || 0, file.gitStatus || "clean");
      }
      const noteById = new Map(index.notes.map((note) => [note.id, note]));
      for (const note of index.notes) insertSeenPage.run(note.pageKey || note.key);
      const stale = db.prepare("SELECT page_key FROM pages WHERE page_key NOT IN (SELECT page_key FROM wiki_seen_pages)").all();
      for (const row of stale) { deleteFts.run(row.page_key); deleteTrigram.run(row.page_key); }
      db.exec("DELETE FROM pages WHERE page_key NOT IN (SELECT page_key FROM wiki_seen_pages)");
      for (const note of index.notes) {
        const pageKey = note.pageKey || note.key;
        insertPage.run(
          pageKey, note.id, note.identityStatus, note.title, note.namespace || note.repository,
          note.qualifiedNamespace || `${note.partition}/${note.namespace || note.repository}`, note.namespaceSource || "repository",
          note.kind || "page", note.file, note.path, note.repositoryPath, note.repositoryId, note.partition,
          note.private ? 1 : 0, note.redirectTo || "", Number(note.mtimeMs) || 0,
        );
        for (const alias of note.aliases) insertAlias.run(pageKey, alias);
        for (const tag of note.tags || []) insertTag.run(pageKey, tag);
        for (const block of note.blocks || []) insertBlock.run(block.id, pageKey, block.kind, Number(block.offset) || 0);
        for (const targetId of note.refs) insertLink.run(pageKey, targetId, noteById.get(targetId)?.title || "", "resolved");
        for (const target of note.unresolvedLinks) insertLink.run(pageKey, null, target, "missing");
        for (const dependency of note.dependencies || []) insertDependency.run(pageKey, dependency.kind, dependency.raw, dependency.path || "", dependency.status);
        if (!note.cacheHit) {
          const aliases = [note.qualifiedTitle, note.fullTitle, ...note.aliases].filter(Boolean).join(" ");
          const tags = (note.tags || []).join(" ");
          const path = `${note.repositoryId}/${note.repositoryPath}`;
          const body = String(note.searchText || "");
          deleteFts.run(pageKey);
          deleteTrigram.run(pageKey);
          insertFts.run(pageKey, note.title, aliases, tags, path, body);
          insertTrigram.run(pageKey, note.title, aliases, tags, path, body);
          const file = (index.files || []).find((item) => item.repositoryId === note.repositoryId && item.repositoryPath === note.repositoryPath);
          const snapshot = { ...note };
          delete snapshot.searchText;
          delete snapshot.cacheHit;
          const repository = (index.repositories || []).find((item) => item.id === note.repositoryId);
          const repositoryCacheIdentity = [
            note.repositoryUid || note.repositoryId,
            repository?.namespace || repository?.name || note.repository,
            ...(repository?.namespaceAliases || []),
          ].join("|");
          upsertCache.run(note.repositoryId, note.repositoryPath, repositoryCacheIdentity, Number(file?.size) || 0, Number(note.mtimeMs) || 0, JSON.stringify(snapshot));
        }
      }
      db.exec("DELETE FROM note_cache WHERE (repository_id || ':' || path) NOT IN (SELECT repository_id || ':' || repository_path FROM pages)");
      for (const diagnostic of index.diagnostics || []) insertDiagnostic.run(diagnostic.code, diagnostic.severity, diagnostic.message, diagnostic.path || "");
      db.prepare("INSERT OR REPLACE INTO wiki_meta VALUES ('generation', ?)").run(index.generation || "");
      db.prepare("INSERT OR REPLACE INTO wiki_meta VALUES ('updated_at', ?)").run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
    for (const note of index.notes || []) { delete note.searchText; delete note.cacheHit; }
  }
  return { ok: true, dbFile };
}

function ftsQuery(value) {
  const tokens = String(value || "").normalize("NFKC").trim().split(/\s+/).filter(Boolean).slice(0, 12);
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

export function searchWikiDatabase(rootValue, body = {}) {
  const dbFile = wikiDatabaseFile(rootValue);
  if (!existsSync(dbFile)) return { ok: true, type: "wiki-search", generation: "", items: [], total: 0, nextCursor: null };
  const query = String(body.query || body.q || "").normalize("NFKC").trim();
  const limit = Math.max(1, Math.min(100, Number(body.limit) || 40));
  const offset = Math.max(0, Number(body.cursor) || 0);
  const repositoryId = String(body.repositoryId || "").trim();
  const partition = String(body.partition || "").trim();
  const namespace = normalizeWikiNamespace(body.namespace || "");
  const sort = String(body.sort || "").trim() === "recent" ? "recent" : "title";
  const db = new DatabaseSync(dbFile, { readOnly: true, timeout: 3000 });
  try {
    const generation = String(db.prepare("SELECT value FROM wiki_meta WHERE key='generation'").get()?.value || "");
    const filters = [];
    const parameters = [];
    if (repositoryId) { filters.push("p.repository_id = ?"); parameters.push(repositoryId); }
    if (partition === "public" || partition === "private") { filters.push("p.partition = ?"); parameters.push(partition); }
    if (namespace) {
      filters.push("(lower(p.namespace) = lower(?) OR lower(p.qualified_namespace) = lower(?))");
      parameters.push(namespace, namespace);
    }
    const where = filters.length ? ` AND ${filters.join(" AND ")}` : "";
    let rows;
    let total;
    if (query) {
      const match = ftsQuery(query);
      const source = /[\u2e80-\u9fff\uf900-\ufaff]/u.test(query) ? "pages_fts_trigram" : "pages_fts";
      rows = db.prepare(`SELECT p.*, bm25(${source}, 0, 12, 5, 4, 3, 1) AS rank FROM ${source} JOIN pages p ON p.page_key = ${source}.page_key WHERE ${source} MATCH ?${where} ORDER BY rank, p.mtime DESC LIMIT ? OFFSET ?`).all(match, ...parameters, limit, offset);
      total = Number(db.prepare(`SELECT count(*) AS count FROM ${source} JOIN pages p ON p.page_key = ${source}.page_key WHERE ${source} MATCH ?${where}`).get(match, ...parameters)?.count || 0);
    } else {
      const baseWhere = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const order = sort === "recent" ? "p.mtime DESC, p.page_key" : "p.title COLLATE NOCASE, p.page_key";
      rows = db.prepare(`SELECT p.*, 0 AS rank FROM pages p ${baseWhere} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...parameters, limit, offset);
      total = Number(db.prepare(`SELECT count(*) AS count FROM pages p ${baseWhere}`).get(...parameters)?.count || 0);
    }
    const aliasStatement = db.prepare("SELECT alias FROM aliases WHERE page_key=? ORDER BY alias");
    const tagStatement = db.prepare("SELECT tag FROM tags WHERE page_key=? ORDER BY tag");
    const refsStatement = db.prepare("SELECT target_id FROM links WHERE source_key=? AND status='resolved' AND target_id IS NOT NULL");
    const backlinksStatement = db.prepare("SELECT p.page_id FROM links l JOIN pages p ON p.page_key=l.source_key WHERE l.target_id=?");
    const missingStatement = db.prepare("SELECT target_title FROM links WHERE source_key=? AND status='missing'");
    const items = rows.map((row) => ({
      id: row.page_id,
      pageKey: row.page_key,
      identityStatus: row.identity_status,
      title: row.title,
      namespace: row.namespace,
      qualifiedNamespace: row.qualified_namespace,
      qualifiedTitle: qualifiedWikiTitle(row.namespace, row.title),
      fullTitle: qualifiedWikiTitle(row.qualified_namespace, row.title),
      namespaceSource: row.namespace_source,
      kind: row.kind,
      file: row.file,
      path: row.workspace_path,
      repositoryPath: row.repository_path,
      repositoryId: row.repository_id,
      repository: String(row.repository_id).split("/").at(-1) || "",
      partition: row.partition,
      private: Boolean(row.private),
      redirectTo: row.redirect_to,
      mtimeMs: Number(row.mtime) || 0,
      rank: Number(row.rank) || 0,
      aliases: aliasStatement.all(row.page_key).map((item) => item.alias),
      tags: tagStatement.all(row.page_key).map((item) => item.tag),
      refs: refsStatement.all(row.page_key).map((item) => item.target_id),
      backlinks: backlinksStatement.all(row.page_id).map((item) => item.page_id),
      unresolvedLinks: missingStatement.all(row.page_key).map((item) => item.target_title),
    }));
    return { ok: true, type: "wiki-search", generation, items, total, nextCursor: offset + items.length < total ? offset + items.length : null };
  } finally {
    db.close();
  }
}

export function resolveWikiLink(index, targetValue, options = {}) {
  const target = String(targetValue || "").trim();
  const source = options.sourceFile ? index.notes.find((note) => note.file === options.sourceFile) : null;
  const byTitle = new Map();
  for (const note of index.notes) {
    for (const value of [note.title, ...(note.aliases || [])]) {
      const key = canonicalTitle(value);
      const bucket = byTitle.get(key) || [];
      bucket.push(note);
      byTitle.set(key, bucket);
    }
  }
  const candidates = titleCandidates(index.notes, byTitle, target, source);
  return {
    type: "wiki-link",
    target,
    status: candidates.length === 1 ? "resolved" : candidates.length > 1 ? "ambiguous" : "missing",
    candidates: candidates.map((note) => ({
      id: note.id, title: note.title, file: note.file, path: note.path,
      namespace: note.namespace, qualifiedNamespace: note.qualifiedNamespace,
      qualifiedTitle: note.qualifiedTitle, fullTitle: note.fullTitle,
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
  await execFileAsync("git", ["init", "--initial-branch=main", path], { cwd: root });
  const manifest = await ensureRepositoryManifest(path);
  await ensureRepositoryGitIgnore(path);
  await execFileAsync("git", ["-C", path, "add", "--", REPOSITORY_MANIFEST, ".gitignore"]);
  await execFileAsync("git", [
    "-C", path,
    "-c", "user.name=Noema",
    "-c", "user.email=noema@local",
    "commit", "-m", "noema: initialize repository",
  ]);
  return {
    ok: true,
    repository: {
      id: `${partition}/${name}`, uid: manifest.repositoryId, name,
      namespace: manifest.namespace || name, qualifiedNamespace: `${partition}/${manifest.namespace || name}`,
      namespaceAliases: manifest.namespaceAliases || [], partition, path,
    },
  };
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
  const manifest = await ensureRepositoryManifest(path);
  await ensureRepositoryGitIgnore(path);
  return {
    ok: true,
    repository: {
      id: `${partition}/${name}`, uid: manifest.repositoryId, name,
      namespace: manifest.namespace || name, qualifiedNamespace: `${partition}/${manifest.namespace || name}`,
      namespaceAliases: manifest.namespaceAliases || [], partition, path,
    },
  };
}

export async function repositoryFromId(root, id) {
  const [partitionValue, nameValue, ...extra] = String(id || "").split("/");
  if (extra.length) throw apiError("Invalid repository id");
  const partition = cleanPartition(partitionValue);
  const name = cleanRepoName(nameValue);
  const path = join(root, partition, name);
  if (!inside(root, path) || !(await isDirectory(path)) || !hasGitMetadata(path)) {
    throw apiError(`Unknown Wiki repository: ${partition}/${name}`, 404);
  }
  const manifest = await repositoryManifest(path);
  return {
    id: `${partition}/${name}`,
    uid: manifest.repositoryId || provisionalKey("repository", partition, name),
    identityStatus: manifest.managed ? "managed" : "provisional",
    name,
    namespace: manifest.namespace || name,
    qualifiedNamespace: `${partition}/${manifest.namespace || name}`,
    namespaceAliases: [...new Set([name, ...(manifest.namespaceAliases || [])].map(normalizeWikiNamespace).filter(Boolean))],
    partition,
    path,
  };
}

export async function adoptWikiRepository(rootValue, repositoryId) {
  const root = expandNoemaPath(rootValue);
  const repository = await repositoryFromId(root, repositoryId);
  const manifest = await ensureRepositoryManifest(repository.path);
  await ensureRepositoryGitIgnore(repository.path);
  return {
    ok: true,
    type: "wiki-repository-adopted",
    repository: {
      ...repository,
      uid: manifest.repositoryId,
      identityStatus: "managed",
    },
    manifest: manifest.file,
  };
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
    repository = {
      id: "legacy", name: "Legacy", namespace: "Legacy", qualifiedNamespace: "private/Legacy",
      namespaceAliases: ["legacy"], partition: "private", path: root,
    };
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
  const id = String(body.id || newNoemaId("page"));
  const tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : parseList(body.tags);
  const namespace = cleanWikiNamespace(body.namespace, repository.namespace || repository.name);
  const content = [
    "#+begin meta",
    `id: ${id}`,
    `title: ${title}`,
    `namespace: ${namespace}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `kind: ${String(body.kind || "page").trim() || "page"}`,
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
  return {
    ok: true, file, id, title, namespace,
    qualifiedTitle: qualifiedWikiTitle(namespace, title),
    repositoryId: repository.id, partition: repository.partition,
  };
}

export function publicWikiNotes(index) {
  return index.layout === "wiki"
    ? index.notes.filter((note) => note.partition === "public" && note.private !== true)
    : [];
}

async function wikiNoteById(root, pageId) {
  const index = await buildWikiIndex(root, { layout: "wiki" });
  const matches = index.notes.filter((note) => note.id === String(pageId || ""));
  if (matches.length === 0) throw apiError(`Unknown Wiki page: ${String(pageId || "")}`, 404);
  if (matches.length > 1) throw apiError(`Duplicate page id must be resolved first: ${String(pageId || "")}`, 409);
  const note = matches[0];
  const repository = index.repositories.find((item) => item.id === note.repositoryId);
  if (!repository) throw apiError(`Unknown Wiki repository: ${note.repositoryId}`, 404);
  return { index, note, repository };
}

export async function wikiPageHistory(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const { note, repository } = await wikiNoteById(root, body.pageId);
  const limit = Math.max(1, Math.min(200, Number(body.limit) || 50));
  return {
    ok: true,
    type: "wiki-page-history",
    pageId: note.id,
    file: note.file,
    commits: await fileHistory(repository.path, note.file, limit),
  };
}

export async function wikiPageDiff(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const { note, repository } = await wikiNoteById(root, body.pageId);
  const sha = String(body.sha || "").trim();
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw apiError("Invalid Git commit", 400, "ERR_WIKI_GIT_COMMIT");
  return { ok: true, type: "wiki-page-diff", pageId: note.id, ...(await diffRoamFile(repository.path, note.file, { sha })) };
}

export async function restoreWikiPageVersion(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const { note, repository } = await wikiNoteById(root, body.pageId);
  const sha = String(body.sha || "").trim();
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw apiError("Invalid Git commit", 400, "ERR_WIKI_GIT_COMMIT");
  await restoreFileFromCommit(repository.path, note.file, sha);
  return { ok: true, type: "wiki-page-restored", pageId: note.id, file: note.file, sha };
}

function destinationFile(repository, body, fallbackName) {
  const directory = cleanRelativePath(body.directory || "");
  const filename = cleanRelativePath(body.filename || fallbackName);
  const target = resolve(repository.path, directory, filename);
  if (!inside(repository.path, target)) throw apiError("Destination must stay inside its repository");
  if (existsSync(target)) throw apiError(`Destination already exists: ${relative(repository.path, target)}`, 409);
  return target;
}

function ownedAssetDirectories(note, pageId = note.id) {
  return ["images", "attachments"].map((kind) => ({
    kind,
    path: join(dirname(note.file), kind, pageId),
  })).filter((entry) => existsSync(entry.path));
}

async function writeOperationJournal(root, operation) {
  const dir = join(root, ".noema", "operations");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${operation.id}.json`);
  await writeFile(file, `${JSON.stringify(operation, null, 2)}\n`, "utf8");
  return file;
}

async function copyOwnedAssets(note, targetFile, sourceId, targetId) {
  const copied = [];
  for (const source of ownedAssetDirectories(note, sourceId)) {
    const target = join(dirname(targetFile), source.kind, targetId);
    await mkdir(dirname(target), { recursive: true });
    await cp(source.path, target, { recursive: true, errorOnExist: true });
    copied.push({ source: source.path, target });
  }
  return copied;
}

export async function moveWikiPage(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const { note } = await wikiNoteById(root, body.pageId);
  const sourceRepository = await repositoryFromId(root, note.repositoryId);
  const targetRepository = await repositoryFromId(root, body.repositoryId || note.repositoryId);
  if (
    sourceRepository.partition === "private"
    && targetRepository.partition === "public"
    && body.confirm !== "MOVE PRIVATE TO PUBLIC"
  ) {
    throw apiError("Type MOVE PRIVATE TO PUBLIC after reviewing the page and dependency list", 409, "ERR_WIKI_PRIVACY_CONFIRM");
  }
  const target = destinationFile(targetRepository, body, basename(note.file));
  const namespace = cleanWikiNamespace(body.namespace, note.namespace || targetRepository.namespace || targetRepository.name);
  const operation = {
    id: newNoemaId("block"),
    type: "move-page",
    phase: "prepared",
    pageId: note.id,
    source: note.file,
    target,
    sourceRepositoryId: sourceRepository.id,
    targetRepositoryId: targetRepository.id,
    dependencies: note.dependencies,
    createdAt: new Date().toISOString(),
  };
  const journal = await writeOperationJournal(root, operation);
  const movedAssets = [];
  try {
    await mkdir(dirname(target), { recursive: true });
    if (sourceRepository.id === targetRepository.id) {
      await rename(note.file, target);
      for (const asset of ownedAssetDirectories(note)) {
        const destination = join(dirname(target), asset.kind, note.id);
        await mkdir(dirname(destination), { recursive: true });
        await rename(asset.path, destination);
        movedAssets.push({ source: asset.path, target: destination });
      }
    } else {
      await copyFile(note.file, target);
      movedAssets.push(...await copyOwnedAssets(note, target, note.id, note.id));
      await rm(note.file);
      for (const asset of ownedAssetDirectories(note)) await rm(asset.path, { recursive: true });
    }
    const movedContent = await readFile(target, "utf8");
    await writeFile(target, replaceMetaField(movedContent, "namespace", namespace), "utf8");
    await rm(journal, { force: true });
    return {
      ok: true,
      type: "wiki-page-moved",
      pageId: note.id,
      source: note.file,
      file: target,
      assets: movedAssets,
      repositoryId: targetRepository.id,
      namespace,
    };
  } catch (error) {
    await writeFile(journal, `${JSON.stringify({ ...operation, phase: "failed", error: String(error?.message || error) }, null, 2)}\n`, "utf8").catch(() => {});
    throw error;
  }
}

export async function deleteWikiPage(rootValue, body = {}, options = {}) {
  const root = expandNoemaPath(rootValue);
  const { note } = await wikiNoteById(root, body.pageId);
  if (note.backlinks.length > 0 && body.confirm !== "DELETE") {
    throw apiError(
      `${note.backlinks.length} page${note.backlinks.length === 1 ? "" : "s"} link to this page. Type DELETE to move it to Trash.`,
      409,
      "ERR_WIKI_BACKLINK_CONFIRM",
    );
  }
  const trashRoot = options.trashRoot ? resolve(String(options.trashRoot)) : join(homedir(), ".Trash");
  await mkdir(trashRoot, { recursive: true });
  const base = `Noema-${slugify(note.title)}-${String(note.id).slice(0, 8)}`;
  let bundle = join(trashRoot, base);
  for (let suffix = 2; existsSync(bundle); suffix++) bundle = join(trashRoot, `${base}-${suffix}`);
  await mkdir(bundle, { recursive: false });
  const operation = {
    id: newNoemaId("block"),
    type: "trash-page",
    phase: "prepared",
    pageId: note.id,
    source: note.file,
    target: bundle,
    backlinks: note.backlinks,
    createdAt: new Date().toISOString(),
  };
  const journal = await writeOperationJournal(root, operation);
  try {
    const trashedFile = join(bundle, basename(note.file));
    await rename(note.file, trashedFile);
    const assets = [];
    for (const asset of ownedAssetDirectories(note)) {
      const target = join(bundle, `${asset.kind}-${note.id}`);
      await rename(asset.path, target);
      assets.push({ source: asset.path, target });
    }
    await rm(journal, { force: true });
    return {
      ok: true,
      type: "wiki-page-trashed",
      pageId: note.id,
      file: note.file,
      trashedFile,
      trashedTo: bundle,
      backlinks: note.backlinks,
      assets,
    };
  } catch (error) {
    await writeFile(journal, `${JSON.stringify({ ...operation, phase: "failed", error: String(error?.message || error) }, null, 2)}\n`, "utf8").catch(() => {});
    throw error;
  }
}

export async function copyWikiPage(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const { note } = await wikiNoteById(root, body.pageId);
  const targetRepository = await repositoryFromId(root, body.repositoryId || note.repositoryId);
  const target = destinationFile(targetRepository, body, basename(note.file));
  const id = newNoemaId("page");
  const title = String(body.title || `${note.title} copy`).trim();
  const namespace = cleanWikiNamespace(body.namespace, note.namespace || targetRepository.namespace || targetRepository.name);
  let content = await readFile(note.file, "utf8");
  content = replaceMetaField(replaceMetaField(replaceMetaField(content, "id", id), "title", title), "namespace", namespace);
  content = content
    .replaceAll(`images/${note.id}/`, `images/${id}/`)
    .replaceAll(`attachments/${note.id}/`, `attachments/${id}/`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  let assets = [];
  try {
    assets = await copyOwnedAssets(note, target, note.id, id);
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
  return { ok: true, type: "wiki-page-copied", sourceId: note.id, id, title, namespace, file: target, assets };
}

export async function mergeWikiPages(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const survivor = (await wikiNoteById(root, body.survivorId)).note;
  const duplicate = (await wikiNoteById(root, body.duplicateId)).note;
  if (survivor.id === duplicate.id) throw apiError("Survivor and duplicate must be different pages");
  if (body.confirm !== "MERGE") throw apiError("Type MERGE to preserve the duplicate as a redirect", 409);
  let survivorContent = typeof body.content === "string" ? body.content : await readFile(survivor.file, "utf8");
  const survivorMeta = metadata(survivorContent);
  const aliases = [...new Set([...parseList(survivorMeta.aliases), duplicate.title])];
  survivorContent = replaceMetaField(survivorContent, "aliases", aliases.join(", "));
  const redirect = [
    "#+begin meta",
    `id: ${duplicate.id}`,
    `title: ${duplicate.title}`,
    "kind: redirect",
    `redirect_to: roam://${survivor.id}`,
    "#+end meta",
    "",
    `# ${duplicate.title}`,
    "",
    `Redirected to [${survivor.title}](roam://${survivor.id}).`,
    "",
  ].join("\n");
  await writeFile(survivor.file, survivorContent, "utf8");
  await writeFile(duplicate.file, redirect, "utf8");
  return {
    ok: true,
    type: "wiki-pages-merged",
    survivorId: survivor.id,
    redirectId: duplicate.id,
    survivorFile: survivor.file,
    redirectFile: duplicate.file,
  };
}

export function wikiTagIndex(index) {
  const tags = new Map();
  for (const note of index.notes || []) {
    for (const raw of note.tags || []) {
      const name = String(raw).trim().replace(/^#/, "");
      if (!name) continue;
      const key = canonicalTitle(name);
      const entry = tags.get(key) || { name, count: 0, pages: [], variants: new Set() };
      entry.count++;
      entry.pages.push({ id: note.id, title: note.title, repositoryId: note.repositoryId, path: note.repositoryPath });
      entry.variants.add(name);
      tags.set(key, entry);
    }
  }
  return [...tags.values()]
    .map((entry) => ({ ...entry, variants: [...entry.variants].sort() }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export async function updateWikiTag(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const action = String(body.action || "");
  const from = String(body.from || body.tag || "").trim().replace(/^#/, "");
  const to = String(body.to || "").trim().replace(/^#/, "");
  if (!from || (action === "rename" && !to)) throw apiError("Tag values are required");
  const index = await buildWikiIndex(root, { layout: "wiki" });
  const changed = [];
  for (const note of index.notes) {
    const current = note.tags || [];
    const next = action === "delete"
      ? current.filter((tag) => canonicalTitle(tag) !== canonicalTitle(from))
      : current.map((tag) => canonicalTitle(tag) === canonicalTitle(from) ? to : tag);
    if (current.join("\0") === next.join("\0")) continue;
    const content = await readFile(note.file, "utf8");
    await writeFile(note.file, replaceMetaField(content, "tags", [...new Set(next)].join(", ")), "utf8");
    changed.push({ id: note.id, file: note.file, tags: next });
  }
  return { ok: true, type: "wiki-tags-updated", action, changed };
}

export async function updateWikiNamespace(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const from = cleanWikiNamespace(body.from || body.namespace);
  const to = cleanWikiNamespace(body.to);
  const partition = String(body.partition || "").trim().toLowerCase();
  if (partition && !PARTITIONS.includes(partition)) throw apiError("Namespace partition must be public or private");
  if (canonicalTitle(from) === canonicalTitle(to)) return { ok: true, type: "wiki-namespace-updated", changed: [] };
  const index = await buildWikiIndex(root, { layout: "wiki" });
  const changed = [];
  for (const note of index.notes) {
    if (canonicalTitle(note.namespace) !== canonicalTitle(from)) continue;
    if (partition && note.partition !== partition) continue;
    const content = await readFile(note.file, "utf8");
    const meta = metadata(content);
    const aliases = [...new Set([...parseList(meta.namespace_aliases), from]
      .map(normalizeWikiNamespace).filter((item) => item && canonicalTitle(item) !== canonicalTitle(to)))];
    const next = replaceMetaField(
      replaceMetaField(content, "namespace", to),
      "namespace_aliases",
      aliases.join(", "),
    );
    await writeFile(note.file, next, "utf8");
    changed.push({ id: note.id, file: note.file, from, to, aliases });
  }
  return { ok: true, type: "wiki-namespace-updated", from, to, partition, changed };
}

function exportRelativePath(noteOrFile) {
  return join(
    String(noteOrFile.partition || "private"),
    String(noteOrFile.repositoryId || "").split("/").at(-1) || "repository",
    String(noteOrFile.repositoryPath || ""),
  );
}

async function copyExportFile(staging, source, target) {
  const file = join(staging, target);
  await mkdir(dirname(file), { recursive: true });
  await copyFile(source, file);
  return target.split(sep).join("/");
}

async function archiveExport(staging, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });
  if (process.platform === "darwin") {
    await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", staging, outputPath]);
  } else {
    await execFileAsync("zip", ["-q", "-r", outputPath, "."], { cwd: staging });
  }
}

export async function exportWiki(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const outputPath = resolve(String(body.outputPath || ""));
  if (!body.outputPath || !outputPath.toLowerCase().endsWith(".zip")) throw apiError("A .zip outputPath is required");
  const index = await buildWikiIndex(root, { layout: "wiki" });
  const staging = join(root, ".noema", "export-staging", newNoemaId("block"));
  await mkdir(staging, { recursive: true });
  const copied = new Set();
  const selectedPages = [];
  try {
    if (body.mode === "physical") {
      const repositoryId = String(body.repositoryId || "");
      const prefix = cleanRelativePath(body.path || "");
      for (const file of index.files.filter((entry) =>
        entry.repositoryId === repositoryId
        && (!prefix || entry.repositoryPath === prefix || entry.repositoryPath.startsWith(`${prefix}/`)))) {
        copied.add(await copyExportFile(staging, file.file, exportRelativePath(file)));
      }
    } else {
      const ids = new Set(Array.isArray(body.pageIds) ? body.pageIds.map(String) : []);
      const tags = new Set(Array.isArray(body.tags) ? body.tags.map(canonicalTitle) : []);
      for (const note of index.notes.filter((item) =>
        ids.has(item.id) || (tags.size > 0 && item.tags.some((tag) => tags.has(canonicalTitle(tag)))))) {
        selectedPages.push(note);
        copied.add(await copyExportFile(staging, note.file, exportRelativePath(note)));
        for (const dependency of note.dependencies.filter((item) => item.status === "resolved" && item.path)) {
          const repository = index.repositories.find((item) => item.id === note.repositoryId);
          if (!repository) continue;
          const source = join(repository.path, dependency.path);
          copied.add(await copyExportFile(staging, source, join(note.partition, repository.name, dependency.path)));
        }
      }
    }
    const manifest = {
      schema: 1,
      exportedAt: new Date().toISOString(),
      mode: body.mode === "physical" ? "physical" : "wiki-selection",
      files: [...copied].sort(),
      pages: selectedPages.map((note) => ({
        id: note.id,
        title: note.title,
        repositoryId: note.repositoryId,
        path: note.repositoryPath,
        links: note.refs,
      })),
    };
    await writeFile(join(staging, "noema-export.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await archiveExport(staging, outputPath);
    return { ok: true, type: "wiki-export", outputPath, fileCount: copied.size, pageCount: selectedPages.length };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
