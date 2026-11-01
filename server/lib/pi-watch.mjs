// Pi's watches: "when this happens, do that", kept in `<project>/.agent/pi/`.
// A countdown, a repeating check and a hook are one object with different
// triggers, and they outlive the short Agent that asked for them.
// Contract: docs/design/pi-watches.md.
//
// journal.jsonl holds every fact (`watch cancel pause resume fire result event`)
// and state is folded on read, like the task graph.  The host's watcher is the
// only thing that acts on it.  It holds one timer and watches a directory only
// while a Project has armed watches; with none it costs nothing.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, realpathSync, statSync, watch as watchDirectory } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { appendEvent, atomicWrite, ensureAgentDirectory, readJournal, withLock } from "./agent-journal.mjs";
import { projectGraph, resolveGraphRoot } from "./project-graph.mjs";
import { readProjectLayout } from "./research-project.mjs";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const EVERY_FLOOR = MINUTE;
const DEFAULT_LIFE = 7 * DAY;
const MAX_LIFE = 30 * DAY;
const DAILY_MESSAGES = 48;
const RETRIES = [MINUTE, 5 * MINUTE, 15 * MINUTE];
const SCRIPT_TIMEOUT = 10 * MINUTE;
const SCRIPT_TIMEOUT_MAX = HOUR;
const KILL_GRACE = 5 * SECOND;
const LOG_LIMIT = 1024 * 1024;
const LOGS_KEPT = 40;
const TAIL = 400;
const MAX_TEXT = 4_096;
const LONGEST_SLEEP = 6 * HOUR;
const DEBOUNCE = 250;
const HELD_RECHECK = 5 * MINUTE;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCRIPT_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "SHELL"];

export const WATCH_ADVICE = {
  budget: "This Project sent its daily Agent messages; watches wait until the count falls. Cancel the noisy one or widen its interval.",
  failed: "The last firing failed after its retries. Read its result, fix the cause, then add the watch again.",
  unknown: "The host stopped while this firing ran, so whether it took effect is unknown. Check the effect; it is not replayed.",
  paused: "Watches are paused here; nothing fires until `resume`.",
};

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const directory = (root) => join(root, ".agent", "pi");
const journalOf = (root) => join(directory(root), "journal.jsonl");
const runsOf = (root) => join(directory(root), "runs");
const tasksOf = (root) => join(root, ".agent", "tasks");
const bounded = (value, name) => {
  const text = String(value ?? "").trim();
  if (!text) fail(`${name} is required`);
  if (text.length > MAX_TEXT) fail(`${name} is over ${MAX_TEXT} characters; pass a reference`);
  return text;
};

function duration(value, name) {
  const match = /^(\d+)(s|m|h|d)$/.exec(String(value));
  if (!match) fail(`${name} must look like 90s, 20m, 2h or 3d`);
  return Number(match[1]) * { s: SECOND, m: MINUTE, h: HOUR, d: DAY }[match[2]];
}

function instant(value, name) {
  const at = Date.parse(String(value));
  if (!Number.isFinite(at)) fail(`${name} must be an ISO-8601 time`);
  return at;
}

/** A watch always ends: at its time, after its count, or when its life runs out. */
function normalizeWhen(when, now) {
  const given = when && typeof when === "object" ? when : fail("when is required: after, at, every or on");
  const kinds = ["after", "at", "every", "on"].filter((key) => given[key] !== undefined);
  if (kinds.length !== 1) fail("when takes exactly one of after, at, every or on");
  const life = given.until === undefined ? now + DEFAULT_LIFE : instant(given.until, "until");
  if (life <= now) fail("until is already past");
  if (life > now + MAX_LIFE) fail("A watch lives at most 30 days; add a new one when it ends");
  const times = given.times === undefined ? undefined : Number(given.times);
  if (times !== undefined && (!Number.isSafeInteger(times) || times < 1)) fail("times must be a positive integer");
  if (given.after !== undefined) return { dueAt: now + duration(given.after, "after"), times: 1, until: Math.max(life, now + duration(given.after, "after")) };
  if (given.at !== undefined) {
    const dueAt = instant(given.at, "at");
    if (dueAt > now + MAX_LIFE) fail("A watch lives at most 30 days");
    return { dueAt, times: 1, until: Math.max(life, dueAt) };
  }
  if (given.every !== undefined) {
    const every = duration(given.every, "every");
    if (every < EVERY_FLOOR) fail("every is at least 1m");
    return { dueAt: now + every, every, times, until: life };
  }
  const on = given.on && typeof given.on === "object" ? given.on : fail("on must name what to match");
  const fields = Object.entries(on).filter(([, value]) => value !== undefined && value !== "");
  if (!fields.length) fail("on must name at least one field, such as kind or phase");
  if (on.phase !== undefined && !on.task) fail("on.phase needs on.task");
  if (on.phase !== undefined && times > 1) fail("on.phase is a condition and fires once");
  return { on: Object.fromEntries(fields), times: times ?? 1, until: life };
}

async function scriptPath(root, script) {
  if (typeof script !== "string" || !script) fail("do.script must be a path");
  const layout = await readProjectLayout(root).catch(() => ({}));
  const places = [root, layout.workspace].filter(Boolean).map((place) => realpathSync(place));
  const full = isAbsolute(script) ? script : resolve(root, script);
  const cwd = layout.workspace || root;
  let real;
  try { real = realpathSync(full); } catch { fail(`No such script: ${script}`, 404); }
  if (!places.some((place) => { const path = relative(place, real); return path && !path.startsWith("..") && !isAbsolute(path); }))
    fail("A script must be a file of this Project", 403);
  const info = statSync(real);
  if (!info.isFile() || !(info.mode & 0o111)) fail(`Not an executable file: ${script}`);
  return { path: real, cwd };
}

function normalizeTarget(to) {
  if (to === undefined || to === "pi") return "pi";
  if (to === "companion") return to;
  if (to && typeof to === "object" && to.buffer && to.nativeSessionId)
    return { buffer: String(to.buffer), nativeSessionId: String(to.nativeSessionId) };
  return fail('to must be "pi", "companion" or {buffer, nativeSessionId}');
}

async function normalizeDo(root, action) {
  if (!action || typeof action !== "object") fail("do is required: a prompt, or a script");
  if ((action.prompt === undefined) === (action.script === undefined)) fail("do takes exactly one of prompt or script");
  if (action.prompt !== undefined) return { to: normalizeTarget(action.to), prompt: bounded(action.prompt, "do.prompt") };
  const args = action.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) fail("do.args must be an array of strings; no shell is involved");
  const timeout = action.timeout === undefined ? SCRIPT_TIMEOUT : duration(action.timeout, "do.timeout");
  if (timeout > SCRIPT_TIMEOUT_MAX) fail("do.timeout is at most 1h");
  await scriptPath(root, action.script);
  return { script: action.script, args, timeout, ...(action.report === undefined ? {} : { report: normalizeTarget(action.report) }) };
}

/** Fold EVENTS into watches.  Pure, so the watcher and every reader agree. */
export function foldWatches(events, now) {
  const watches = new Map();
  let paused = false;
  const open = new Map();
  events.forEach((event, index) => {
    if (event.kind === "pause") paused = true;
    else if (event.kind === "resume") paused = false;
    else if (event.kind === "watch") watches.set(event.id, { ...event, fires: 0, retries: 0, cursor: { graph: event.graphSeen ?? 0, pi: index + 1 } });
    const watch = watches.get(event.id);
    if (!watch) return;
    if (event.kind === "cancel") watch.cancelled = true;
    else if (event.kind === "fire") {
      watch.fires = event.n;
      watch.lastAt = event.at;
      if (event.cursor) watch.cursor = event.cursor;
      open.set(`${event.id}/${event.n}`, { id: event.id, n: event.n });
    } else if (event.kind === "result") {
      open.delete(`${event.id}/${event.n}`);
      watch.last = event;
      if (event.ok === false && event.retry) { watch.fires = event.n - 1; watch.retries += 1; watch.retryAt = event.retryAt; }
      else { watch.retries = 0; watch.retryAt = undefined; if (event.ok === false) watch.failed = true; }
    }
  });
  for (const watch of watches.values()) {
    const spent = watch.times !== undefined && watch.fires >= watch.times;
    watch.state = watch.cancelled ? "cancelled" : spent ? (watch.failed ? "failed" : "done") : now > watch.until ? "expired" : "armed";
    if (watch.state === "armed" && watch.on === undefined)
      watch.nextAt = watch.retryAt ?? (watch.every && watch.lastAt ? watch.lastAt + watch.every : watch.dueAt);
    else if (watch.retryAt) watch.nextAt = watch.retryAt;
  }
  const dayStart = now - DAY;
  const messages = events.filter((event) => event.kind === "fire" && event.message && event.at >= dayStart).length;
  return { watches, paused, open: [...open.values()], messages };
}

const whenText = (watch) => watch.on ? `on ${JSON.stringify(watch.on)}`
  : watch.every ? `every ${Math.round(watch.every / MINUTE)}m` : "once";
const actionText = (watch) => watch.do.script ? `script ${watch.do.script}`
  : `tell ${typeof watch.do.to === "string" ? watch.do.to : watch.do.to.buffer}`;

function findings(folded) {
  const list = [];
  if (folded.paused) list.push({ code: "paused", fix: WATCH_ADVICE.paused });
  if (folded.messages >= DAILY_MESSAGES) list.push({ code: "budget", fix: WATCH_ADVICE.budget });
  for (const watch of folded.watches.values()) {
    if (watch.state === "failed") list.push({ code: "failed", id: watch.id, fix: WATCH_ADVICE.failed });
    if (watch.last?.unknown) list.push({ code: "unknown", id: watch.id, fix: WATCH_ADVICE.unknown });
  }
  return list;
}

const publicWatch = (watch) => ({ id: watch.id, why: watch.why, agent: watch.agent, state: watch.state,
  when: whenText(watch), action: actionText(watch), fires: watch.fires, ...(watch.times ? { times: watch.times } : {}),
  nextAt: watch.nextAt ?? null, until: watch.until, ...(watch.last ? { last: {
    at: watch.last.at, ok: watch.last.ok ?? null, ...(watch.last.exit === undefined ? {} : { exit: watch.last.exit }),
    ...(watch.last.tail ? { tail: watch.last.tail } : {}) } } : {}) });

async function load(root, now = Date.now()) {
  const { events, torn } = await readJournal(journalOf(root));
  return { events, torn, ...foldWatches(events, now) };
}

/** A Project's watches in a few fields, or null when it has none. */
export async function watchSummary(root) {
  if (!existsSync(journalOf(root))) return null;
  const folded = await load(root);
  const armed = [...folded.watches.values()].filter((watch) => watch.state === "armed");
  const next = armed.map((watch) => watch.nextAt).filter(Boolean).sort((a, b) => a - b)[0] ?? null;
  return { armed: armed.length, paused: folded.paused, nextAt: next, findings: findings(folded) };
}

const readers = {
  async list(root, body, now) {
    const folded = await load(root, now);
    const all = [...folded.watches.values()].map(publicWatch);
    const armed = all.filter((watch) => watch.state === "armed");
    const ended = all.filter((watch) => watch.state !== "armed").slice(-Number(body.limit || 10)).reverse();
    return { root, paused: folded.paused, messagesToday: folded.messages, dailyMessages: DAILY_MESSAGES, armed, ended, findings: findings(folded) };
  },
  async log(root, body) {
    const id = String(body.id ?? "");
    if (!ID.test(id)) fail("A watch id is required");
    const logs = (await readdir(runsOf(root)).catch(() => [])).filter((name) => name.startsWith(`${id}-`)).sort();
    const name = body.n ? `${id}-${body.n}.log` : logs.at(-1);
    if (!name || !logs.includes(name)) fail(`No log for ${id}`, 404);
    const text = await readFile(join(runsOf(root), name), "utf8");
    return { root, id, log: name, text: text.slice(-Math.min(Number(body.limit) || 12_000, 32_000)) };
  },
};

const writers = {
  async add(root, body, now) {
    const when = normalizeWhen(body.when, now);
    const action = await normalizeDo(root, body.do);
    const folded = await load(root, now);
    if (body.requestId) {
      const seen = folded.events.find((event) => event.requestId === body.requestId);
      if (seen) return { root, id: seen.id, replayed: true };
    }
    const id = body.id === undefined ? `w-${randomUUID().slice(0, 8)}` : String(body.id);
    if (!ID.test(id)) fail(`Bad watch id: ${id}`);
    if (folded.watches.get(id)?.state === "armed") fail(`Watch ${id} is already armed`, 409);
    const graphSeen = when.on ? (await readJournal(join(tasksOf(root), "journal.jsonl"))).events.length : undefined;
    const event = { kind: "watch", at: now, id, why: bounded(body.why, "why"), agent: bounded(body.agent, "agent"),
      ...when, do: action, ...(graphSeen === undefined ? {} : { graphSeen }), ...(body.requestId ? { requestId: body.requestId } : {}) };
    await appendEvent(journalOf(root), event);
    return { root, id, nextAt: when.dueAt ?? null, until: when.until };
  },
  async cancel(root, body, now) {
    const id = String(body.id ?? "");
    const watch = (await load(root, now)).watches.get(id) ?? fail(`Unknown watch: ${id}`, 404);
    if (watch.state !== "armed") return { root, id, state: watch.state };
    await appendEvent(journalOf(root), { kind: "cancel", at: now, id, agent: body.agent ?? "person" });
    return { root, id, state: "cancelled" };
  },
  async pause(root, _body, now) { await appendEvent(journalOf(root), { kind: "pause", at: now }); return { root, paused: true }; },
  async resume(root, _body, now) { await appendEvent(journalOf(root), { kind: "resume", at: now }); return { root, paused: false }; },
  /** A fact from Emacs.  Kept only when an armed watch could match it. */
  async event(root, body, now) {
    const folded = await load(root, now);
    const fact = { name: String(body.name ?? ""), buffer: body.buffer, agent: body.agent, reason: body.reason };
    const wanted = [...folded.watches.values()].some((watch) => watch.state === "armed" && watch.on && matches(watch.on, fact));
    if (!wanted) return { root, kept: false };
    await appendEvent(journalOf(root), { kind: "event", at: now, ...fact });
    return { root, kept: true };
  },
};

/** Does FACT carry every field ON asks for?  `phase` is a condition, not a fact. */
function matches(on, fact) {
  if (on.phase !== undefined) return false;
  return Object.entries(on).every(([key, value]) => (key === "kind" ? (fact.kind ?? fact.name) === value : fact[key] === value));
}

/** One API call; ops outside `list` and `log` write.  WATCHER rearms after a write. */
export async function piWatch(body = {}, { watcher, now = Date.now() } = {}) {
  const op = String(body.op || "list");
  const root = await resolveGraphRoot(body.root);
  if (readers[op]) {
    if (!existsSync(journalOf(root))) return { root, store: false };
    return readers[op](root, body, now);
  }
  const writer = writers[op] ?? fail(`Unknown operation: ${op}`);
  if (op === "event" && !existsSync(journalOf(root))) return { root, kept: false };
  if (op === "add") await ensureAgentDirectory(root, "pi");
  else if (!existsSync(journalOf(root))) fail("This Project has no watches", 404);
  const answer = await withLock(directory(root), "Pi's watches", () => writer(root, body, now));
  await watcher?.register(root);
  return answer;
}

async function sweepLogs(root) {
  const names = (await readdir(runsOf(root)).catch(() => [])).sort();
  await Promise.all(names.slice(0, Math.max(0, names.length - LOGS_KEPT)).map((name) => rm(join(runsOf(root), name), { force: true })));
}

/** The one thing that acts: a timer for the nearest firing, a directory watch
 * for Projects with hooks, nothing at all otherwise.  DELIVER.pi and DELIVER.agent
 * send a prompt; they throw or answer `{ok: false}` when it was not accepted. */
export function createPiWatcher({ deliver, rootsFile, log = () => {}, clock = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, watchImpl = watchDirectory }) {
  const roots = new Set();
  const dueByRoot = new Map();
  const queues = new Map();
  const watchers = new Map();
  const running = new Map();
  const busy = new Set();
  let timer = null;
  let stopped = false;

  const saveRoots = () => atomicWrite(rootsFile, `${JSON.stringify([...roots])}\n`);

  function schedule() {
    if (timer) { clearTimer(timer); timer = null; }
    if (stopped || !dueByRoot.size) return;
    const next = Math.min(...dueByRoot.values());
    // Waking is by the wall clock, so a sleeping laptop catches up on its next tick.
    timer = setTimer(() => { timer = null; for (const root of roots) scan(root); }, Math.min(Math.max(next - clock(), 0), LONGEST_SLEEP));
    timer.unref?.();
  }

  function follow(root, wanted) {
    const current = watchers.get(root);
    const path = existsSync(tasksOf(root)) ? tasksOf(root) : join(root, ".agent");
    if (current && (!wanted || current.path !== path)) { current.handle.close(); watchers.delete(root); }
    if (!wanted || watchers.has(root)) return;
    let pending = null;
    const handle = watchImpl(path, () => {
      clearTimer(pending);
      pending = setTimer(() => scan(root), DEBOUNCE);
      pending.unref?.();
    });
    handle.on?.("error", () => { handle.close(); watchers.delete(root); });
    watchers.set(root, { handle, path });
  }

  async function deliverTo(root, to, prompt) {
    const accepted = (answer) => { if (answer?.ok === false) throw new Error(answer.message || "not accepted"); };
    if (typeof to === "object") {
      try { return accepted(await deliver.agent({ action: "send", ...to, prompt })); }
      catch (error) {
        log(`watch: session gone, telling Pi: ${error.message}`);
        return accepted(await deliver.pi({ action: "send", root,
          prompt: `The Agent session ${to.buffer} that should hear this is gone.\n${prompt}` }));
      }
    }
    accepted(await deliver.pi({ action: "send", ...(to === "companion" ? { companion: true } : { root }), prompt }));
  }

  function runScript(root, watch, n) {
    return new Promise((done) => {
      const started = clock();
      scriptPath(root, watch.do.script).then(({ path, cwd }) => {
        mkdirSync(runsOf(root), { recursive: true });
        const logFile = `${watch.id}-${String(n).padStart(6, "0")}.log`;
        const output = createWriteStream(join(runsOf(root), logFile));
        const env = Object.fromEntries(SCRIPT_ENV.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
        const child = spawn(path, watch.do.args, { cwd, env: { ...env, NOEMA_PROJECT_ROOT: root, NOEMA_WATCH_ID: watch.id }, stdio: ["ignore", "pipe", "pipe"] });
        let written = 0;
        let tail = "";
        const take = (chunk) => {
          tail = (tail + chunk).slice(-TAIL);
          if (written < LOG_LIMIT) output.write(chunk.subarray(0, LOG_LIMIT - written));
          written += chunk.length;
        };
        child.stdout.on("data", take);
        child.stderr.on("data", take);
        running.set(child, root);
        const limit = setTimer(() => {
          child.kill("SIGTERM");
          setTimer(() => child.kill("SIGKILL"), KILL_GRACE).unref?.();
        }, watch.do.timeout);
        limit.unref?.();
        const finish = (exit, message) => {
          clearTimer(limit);
          running.delete(child);
          output.end();
          done({ ok: exit === 0, exit, ms: clock() - started, log: logFile, tail: (message || tail).trim() });
        };
        child.on("error", (error) => finish(-1, error.message));
        child.on("close", (exit) => finish(exit));
      }).catch((error) => done({ ok: false, exit: -1, ms: 0, tail: error.message }));
    });
  }

  async function act(root, watch, n, reason, late) {
    const head = `[Watch ${watch.id} fired: ${reason}${late ? `, ${Math.round(late / MINUTE)}m late` : ""}. Set by ${watch.agent}, not the person: ${watch.why}]`;
    if (watch.do.script) {
      const result = await runScript(root, watch, n);
      await record(root, { kind: "result", id: watch.id, n, ...result, ...(result.ok ? {} : { retry: false }) });
      await sweepLogs(root);
      if (watch.do.report) await deliverTo(root, watch.do.report,
        `${head}\nScript ${watch.do.script} ${result.ok ? "succeeded" : `failed with ${result.exit}`}. Log: \`agent:pi:watch\` op=log id=${watch.id}.\n${result.tail}`)
        .catch((error) => log(`watch: report failed: ${error.message}`));
      return;
    }
    try {
      await deliverTo(root, watch.do.to, `${head}\n${watch.do.prompt}`);
      await record(root, { kind: "result", id: watch.id, n, ok: true });
    } catch (error) {
      // Not accepted, so sending again cannot do the work twice.
      const wait = RETRIES[watch.retries];
      await record(root, { kind: "result", id: watch.id, n, ok: false, tail: error.message,
        ...(wait ? { retry: true, retryAt: clock() + wait } : {}) });
    }
  }

  const record = (root, event) => withLock(directory(root), "Pi's watches", () => appendEvent(journalOf(root), { at: clock(), ...event }));

  /** Decide under the lock, so one firing is written once however scans race.
   * The fact goes in first: a crash afterwards is `unknown`, never a replay. */
  async function fire(root, id, reason, cursor) {
    const fired = await withLock(directory(root), "Pi's watches", async () => {
      const folded = await load(root, clock());
      const watch = folded.watches.get(id);
      if (!watch || watch.state !== "armed" || folded.paused) return null;
      const message = Boolean(watch.do.prompt || watch.do.report);
      if (message && folded.messages >= DAILY_MESSAGES) return null;
      const n = watch.fires + 1;
      await appendEvent(journalOf(root), { kind: "fire", at: clock(), id, n, reason, message, ...(cursor ? { cursor } : {}) });
      return { watch, n };
    });
    if (fired) await act(root, fired.watch, fired.n, reason, lateBy(fired.watch, clock()));
  }

  const lateBy = (watch, now) => (watch.nextAt && now - watch.nextAt > MINUTE ? now - watch.nextAt : 0);

  /** The first fact past WATCH's cursor that its hook matches. */
  function firstMatch(watch, graphEvents, piEvents, phases) {
    const on = watch.on;
    if (on.phase !== undefined)
      return phases?.get(on.task) === on.phase ? { reason: `${on.task} is ${on.phase}`, cursor: watch.cursor } : null;
    for (let index = watch.cursor.graph; index < graphEvents.length; index += 1)
      if (matches(on, graphEvents[index]))
        return { reason: `${graphEvents[index].kind}${graphEvents[index].task ? ` of ${graphEvents[index].task}` : ""}`,
          cursor: { ...watch.cursor, graph: index + 1 } };
    for (let index = watch.cursor.pi; index < piEvents.length; index += 1) {
      const fact = piEvents[index];
      const name = fact.kind === "event" ? fact.name : fact.kind === "result" && fact.exit !== undefined ? (fact.ok ? "script-ok" : "script-failed") : null;
      if (name && matches(on, { ...fact, kind: name, watch: fact.id }))
        return { reason: `${name}${fact.buffer ? ` of ${fact.buffer}` : ""}`, cursor: { ...watch.cursor, pi: index + 1 } };
    }
    return null;
  }

  /** A firing with no result that nothing here is running: the host stopped under
   * it.  Reread under the lock, since a result may land just after the scan's read. */
  const settle = (root) => withLock(directory(root), "Pi's watches", async () => {
    for (const { id, n } of (await load(root, clock())).open)
      if (!busy.has(`${root}/${id}/${n}`))
        await appendEvent(journalOf(root), { kind: "result", at: clock(), id, n, ok: null, unknown: true });
  });

  async function scanNow(root) {
    if (stopped) return;
    if (!existsSync(journalOf(root))) { roots.delete(root); dueByRoot.delete(root); follow(root, false); await saveRoots(); return schedule(); }
    let folded = await load(root, clock());
    if (folded.open.some(({ id, n }) => !busy.has(`${root}/${id}/${n}`))) await settle(root);
    const armed = [...folded.watches.values()].filter((watch) => watch.state === "armed");
    const hooks = armed.filter((watch) => watch.on);
    if (!folded.paused) {
      const due = armed.filter((watch) => !watch.on && watch.nextAt <= clock());
      const retried = [...folded.watches.values()].filter((watch) => watch.on && watch.retryAt && watch.retryAt <= clock());
      if (hooks.length) {
        const graph = hooks.some((watch) => watch.on.phase === undefined)
          ? (await readJournal(join(tasksOf(root), "journal.jsonl"))).events : [];
        const phases = hooks.some((watch) => watch.on.phase !== undefined)
          ? new Map(((await projectGraph({ root, op: "graph" })).rows ?? []).map((row) => [row.id, row.phase])) : null;
        for (const watch of hooks) {
          const match = !watch.retryAt && firstMatch(watch, graph, folded.events, phases);
          if (match) launch(root, watch, match.reason, match.cursor);
        }
      }
      for (const watch of [...due, ...retried]) launch(root, watch, watch.retryAt ? "retry" : "its time came");
      folded = await load(root, clock());
    }
    const stillArmed = [...folded.watches.values()].filter((watch) => watch.state === "armed");
    const until = stillArmed.map((watch) => watch.until);
    const times = stillArmed.map((watch) => watch.nextAt).filter(Boolean).concat(until);
    // A due watch still here is held by the budget; a firing in flight rescans itself.
    if (times.length && !folded.paused)
      dueByRoot.set(root, Math.min(...times.map((at) => (at <= clock() ? clock() + HELD_RECHECK : at))));
    else dueByRoot.delete(root);
    follow(root, !folded.paused && stillArmed.some((watch) => watch.on));
    schedule();
  }

  function launch(root, watch, reason, cursor) {
    const key = `${root}/${watch.id}/${watch.fires + 1}`;
    if (busy.has(key)) return;
    busy.add(key);
    fire(root, watch.id, reason, cursor)
      .catch((error) => log(`watch: ${watch.id} failed: ${error.message}`))
      .finally(() => { busy.delete(key); if (!stopped) scan(root); });
  }

  /** Scans of one root run in turn; a burst of changes collapses into one more. */
  function scan(root) {
    const state = queues.get(root) ?? { running: false, again: false };
    queues.set(root, state);
    if (state.running) { state.again = true; return state.promise; }
    state.running = true;
    state.promise = (async () => {
      do {
        state.again = false;
        await scanNow(root).catch((error) => log(`watch: ${root}: ${error.message}`));
      } while (state.again && !stopped);
      state.running = false;
    })();
    return state.promise;
  }

  return {
    async start() {
      const saved = await readFile(rootsFile, "utf8").then(JSON.parse).catch(() => []);
      await Promise.all(saved.map(async (root) => { roots.add(root); await scan(root); }));
    },
    async register(root) {
      if (!roots.has(root)) { roots.add(root); await saveRoots(); }
      await scan(root);
    },
    /** Agents and the page may reach a Project whose index entry was lost. */
    async notice(root) { if (!roots.has(root) && existsSync(journalOf(root))) await this.register(root); },
    idle() { return !timer && !watchers.size && !running.size; },
    async drain() { await Promise.all([...queues.values()].map((state) => state.promise)); },
    async stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      for (const { handle } of watchers.values()) handle.close();
      watchers.clear();
      for (const child of running.keys()) child.kill("SIGTERM");
    },
  };
}
