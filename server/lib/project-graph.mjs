// The Project task graph: what a Project's Agents are doing, in what order,
// and why.  Contract: docs/noema/design/project-graph.md.
//
// Everything lives in `<project>/.agent/tasks/`:
//
//   <id>.md         one task's definition: flat front matter, then Markdown
//   journal.jsonl   every fact that happened, appended and never rewritten
//
// One owner per fact.  A task file says what the task is; the journal says
// what has happened to it, and state, claims and review cycles are folded from
// the journal on every read, so the two cannot drift.  There is no index and
// no database; deleting nothing and adding nothing is always a valid repair.
//
// Node built-ins only: `scripts/project-graph.mjs` runs this with no Noema host.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendEvent, atomicWrite, ensureAgentDirectory, readJournal, withLock } from "./agent-journal.mjs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { findResearchProjectRootOrNull } from "./research-project.mjs";

const run = promisify(execFile);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEASE_MS = 4 * HOUR;
const QUIET_MS = 3 * DAY;
const MAX_TEXT = 8_192;
const DEFAULT_CYCLES = 2;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NOTE_KINDS = new Set(["note", "decision", "commit"]);
const FANOUT = 3;
const BODY_BUDGET = 4_096;
const TEMP_AGE_MS = HOUR;

/** What to do about each phase and finding.  Rules live here rather than in a
 * Skill: an Agent reads the one line it needs, when it needs it. */
export const PHASE_ADVICE = {
  ready: "Claim it, or work on something that unlocks more.",
  waiting: "Finish the tasks in `on` first.",
  claimed: "Held by another Agent; coordinate through emacs:agent, do not touch it.",
  stale_claim: "The claim expired. Confirm with emacs:agent status that the holder stopped, read its journal, then claim with take.",
  awaiting_review: "Needs a verdict from an Agent other than the submitter.",
  blocked: "Read `reason`. Exhausted review cycles are a person's decision; state todo resumes it.",
  blocked_by_dependency: "A dependency was dropped or is missing; a dropped task does not satisfy it. Change the plan.",
  cycle: "A hand edit made a dependency cycle; fix `after` with plan.",
  done: "Finished.",
  dropped: "Abandoned; its file stays because the journal refers to it.",
};
export const FINDING_ADVICE = {
  "id-mismatch": "Rename the file to <id>.md.",
  "duplicate-id": "Two files claim this id; keep one and rename the other.",
  cycle: "Fix `after` with plan.",
  "unknown-dependency": "Fix `after` with plan, or restore the task.",
  "torn-journal-line": "A crash left half a line, already skipped. Check the last action took effect; never edit the journal.",
  "done-without-evidence": "Review the actual output; add a follow-up task with plan if it does not hold.",
  "done-above-open-work": "Done while a dependency is open; verify it, or add a task to reconcile.",
  "submitted-with-open-acceptance": "Submitted with unchecked acceptance; finish it in a follow-up task or correct the criteria.",
  "self-reviewed": "Have another Agent look at it, or leave the note why none could.",
  "stale-claim": "Confirm the holder stopped, then claim with take.",
  quiet: "Ask the holder or the person whether this line continues; do not abandon it automatically.",
  "journal-without-task": "The task file is gone; rebuild it with plan from the journal, or confirm it was abandoned.",
  deadlocked: "Open tasks remain and none can move. Tell the person; do not bypass dependencies.",
  "no-acceptance": "Add `- [ ]` criteria that someone else could verify.",
  "body-over-budget": "Reference files and ranges instead of pasting material.",
  "missing-reference": "The body names a path that does not exist; update it.",
  "high-fanout-without-review": "Many tasks depend on this one; set review: required.",
  "leftover-temp": "Harmless; agent:project:maintain removes it.",
};

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

// ---------------------------------------------------------------------------
// Where a Project's data is
// ---------------------------------------------------------------------------

async function gitPlaces(directory) {
  try {
    const { stdout } = await run("git", ["-C", directory, "rev-parse", "--path-format=absolute",
      "--show-toplevel", "--git-common-dir"], { timeout: 3_000 });
    const [top, common] = stdout.trim().split("\n");
    // A linked worktree shares its main checkout's history, and `.agent/` is
    // not tracked, so its tasks are the main checkout's.  A submodule's common
    // directory is not called `.git` and it keeps its own top level.
    return { top, main: basename(common) === ".git" ? dirname(common) : top };
  } catch {
    return null;
  }
}

/** True only when START is a repository that positively lacks REF. */
async function gitLacks(start, ref) {
  if (!await gitPlaces(start)) return false;
  return run("git", ["-C", start, "cat-file", "-e", `${ref}^{commit}`], { timeout: 3_000 }).then(() => false, () => true);
}

/** The directory holding `.agent/` for START: the nearest Noema Project seen
 * from the main checkout, else that checkout.  Nothing is created. */
export async function resolveGraphRoot(start) {
  if (typeof start !== "string" || !isAbsolute(start)) fail("An absolute root is required");
  const places = await gitPlaces(start);
  const from = places ? join(places.main, relative(places.top, start)) : start;
  return await findResearchProjectRootOrNull(from).catch(() => null)
    ?? await findResearchProjectRootOrNull(start).catch(() => null)
    ?? places?.main
    ?? fail(`Neither a Noema Project nor a Git repository: ${start}`, 404);
}

const tasksDirectory = (root) => join(root, ".agent", "tasks");
const journalFile = (root) => join(tasksDirectory(root), "journal.jsonl");
const taskFile = (root, id) => join(tasksDirectory(root), `${id}.md`);

// ---------------------------------------------------------------------------
// Task files
// ---------------------------------------------------------------------------

function parseValue(key, raw) {
  const text = raw.trim();
  if (key === "after" || key === "related") {
    const inner = /^\[(.*)\]$/.exec(text)?.[1] ?? text;
    return inner.split(",").map((part) => part.trim()).filter(Boolean);
  }
  if (key === "cycles") return Number(text);
  return text.replace(/^"(.*)"$/, "$1");
}

/** Parse a task file, or return null when it has no front matter: `.agent/tasks/`
 * also holds freehand Markdown notes (project-agent-management). */
export function parseTask(text) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const task = { after: [], related: [], body: match[2] };
  for (const line of match[1].split("\n")) {
    const pair = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (pair) task[pair[1]] = parseValue(pair[1], pair[2]);
  }
  return typeof task.id === "string" ? task : null;
}

export function serializeTask(task) {
  const lines = ["---", `id: ${task.id}`, `title: ${task.title}`];
  if (task.after.length) lines.push(`after: [${task.after.join(", ")}]`);
  if (task.related.length) lines.push(`related: [${task.related.join(", ")}]`);
  if (task.agent) lines.push(`agent: ${task.agent}`);
  if (task.review) lines.push(`review: ${task.review}`);
  if (task.cycles !== undefined) lines.push(`cycles: ${task.cycles}`);
  lines.push("---", "");
  return lines.join("\n") + (task.body || "");
}

async function readTasks(root) {
  const tasks = new Map();
  const problems = [];
  let names;
  try {
    names = await readdir(tasksDirectory(root));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let freehand = 0;
  const temporaries = names.filter((name) => name.endsWith(".tmp")).length;
  for (const name of names.sort()) {
    if (!name.endsWith(".md") || name.startsWith(".")) continue;
    const task = parseTask(await readFile(join(tasksDirectory(root), name), "utf8"));
    if (!task) { freehand += 1; continue; }
    if (name !== `${task.id}.md`) problems.push({ code: "id-mismatch", task: task.id, file: name });
    if (tasks.has(task.id)) { problems.push({ code: "duplicate-id", task: task.id, file: name }); continue; }
    tasks.set(task.id, { ...task, file: taskFile(root, name.slice(0, -3)) });
  }
  return { tasks, problems, freehand, temporaries };
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/** Fold EVENTS into each task's state.  Pure, so every view sees one answer. */
export function foldJournal(events) {
  const facts = new Map();
  const fact = (id) => {
    if (!facts.has(id)) facts.set(id, { state: "todo", claim: null, cycles: 0, sessions: [],
      evidence: "", feedback: "", reason: "", lastEvent: 0, submittedBy: "", reviewedBy: "", openAcceptance: [] });
    return facts.get(id);
  };
  for (const event of events) {
    if (!event.task) continue;
    const item = fact(event.task);
    item.lastEvent = Math.max(item.lastEvent, event.at || 0);
    if (event.session && !item.sessions.includes(event.session)) item.sessions.push(event.session);
    if (item.claim && item.claim.agent === event.agent) item.claim.seen = event.at;
    if (event.kind === "claim") {
      Object.assign(item, { state: "doing", reason: "",
        claim: { agent: event.agent, session: event.session || "", since: event.at, seen: event.at } });
    } else if (event.kind === "release") {
      Object.assign(item, { state: "todo", claim: null, reason: event.text || "" });
    } else if (event.kind === "submit") {
      Object.assign(item, { state: event.needsReview ? "review" : "done", claim: null,
        evidence: event.text || "", submittedBy: event.agent || "", feedback: "",
        openAcceptance: event.openAcceptance || [] });
    } else if (event.kind === "review") {
      item.reviewedBy = event.agent || "";
      if (event.verdict === "passed") Object.assign(item, { state: "done", feedback: "" });
      else {
        item.cycles += 1;
        Object.assign(item, { state: event.exhausted ? "blocked" : "todo", feedback: event.text || "",
          reason: event.exhausted ? "Review cycles exhausted; a person decides" : "" });
      }
    } else if (event.kind === "state") {
      Object.assign(item, { state: event.state, claim: null, reason: event.text || "" });
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------
// The graph: order, reasons and diagnostics
// ---------------------------------------------------------------------------

function findCycles(tasks) {
  const color = new Map();
  const members = new Set();
  const visit = (id, path) => {
    color.set(id, 1);
    for (const dep of tasks.get(id)?.after ?? []) {
      if (!tasks.has(dep)) continue;
      if (color.get(dep) === 1) path.slice(path.indexOf(dep)).forEach((item) => members.add(item));
      else if (!color.has(dep)) visit(dep, [...path, dep]);
    }
    color.set(id, 2);
  };
  for (const id of tasks.keys()) if (!color.has(id)) visit(id, [id]);
  return members;
}

/** Why TASK is or is not runnable.  This only explains the records; nothing
 * here changes a state or decides anything on anyone's behalf. */
function phaseOf(task, fact, tasks, facts, cycles, now) {
  if (cycles.has(task.id)) return { phase: "cycle", on: [] };
  if (fact.state === "done" || fact.state === "dropped") return { phase: fact.state, on: [] };
  if (fact.state === "review") return { phase: "awaiting_review", on: [] };
  if (fact.state === "blocked") return { phase: "blocked", on: [] };
  if (fact.state === "doing") {
    const alive = fact.claim && now - fact.claim.seen <= LEASE_MS;
    return { phase: alive ? "claimed" : "stale_claim", on: [] };
  }
  const dropped = [], missing = [], open = [];
  for (const dep of task.after) {
    const state = facts.get(dep)?.state ?? "todo";
    if (!tasks.has(dep)) missing.push(dep);
    else if (state === "dropped") dropped.push(dep);
    else if (state !== "done") open.push(dep);
  }
  // A dropped dependency is not a satisfied one, as in Agenda's WorkNodes.
  if (dropped.length || missing.length) return { phase: "blocked_by_dependency", on: [...dropped, ...missing] };
  return open.length ? { phase: "waiting", on: open } : { phase: "ready", on: [] };
}

function buildRows(tasks) {
  const rows = [];
  const placed = new Set();
  const children = new Map();
  for (const task of tasks.values()) {
    const parent = task.after.find((dep) => tasks.has(dep) && dep !== task.id);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), task.id]);
  }
  const place = (id, prefix, branch) => {
    if (placed.has(id)) return;
    placed.add(id);
    rows.push({ id, prefix: prefix + branch });
    const kids = (children.get(id) ?? []).filter((kid) => !placed.has(kid));
    const inner = prefix + (branch === "├─ " ? "│  " : branch ? "   " : "");
    kids.forEach((kid, index) => place(kid, inner, index === kids.length - 1 ? "└─ " : "├─ "));
  };
  for (const task of tasks.values())
    if (!task.after.some((dep) => tasks.has(dep) && dep !== task.id)) place(task.id, "", "");
  // Only cycle members are left: every other task hangs from a root.
  for (const id of tasks.keys()) place(id, "", "");
  return rows;
}

async function loadGraph(root, start = root, now = Date.now()) {
  const read = await readTasks(root);
  if (!read) return null;
  const { tasks, problems, freehand, temporaries } = read;
  const { events, torn } = await readJournal(journalFile(root));
  const facts = foldJournal(events);
  const cycles = findCycles(tasks);
  const blank = foldJournal([{ task: "blank" }]).get("blank");
  const view = new Map();
  for (const task of tasks.values()) {
    const fact = facts.get(task.id) ?? blank;
    const { phase, on } = phaseOf(task, fact, tasks, facts, cycles, now);
    const { body, ...definition } = task;
    view.set(task.id, { ...definition, ...fact, phase, on, advice: PHASE_ADVICE[phase], unresolvedAfter: task.after.filter((dep) => !tasks.has(dep)) });
  }
  return { root, tasks, view, events, torn, problems, freehand, temporaries, facts, cycles, now,
    places: [...new Set([root, start])] };
}

const OPEN = new Set(["ready", "waiting", "claimed", "stale_claim", "awaiting_review", "blocked",
  "blocked_by_dependency", "cycle"]);

function summarize(graph) {
  const counts = {};
  for (const item of graph.view.values()) counts[item.phase] = (counts[item.phase] ?? 0) + 1;
  const list = (phase) => [...graph.view.values()].filter((item) => item.phase === phase).map((item) => item.id);
  const open = [...graph.view.values()].filter((item) => OPEN.has(item.phase));
  const moving = ["ready", "claimed", "stale_claim", "awaiting_review"].some((phase) => counts[phase]);
  return { root: graph.root, tasks: graph.view.size, counts, ready: list("ready"),
    awaitingReview: list("awaiting_review"), staleClaims: list("stale_claim"),
    deadlocked: open.length > 0 && !moving,
    advice: open.length === 0 ? "No open work." : !moving ? FINDING_ADVICE.deadlocked
      : list("ready").length ? `Run next, then claim one of ${list("ready").length} ready tasks.`
        : "Open work is held or awaiting review; see graph." };
}

/** Refuse what corrupts the graph; warn about claims nothing supports; leave
 * modelling judgement to the Skill. */
function referencedPaths(body) {
  const paths = new Set();
  for (const [, token] of body.matchAll(/`([^`\s]+)`/g)) {
    const path = token.replace(/:\d+(?:-\d+)?$/, "");
    if (/^[\w.~-]+(?:\/[\w.-]+)+$/.test(path) && !path.startsWith("~") && !path.startsWith(".agent/")) paths.add(path);
  }
  return [...paths];
}

/** Audit what a machine can: open tasks' references, size and blast radius. */
function auditOpenWork(graph, warnings) {
  const dependents = new Map();
  for (const task of graph.tasks.values())
    for (const dep of task.after) dependents.set(dep, (dependents.get(dep) ?? 0) + 1);
  for (const item of graph.view.values()) {
    if (!OPEN.has(item.phase)) continue;
    const { body } = graph.tasks.get(item.id);
    if (!/^\s*- \[[ x]\]/m.test(body)) warnings.push({ code: "no-acceptance", task: item.id });
    if (body.length > BODY_BUDGET) warnings.push({ code: "body-over-budget", task: item.id, length: body.length });
    if (!item.review && (dependents.get(item.id) ?? 0) >= FANOUT)
      warnings.push({ code: "high-fanout-without-review", task: item.id, dependents: dependents.get(item.id) });
    for (const path of referencedPaths(body))
      if (!graph.places.some((place) => existsSync(join(place, path))))
        warnings.push({ code: "missing-reference", task: item.id, path });
  }
}

export function diagnose(graph) {
  const errors = [...graph.problems];
  const warnings = [];
  if (graph.temporaries) warnings.push({ code: "leftover-temp", count: graph.temporaries });
  for (const id of graph.cycles) errors.push({ code: "cycle", task: id });
  if (graph.torn) warnings.push({ code: "torn-journal-line", count: graph.torn });
  for (const item of graph.view.values()) {
    for (const dep of item.unresolvedAfter) errors.push({ code: "unknown-dependency", task: item.id, dependency: dep });
    if (item.phase === "done") {
      if (!item.evidence) warnings.push({ code: "done-without-evidence", task: item.id });
      if (item.openAcceptance.length) warnings.push({ code: "submitted-with-open-acceptance", task: item.id, items: item.openAcceptance });
      if (item.review && item.submittedBy && item.submittedBy === item.reviewedBy)
        warnings.push({ code: "self-reviewed", task: item.id, agent: item.submittedBy });
      const openDeps = item.after.filter((dep) => {
        const phase = graph.view.get(dep)?.phase;
        return phase && phase !== "done";
      });
      if (openDeps.length) warnings.push({ code: "done-above-open-work", task: item.id, on: openDeps });
    }
    if (item.phase === "stale_claim") warnings.push({ code: "stale-claim", task: item.id, agent: item.claim?.agent ?? "" });
    if (["claimed", "stale_claim", "awaiting_review", "blocked"].includes(item.phase)
        && item.lastEvent && graph.now - item.lastEvent > QUIET_MS)
      warnings.push({ code: "quiet", task: item.id, days: Math.floor((graph.now - item.lastEvent) / DAY) });
  }
  for (const id of graph.facts.keys())
    if (!graph.tasks.has(id)) warnings.push({ code: "journal-without-task", task: id });
  if (summarize(graph).deadlocked) warnings.push({ code: "deadlocked" });
  auditOpenWork(graph, warnings);
  const advised = (finding) => ({ ...finding, fix: FINDING_ADVICE[finding.code] });
  return { ok: errors.length === 0, errors: errors.map(advised), warnings: warnings.map(advised), freehandNotes: graph.freehand };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const ensureStore = (root) => ensureAgentDirectory(root, "tasks");

const bounded = (text, name) => {
  const value = text === undefined || text === null ? "" : String(text);
  if (value.length > MAX_TEXT) fail(`${name} exceeds ${MAX_TEXT} characters; reference a file instead`);
  return value;
};

function identity(body) {
  const agent = String(body.agent || "").trim();
  if (!agent) fail("agent is required: name who is acting");
  return { agent, session: String(body.session || "").trim() };
}

function normalizeTask(input, existing) {
  const id = String(input.id ?? existing?.id ?? "");
  if (!ID.test(id)) fail(`Task id must match ${ID}: ${id}`);
  const list = (key) => {
    const value = input[key] ?? existing?.[key] ?? [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${key} must be an array of ids`);
    return [...new Set(value)];
  };
  const title = String(input.title ?? existing?.title ?? "").trim();
  if (!title || /[\r\n]/.test(title)) fail(`Task ${id} needs a one-line title`);
  const cycles = input.cycles ?? existing?.cycles;
  if (cycles !== undefined && (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 20)) fail("cycles must be 1..20");
  const review = input.review ?? existing?.review ?? "";
  if (review !== "" && review !== "required") fail('review must be "required" or absent');
  return { id, title, after: list("after"), related: list("related"), review, cycles,
    agent: String(input.agent ?? existing?.agent ?? "").trim(),
    body: bounded(input.body ?? existing?.body ?? "", "body") };
}

/** Validate a whole plan against the current tasks.  Nothing partly valid is written. */
function vetPlan(existing, inputs) {
  if (!Array.isArray(inputs) || !inputs.length) fail("tasks must be a non-empty array");
  const merged = new Map(existing);
  const incoming = new Map();
  for (const input of inputs) {
    const id = String(input?.id ?? "");
    if (incoming.has(id)) fail(`Task ${id} appears twice in the plan`);
    const task = normalizeTask(input, existing.get(id));
    incoming.set(id, task);
    merged.set(id, task);
  }
  for (const task of incoming.values())
    for (const dep of [...task.after, ...task.related])
      if (!merged.has(dep)) fail(`Task ${task.id} refers to unknown task ${dep}`, 422);
  const cycle = findCycles(merged);
  if (cycle.size) fail(`The plan has a dependency cycle: ${[...cycle].join(", ")}`, 422);
  const vague = [...incoming.values()].filter((task) => !/^\s*- \[[ x]\]/m.test(task.body)).map((task) => task.id);
  if (vague.length) fail(`Tasks need \`- [ ]\` acceptance criteria: ${vague.join(", ")}`, 422);
  const warnings = [...incoming.values()].filter((task) => task.body.length > BODY_BUDGET)
    .map((task) => ({ code: "body-over-budget", task: task.id, fix: FINDING_ADVICE["body-over-budget"] }));
  return { incoming, warnings };
}

async function record(root, graph, body, event) {
  const requestId = String(body.requestId || "").trim();
  if (requestId) {
    const earlier = graph?.events.find((item) => item.requestId === requestId);
    if (earlier) return { ...earlier, replayed: true };
  }
  const entry = { at: Date.now(), ...event, ...(requestId ? { requestId } : {}) };
  await appendEvent(journalFile(root), entry);
  return entry;
}

const taskOf = (graph, id) => graph?.view.get(String(id ?? "")) ?? fail(`Unknown task: ${id}`, 404);

function requireHolder(item, agent) {
  if (item.claim && item.claim.agent !== agent) fail(`Task ${item.id} is claimed by ${item.claim.agent}`, 409);
}

const writers = {
  /** Remove what a crash left behind.  Task files and the journal are never touched. */
  async maintain(root) {
    const cutoff = Date.now() - TEMP_AGE_MS;
    let removed = 0;
    for (const name of await readdir(tasksDirectory(root))) {
      if (!name.endsWith(".tmp")) continue;
      const file = join(tasksDirectory(root), name);
      if ((await stat(file)).mtimeMs < cutoff) { await rm(file, { force: true }); removed += 1; }
    }
    return { root, removed };
  },
  async plan(root, graph, body) {
    const { incoming, warnings } = vetPlan(graph?.tasks ?? new Map(), body.tasks);
    if (body.dryRun) return { dryRun: true, tasks: [...incoming.keys()], warnings };
    for (const task of incoming.values()) await atomicWrite(taskFile(root, task.id), serializeTask(task));
    const event = await record(root, graph, body, { kind: "plan", tasks: [...incoming.keys()],
      agent: String(body.agent || ""), session: String(body.session || "") });
    return { tasks: [...incoming.keys()], warnings, event };
  },
  async claim(root, graph, body) {
    const who = identity(body);
    const item = taskOf(graph, body.id);
    const earlier = body.requestId && graph.events.find((event) => event.requestId === body.requestId);
    if (earlier) return { ...earlier, replayed: true };
    const takeover = item.phase === "stale_claim" && body.take === true;
    if (item.phase !== "ready" && !takeover)
      fail(`Task ${item.id} is ${item.phase}${item.on.length ? ` on ${item.on.join(", ")}` : ""}`, 409);
    return record(root, graph, body, { kind: "claim", task: item.id, ...who,
      ...(takeover ? { takenFrom: item.claim?.agent ?? "" } : {}) });
  },
  async release(root, graph, body) {
    const who = identity(body);
    const item = taskOf(graph, body.id);
    requireHolder(item, who.agent);
    return record(root, graph, body, { kind: "release", task: item.id, ...who, text: bounded(body.text, "text") });
  },
  async note(root, graph, body) {
    const who = identity(body);
    const kind = String(body.kind || "note");
    if (!NOTE_KINDS.has(kind)) fail(`kind must be one of ${[...NOTE_KINDS].join(", ")}`);
    const task = body.id ? taskOf(graph, body.id).id : undefined;
    const refs = (Array.isArray(body.refs) ? body.refs.map(String) : String(body.refs ?? "").split(","))
      .map((ref) => ref.trim()).filter(Boolean);
    if (kind === "commit") {
      if (!refs.length) fail("A commit note needs refs with its sha");
      for (const ref of refs)
        if (await gitLacks(body.root, ref)) fail(`Git does not know ${ref} here; record the commit from its repository`, 422);
    }
    return record(root, graph, body, { kind, ...(task ? { task } : {}), ...who,
      text: bounded(body.text, "text"), ...(refs.length ? { refs } : {}) });
  },
  async submit(root, graph, body) {
    const who = identity(body);
    const item = taskOf(graph, body.id);
    requireHolder(item, who.agent);
    if (!["ready", "claimed", "stale_claim"].includes(item.phase))
      fail(`Task ${item.id} cannot be submitted while ${item.phase}`, 409);
    const evidence = bounded(body.evidence, "evidence").trim();
    if (!evidence) fail("evidence is required: what was run or inspected, and what it showed");
    const unchecked = [...graph.tasks.get(item.id).body.matchAll(/^\s*- \[ \]\s*(.*)$/gm)].map((match) => match[1]);
    if (unchecked.length && body.partial !== true)
      fail(`Acceptance is unchecked in ${item.id}.md; check what holds, or pass partial to submit honestly without it: ${unchecked.join("; ")}`, 409);
    return record(root, graph, body, { kind: "submit", task: item.id, ...who,
      needsReview: item.review === "required", text: evidence,
      ...(unchecked.length ? { openAcceptance: unchecked } : {}) });
  },
  async review(root, graph, body) {
    const who = identity(body);
    const item = taskOf(graph, body.id);
    if (body.verdict !== "passed" && body.verdict !== "needs_changes") fail('verdict must be "passed" or "needs_changes"');
    const earlier = body.requestId && graph.events.find((event) => event.requestId === body.requestId);
    if (earlier) return { ...earlier, replayed: true };
    if (item.phase !== "awaiting_review") fail(`Task ${item.id} is ${item.phase}, not awaiting review`, 409);
    if (item.submittedBy === who.agent && body.self !== true)
      fail(`${who.agent} submitted ${item.id}; another Agent reviews it, or pass self to record that none could`, 409);
    const limit = graph.tasks.get(item.id).cycles ?? DEFAULT_CYCLES;
    const exhausted = body.verdict === "needs_changes" && graph.facts.get(item.id).cycles + 1 >= limit;
    return record(root, graph, body, { kind: "review", task: item.id, ...who, verdict: body.verdict,
      ...(exhausted ? { exhausted: true } : {}), text: bounded(body.text, "text") });
  },
  async state(root, graph, body) {
    const who = identity(body);
    const item = taskOf(graph, body.id);
    // `done` is reached by submit and review, which carry the evidence.
    if (!["todo", "blocked", "dropped"].includes(body.state)) fail("state must be todo, blocked or dropped");
    requireHolder(item, who.agent);
    return record(root, graph, body, { kind: "state", task: item.id, ...who, state: body.state, text: bounded(body.text, "text") });
  },
};

// ---------------------------------------------------------------------------
// The one entry
// ---------------------------------------------------------------------------

const readers = {
  status: (graph) => ({ ...summarize(graph), check: diagnose(graph) }),
  check: (graph) => ({ root: graph.root, ...diagnose(graph) }),
  next(graph) {
    const items = [...graph.view.values()].filter((item) => item.phase === "ready");
    return { root: graph.root, advice: summarize(graph).advice,
      ready: items.map(({ id, title, agent, feedback, sessions }) =>
        ({ id, title, agent, feedback, lastSession: sessions.at(-1) ?? "" })) };
  },
  show(graph, body) {
    const item = taskOf(graph, body.id);
    return { ...item, body: graph.tasks.get(item.id).body,
      journal: graph.events.filter((event) => event.task === item.id) };
  },
  graph(graph) {
    return { ...summarize(graph), rows: buildRows(graph.tasks).map((row) => {
      const item = graph.view.get(row.id);
      return { ...row, title: item.title, state: item.state, phase: item.phase, on: item.on, agent: item.agent,
        holder: item.claim?.agent ?? "", cycles: item.cycles, also: item.after.slice(1), related: item.related, file: item.file };
    }) };
  },
  timeline(graph, body) {
    const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 500);
    return { root: graph.root, events: graph.events.slice(-limit).reverse() };
  },
};

/** Run one operation.  A missing store reads as `store: false`; only a write makes one. */
export async function projectGraph(body = {}) {
  const operation = String(body.op || "status");
  const root = await resolveGraphRoot(body.root);
  if (readers[operation]) {
    const graph = await loadGraph(root, body.root);
    return graph ? readers[operation](graph, body) : { root, store: false };
  }
  const writer = writers[operation];
  if (!writer) fail(`Unknown operation: ${operation}`);
  if (operation === "plan" && body.dryRun) return writer(root, await loadGraph(root, body.root), body);
  if (operation === "maintain" && !await loadGraph(root)) return { root, store: false, removed: 0 };
  await ensureStore(root);
  return withLock(tasksDirectory(root), "the task graph", async () => writer(root, await loadGraph(root, body.root), body));
}

/** The line-oriented form of a graph, for a terminal and for agents. */
export function renderGraph(result) {
  if (result.store === false) return `No task graph in ${result.root}\n`;
  const glyph = { ready: "○", waiting: "·", claimed: "◐", stale_claim: "◌", awaiting_review: "◑",
    blocked: "✕", blocked_by_dependency: "✕", cycle: "!", done: "●", dropped: "–" };
  const lines = result.rows.map((row) => {
    const notes = [row.phase, row.holder, row.on.length ? `on ${row.on.join(", ")}` : "",
      row.also.length ? `also after ${row.also.join(", ")}` : ""].filter(Boolean).join(" · ");
    return `${row.prefix}${glyph[row.phase] ?? "?"} ${row.id}  ${row.title}  [${notes}]`;
  });
  return `${lines.join("\n")}\n`;
}
