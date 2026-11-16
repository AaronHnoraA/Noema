// An exploration: several agents work one mathematical problem at once, each
// on a direction no other holds, and the session that started them judges
// what they submit.  Contract: docs/noema/design/math-exploration.md (E1-E14).
//
// Adapted from Open Math Harness's Ultramath (Apache-2.0; interfaces/swarm,
// program-files/chat-agent/src/swarm): the board's rules, the duplicate check,
// one wake per report, and two rejections per direction.  Here the thinking
// lives in Markdown: `explorations/<id>/` in the Project holds `problem.md`,
// one notebook per member (`m1.md` …) that only its member writes, and
// `summary.md` when it ends.  `journal.jsonl` beside them holds only what
// happened (register, post, submit, verdict, …); state is folded on read, like
// the task graph.  Members are ordinary background agent-shell sessions,
// started and reached through `noema:api:emacs:agent`.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appendEvent, readJournal, withLock } from "./agent-journal.mjs";
import { frozenObjection, lakeRootOf, theoremName } from "./lean-judge.mjs";
import { resolveGraphRoot } from "./project-graph.mjs";

export const LIMITS = Object.freeze({
  members: 8, defaultMembers: 4, minMinutes: 10, maxMinutes: 24 * 60, defaultMinutes: 120,
  title: 120, problem: 8_000, standard: 1_000, direction: 600, finding: 800, report: 1_500,
  reason: 2_000, directions: 40, findings: 32, files: 10,
  // A member whose run ends with time left is woken again, at most this often (E15).
  nudges: 3, nudgeMinutes: 3,
});
const KINDS = new Set(["lemma", "partial", "counterexample", "dead-end", "note"]);
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MEMBER = /^m[1-9]$/;
const MINUTE = 60_000;
const TICK = 2 * MINUTE;
const SOURCE = resolve(import.meta.dirname, "../..");
export const CLI = `node ${join(SOURCE, "scripts/exploration.mjs")}`;
export const JUDGE_CLI = `node ${join(SOURCE, "scripts/lean-judge.mjs")}`;

export const ADVICE = {
  free: "Read the board, then register a direction before anything else.",
  holding: "Work your direction in your notebook; post what others can use; submit or abandon.",
  waiting: "Your report waits for the judge; end your turn.",
  time: "Time is up: submit what you have now, or abandon with the reason.",
  waitingReports: "Reports wait for a verdict: read them, then decide with verdict.",
  interrupted: "Its members are gone (Emacs restarted?); resume starts them again from their notebooks.",
};

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const bytes = (text) => Buffer.byteLength(text);
export const directoryOf = (root, id) => join(root, "explorations", id);
const journalOf = (dir) => join(dir, "journal.jsonl");
const notebookOf = (dir, member) => join(dir, `${member}.md`);
const isoMinute = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

function text(value, name, limit, { optional = false } = {}) {
  const string = String(value ?? "").trim();
  if (!string) return optional ? null : fail(`${name} is required`);
  if (bytes(string) > limit) fail(`${name} is ${bytes(string)} bytes; at most ${limit}. Shorten it and try again; nothing is cut.`);
  return string;
}

/** Fill TEMPLATE's `{name}` places from VARS; a missing value is an error, as
 * in a strict template, never an empty string. */
export function render(template, vars) {
  return template.replace(/\{([a-z_]+)\}/g, (_whole, name) => {
    if (!(name in vars)) throw new Error(`Template value missing: ${name}`);
    return String(vars[name]);
  });
}
const prompt = (name) => readFileSync(join(SOURCE, "resources/agent/exploration", `${name}.md`), "utf8");

// ---------------------------------------------------------------------------
// The board: fold the journal
// ---------------------------------------------------------------------------

/** Fold EVENTS into the exploration they describe.  Pure, so every reader,
 * the supervisor and the page agree. */
export function fold(events, now = Date.now()) {
  let x = null;
  const member = (name) => x?.members.get(name);
  const direction = (id) => x?.directions.find((item) => item.id === id);
  for (const event of events) {
    if (event.kind === "start") {
      x = { ...event, kind: undefined, state: "running", outcome: null, directions: [], refused: 0,
        members: new Map(event.members.map((name) => [name, { name, direction: null, requestId: null, buffer: null, done: false, idle: false, lost: false, nudges: 0, askedToRegister: false }])) };
      continue;
    }
    if (!x) continue;
    const m = member(event.member);
    // Anything a member does shows it is alive.
    if (m && ["register", "abandon", "post", "submit"].includes(event.kind)) Object.assign(m, { idle: false, lost: false });
    const d = direction(event.direction ?? m?.direction);
    switch (event.kind) {
      case "task": Object.assign(m, { requestId: event.requestId, buffer: event.buffer ?? m.buffer, idle: false, lost: false }); break;
      case "nudge":
        Object.assign(m, { requestId: event.requestId, buffer: event.buffer ?? m.buffer, idle: false, lost: false, nudges: m.nudges + 1 });
        if (event.reason === "register") m.askedToRegister = true;
        break;
      case "register":
        m.askedToRegister = false;
        x.directions.push({ id: event.direction, member: event.member, text: event.text, state: "open", rejections: 0, findings: [], reports: [], at: event.at });
        m.direction = event.direction;
        break;
      case "refuse": x.refused += 1; break;
      case "abandon": Object.assign(d, { state: "abandoned", reason: event.reason }); m.direction = null; break;
      case "post": d.findings.push({ kind: event.type, text: event.text, at: event.at }); break;
      case "judged": (d.judged ??= []).push({ at: event.at, verdict: event.verdict }); break;
      case "submit":
        d.state = "waiting";
        d.reports.push({ report: event.report, files: event.files, proof: event.proof ?? null, lean: event.lean ?? null, at: event.at, verdict: null });
        break;
      case "verdict": {
        d.reports.at(-1).verdict = { accept: event.accept, reason: event.reason, by: event.by, at: event.at };
        if (event.accept) { d.state = "succeeded"; m.done = true; m.direction = null; }
        else if ((d.rejections += 1) >= 2) { d.state = "dead"; m.direction = null; }
        else d.state = "open";
        break;
      }
      case "idle": m.idle = true; break;
      case "lost": m.lost = true; break;
      case "interrupt": x.state = "interrupted"; break;
      case "resume": Object.assign(x, { state: "running", deadline: event.deadline }); break;
      case "end": Object.assign(x, { state: "ended", outcome: event.outcome, endedAt: event.at }); break;
      default: break;
    }
  }
  if (!x) return null;
  for (const m of x.members.values()) {
    const held = direction(m.direction);
    m.state = m.done ? "done" : held?.state === "waiting" ? "waiting" : held ? "holding" : "free";
    if (held?.state === "open" && (m.idle || m.lost)) held.stalled = true;
  }
  x.waiting = x.directions.filter((d) => d.state === "waiting").map((d) => d.id);
  x.solved = x.directions.some((d) => d.state === "succeeded");
  x.overdue = x.state === "running" && now >= x.deadline;
  return x;
}

async function load(dir, now) {
  const { events, torn } = await readJournal(journalOf(dir));
  const x = fold(events, now);
  if (!x) fail(`No exploration in ${dir}`, 404);
  return Object.assign(x, { torn, dir });
}

/** The board in Markdown, as members and the person read it. */
export function boardMarkdown(x, now = Date.now()) {
  const left = x.state === "running" ? ` · ${Math.max(0, Math.round((x.deadline - now) / MINUTE))} min left` : "";
  const lines = [`# ${x.title} · ${x.state}${x.outcome ? ` (${x.outcome})` : ""}${left}`, ""];
  if (!x.directions.length) lines.push("No direction is registered yet.");
  for (const d of x.directions) {
    const status = d.stalled ? `${d.state}, stalled` : d.state;
    lines.push(`## ${d.id} · ${d.member} · ${status}${d.rejections ? ` · ${d.rejections} rejection(s)` : ""}`, "", d.text, "");
    if (d.reason) lines.push(`Abandoned: ${d.reason}`, "");
    for (const f of d.findings) lines.push(`- [${f.kind}] ${f.text.replace(/\n/g, " ")}`);
    for (const r of d.reports) {
      const verdict = r.verdict ? `${r.verdict.accept ? "accepted" : "rejected"} by ${r.verdict.by}${r.verdict.reason ? `: ${r.verdict.reason}` : ""}` : "waiting for the judge";
      lines.push(`- **Report** (${verdict})${r.lean?.accepted ? " · Lean accepted" : ""}`);
    }
    if (d.findings.length || d.reports.length) lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function publicView(x, now) {
  return {
    id: x.id, title: x.title, state: x.state, outcome: x.outcome, dir: x.dir, deadline: x.deadline,
    minutesLeft: x.state === "running" ? Math.max(0, Math.round((x.deadline - now) / MINUTE)) : null,
    judge: x.lean ? { lean: x.lean } : null, coordinator: x.coordinator, waiting: x.waiting,
    members: [...x.members.values()].map(({ name, state, direction, idle, lost, buffer }) => ({ name, state, direction, idle, lost, buffer, notebook: notebookOf(x.dir, name) })),
    directions: x.directions.map(({ id, member, text: what, state, stalled, rejections, findings, reports }) => ({
      id, member, text: what, state, stalled: Boolean(stalled), rejections, findings: findings.length,
      reports: reports.map(({ report, files, proof, lean, verdict }) => ({ report, files, proof, lean, verdict })) })),
    ...(x.torn ? { torn: x.torn } : {}),
    advice: x.state === "interrupted" ? ADVICE.interrupted : x.waiting.length ? ADVICE.waitingReports : null,
  };
}

// ---------------------------------------------------------------------------
// Markdown files: problem, notebooks, summary
// ---------------------------------------------------------------------------

// Dates in ids and meta are the person's local ones, as Noema writes note ids.
const two = (value) => String(value).padStart(2, "0");
const localDate = (ms, separator = "-") => { const d = new Date(ms); return [d.getFullYear(), two(d.getMonth() + 1), two(d.getDate())].join(separator); };
const stamp = (ms) => { const d = new Date(ms); return `${localDate(ms, "")}T${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`; };
const meta = (title, at, id) => `#+begin meta\ntitle: ${title}\ndate: ${localDate(at)}\ntags: exploration\nid: ${id}\nkind: default\n#+end meta\n\n`;

function problemMarkdown(x) {
  const source = x.note ? `See [${x.note.split("/").at(-1)}](${relative(x.dir, x.note)}).\n\n` : "";
  const members = x.members.map((name) => `- [${name}](${name}.md)`).join("\n");
  const judge = x.lean ? `Lean decides whether a proof proves \`${x.theorem}\` in [${x.lean.split("/").at(-1)}](${relative(x.dir, x.lean)}); the judge decides the rest.` : "No mechanical judge: the judge reads each report.";
  return `${meta(x.title, x.at, `${stamp(x.at)}-exploration-${x.id}`)}# ${x.title}\n\nExploration \`${x.id}\`: ${x.members.length} members until ${isoMinute(x.deadline)}. ${judge}\n\n## Problem\n\n${source}${x.problem ?? ""}\n\n## Standard\n\n${x.standard}\n\n## Members\n\n${members}\n`;
}

const notebookMarkdown = (x, name) => `${meta(`${x.title} · ${name}`, x.at, `${stamp(x.at)}-exploration-${x.id}-${name}`)}## Direction\n\nNot registered yet.\n\n## State\n\n## Work\n\n## Report\n`;

/** Write DIRECTION into the notebook's `## Direction` section only. */
function writeDirection(file, direction, what) {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "## Direction\n\n";
  const body = `## Direction\n\n${direction}: ${what}\n\n`;
  const next = /^## Direction\n[\s\S]*?(?=^## |(?![\s\S]))/m.test(current)
    ? current.replace(/^## Direction\n[\s\S]*?(?=^## |(?![\s\S]))/m, body)
    : `${current.trimEnd()}\n\n${body}`;
  writeFileSync(file, next);
}

function summaryMarkdown(x) {
  const order = { succeeded: 0, waiting: 1, open: 2, dead: 3, abandoned: 4 };
  const directions = [...x.directions].sort((a, b) => order[a.state] - order[b.state]);
  const body = directions.map((d) => {
    const reports = d.reports.map((r) => `- Report${r.lean?.accepted ? " (Lean accepted)" : ""}: ${r.verdict ? `${r.verdict.accept ? "accepted" : "rejected"} by ${r.verdict.by}${r.verdict.reason ? ` — ${r.verdict.reason}` : ""}` : "never decided"}\n\n  ${r.report.replace(/\n/g, "\n  ")}`).join("\n");
    const findings = d.findings.map((f) => `- [${f.kind}] ${f.text.replace(/\n/g, " ")}`).join("\n");
    return `## ${d.id} · ${d.state} · [${d.member}](${d.member}.md)\n\n${d.text}\n${d.reason ? `\nAbandoned: ${d.reason}\n` : ""}${findings ? `\n${findings}\n` : ""}${reports ? `\n${reports}\n` : ""}`;
  }).join("\n");
  return `${meta(`${x.title} · summary`, x.endedAt ?? Date.now(), `${stamp(x.at)}-exploration-${x.id}-summary`)}# ${x.title} · summary\n\nOutcome: **${x.outcome}**. Problem: [problem.md](problem.md). ${x.directions.length} directions, ${x.directions.filter((d) => d.state === "succeeded").length} succeeded. Written when the exploration ended; the notebooks hold the work.\n\n${body || "No direction was registered.\n"}`;
}

// ---------------------------------------------------------------------------
// Talking to Emacs sessions
// ---------------------------------------------------------------------------

async function agentCall(deps, body) {
  const answer = await deps.call("noema:api:emacs:agent", [body]);
  if (answer?.ok === false) throw new Error(answer.message || "not accepted");
  return answer;
}

/** The live native session of member M, or null when it is gone. */
async function memberSession(deps, m) {
  if (!m.requestId) return null;
  try {
    const result = await agentCall(deps, { action: "result", requestId: m.requestId, limit: 1 });
    return result?.buffer && result?.nativeSessionId ? { buffer: result.buffer, nativeSessionId: result.nativeSessionId, terminal: result.terminal === true } : null;
  } catch { return null; }
}

function memberPrompt(x, name, resumed) {
  const lean = x.lean;
  const vars = {
    member: name, title: x.title, judge_who: x.coordinator ? `The session that started the exploration (${x.coordinator.buffer})` : "The person",
    problem_file: join(x.dir, "problem.md"), standard: x.standard, deadline: isoMinute(x.deadline), dir: x.dir,
    file: notebookOf(x.dir, name), scratch: join(x.dir, name), cli: CLI, root: x.root, id: x.id,
    lean_rule: lean ? `A proof counts only when Lean accepts it against the frozen statement ${lean} (theorem \`${x.theorem}\`): keep its preamble and statement byte for byte. \`${JUDGE_CLI} check --statement ${lean} --candidate <file>\` grades a partial proof (errors, remaining sorries); \`verify\` decides a solve.` : "",
    submit_rule: lean ? "Pass your Lean file with --proof: the Lean judge verifies it first, and a proof Lean does not accept is refused with Lean's reason while you keep working." : "There is no mechanical judge: the judge reads your report and files.",
  };
  const body = render(prompt("member"), vars);
  if (!resumed) return body;
  const held = resumed.direction ? `You hold direction ${resumed.direction.id}: ${resumed.direction.text}` : "You hold no direction: read the board and register one.";
  return render(prompt("resume"), { title: x.title, deadline: isoMinute(x.deadline), member: name, file: notebookOf(x.dir, name), held }) + body;
}

async function spawnMembers(x, names, deps, resumed) {
  const started = [];
  const failures = [];
  for (const name of names) {
    try {
      const answer = await agentCall(deps, {
        action: "spawn", root: x.root, agent: x.agent, name: `explore-${x.id}-${name}`,
        ...(x.modelId ? { modelId: x.modelId } : {}), ...(x.effort ? { effort: x.effort } : {}),
        prompt: memberPrompt(x, name, resumed?.get(name)),
      });
      started.push({ kind: "task", at: deps.now(), member: name, requestId: answer.requestId, buffer: answer.session?.buffer ?? null });
    } catch (error) {
      failures.push({ member: name, message: error.message });
      started.push({ kind: "lost", at: deps.now(), member: name, why: error.message });
    }
  }
  return { started, failures };
}

async function wakeCoordinator(x, deps, message) {
  if (!x.coordinator) return;
  await agentCall(deps, { action: "send", ...x.coordinator, prompt: message });
}

async function stopMembers(x, deps) {
  for (const m of x.members.values()) {
    if (m.done || m.lost) continue;
    const session = await memberSession(deps, m);
    if (session && !session.terminal) await agentCall(deps, { action: "stop", buffer: session.buffer, nativeSessionId: session.nativeSessionId }).catch(() => {});
  }
}

/** End X: the fact first, then the summary and one wake (E12). */
async function end(dir, x, outcome, deps, { wake = true } = {}) {
  await appendEvent(journalOf(dir), { kind: "end", at: deps.now(), outcome });
  const ended = await load(dir, deps.now());
  writeFileSync(join(dir, "summary.md"), summaryMarkdown(ended));
  supervisor.disarm(dir);
  if (wake) await wakeCoordinator(ended, deps, `[From exploration ${x.id}, not the person] It ended ${outcome}. The summary is ${join(dir, "summary.md")}; the notebooks hold the work. Tell the person what it found and what remains open.`).catch(() => {});
  return ended;
}

// ---------------------------------------------------------------------------
// Supervision: deadline and liveness, one timer per running exploration
// ---------------------------------------------------------------------------

export const supervisor = {
  timers: new Map(),
  arm(dir, delay, run) {
    clearTimeout(this.timers.get(dir));
    const timer = setTimeout(() => { this.timers.delete(dir); run().catch(() => {}); }, Math.max(1_000, delay));
    timer.unref?.();
    this.timers.set(dir, timer);
  },
  disarm(dir) { clearTimeout(this.timers.get(dir)); this.timers.delete(dir); },
};

/** A member whose run ended with time left is woken once more (E15): one that
 * holds an open direction continues it, one that holds none is asked once to
 * read the board and register another.  Otherwise, or when the wake is not
 * accepted, it is idle.  Persistence is the loop's, not the prompt's. */
async function nudgeOrIdle(x, m, session, deps) {
  const now = deps.now();
  const minutes = Math.floor((x.deadline - now) / MINUTE);
  const held = x.directions.find((d) => d.id === m.direction && d.state === "open");
  const canRegister = !held && !m.askedToRegister && x.directions.length < LIMITS.directions;
  const idle = { kind: "idle", at: now, member: m.name };
  if (minutes < LIMITS.nudgeMinutes || m.nudges >= LIMITS.nudges || (!held && !canRegister)) return idle;
  const head = `[From exploration ${x.id}, not the person] Your run ended with ${minutes} minutes left.`;
  const message = held
    ? `${head} You still hold direction ${held.id}. Read your notebook's State and continue at the unresolved step: submit when it is solved, post what others can use, and abandon only when the direction is refuted or exhausted, saying why.`
    : `${head} You hold no direction. Read the board: if an approach nobody has tried is worth the remaining time, register it and work it; otherwise end your turn.`;
  try {
    const answer = await agentCall(deps, { action: "send", buffer: session.buffer, nativeSessionId: session.nativeSessionId, prompt: message });
    return { kind: "nudge", at: now, member: m.name, reason: held ? "continue" : "register", requestId: answer.requestId, buffer: session.buffer };
  } catch { return idle; }
}

/** Look at X's members and clock once: mark ended runs idle, vanished ones
 * lost; end it at its deadline or when nothing can still happen; an
 * exploration whose every live member vanished is interrupted (E10, E11). */
export async function tick(dir, deps) {
  let x = await load(dir, deps.now());
  if (x.state !== "running") { supervisor.disarm(dir); return x; }
  const facts = [];
  for (const m of x.members.values()) {
    if (m.done || m.idle || m.lost || m.state === "waiting") continue;
    const session = await memberSession(deps, m);
    if (!session) facts.push({ kind: "lost", at: deps.now(), member: m.name });
    else if (session.terminal) facts.push(await nudgeOrIdle(x, m, session, deps));
  }
  for (const fact of facts) await appendEvent(journalOf(dir), fact);
  x = await load(dir, deps.now());
  if (x.overdue) {
    await stopMembers(x, deps);
    return end(dir, x, x.solved ? "solved" : "expired", deps);
  }
  const live = [...x.members.values()].filter((m) => !m.done && !m.idle && !m.lost);
  if (!live.length && !x.waiting.length) {
    const vanished = [...x.members.values()].filter((m) => !m.done);
    if (vanished.length && vanished.every((m) => m.lost)) {
      await appendEvent(journalOf(dir), { kind: "interrupt", at: deps.now() });
      await wakeCoordinator(x, deps, `[From exploration ${x.id}, not the person] Its members are gone, so it is interrupted. Tell the person; \`resume\` continues it from the notebooks.`).catch(() => {});
      supervisor.disarm(dir);
      return load(dir, deps.now());
    }
    return end(dir, x, x.solved ? "solved" : "exhausted", deps);
  }
  supervisor.arm(dir, Math.min(TICK, x.deadline - deps.now()), () => tick(dir, deps));
  return x;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function identified(deps, who, name) {
  if (!who?.buffer || !who?.nativeSessionId) fail(`${name} must be {buffer, nativeSessionId} of a live session`);
  const answer = await agentCall(deps, { action: "status", buffer: who.buffer, nativeSessionId: who.nativeSessionId });
  return { coordinator: { buffer: who.buffer, nativeSessionId: who.nativeSessionId }, agent: answer?.session?.agent };
}

function freshId(root, title, now) {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "problem";
  const base = `${localDate(now, "")}-${slug}`;
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!existsSync(directoryOf(root, id))) return id;
  }
}

function absoluteFile(path, name, { extension } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) fail(`${name} must be an absolute path`);
  if (!existsSync(path)) fail(`No such file: ${path}`, 404);
  if (extension && !extension.test(path)) fail(`${name} must be a ${extension.source} file`);
  return realpathSync(path);
}

async function start(body, deps) {
  const root = await resolveGraphRoot(body.root);
  const { coordinator, agent: coordinatorAgent } = await identified(deps, body.coordinator, "coordinator");
  const title = text(body.title, "title", LIMITS.title);
  const note = body.note === undefined ? null : absoluteFile(body.note, "note", { extension: /\.(md|markdown)$/ });
  const problem = text(body.problem, "problem", LIMITS.problem, { optional: true });
  if (!note && !problem) fail("Give the problem: note (a Markdown file) or problem (text)");
  const standard = text(body.standard ?? "A complete, checked solution of the problem as stated.", "standard", LIMITS.standard);
  let lean = null;
  let theorem = null;
  if (body.lean !== undefined) {
    lean = absoluteFile(body.lean, "lean", { extension: /\.lean$/ });
    const objection = frozenObjection(readFileSync(lean, "utf8"));
    if (objection) fail(`The Lean statement cannot judge proofs: ${objection}`);
    if (!lakeRootOf(dirname(lean))) fail("The Lean statement is not inside a Lake project");
    theorem = theoremName(readFileSync(lean, "utf8"));
  }
  const members = body.members ?? LIMITS.defaultMembers;
  if (!Number.isSafeInteger(members) || members < 1 || members > LIMITS.members) fail(`members is 1..${LIMITS.members}`);
  const minutes = body.minutes ?? LIMITS.defaultMinutes;
  if (!Number.isSafeInteger(minutes) || minutes < LIMITS.minMinutes || minutes > LIMITS.maxMinutes) fail(`minutes is ${LIMITS.minMinutes}..${LIMITS.maxMinutes}`);
  const agent = body.agent ?? coordinatorAgent;
  if (!agent) fail("agent is required: the coordinator reported none");
  const now = deps.now();
  const id = body.id === undefined ? freshId(root, title, now) : String(body.id);
  if (!ID.test(id)) fail(`Bad exploration id: ${id}`);
  const dir = directoryOf(root, id);
  if (existsSync(dir)) fail(`Exploration ${id} exists already`, 409);
  const names = Array.from({ length: members }, (_, n) => `m${n + 1}`);
  const event = { kind: "start", at: now, id, root, title, note, problem, standard, lean, theorem, members: names, agent,
    ...(body.modelId ? { modelId: String(body.modelId) } : {}), ...(body.effort ? { effort: String(body.effort) } : {}),
    minutes, deadline: now + minutes * MINUTE, coordinator, dedup: body.dedup !== false };
  mkdirSync(dir, { recursive: true });
  const x = { ...event, dir };
  writeFileSync(join(dir, "problem.md"), problemMarkdown(x));
  for (const name of names) { writeFileSync(notebookOf(dir, name), notebookMarkdown(x, name)); mkdirSync(join(dir, name), { recursive: true }); }
  await appendEvent(journalOf(dir), event);
  const { started, failures } = await spawnMembers(x, names, deps);
  for (const fact of started) await appendEvent(journalOf(dir), fact);
  supervisor.arm(dir, TICK, () => tick(dir, deps));
  const coordinatorText = render(prompt("coordinator"), { title, id, members, deadline: isoMinute(event.deadline), cli: CLI, root,
    lean_note: lean ? "A report on this problem carries a proof Lean already accepted against the frozen statement: whether that proof holds is settled; judge whether it answers the problem and its standard." : "" });
  return { id, dir, problem: join(dir, "problem.md"), deadline: event.deadline, members: names, failures, instructions: coordinatorText };
}

async function duplicateCheck(x, proposal, deps) {
  const directions = x.directions.map((d) => ({ id: d.id, state: d.state, text: d.text }));
  if (!directions.length || !x.dedup) return null;
  let answer;
  try { answer = await deps.duplicate({ proposal, directions }); }
  catch (error) { fail(`The duplicate check could not run (${error.message}); register again in a minute. A direction is never admitted uncompared.`, 503); }
  const taken = answer?.duplicateOf ? directions.find((d) => d.id === answer.duplicateOf) : null;
  if (answer?.duplicateOf && !taken) fail("The duplicate check answered with a direction that does not exist; register again.", 503);
  return taken ? { ...taken, reason: String(answer.reason ?? "").slice(0, 600) } : null;
}

async function register(dir, body, deps) {
  const proposal = text(body.text, "text", LIMITS.direction);
  let x = await load(dir, deps.now());
  const m = memberOf(x, body.member);
  if (x.state !== "running") fail(`The exploration is ${x.state}`, 409);
  if (x.overdue) fail(ADVICE.time, 409);
  if (m.done) fail("Your direction succeeded; you are done", 409);
  if (m.direction) fail(`You hold ${m.direction}; abandon it with the reason before registering another`, 409);
  if (x.directions.length >= LIMITS.directions) fail(`The board holds ${LIMITS.directions} directions, its most`, 409);
  // Compare outside the lock, then again with whatever was registered meanwhile.
  let compared = 0;
  for (let round = 0; round < 3; round += 1) {
    const unseen = { ...x, directions: x.directions.slice(compared) };
    const taken = await duplicateCheck(unseen, proposal, deps);
    if (taken) {
      await appendEvent(journalOf(dir), { kind: "refuse", at: deps.now(), member: m.name, text: proposal, duplicateOf: taken.id, reason: taken.reason });
      return { registered: false, duplicateOf: taken.id, duplicate: taken.text, reason: taken.reason, advice: "Choose a genuinely different approach: rewording is not different." };
    }
    compared = x.directions.length;
    const done = await withLock(dir, "the exploration", async () => {
      const now = await load(dir, deps.now());
      if (now.directions.length !== compared) { x = now; return null; }
      const id = `d${now.directions.length + 1}`;
      await appendEvent(journalOf(dir), { kind: "register", at: deps.now(), member: m.name, direction: id, text: proposal });
      writeDirection(notebookOf(dir, m.name), id, proposal);
      return id;
    });
    if (done) return { registered: true, direction: done, notebook: notebookOf(dir, m.name), advice: ADVICE.holding };
  }
  return fail("The board kept changing while your direction was compared; register again", 409);
}

function memberOf(x, name) {
  if (!MEMBER.test(String(name ?? ""))) fail("member is required (m1, m2, …)");
  return x.members.get(name) ?? fail(`No member ${name} in ${x.id}`, 404);
}

function heldDirection(x, m, { waitingAllowed = false } = {}) {
  const d = x.directions.find((item) => item.id === m.direction);
  if (!d) fail(`You hold no direction. ${ADVICE.free}`, 409);
  if (d.state === "waiting" && !waitingAllowed) fail(ADVICE.waiting, 409);
  return d;
}

function filesInside(dir, list, name) {
  const items = Array.isArray(list) ? list : String(list ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length > LIMITS.files) fail(`At most ${LIMITS.files} ${name}`);
  const real = realpathSync(dir);
  // A relative path names a file of the exploration, or of the Project around it.
  const root = resolve(dir, "../..");
  return items.map((item) => {
    const path = isAbsolute(item) ? item : [join(dir, item), join(root, item)].find(existsSync);
    if (!path || !existsSync(path)) fail(`No such file: ${item}`, 404);
    const rest = relative(real, realpathSync(path));
    if (!rest || rest.startsWith("..") || isAbsolute(rest)) fail(`${item} is outside the exploration's directory`, 403);
    return realpathSync(path);
  });
}

async function submit(dir, body, deps) {
  const report = text(body.report, "report", LIMITS.report);
  const x = await load(dir, deps.now());
  const m = memberOf(x, body.member);
  if (x.state !== "running") fail(`The exploration is ${x.state}`, 409);
  const d = heldDirection(x, m);
  const files = filesInside(dir, body.files, "files");
  let proof = null;
  let lean = null;
  if (x.lean) {
    if (!body.proof) fail("This exploration's judge is Lean: pass your proof file with proof");
    [proof] = filesInside(dir, [body.proof], "proof");
    const verdict = await deps.judge({ op: "verify", statement: x.lean, candidate: proof });
    if (verdict.accepted !== true) {
      await appendEvent(journalOf(dir), { kind: "judged", at: deps.now(), member: m.name, direction: d.id, verdict });
      return { submitted: false, lean: verdict, advice: verdict.status === "no_verdict" ? "Lean gave no verdict (it timed out or could not start); submit again." : "Lean did not accept the proof; its reason is above. Keep working." };
    }
    lean = { accepted: true, axioms: verdict.axioms };
  }
  const leanLine = lean ? `Lean accepted ${proof} against ${x.lean} (axioms: ${lean.axioms.join(", ") || "none"}).` : "No mechanical judge checked it.";
  // The judge is told before the submission is taken: a submission nobody can be told of is refused (E8).
  try {
    await wakeCoordinator(x, deps, `[From exploration ${x.id}, member ${m.name}, not the person] A report on direction ${d.id} waits for your verdict. ${leanLine}\n\nReport:\n${report}\n\nFiles: ${[...files, ...(proof ? [proof] : [])].join(", ") || "none"}; notebook: ${notebookOf(dir, m.name)}\nDecide: ${CLI} verdict --root ${x.root} --id ${x.id} --member ${m.name} --accept|--reject --reason "..."`);
  } catch (error) { fail(`The judge cannot be told now (${error.message}); submit again later.`, 503); }
  await appendEvent(journalOf(dir), { kind: "submit", at: deps.now(), member: m.name, direction: d.id, report, files, proof, lean });
  return { submitted: true, direction: d.id, advice: ADVICE.waiting };
}

async function verdict(dir, body, deps) {
  const x = await load(dir, deps.now());
  const m = memberOf(x, body.member);
  const d = x.directions.find((item) => item.id === m.direction && item.state === "waiting");
  if (!d) fail(`No report of ${m.name} waits for a verdict`, 409);
  const accept = body.accept === true;
  if (!accept && body.accept !== false) fail("accept must be true or false");
  const reason = text(body.reason, "reason", LIMITS.reason, { optional: accept });
  const by = body.by === "person" ? "person" : "coordinator";
  await appendEvent(journalOf(dir), { kind: "verdict", at: deps.now(), member: m.name, direction: d.id, accept, reason, by });
  let after = await load(dir, deps.now());
  if (!accept) {
    const ended = after.directions.find((item) => item.id === d.id).state === "dead";
    const message = `[From exploration ${x.id}: the ${by === "person" ? "person" : "judge"}'s verdict] Your report on direction ${d.id} was rejected. Reason: ${reason}\n\n${ended
      ? `That was its second rejection, so the direction has ended. Register a genuinely different one if time remains (until ${isoMinute(x.deadline)}), or end your turn.`
      : "Revise in the same direction, update your notebook, and submit again; a second rejection ends the direction."}`;
    const session = await memberSession(deps, m);
    try {
      if (!session) throw new Error("the member's session is gone");
      const answer = await agentCall(deps, { action: "send", buffer: session.buffer, nativeSessionId: session.nativeSessionId, prompt: message });
      await appendEvent(journalOf(dir), { kind: "task", at: deps.now(), member: m.name, requestId: answer.requestId, buffer: session.buffer });
    } catch { await appendEvent(journalOf(dir), { kind: "lost", at: deps.now(), member: m.name }); }
  }
  after = await load(dir, deps.now());
  if (accept && body.finish === true) {
    await stopMembers(after, deps);
    after = await end(dir, after, "solved", deps, { wake: false });
  } else after = await tick(dir, deps);
  return { recorded: true, direction: d.id, state: after.directions.find((item) => item.id === d.id).state, exploration: after.state, outcome: after.outcome };
}

async function abandon(dir, body, deps) {
  const reason = text(body.reason, "reason", LIMITS.direction);
  const x = await load(dir, deps.now());
  const m = memberOf(x, body.member);
  const d = heldDirection(x, m);
  await appendEvent(journalOf(dir), { kind: "abandon", at: deps.now(), member: m.name, direction: d.id, reason });
  return { abandoned: d.id, advice: x.overdue ? "Time is up; end your turn." : "Register a different direction, or end your turn." };
}

async function post(dir, body, deps) {
  const type = String(body.kind ?? "");
  if (!KINDS.has(type)) fail(`kind is one of ${[...KINDS].join(", ")}`);
  const what = text(body.text, "text", LIMITS.finding);
  const x = await load(dir, deps.now());
  const m = memberOf(x, body.member);
  if (x.state !== "running") fail(`The exploration is ${x.state}`, 409);
  const d = heldDirection(x, m, { waitingAllowed: true });
  if (d.findings.length >= LIMITS.findings) fail(`Direction ${d.id} holds ${LIMITS.findings} findings, its most; put more in your notebook`, 409);
  await appendEvent(journalOf(dir), { kind: "post", at: deps.now(), member: m.name, direction: d.id, type, text: what });
  return { posted: true, direction: d.id };
}

async function stop(dir, body, deps) {
  const x = await load(dir, deps.now());
  if (x.state === "ended") fail("The exploration has ended already", 409);
  await stopMembers(x, deps);
  const ended = await end(dir, x, x.solved ? "solved" : "stopped", deps, { wake: body.by === "person" });
  return { stopped: true, outcome: ended.outcome, summary: join(dir, "summary.md") };
}

async function resume(dir, body, deps) {
  const x = await load(dir, deps.now());
  if (x.state !== "interrupted") fail(`Only an interrupted exploration resumes; this one is ${x.state}`, 409);
  const now = deps.now();
  let deadline = x.deadline;
  if (body.minutes !== undefined) {
    if (!Number.isSafeInteger(body.minutes) || body.minutes < LIMITS.minMinutes || body.minutes > LIMITS.maxMinutes) fail(`minutes is ${LIMITS.minMinutes}..${LIMITS.maxMinutes}`);
    deadline = now + body.minutes * MINUTE;
  } else if (deadline - now < 2 * MINUTE) fail("Its deadline has passed or is under two minutes away: give minutes", 409);
  await appendEvent(journalOf(dir), { kind: "resume", at: now, deadline });
  const resumed = await load(dir, now);
  const names = [...resumed.members.values()].filter((m) => !m.done).map((m) => m.name);
  const held = new Map(names.map((name) => [name, { direction: resumed.directions.find((d) => d.id === resumed.members.get(name).direction) }]));
  const { started, failures } = await spawnMembers(resumed, names, deps, held);
  for (const fact of started) await appendEvent(journalOf(dir), fact);
  supervisor.arm(dir, TICK, () => tick(dir, deps));
  return { resumed: true, deadline, members: names, failures };
}

/** Every exploration of the Project at ROOT, newest first. */
async function list(root, deps) {
  const base = join(root, "explorations");
  if (!existsSync(base)) return [];
  const rows = [];
  for (const id of readdirSync(base)) {
    const dir = directoryOf(root, id);
    if (!existsSync(journalOf(dir))) continue;
    const x = await load(dir, deps.now()).catch(() => null);
    if (!x) continue;
    if (x.state === "running" && !supervisor.timers.has(dir)) supervisor.arm(dir, 1_000, () => tick(dir, deps));
    rows.push({ id, title: x.title, state: x.state, outcome: x.outcome, deadline: x.deadline, waiting: x.waiting.length,
      members: x.members.size, directions: x.directions.length, at: x.at, dir });
  }
  return rows.sort((a, b) => b.at - a.at);
}

/** What `status`, `board` and `list` answer, read from the journal alone: no
 * Emacs query, no clock, no host.  The command line serves its reads with it,
 * so a sandboxed member reads the board without loopback access (E16). */
export async function explorationView(body = {}, now = Date.now()) {
  const op = String(body.op || "status");
  const root = await resolveGraphRoot(body.root);
  if (op === "list") {
    const base = join(root, "explorations");
    const rows = [];
    for (const id of existsSync(base) ? readdirSync(base) : []) {
      if (!existsSync(journalOf(directoryOf(root, id)))) continue;
      const x = await load(directoryOf(root, id), now).catch(() => null);
      if (x) rows.push({ id, title: x.title, state: x.state, outcome: x.outcome, deadline: x.deadline, waiting: x.waiting.length,
        members: x.members.size, directions: x.directions.length, at: x.at, dir: x.dir });
    }
    return { root, explorations: rows.sort((a, b) => b.at - a.at) };
  }
  if (op !== "status" && op !== "board") fail(`Not a read: ${op}`);
  if (!ID.test(String(body.id ?? ""))) fail("id is required");
  const dir = directoryOf(root, body.id);
  if (!existsSync(journalOf(dir))) fail(`No exploration ${body.id} in ${root}`, 404);
  return viewOf(await load(dir, now), body, op, now);
}

function viewOf(x, body, op, now) {
  const view = publicView(x, now);
  if (body.member) {
    const m = memberOf(x, body.member);
    view.you = { name: m.name, state: m.state, direction: m.direction, notebook: notebookOf(x.dir, m.name),
      minutesLeft: view.minutesLeft, advice: x.overdue ? ADVICE.time : ADVICE[m.state] ?? null };
  }
  return op === "board" ? { ...view, markdown: boardMarkdown(x, now) } : view;
}

/** A Project's explorations in a few fields for `agent:project:status`, or
 * null when it has none.  Reads only; arms no clock. */
export async function explorationSummary(root) {
  const base = join(root, "explorations");
  if (!existsSync(base)) return null;
  const counts = { total: 0, running: 0, interrupted: 0, waitingReports: 0 };
  for (const id of readdirSync(base)) {
    const file = journalOf(directoryOf(root, id));
    if (!existsSync(file)) continue;
    const x = fold((await readJournal(file)).events);
    if (!x) continue;
    counts.total += 1;
    if (x.state === "running") counts.running += 1;
    if (x.state === "interrupted") counts.interrupted += 1;
    counts.waitingReports += x.waiting.length;
  }
  return counts.total ? counts : null;
}

/** The API and CLI entry.  Every operation names the Project (`root`) and,
 * except `start` and `list`, the exploration (`id`); a member's calls name it
 * (`member`). */
export async function exploration(body = {}, deps) {
  const op = String(body.op || "status");
  const now = deps.now ?? (() => Date.now());
  deps = { ...deps, now };
  if (op === "start") return start(body, deps);
  const root = await resolveGraphRoot(body.root);
  if (op === "list") return { root, explorations: await list(root, deps) };
  if (!ID.test(String(body.id ?? ""))) fail("id is required");
  const dir = directoryOf(root, body.id);
  if (!existsSync(journalOf(dir))) fail(`No exploration ${body.id} in ${root}`, 404);
  const ops = { register, submit, verdict, abandon, post, stop, resume };
  if (ops[op]) return ops[op](dir, body, deps);
  if (op !== "status" && op !== "board") fail(`Unknown operation: ${op}`);
  let x = await load(dir, now());
  if (x.state === "running") x = await tick(dir, deps);
  return viewOf(x, body, op, now());
}

/** The duplicate check as one bounded model call (E5). */
export function modelDuplicateCheck(callOneTool) {
  return async ({ proposal, directions }) => {
    const frame = (label, value) => value.split("\n").map((line) => `${label}| ${line}`).join("\n");
    const user = `Registered directions:\n${directions.map((d) => frame(`${d.id} (${d.state})`, d.text)).join("\n")}\n\nProposal:\n${frame("proposal", proposal)}`;
    const answer = await callOneTool({ system: prompt("duplicate"), user, tool: {
      name: "duplicate_verdict", description: "Name the registered direction the proposal duplicates, or null.",
      parameters: { type: "object", properties: { duplicate_of: { type: ["string", "null"] }, reason: { type: "string" } }, required: ["duplicate_of", "reason"] } } });
    if (!("duplicate_of" in answer)) throw new Error("the check gave no verdict");
    return { duplicateOf: answer.duplicate_of || null, reason: answer.reason };
  };
}
