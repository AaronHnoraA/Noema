import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { mergeAgendaScopes } from "./agenda-projection.mjs";
import { createAgendaCaptureTemplates } from "./agenda-capture-templates.mjs";
import { startNoteWatcher } from "./watch.mjs";

const ignored = new Set([".git", ".noema", ".agent", "node_modules", "vendor", "build", "dist", ".venv", "__pycache__"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inside = (root, file) => {
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
export const agendaPathRelevant = (file) => !String(file).split(/[\\/]/).some((part) => part.startsWith(".") || ignored.has(part));
const agendaFile = (file) => agendaPathRelevant(file) && [".md", ".markdown", ".noema"].includes(extname(file).toLowerCase());
const failure = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

export async function listDocuments(root, { signal, isRelevant = agendaPathRelevant } = {}) {
  const files = [];
  async function walk(directory) {
    signal?.throwIfAborted();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const file = join(directory, entry.name);
      if (!isRelevant(relative(root, file))) continue;
      // Linked directories/files are not additional implicit scan roots.
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && agendaFile(relative(root, file))) files.push(file);
    }
  }
  await walk(root);
  return files.sort();
}

export async function readDocument(file, { signal } = {}) {
  signal?.throwIfAborted();
  const info = await lstat(file);
  if (!info.isFile()) throw failure("Agenda source is not a regular file", 400);
  if (info.size > 16 * 1024 * 1024) throw failure("Agenda source exceeds 16 MiB", 413);
  const content = await readFile(file, { encoding: "utf8", signal });
  return { content, revision: hash(content), mtimeMs: info.mtimeMs };
}

/** Event-invalidated, explicitly leased source index. No timers run at rest.
 * IO and evaluation are injectable so remote targets can use their gateway.
 * A broader active root owns overlapping files; child scopes are projections.
 */
export function createAgendaIndex({
  knowledgeRoot, parseDocument, evaluate, mutate, create, ensureId, linkNodes, startClock, stopClock,
  onMutation = () => {}, excludePatterns = [], captureTemplates = [], beforeClockIn = async () => {},
  list = listDocuments, read = readDocument, canonicalRoot = realpath,
  watch = startNoteWatcher, watchKnowledge = true, onChange = () => {},
  now = Date.now,
} = {}) {
  if (!knowledgeRoot || !parseDocument || !evaluate) throw new Error("Agenda requires a knowledge root, parser and evaluator");
  if (!Array.isArray(excludePatterns) || excludePatterns.some((pattern) => typeof pattern !== "string")) {
    throw new Error("Agenda excludePatterns must be an array of glob strings");
  }
  const captures = createAgendaCaptureTemplates(captureTemplates, {now});
  const exclusions = [...excludePatterns];
  const relevant = (path) => agendaPathRelevant(path) && !exclusions.some((pattern) => matchesGlob(path, pattern) || matchesGlob(`${path}/`, pattern));
  const relevantFile = (path) => relevant(path) && agendaFile(path);
  const scopes = new Map();
  const owners = new Map();
  const rootAliases = new Map();
  let generation = 0;
  let closed = false;
  let lifecycle = Promise.resolve();
  let initialized = null;
  const serial = (operation) => {
    const result = lifecycle.then(operation);
    lifecycle = result.catch(() => {});
    return result;
  };
  function changed(files = []) {
    generation++;
    for (const owner of owners.values()) owner.cache.clear();
    onChange({ version: generation, files, scopes: [...scopes.keys()] });
  }
  function invalidate(files = null) {
    if (closed) return;
    if (files) files = files.map((file) => {
      const alias = [...rootAliases.keys()].sort((a, b) => b.length - a.length).find((root) => inside(root, file));
      return alias ? resolve(rootAliases.get(alias), relative(alias, file)) : file;
    });
    let affected = false;
    for (const owner of owners.values()) {
      if (files === null) { owner.full = true; affected = true; }
      else for (const file of files) {
        if (inside(owner.root, file) && relevantFile(relative(owner.root, file))) {
          owner.dirty.add(file);
          affected = true;
        }
      }
    }
    if (affected) changed(files || []);
  }
  function reconcile() {
    const roots = [...new Set([...scopes.values()].map((s) => s.root))];
    const desired = roots.filter((root) => !roots.some((other) => root !== other && inside(other, root)));
    for (const [root, owner] of owners) {
      if (!desired.includes(root)) {
        owner.active = false;
        owner.abort.abort();
        owner.watcher?.close();
        owner.documents.clear();
        owners.delete(root);
      }
    }
    for (const root of desired) {
      if (owners.has(root)) continue;
      const owner = { root, active: true, abort: new AbortController(), documents: new Map(), errors: new Map(), dirty: new Set(), full: true, pending: null, cache: new Map() };
      owners.set(root, owner);
      const knowledge = [...scopes.values()].some((s) => s.kind === "knowledge" && s.root === root);
      if (watch && (!knowledge || watchKnowledge)) {
        owner.watcher = watch({
          root, isRelevant: relevantFile, isDirectoryRelevant: relevant,
          isSelfWrite: () => false,
          onBatch: (files) => { if (owner.active) invalidate(files); },
          onFullRescan: () => {
            if (owner.active) { owner.full = true; changed(); }
          },
        });
      }
    }
  }
  async function initialize() {
    if (closed) throw failure("Agenda is closed", 503);
    if (!initialized) initialized = serial(async () => {
      const root = await canonicalRoot(knowledgeRoot);
      if (closed) return;
      rootAliases.set(resolve(knowledgeRoot), root);
      scopes.set("knowledge", { id: "knowledge", kind: "knowledge", root, leases: new Set(["resident"]) });
      reconcile();
      changed();
    }).catch((error) => { initialized = null; throw error; });
    await initialized;
  }
  async function enter({ root, lease = "emacs" } = {}) {
    await initialize();
    if (!root || !lease) throw failure("Project root and lease are required", 400);
    return serial(async () => {
      const canonical = await canonicalRoot(root);
      if (closed) throw failure("Agenda is closed", 503);
      rootAliases.set(resolve(root), canonical);
      const id = `project:${hash(canonical).slice(0, 24)}`;
      let scope = scopes.get(id);
      if (!scope) {
        scope = { id, kind: "project", root: canonical, leases: new Set() };
        scopes.set(id, scope);
      }
      const fresh = !scope.leases.has(lease);
      scope.leases.add(lease);
      if (fresh) { reconcile(); changed(); }
      return { id, root: canonical, kind: "project" };
    });
  }
  async function leave({ id, lease = "emacs" } = {}) {
    await initialize();
    return serial(() => {
      const scope = scopes.get(id);
      if (!scope || scope.kind === "knowledge") return { changed: false };
      if (!scope.leases.delete(lease)) return { changed: false };
      if (scope.leases.size === 0) scopes.delete(id);
      reconcile();
      changed();
      return { changed: true };
    });
  }
  async function flush(owner) {
    if (owner.pending) return owner.pending;
    owner.pending = (async () => {
      if (owner.full) {
        owner.full = false;
        try {
          const files = (await list(owner.root, { signal: owner.abort.signal, isRelevant: relevant }))
            .filter((file) => relevantFile(relative(owner.root, file)));
          if (!owner.active) return;
          owner.errors.delete(owner.root);
          const present = new Set(files);
          for (const file of owner.documents.keys()) if (!present.has(file)) owner.documents.delete(file);
          for (const file of owner.errors.keys()) if (!present.has(file)) owner.errors.delete(file);
          for (const file of files) owner.dirty.add(file);
        } catch (error) {
          owner.full = true;
          if (!owner.active) return;
          owner.documents.clear(); owner.cache.clear(); owner.dirty.clear();
          owner.errors.set(owner.root, String(error.message || error));
          return;
        }
      }
      const dirty = [...owner.dirty];
      owner.dirty.clear();
      for (const file of dirty) {
        if (!owner.active) return;
        try {
          // Canonical containment also rejects a parent directory replaced by
          // a symlink since initial discovery.
          const canonical = await canonicalRoot(file);
          if (!inside(owner.root, canonical)) throw failure("Agenda source escapes its active root", 403);
          if (!relevantFile(relative(owner.root, canonical))) { owner.documents.delete(file); owner.errors.delete(file); continue; }
          const doc = await read(file, { signal: owner.abort.signal });
          if (!owner.active) return;
          if (owner.documents.get(file)?.revision !== doc.revision) {
            const planning = await parseDocument({ ...doc, file, root: owner.root });
            owner.documents.set(file, { revision: doc.revision, planning });
          }
          owner.errors.delete(file);
        } catch (error) {
          owner.documents.delete(file);
          if (error.code === "ENOENT") owner.errors.delete(file);
          else owner.errors.set(file, String(error.message || error));
        }
      }
    })().finally(() => { owner.pending = null; });
    return owner.pending;
  }
  async function query(body = {}) {
    await initialize();
    await lifecycle;
    const requested = Array.isArray(body.scopes) ? body.scopes : ["knowledge"];
    if (!requested.length) throw failure("Select at least one Agenda scope", 400);
    const selected = requested.map((id) => {
      const scope = scopes.get(id);
      if (!scope) throw failure(`Agenda scope is inactive: ${id}`, 409);
      return scope;
    }).filter((scope, index, all) => !all.some((other, otherIndex) => otherIndex !== index
      && inside(other.root, scope.root) && (other.root !== scope.root || otherIndex < index)));
    const used = [...owners.values()].filter((owner) => selected.some((s) => inside(owner.root, s.root)));
    await Promise.all(used.map(flush));
    const version = generation;
    const results = [];
    const errors = [];
    for (const scope of selected) {
      if (scopes.get(scope.id) !== scope) throw failure("Project left while Agenda was loading");
      const owner = used.find((candidate) => inside(candidate.root, scope.root));
      if (!owner?.active) throw failure("Agenda scope changed while loading");
      for (const [file, message] of owner.errors) if (file === owner.root || inside(scope.root, file)) errors.push({ file, message });
      const key = JSON.stringify([scope.id, body.from || "", body.days || 7, !!body.includePlanning, !!body.includeGantt, new Date(now()).toDateString()]);
      let result = owner.cache.get(key);
      if (!result) {
        const planning = { todos: [], projects: [], milestones: [], clocks: [], dag: { nodes: [], edges: [] } };
        for (const [file, doc] of owner.documents) {
          if (!inside(scope.root, file)) continue;
          const identityCounts = new Map();
          for (const raw of doc.planning.todos || []) identityCounts.set(raw.id, (identityCounts.get(raw.id) || 0) + 1);
          for (const kind of ["todos", "projects", "milestones", "clocks"]) for (const raw of doc.planning[kind] || []) {
            const item = structuredClone(raw);
            const ambiguous = kind === "todos" && identityCounts.get(raw.id) > 1;
            item.uid = hash(`${file}\0${item.id}${ambiguous ? `\0${item.index}` : ""}`);
            item.scopeId = scope.id;
            item.sourceKind = item.sourceKind || "markdown";
            item.sourceRef = { file, id: item.id, index: item.index, source: item.source, revision: doc.revision, ambiguous };
            planning[kind].push(item);
          }
          for (const raw of doc.planning.dag?.nodes || []) planning.dag.nodes.push({
            ...structuredClone(raw), scopeId: scope.id,
            sourceRef: { file, id: raw.id, index: raw.index, revision: doc.revision },
          });
          for (const raw of doc.planning.dag?.edges || []) planning.dag.edges.push(structuredClone(raw));
        }
        result = await evaluate(planning, body, { todayMs: now() });
        if (version === generation && !owner.full && owner.dirty.size === 0 && !result.clocktable?.running) {
          if (owner.cache.size >= 16) owner.cache.delete(owner.cache.keys().next().value);
          owner.cache.set(key, result);
        }
      }
      results.push(result);
    }
    if (selected.some((scope) => scopes.get(scope.id) !== scope) || used.some((owner) => !owner.active)) {
      throw failure("Project left while Agenda was loading");
    }
    return mergeAgendaScopes(results, selected, { version, errors, nowMs: now() });
  }
  async function queryActive(body = {}) {
    await initialize();
    return query({ ...body, scopes: body.scopes || [...scopes.keys()] });
  }
  function validateTodo(todo, body, checkRevision = true) {
    if (!todo) throw failure("Agenda item disappeared; refresh before editing");
    if (todo.sourceRef.ambiguous) throw failure("Task ID is duplicated in this document; repair its ID before editing from Agenda");
    if (checkRevision && (!body.revision || body.revision !== todo.sourceRef.revision)) throw failure("Agenda source changed; refresh before editing");
    return todo;
  }
  async function lookup(body, checkRevision = true) {
    const snapshot = await query({ scopes: [body.scopeId] });
    return validateTodo(snapshot.todos.find((item) => item.uid === body.uid), body, checkRevision);
  }
  async function publish(result, files = []) {
    const changedFiles = result.changed === false ? [] : [...new Set([...files, ...(result.changedPaths || []), ...(result.file ? [result.file] : [])])];
    if (changedFiles.length) {
      invalidate(changedFiles);
      await onMutation({ ...result, changedPaths: changedFiles });
    }
    return result;
  }
  async function identify(body = {}) {
    const todo = await lookup(body);
    if (todo.sourceKind === "work-node" || todo.id.startsWith("#")) return todo;
    if (!ensureId) throw failure("Stable task IDs are unavailable", 501);
    const snapshot = await query({scopes:[todo.scopeId]});
    const result = await ensureId(todo, {planningIds:snapshot.todos.map((item) => String(item.sourceRef.id).replace(/^#/, ""))});
    await publish(result, [todo.file]);
    const fresh = await query({scopes:[todo.scopeId]});
    return validateTodo(fresh.todos.find((item) => item.file === todo.file && item.id === result.id), {}, false);
  }
  async function patch(body = {}) {
    if (typeof mutate !== "function") throw failure("Agenda mutations are unavailable", 501);
    const todo = await lookup(body);
    const result = await mutate(todo, body.patch || {});
    return publish(result, [todo.file]);
  }
  async function batch(body = {}) {
    if (!Array.isArray(body.items) || body.items.length > 1000) throw failure("Batch requires up to 1000 task requests", 400);
    if (typeof mutate !== "function") throw failure("Agenda mutations are unavailable", 501);
    const requests = [];
    const results = [];
    const seen = new Set();
    const snapshots = new Map();
    const repeatedSources = new Set();
    // Preflight before any writes. Each task is subsequently guarded again
    // by its source revision inside the serialized source writer.
    for (const item of body.items) {
      if (seen.has(item.uid)) continue;
      seen.add(item.uid);
      try {
        if (!snapshots.has(item.scopeId)) {
          const tasks = (await query({ scopes: [item.scopeId] })).todos;
          const sourceKeys = new Set();
          for (const todo of tasks) {
            const key = `${todo.file}\0${todo.source}`;
            if (sourceKeys.has(key)) repeatedSources.add(key);
            sourceKeys.add(key);
          }
          snapshots.set(item.scopeId, new Map(tasks.map((todo) => [todo.uid, todo])));
        }
        const todo = validateTodo(snapshots.get(item.scopeId).get(item.uid), item);
        if (todo.sourceKind === "markdown" && !todo.id.startsWith("#") && repeatedSources.has(`${todo.file}\0${todo.source}`)) {
          throw failure("Identical tasks need stable IDs before batch editing");
        }
        requests.push({ item, todo });
      }
      catch (error) { results.push({ uid: item.uid, ok: false, message: error.message }); }
    }
    const revisions = new Map();
    const changedFiles = new Set();
    for (const { item, todo } of requests) {
      try {
        if (!scopes.has(todo.scopeId)) throw failure("Project left before the batch finished");
        const rebased = { ...todo, ...(revisions.has(todo.file) ? { index: undefined } : {}), sourceRef: { ...todo.sourceRef, revision: revisions.get(todo.file) || todo.sourceRef.revision } };
        const result = await mutate(rebased, item.patch || body.patch || {});
        const revision = result.contentRevision || String(result.revision || "").replace(/^sha256:/, "");
        if (revision) revisions.set(todo.file, revision);
        if (result.changed !== false) changedFiles.add(todo.file);
        results.push({ uid: item.uid, ok: true });
      } catch (error) { results.push({ uid: item.uid, ok: false, message: error.message }); }
    }
    await publish({ changed: changedFiles.size > 0, changedPaths: [...changedFiles] });
    return { type: "agenda-batch", results, succeeded: results.filter((result) => result.ok).length };
  }
  async function capture(body = {}) {
    body = captures.expand(body);
    await initialize();
    if (typeof create !== "function") throw failure("Agenda capture is unavailable", 501);
    const scope = scopes.get(body.scopeId || "knowledge");
    if (!scope) throw failure("Capture scope is inactive");
    const file = resolve(scope.root, body.file || "inbox.md");
    if (!inside(scope.root, file) || !relevantFile(relative(scope.root, file)) || !/\.(md|markdown)$/i.test(file)) throw failure("Capture file must be Markdown inside the selected scope", 400);
    let probe = file;
    for (;;) {
      try {
        const canonical = await canonicalRoot(probe);
        if (!inside(scope.root, canonical)) throw failure("Capture path escapes the selected scope", 403);
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || probe === scope.root) throw error;
        probe = dirname(probe);
      }
    }
    const snapshot = await query({ scopes: [scope.id], includePlanning: true });
    const planningIds = [...snapshot.todos, ...snapshot.projects, ...snapshot.milestones, ...snapshot.clocks]
      .map((item) => String(item.sourceRef.id || "").replace(/^#/, ""));
    if (scopes.get(scope.id) !== scope) throw failure("Project left before capture");
    const result = await create({ ...body, file }, { planningIds, captureRoot: scope.root });
    await publish(result, [file]);
    const fresh = await query({ scopes: [scope.id] });
    const todo = fresh.todos.find((item) => item.file === file && (item.sourceRef.id === result.todo?.id || item.index === result.index));
    return { ...result, todo: todo ? { ...todo, id: todo.uid } : result.todo };
  }
  async function dependency(body = {}) {
    const source = await lookup(body.source);
    const target = await lookup(body.target);
    if (source.scopeId !== target.scopeId) throw failure("Dependencies must belong to the same active scope", 422);
    if (source.uid === target.uid) throw failure("A task cannot depend on itself", 422);
    if (source.sourceKind === "work-node" || target.sourceKind === "work-node") {
      if (source.sourceKind !== target.sourceKind || source.file !== target.file || !linkNodes) throw failure("WorkNode dependencies must be in the same work document", 422);
      return publish(await linkNodes(source, target), [source.file]);
    }
    if (!ensureId) throw failure("Stable task IDs are unavailable", 501);
    const snapshot = await query({ scopes: [source.scopeId] });
    const planningIds = snapshot.todos.map((todo) => String(todo.sourceRef.id).replace(/^#/, ""));
    const identified = await ensureId(target, { planningIds });
    if (identified.changed) {
      await publish(identified, [target.file]);
      // ID minting on a neighbouring task may shift a positional source.
      const fresh = await query({ scopes: [source.scopeId] });
      const matches = fresh.todos.filter((todo) => todo.file === source.file && todo.source === source.source);
      if (matches.length !== 1) throw failure("Dependency source changed while assigning an ID");
      Object.assign(source, matches[0]);
    }
    return publish(await mutate(source, { afterAdd: identified.id }), [source.file]);
  }
  let clockQueue = Promise.resolve();
  function clockOperation(operation) {
    const pending = clockQueue.then(operation);
    clockQueue = pending.catch(() => {});
    return pending;
  }
  function clockRequest(clock) {
    return { file: clock.file, index: clock.index, source: clock.source, revision: clock.sourceRef.revision,
      sourceKind: clock.sourceKind, workNodeId: clock.workNodeId, clockId: clock.clockId, scopeId: clock.scopeId };
  }
  async function stopIndexedClock(clock) {
    if (!scopes.has(clock.scopeId)) throw failure("Clock scope is inactive");
    return publish(await stopClock(clockRequest(clock), { strict: true }), [clock.file]);
  }
  function clockIn(body = {}) {
    return clockOperation(async () => {
      if (!startClock || !stopClock) throw failure("Agenda clocks are unavailable", 501);
      let todo = await lookup(body);
      if (!["markdown", "work-node"].includes(todo.sourceKind)) throw failure("Unsupported clock source", 422);
      // Validate the destination before closing another task's clock. A file
      // notification may not have arrived yet, even though the source changed.
      if ((await read(todo.file)).revision !== todo.sourceRef.revision) throw failure("Agenda source changed; refresh before clocking in");
      const snapshot = await queryActive({ includePlanning: true });
      const running = snapshot.clocks.filter((clock) => clock.args?.from && !clock.args?.to);
      await beforeClockIn(todo);
      if (running.length === 1 && running[0].todoId === todo.uid) return { changed: false, file: todo.file };
      for (const clock of running) {
        // Re-read the clock after our own previous write to the same file.
        const candidates = (await query({ scopes: [clock.scopeId], includePlanning: true })).clocks.filter((item) => item.file === clock.file
          && (clock.sourceKind === "work-node" ? item.workNodeId === clock.workNodeId && item.clockId === clock.clockId : item.source === clock.source));
        const current = candidates.length === 1 ? candidates[0] : null;
        if (!current || current.source !== clock.source) throw failure("Running clock changed; refresh before clocking in");
        await stopIndexedClock(current);
      }
      if (running.some((clock) => clock.file === todo.file)) {
        const fresh = await query({ scopes: [todo.scopeId] });
        const matches = fresh.todos.filter((item) => item.file === todo.file
          && (todo.sourceKind === "work-node" ? item.workNodeId === todo.workNodeId : item.source === todo.source));
        if (matches.length !== 1) throw failure("Task changed while stopping the previous clock");
        todo = matches[0];
      }
      const planningIds = [...snapshot.todos, ...snapshot.projects, ...snapshot.milestones, ...snapshot.clocks]
        .map((item) => String(item.sourceRef.id).replace(/^#/, ""));
      return publish(await startClock(todo, { planningIds, runningClocks: [] }), [todo.file]);
    });
  }
  function clockOut(body = {}) {
    return clockOperation(async () => {
      if (!stopClock) throw failure("Agenda clocks are unavailable", 501);
      const snapshot = await query({ scopes: [body.scopeId], includePlanning: true });
      const clock = snapshot.clocks.find((item) => item.uid === body.uid && item.args?.from && !item.args?.to);
      if (!clock || clock.sourceRef.revision !== body.revision) throw failure("Running clock changed; refresh before stopping");
      return stopIndexedClock(clock);
    });
  }
  function close() {
    closed = true;
    for (const owner of owners.values()) { owner.active = false; owner.abort.abort(); owner.watcher?.close(); owner.documents.clear(); }
    owners.clear(); scopes.clear(); rootAliases.clear();
  }
  return { captureTemplates: captures.catalog, initialize, enter, leave, query, queryActive, lookup, identify, patch, batch, capture, dependency, clockIn, clockOut, invalidate, close,
    status: () => ({ version: generation, scopes: [...scopes.values()].map(({ id, root, kind, leases }) => ({ id, root, kind, leases: leases.size })),
      owners: [...owners.values()].map(({ root, documents, dirty, full, watcher }) => ({ root, documents: documents.size, dirty: dirty.size, full, watching: !!watcher })) }) };
}
