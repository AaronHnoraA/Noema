import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

import { assetRefsFromContent } from "./runtime.mjs";
import { knowledgeSearchResponse } from "./knowledge-search.mjs";
import { resolveWikiLink, resolveWikiRelationships, searchWikiDatabase, wikiPageMetadata } from "./wiki-workspace.mjs";

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function publicRef(noteOrFile) {
  return `${noteOrFile.repositoryId}/${String(noteOrFile.repositoryPath || "").replace(/^\/+/, "")}`;
}

function cleanNote(note, absoluteToPublic) {
  const result = {
    ...note,
    file: publicRef(note),
    path: publicRef(note),
    link: publicRef(note),
    refs: [...(note.refs || [])],
    backlinks: [...(note.backlinks || [])],
    unresolvedLinks: [...(note.unresolvedLinks || [])],
    aliases: [...(note.aliases || [])],
    tags: [...(note.tags || [])],
    namespaceAliases: [...(note.namespaceAliases || [])],
    dependencies: (note.dependencies || []).map((dependency) => ({
      ...dependency,
      path: absoluteToPublic.get(String(dependency.path || "")) || String(dependency.path || "").replace(/^\/+/, ""),
    })),
  };
  delete result.searchText;
  delete result.cacheHit;
  delete result.wikiLinks;
  delete result.repositoryUid;
  delete result.source;
  return result;
}

// Reading order is authored in the page, like everything else about it:
// `pinned: true` lifts a page onto the reader's front page and `order: 3`
// places it among the pages of its folder.  Both are read only when the
// public catalog is built; the local index and its cache never see them.
function readingMetadata(content) {
  const meta = wikiPageMetadata(content);
  const order = Number(String(meta.order ?? "").trim());
  return {
    pinned: /^(?:true|yes|1)$/i.test(String(meta.pinned ?? "").trim()),
    order: String(meta.order ?? "").trim() !== "" && Number.isFinite(order) ? order : null,
  };
}

const readingCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function readingOrder(left, right) {
  if (left.order !== right.order) {
    if (left.order === null) return 1;
    if (right.order === null) return -1;
    return left.order - right.order;
  }
  return readingCollator.compare(left.title, right.title) || left.file.localeCompare(right.file);
}

/**
 * Previous and next page for every public page: its neighbours among the
 * pages of the same repository folder, in reading order.  Redirects are not
 * pages to read through, so they neither get nor are neighbours.
 */
function readingNeighbors(notes) {
  const folders = new Map();
  for (const note of notes) {
    if (note.kind === "redirect") continue;
    const path = String(note.repositoryPath || "");
    const folder = `${note.repositoryId}\0${path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}`;
    const bucket = folders.get(folder);
    if (bucket) bucket.push(note);
    else folders.set(folder, [note]);
  }
  const neighbors = new Map();
  const link = (note) => (note ? { file: note.file, title: note.title } : null);
  for (const pages of folders.values()) {
    pages.sort(readingOrder);
    pages.forEach((note, position) => {
      neighbors.set(note.file, { previous: link(pages[position - 1]), next: link(pages[position + 1]) });
    });
  }
  return neighbors;
}

function cleanReportValue(value, absoluteToPublic) {
  if (Array.isArray(value)) return value.map((item) => cleanReportValue(item, absoluteToPublic));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "file" || key === "sourceFile") {
      result[key] = absoluteToPublic.get(String(item || "")) || "";
    } else {
      result[key] = cleanReportValue(item, absoluteToPublic);
    }
  }
  return result;
}

function cleanRepository(repository) {
  return {
    id: repository.id,
    uid: repository.uid,
    identityStatus: repository.identityStatus,
    name: repository.name,
    namespace: repository.namespace,
    qualifiedNamespace: repository.qualifiedNamespace,
    namespaceAliases: [...(repository.namespaceAliases || [])],
    partition: "public",
    path: repository.id,
    public: true,
  };
}

function directoryInventory(files) {
  const directories = new Map();
  for (const file of files) {
    const parts = String(file.repositoryPath || "").split("/").filter(Boolean);
    for (let index = 0; index < Math.max(1, parts.length); index++) {
      const path = parts.slice(0, index).join("/");
      const key = `${file.repositoryId}:${path}`;
      const current = directories.get(key) || {
        repositoryId: file.repositoryId,
        partition: "public",
        path,
        name: path.split("/").at(-1) || file.repositoryId.split("/").at(-1) || "",
        fileCount: 0,
      };
      current.fileCount++;
      directories.set(key, current);
    }
  }
  return [...directories.values()].sort((a, b) => `${a.repositoryId}/${a.path}`.localeCompare(`${b.repositoryId}/${b.path}`));
}

function cleanAssetSource(value) {
  let source = String(value || "").trim();
  if (!source || source.startsWith("#")) return "";
  try { source = decodeURIComponent(source); } catch {}
  source = source.split("#", 1)[0].split("?", 1)[0].trim().replace(/^<|>$/g, "");
  if (!source || /^[a-z][a-z0-9+.-]*:/i.test(source) || isAbsolute(source)) return "";
  return source;
}

function publicSearch(index, body = {}) {
  const query = String(body.query || body.q || "").normalize("NFKC").trim().toLocaleLowerCase();
  const repositoryId = String(body.repositoryId || "").trim();
  const namespace = String(body.namespace || "").trim().toLocaleLowerCase();
  const limit = Math.max(1, Math.min(100, Number(body.limit) || 40));
  const offset = Math.max(0, Number(body.cursor) || 0);
  const sort = String(body.sort || "") === "recent" ? "recent" : "title";
  let items = index.notes.filter((note) => {
    if (repositoryId && note.repositoryId !== repositoryId) return false;
    if (namespace && ![note.namespace, note.qualifiedNamespace].some((value) => String(value || "").toLocaleLowerCase() === namespace)) return false;
    if (!query) return true;
    const haystack = [note.title, note.namespace, note.qualifiedNamespace, note.repositoryPath, ...(note.aliases || []), ...(note.tags || [])]
      .join("\n").normalize("NFKC").toLocaleLowerCase();
    return query.split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
  });
  items = items.sort(sort === "recent"
    ? (a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0) || a.title.localeCompare(b.title)
    : (a, b) => a.title.localeCompare(b.title));
  const total = items.length;
  const page = items.slice(offset, offset + limit);
  return { ok: true, type: "wiki-search", generation: index.generation, items: page, total, nextCursor: offset + page.length < total ? offset + page.length : null };
}

export async function buildServerPublicCatalog(fullIndex, config) {
  const configured = new Set(config.repositories.map((repository) => repository.id));
  const repositoryById = new Map((fullIndex.repositories || []).map((repository) => [repository.id, repository]));
  const visibleOriginal = (fullIndex.notes || []).filter((note) => (
    configured.has(note.repositoryId)
    && note.partition === "public"
    && note.private !== true
  ));
  const relationshipNotes = visibleOriginal.map((note) => ({
    ...note,
    aliases: [...(note.aliases || [])],
    tags: [...(note.tags || [])],
    wikiLinks: [...(note.wikiLinks || [])],
    refs: [],
    backlinks: [],
    unresolvedLinks: [],
  }));
  const related = resolveWikiRelationships(relationshipNotes);
  const absoluteToPublic = new Map(relationshipNotes.map((note) => [resolve(note.file), publicRef(note)]));
  const noteByRef = new Map();
  const repositoryRootById = new Map();
  for (const repository of fullIndex.repositories || []) {
    if (configured.has(repository.id)) repositoryRootById.set(repository.id, resolve(repository.path));
  }
  for (const note of relationshipNotes) noteByRef.set(publicRef(note), resolve(note.file));

  const assetByRef = new Map();
  const readingByFile = new Map();
  for (const note of visibleOriginal) {
    const repositoryRoot = repositoryRootById.get(note.repositoryId);
    if (!repositoryRoot) continue;
    let content = "";
    try { content = await readFile(note.file, "utf8"); } catch { continue; }
    readingByFile.set(resolve(note.file), readingMetadata(content));
    for (const file of assetRefsFromContent(content, note.file)) {
      const absolute = resolve(file);
      if (!inside(repositoryRoot, absolute) || !existsSync(absolute)) continue;
      const repositoryPath = relative(repositoryRoot, absolute).split(sep).join("/");
      assetByRef.set(`${note.repositoryId}/${repositoryPath}`, absolute);
      absoluteToPublic.set(absolute, `${note.repositoryId}/${repositoryPath}`);
    }
  }

  const notes = related.notes.map((note) => ({
    ...cleanNote(note, absoluteToPublic),
    ...(readingByFile.get(resolve(note.file)) || { pinned: false, order: null }),
  }));
  const neighbors = readingNeighbors(notes);
  const visibleNoteRefs = new Set(notes.map((note) => note.file));
  const files = [];
  for (const item of fullIndex.files || []) {
    if (!configured.has(item.repositoryId) || item.partition !== "public") continue;
    const ref = publicRef(item);
    if (!visibleNoteRefs.has(ref) && !assetByRef.has(ref)) continue;
    files.push({
      repositoryId: item.repositoryId,
      partition: "public",
      file: ref,
      path: ref,
      repositoryPath: item.repositoryPath,
      name: item.name,
      ext: item.ext,
      kind: item.kind,
      size: item.size,
      mtimeMs: item.mtimeMs,
      gitStatus: "clean",
    });
  }
  const repositories = [...new Set(notes.map((note) => note.repositoryId))]
    .map((id) => repositoryById.get(id)).filter(Boolean).map(cleanRepository);
  const generation = createHash("sha256")
    .update(String(fullIndex.generation || ""))
    .update(`\0${notes.map((note) => note.file).sort().join("\0")}`)
    .digest("hex").slice(0, 20);
  const index = {
    type: "wiki-index",
    generation,
    root: "",
    layout: "wiki",
    dbFile: "",
    repositories,
    notes,
    files,
    directories: directoryInventory(files),
    diagnostics: [],
    reports: cleanReportValue(related.reports, absoluteToPublic),
  };
  const publicByPageKey = new Map(notes.map((note) => [note.pageKey || note.key, note]));
  const allowedRepositoryIds = repositories.map((repository) => repository.id);
  return Object.freeze({
    index,
    noteByRef,
    assetByRef,
    repositoryRootById,
    createdAt: new Date().toISOString(),
    note(ref) {
      return noteByRef.get(String(ref || "")) || "";
    },
    neighbors(ref) {
      return neighbors.get(String(ref || "")) || { previous: null, next: null };
    },
    search(body) {
      const lexical = searchWikiDatabase(config.noteRoot || fullIndex.root, {
        ...(body || {}),
        partition: "public",
        allowedRepositoryIds,
      });
      lexical.items = lexical.items.map((item) => {
        const clean = publicByPageKey.get(item.pageKey || item.key);
        return clean ? { ...clean, rank: item.rank, excerpt: item.excerpt, ...(item.matchedTerms ? { matchedTerms: item.matchedTerms } : {}) } : null;
      }).filter(Boolean);
      return knowledgeSearchResponse(index, body || {}, lexical);
    },
    resolveLink(target, sourceFile = "") {
      return resolveWikiLink(index, target, { sourceFile });
    },
    asset(source, baseRef) {
      const baseFile = noteByRef.get(String(baseRef || ""));
      if (!baseFile) return "";
      const cleaned = cleanAssetSource(source);
      if (!cleaned) return "";
      const target = resolve(dirname(baseFile), cleaned);
      const targetRef = absoluteToPublic.get(target);
      return targetRef && assetByRef.get(targetRef) === target ? target : "";
    },
  });
}

export async function publicOpenedNote(catalog, ref) {
  const key = String(ref || "").replace(/^\/+/, "");
  const file = catalog.note(key);
  if (!file) throw Object.assign(new Error("Page not found"), { statusCode: 404 });
  const info = await stat(file);
  const note = catalog.index.notes.find((item) => item.file === key);
  return {
    type: "open",
    file: key,
    title: note?.title || key.split("/").at(-1) || "Noema",
    mode: "markdown",
    content: await readFile(file, "utf8"),
    kind: note?.kind || "page",
    mtimeMs: info.mtimeMs,
    size: info.size,
    standalone: false,
    remote: true,
    pinned: note?.pinned === true,
    // A catalog assembled elsewhere (the public MCP surface) has no reading order.
    ...(typeof catalog.neighbors === "function" ? catalog.neighbors(key) : { previous: null, next: null }),
  };
}
