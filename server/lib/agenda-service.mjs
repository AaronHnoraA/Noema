import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { formatDateValue } from "../../shared/planning-values.mjs";
import { createAgendaIndex } from "./agenda-index.mjs";
import { buildClockModel } from "./runtime.mjs";

const failure = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const within = (root, file) => {
  const path = relative(root, file);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
const revision = (record) => createHash("sha256").update(JSON.stringify(record)).digest("hex");
const clockId = (clock) => clock.clockId || clock.args?.id || (clock.sourceRef?.id?.startsWith("#") ? clock.sourceRef.id.slice(1) : "");
const identity = (file, kind, node, id, from, task, text) => JSON.stringify([file, kind, node || "", id ? ["id", id] : ["legacy", from, task || "", text || ""]]);
const recordKey = (record) => identity(record.file, record.sourceKind, record.workNodeId, record.clockId, record.from, record.task, record.text);
const sourceKey = (clock) => identity(clock.file, clock.sourceKind, clock.workNodeId, clockId(clock), clock.args?.from, clock.args?.task, clock.title || clock.text);
function clockMap(clocks) {
  const result = new Map();
  for (const clock of clocks) {
    const key = sourceKey(clock);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(clock);
  }
  return result;
}

/** Durable operations around the existing source index. The journal is host
 * state; inactive project contents are never opened, watched or discovered.
 * Queries only observe. Deferred source writes run on entry or explicit retry. */
export function createAgendaService({ clockStore, now = Date.now, ...options }) {
  if (!clockStore) return createAgendaIndex({ ...options, now });
  let state;
  let queue = Promise.resolve();
  let closed = false;
  const run = (operation) => {
    const next = queue.then(async () => {
      if (closed) throw failure("Agenda is closed", 503);
      state = clockStore.read();
      return operation();
    });
    queue = next.catch(() => {});
    return next;
  };
  function save(records) {
    if (JSON.stringify(records) === JSON.stringify(state.records)) return;
    state = clockStore.commit(state, records);
    options.onChange?.({ clockRevision: state.revision, files: [] });
  }
  const put = (record) => save(state.records.some((r) => r.id === record.id)
    ? state.records.map((r) => r.id === record.id ? record : r) : [...state.records, record]);
  const remove = (id) => save(state.records.filter((r) => r.id !== id));
  const active = (record) => index.status().scopes.some((scope) => within(scope.root, record.file));
  const scopeRoot = (id) => index.status().scopes.find((scope) => scope.id === id)?.root;
  const matches = (record, clock) => recordKey(record) === sourceKey(clock);
  function fromClock(clock, previous = {}) {
    return { ...previous, id: previous.id || `journal:${randomUUID()}`, phase: previous.to ? "stopping" : "running",
      file: clock.file, scopeId: clock.scopeId, root: scopeRoot(clock.scopeId), sourceKind: clock.sourceKind,
      workNodeId: clock.workNodeId, clockId: clockId(clock), from: clock.args.from, task: clock.args.task || "",
      text: clock.title || clock.text || "", todoId: clock.todoId, source: clock.source,
      message: "" };
  }
  function compatible(record, clock) {
    return record.from === clock.args?.from && (record.task === undefined || record.task === (clock.args?.task || ""));
  }
  async function observe(body = {}) {
    const snapshot = await index.queryActive({ ...body, scopes: undefined, includePlanning: true });
    const sources = clockMap(snapshot.clocks);
    let records = state.records.map((r) => ({ ...r }));
    for (const record of records) {
      if (!active(record)) continue;
      const candidates = sources.get(recordKey(record)) || [];
      const clock = candidates.length === 1 ? candidates[0] : null;
      if (!clock) { record.message = candidates.length ? "Clock identity is ambiguous" : "Clock source is missing; verify the source before retrying"; continue; }
      if (!compatible(record, clock)) { record.message = "Clock start or task reference changed in the source"; continue; }
      if (clock.args.to) {
        if (!record.to || clock.args.to === record.to) record.remove = true;
        else record.message = "Clock has a different stop time in the source";
      } else {
        const refreshed = fromClock(clock, record);
        if (record.to) refreshed.message = record.message;
        Object.assign(record, refreshed);
      }
    }
    records = records.filter((r) => !r.remove);
    const tracked = new Set(records.map(recordKey));
    for (const clock of snapshot.clocks) if (clock.args?.from && !clock.args.to && !tracked.has(sourceKey(clock))) {
      const record = fromClock(clock);
      if (sources.get(sourceKey(clock)).length > 1) record.message = "Clock identity is ambiguous";
      records.push(record);
      tracked.add(sourceKey(clock));
    }
    save(records);
    return snapshot;
  }
  function requestStop(record) {
    if (record.to) return record;
    const to = formatDateValue(now(), true);
    if (to < record.from) throw failure("Clock stop time is before its start", 422);
    const stopped = { ...record, to, phase: "stopping", message: "" };
    put(stopped);
    return stopped;
  }
  async function stopSource(body, writeOptions = {}) {
    const record = state.records.find((r) => r.file === body.file
      && (r.sourceKind === "work-node" ? r.workNodeId === body.workNodeId && r.clockId === body.clockId : r.source === body.source));
    if (!record) throw failure("Clock reference changed; refresh before stopping");
    if (record.message) throw failure(record.message);
    const stopped = requestStop(record);
    try {
      if (await options.isSourceProtected?.(body.file)) throw failure("Save the modified source buffer before retrying");
      return await options.stopClock(body, { ...writeOptions, at: stopped.to });
    } catch (error) {
      put({ ...stopped, message: String(error.message || error) });
      throw error;
    }
  }
  const index = createAgendaIndex({ ...options, now,
    async beforeClockIn(todo) {
      await options.beforeClockIn?.(todo);
      if (await options.isSourceProtected?.(todo.file)) throw failure("Save the modified source buffer before clocking in");
      if (state.records.some((record) => active(record) && record.phase === "starting")) {
        throw failure("A clock start is unconfirmed; inspect the Clock report before starting another task");
      }
      // The base index verifies the destination revision before this hook.
      for (const record of [...state.records]) if (!active(record) && !record.to) requestStop(record);
    },
    async startClock(todo, writeOptions) {
      const id = `clk_${randomUUID()}`;
      const from = formatDateValue(now(), true);
      const record = { id: `journal:${randomUUID()}`, phase: "starting", file: todo.file, scopeId: todo.scopeId,
        root: scopeRoot(todo.scopeId), sourceKind: todo.sourceKind, workNodeId: todo.workNodeId,
        clockId: id, from, text: todo.text, todoId: todo.uid, message: "" };
      put(record); // Write-ahead: no source write starts before this commit.
      try {
        return await options.startClock(todo, { ...writeOptions, clockId: id, at: from });
      } catch (error) {
        put({ ...record, message: String(error.message || error) });
        throw error;
      }
    },
    stopClock: stopSource,
  });
  async function applyStops(body = {}) {
    const changedPaths = [];
    for (const stored of [...state.records]) {
      const record = state.records.find((r) => r.id === stored.id);
      if (!record?.to || !active(record) || (body.uid && body.uid !== record.id)) continue;
      if ((body.protectedFiles || []).includes(record.file)) {
        put({ ...record, message: "Save the modified source buffer before retrying" });
        continue;
      }
      // Use an active source snapshot, never a direct read from the journal.
      const snapshot = await index.queryActive({ includePlanning: true });
      const candidates = snapshot.clocks.filter((clock) => matches(record, clock));
      const clock = candidates.length === 1 ? candidates[0] : null;
      if (!clock || !compatible(record, clock)) {
        put({ ...record, message: "Clock source changed or is missing; verify it before retrying" });
        continue;
      }
      if (clock.args.to) {
        if (clock.args.to === record.to) remove(record.id);
        else put({ ...record, message: "Clock has a different stop time in the source" });
        continue;
      }
      put(fromClock(clock, record));
      try {
        await index.clockOut({ uid: clock.uid, scopeId: clock.scopeId, revision: clock.sourceRef.revision });
        remove(record.id);
        changedPaths.push(clock.file);
      } catch (error) {
        const current = state.records.find((r) => r.id === record.id);
        if (current) put({ ...current, message: String(error.message || error) });
      }
    }
    return [...new Set(changedPaths)];
  }
  function decorate(snapshot) {
    let clocktable = snapshot.clocktable || { tasks: [], byDay: {}, byProject: {} };
    const pending = state.records.filter((record) => record.to);
    if (pending.length && snapshot.clocks) {
      let adjusted = false;
      const pendingByKey = new Map(pending.map((record) => [recordKey(record), record]));
      const sources = clockMap(snapshot.clocks);
      const clocks = snapshot.clocks.map((clock) => {
        const record = pendingByKey.get(sourceKey(clock));
        if (!record || sources.get(sourceKey(clock)).length !== 1 || !compatible(record, clock) || clock.args.to) return clock;
        adjusted = true;
        return { ...clock, args: { ...clock.args, to: record.to } };
      });
      if (adjusted) {
        clocktable = { ...buildClockModel(clocks, snapshot.todos.map((todo) => ({ ...todo, id: todo.uid,
          canon: { ...todo.canon, project: todo.projectKey || "" } })), [], now()), intentAdjusted: true };
        snapshot = { ...snapshot, projectModel: snapshot.projectModel?.map((project) => ({ ...project,
          clockedMinutes: clocktable.byProject[project.key] || 0 })) };
      }
    }
    const records = state.records.map((record) => ({ uid: record.id, scopeId: record.scopeId, revision: revision(record),
      file: record.file, text: record.text, from: record.from, to: record.to, todoId: record.todoId,
      sourceKind: record.sourceKind, inactive: !active(record), pending: record.phase !== "running",
      message: record.message || "", minutesSoFar: Math.max(0, Math.floor((now() - new Date(record.from.replace(" ", "T")).getTime()) / 60000)) }));
    const running = records.filter((record) => !record.to);
    return { ...snapshot, version: snapshot.version + state.revision,
      clocktable: { ...clocktable,
        running: running[0] || null, runningClocks: running, pendingWrites: records.filter((record) => record.to) } };
  }
  const query = (body, all) => run(async () => {
    const observed = await observe(body);
    const requested = body.scopes || (all ? observed.scopes.map((scope) => scope.id) : ["knowledge"]);
    if (body.includePlanning && JSON.stringify([...new Set(requested)].sort()) === JSON.stringify(observed.scopes.map((scope) => scope.id).sort())) {
      return decorate(observed);
    }
    return decorate(await index[all ? "queryActive" : "query"](body));
  });
  return {
    ...index,
    query: (body = {}) => query(body, false), queryActive: (body = {}) => query(body, true),
    initialize: () => run(() => index.initialize()),
    enter: (body = {}) => run(async () => {
      const scope = await index.enter(body);
      await observe();
      const changedPaths = await applyStops(body);
      return { ...scope, changedPaths };
    }),
    leave: (body = {}) => run(async () => { await observe(); return index.leave(body); }),
    clockIn: (body = {}) => run(async () => {
      await observe();
      const result = await index.clockIn(body);
      await observe();
      return result;
    }),
    clockOut: (body = {}) => run(async () => {
      const record = state.records.find((r) => r.id === body.uid);
      if (!record || revision(record) !== body.revision) throw failure("Running clock changed; refresh before stopping");
      requestStop(record);
      const changedPaths = await applyStops({ ...body, uid: record.id });
      return { ok: true, deferred: state.records.some((r) => r.id === record.id), changedPaths };
    }),
    retryClocks: (body = {}) => run(async () => {
      if (body.uid) {
        const record = state.records.find((r) => r.id === body.uid);
        if (!record || (body.revision && body.revision !== revision(record))) throw failure("Clock receipt changed; refresh before retrying");
      }
      await observe();
      const changedPaths = await applyStops(body);
      return { ok: true, changedPaths, pending: state.records.filter((r) => r.to).length };
    }),
    keepClockSource: (body = {}) => run(async () => {
      const record = state.records.find((r) => r.id === body.uid);
      if (!record || revision(record) !== body.revision) throw failure("Clock receipt changed; refresh before resolving it");
      if (!active(record)) throw failure("Enter the source project before resolving a clock receipt");
      if ((body.protectedFiles || []).includes(record.file) || await options.isSourceProtected?.(record.file)) throw failure("Save the modified source buffer before resolving its clock");
      index.invalidate([record.file]);
      const snapshot = await index.queryActive({ includePlanning: true });
      if (snapshot.errors.some((error) => error.file === record.file)) throw failure("The source could not be read; its clock receipt is retained");
      remove(record.id);
      await observe();
      return { ok: true, changedPaths: [] };
    }),
    close: async () => { await queue; if (closed) return; closed = true; index.close(); clockStore.close(); },
  };
}
