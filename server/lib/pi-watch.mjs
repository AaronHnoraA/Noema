// The facts of Pi's watches: "when this happens, do that".
// Contract: docs/design/pi-watches.md.
//
// `.agent/pi/journal.jsonl` holds the facts (`watch cancel fire result`) and state
// is folded on read, like the task graph.  Anyone may list, add or cancel here.
// Nothing here acts: the Pi plugin does, for as long as the Project's Pi runs
// (`resources/pi/extensions/noema-manager/watcher.mjs`).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { appendEvent, ensureAgentDirectory, readJournal } from "./agent-journal.mjs";
import { resolveGraphRoot } from "./project-graph.mjs";
import { readProjectLayout } from "./research-project.mjs";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const UNITS = { s: 1000, m: MINUTE, h: 60 * MINUTE, d: DAY };
const LIFE = 7 * DAY;
export const DAILY_MESSAGES = 48;
const MAX_TEXT = 4_096;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const WATCH_ADVICE = {
  budget: "This Project sent its daily Agent messages; watches wait until the count falls. Cancel the noisy one.",
  failed: "The last firing failed. Read its `last`, fix the cause, then add the watch again.",
  unknown: "Pi stopped during this firing, so its effect is unknown. Check it; it is not replayed.",
};

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
export const directoryOf = (root) => join(root, ".agent", "pi");
export const journalOf = (root) => join(directoryOf(root), "journal.jsonl");
export const ownerOf = (root) => join(directoryOf(root), "watcher.json");
export const tasksOf = (root) => join(root, ".agent", "tasks");

function duration(value, name) {
  const match = /^(\d+)([smhd])$/.exec(String(value));
  return match ? Number(match[1]) * UNITS[match[2]] : fail(`${name} must look like 90s, 20m, 2h or 3d`);
}

function text(value, name) {
  const string = String(value ?? "").trim();
  if (!string) fail(`${name} is required`);
  return string.length > MAX_TEXT ? fail(`${name} is too long; pass a reference`) : string;
}

/** A watch always ends: at its time, after its count, or after a week. */
function normalizeWhen(when, now) {
  const { after, every, on, times = 1 } = when ?? {};
  if ([after, every, on].filter((value) => value !== undefined).length !== 1) fail("when takes exactly one of after, every or on");
  if (!Number.isSafeInteger(times) || times < 1) fail("times must be a positive integer");
  if (after !== undefined) { const dueAt = now + duration(after, "after"); return { dueAt, times: 1, until: dueAt + LIFE }; }
  if (every !== undefined) {
    const interval = duration(every, "every");
    if (interval < MINUTE) fail("every is at least 1m");
    return { dueAt: now + interval, every: interval, times, until: now + LIFE };
  }
  if (!on?.kind && !on?.phase) fail("on needs a kind or a phase");
  if (on.phase && !on.task) fail("on.phase needs on.task");
  return { on, times: on.phase ? 1 : times, until: now + LIFE };
}

export async function scriptPath(root, script) {
  const { workspace } = await readProjectLayout(root).catch(() => ({}));
  const places = [root, workspace].filter(Boolean).map((place) => realpathSync(place));
  let path;
  try { path = realpathSync(resolve(root, String(script))); } catch { fail(`No such script: ${script}`, 404); }
  const inside = places.some((place) => { const rest = relative(place, path); return rest && !rest.startsWith("..") && !isAbsolute(rest); });
  if (!inside) fail("A script must be a file of this Project", 403);
  if (!statSync(path).isFile() || !(statSync(path).mode & 0o111)) fail(`Not an executable file: ${script}`);
  return { path, cwd: workspace || root };
}

function normalizeTarget(to = "pi") {
  if (to === "pi" || to === "companion" || (to?.buffer && to?.nativeSessionId)) return to;
  return fail('to must be "pi", "companion" or {buffer, nativeSessionId}');
}

async function normalizeDo(root, action) {
  if ((action?.prompt === undefined) === (action?.script === undefined)) fail("do takes exactly one of prompt or script");
  if (action.prompt !== undefined) return { prompt: text(action.prompt, "do.prompt"), to: normalizeTarget(action.to) };
  const { script, args = [], report } = action;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) fail("do.args must be an array of strings; no shell is involved");
  await scriptPath(root, script);
  return { script, args, ...(report === undefined ? {} : { report: normalizeTarget(report) }) };
}

/** Fold EVENTS into watches.  Pure, so the watcher and every reader agree. */
export function foldWatches(events, now) {
  const watches = new Map();
  const running = new Map();
  let messages = 0;
  for (const event of events) {
    if (event.kind === "watch") { watches.set(event.id, { ...event, fires: 0, seen: event.seen ?? 0 }); continue; }
    const watch = watches.get(event.id);
    if (!watch) continue;
    if (event.kind === "cancel") watch.cancelled = true;
    if (event.kind === "fire") {
      Object.assign(watch, { fires: event.n, lastAt: event.at, seen: event.seen ?? watch.seen });
      running.set(`${event.id}/${event.n}`, { id: event.id, n: event.n });
      if (event.message && event.at >= now - DAY) messages += 1;
    }
    if (event.kind === "result") { watch.last = event; running.delete(`${event.id}/${event.n}`); }
  }
  for (const watch of watches.values()) {
    watch.state = watch.cancelled ? "cancelled" : watch.fires >= watch.times ? "done" : now > watch.until ? "expired" : "armed";
    if (watch.state === "armed" && !watch.on) watch.nextAt = watch.lastAt ? watch.lastAt + watch.every : watch.dueAt;
  }
  return { watches, running: [...running.values()], messages };
}

export const load = async (root, now) => foldWatches((await readJournal(journalOf(root))).events, now);
export const armedOf = (folded) => [...folded.watches.values()].filter((watch) => watch.state === "armed");

function findings(folded) {
  const list = folded.messages >= DAILY_MESSAGES ? [{ code: "budget", fix: WATCH_ADVICE.budget }] : [];
  for (const watch of folded.watches.values()) {
    const code = watch.last?.unknown ? "unknown" : watch.last?.ok === false ? "failed" : null;
    if (code) list.push({ code, id: watch.id, fix: WATCH_ADVICE[code] });
  }
  return list;
}

/** Is a project Pi watching ROOT?  The owner file is believed only while its process lives. */
export function watcherRunning(root) {
  try {
    process.kill(JSON.parse(readFileSync(ownerOf(root), "utf8")).pid, 0);
    return true;
  } catch { return false; }
}

const publicWatch = ({ id, why, agent, state, fires, times, nextAt, on, every, do: action, last }) => ({
  id, why, agent, state, fires, times, nextAt: nextAt ?? null,
  when: on ? `on ${JSON.stringify(on)}` : every ? `every ${every / MINUTE}m` : "once",
  action: action.script ? `script ${action.script}` : `tell ${action.to.buffer ?? action.to}`,
  ...(last ? { last: { ok: last.ok, tail: last.tail } } : {}) });

/** A Project's watches in a few fields, or null when it has none. */
export async function watchSummary(root) {
  if (!existsSync(journalOf(root))) return null;
  const folded = await load(root, Date.now());
  return { armed: armedOf(folded).length, running: watcherRunning(root), findings: findings(folded) };
}

/** List, add or cancel.  This only reads and writes facts; it never acts. */
export async function piWatch(body = {}, { now = Date.now() } = {}) {
  const op = String(body.op || "list");
  const root = await resolveGraphRoot(body.root);
  if (op === "list") {
    if (!existsSync(journalOf(root))) return { root, store: false };
    const folded = await load(root, now);
    const all = [...folded.watches.values()].map(publicWatch);
    return { root, running: watcherRunning(root), messagesToday: folded.messages, dailyMessages: DAILY_MESSAGES,
      armed: all.filter((watch) => watch.state === "armed"),
      ended: all.filter((watch) => watch.state !== "armed").slice(-10).reverse(), findings: findings(folded) };
  }
  if (op === "cancel") {
    const id = String(body.id ?? "");
    if ((await load(root, now)).watches.get(id)?.state !== "armed") fail(`No armed watch: ${id}`, 404);
    await appendEvent(journalOf(root), { kind: "cancel", at: now, id });
    return { root, id, state: "cancelled" };
  }
  if (op !== "add") fail(`Unknown operation: ${op}`);
  const id = body.id === undefined ? `w-${randomUUID().slice(0, 8)}` : String(body.id);
  if (!ID.test(id)) fail(`Bad watch id: ${id}`);
  const when = normalizeWhen(body.when, now);
  const action = await normalizeDo(root, body.do);
  const event = { kind: "watch", at: now, id, why: text(body.why, "why"), agent: text(body.agent, "agent"), ...when, do: action };
  await ensureAgentDirectory(root, "pi");
  if ((await load(root, now)).watches.get(id)?.state === "armed") fail(`Watch ${id} is already armed`, 409);
  if (when.on) event.seen = (await readJournal(join(tasksOf(root), "journal.jsonl"))).events.length;
  await appendEvent(journalOf(root), event);
  return { root, id, nextAt: when.dueAt ?? null, running: watcherRunning(root) };
}
