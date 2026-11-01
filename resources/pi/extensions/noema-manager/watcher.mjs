// Pi's plugin side of its watches: the only thing that acts on them, living and
// dying with a project Pi.  The facts and their rules are server/lib/pi-watch.mjs.
// Contract: docs/design/pi-watches.md.
import { spawn } from "node:child_process";
import { existsSync, rmSync, watch as watchDirectory, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, ensureAgentDirectory, readJournal } from "../../../../server/lib/agent-journal.mjs";
import { DAILY_MESSAGES, armedOf, directoryOf, journalOf, load, ownerOf, scriptPath, tasksOf, watcherRunning } from "../../../../server/lib/pi-watch.mjs";
import { projectGraph } from "../../../../server/lib/project-graph.mjs";

const MINUTE = 60_000;
const SCRIPT_TIMEOUT = 10 * MINUTE;
const LONGEST_SLEEP = 360 * MINUTE;
const TAIL = 2_000;
const SCRIPT_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "SHELL"];

/** Run a script with no shell and a clean environment; it ends within SCRIPT_TIMEOUT. */
async function runScript(root, watch, setTimer, clearTimer) {
  const { path, cwd } = await scriptPath(root, watch.do.script);
  const env = Object.fromEntries(SCRIPT_ENV.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const child = spawn(path, watch.do.args, { cwd, stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, NOEMA_PROJECT_ROOT: root, NOEMA_WATCH_ID: watch.id } });
  return new Promise((done) => {
    let tail = "";
    const take = (chunk) => { tail = (tail + chunk).slice(-TAIL); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const limit = setTimer(() => child.kill("SIGKILL"), SCRIPT_TIMEOUT);
    child.on("error", (error) => { clearTimer(limit); done({ ok: false, tail: error.message }); });
    child.on("close", (exit) => { clearTimer(limit); done({ ok: exit === 0, exit, tail: tail.trim() }); });
  });
}

/** Acts for ROOT while a project Pi runs: one timer, one directory watch, and one
 * more on the task graph only with hooks.  DELIVER.pi and DELIVER.agent send a
 * prompt, and throw or answer `{ok: false}` when it was not accepted. */
export function createPiWatcher({ root, deliver, log = () => {}, clock = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, watchImpl = watchDirectory }) {
  const acting = new Set();
  const followers = new Map();
  let timer = null;
  let settle = null;
  let queue = Promise.resolve();
  let stopped = true;

  async function send(to, prompt) {
    const accepted = (answer) => { if (answer?.ok === false) throw new Error(answer.message || "not accepted"); };
    if (to.buffer) {
      try { return accepted(await deliver.agent({ action: "send", ...to, prompt })); }
      catch { prompt = `The Agent session ${to.buffer} that should hear this is gone.\n${prompt}`; }
    }
    accepted(await deliver.pi({ action: "send", ...(to === "companion" ? { companion: true } : { root }), prompt }));
  }

  async function act(watch, n, reason) {
    const head = `[Watch ${watch.id} fired: ${reason}. Set by ${watch.agent}, not the person: ${watch.why}]`;
    let result;
    try {
      if (watch.do.script) {
        result = await runScript(root, watch, setTimer, clearTimer);
        if (watch.do.report) await send(watch.do.report, `${head}\nScript ${watch.do.script} ${result.ok ? "succeeded" : "failed"}.\n${result.tail}`);
      } else {
        await send(watch.do.to, `${head}\n${watch.do.prompt}`);
        result = { ok: true };
      }
    } catch (error) { result = { ...result, ok: false, tail: error.message }; }
    await appendEvent(journalOf(root), { kind: "result", at: clock(), id: watch.id, n, ...result });
    acting.delete(`${watch.id}/${n}`);
  }

  /** The fact goes in before the action: a crash afterwards is `unknown`, never a replay. */
  async function fire(watch, folded, reason, seen) {
    const message = Boolean(watch.do.prompt || watch.do.report);
    if (message && folded.messages >= DAILY_MESSAGES) return;
    if (message) folded.messages += 1;
    const n = watch.fires + 1;
    await appendEvent(journalOf(root), { kind: "fire", at: clock(), id: watch.id, n, reason, message, ...(seen === undefined ? {} : { seen }) });
    acting.add(`${watch.id}/${n}`);
    act(watch, n, reason).catch((error) => log(`watch ${watch.id}: ${error.message}`));
  }

  /** The first graph fact past WATCH's cursor that its hook matches. */
  function match(watch, events, phases) {
    const { on, seen } = watch;
    if (on.phase) return phases.get(on.task) === on.phase ? { reason: `${on.task} is ${on.phase}` } : null;
    const fields = Object.entries(on);
    const index = events.findIndex((event, at) => at >= seen && fields.every(([key, value]) => event[key] === value));
    return index < 0 ? null : { reason: `${events[index].kind}${events[index].task ? ` of ${events[index].task}` : ""}`, seen: index + 1 };
  }

  function follow(path) {
    if (followers.has(path)) return;
    const handle = watchImpl(path, () => {
      clearTimer(settle);
      settle = setTimer(scan, 250);
    });
    handle.on?.("error", () => followers.delete(path));
    followers.set(path, handle);
  }

  function unfollow(path) {
    followers.get(path)?.close();
    followers.delete(path);
  }

  async function scanNow() {
    if (stopped) return;
    clearTimer(timer);
    timer = null;
    const folded = await load(root, clock());
    const armed = armedOf(folded);
    for (const watch of armed.filter((item) => !item.on && item.nextAt <= clock())) await fire(watch, folded, "its time came");
    const hooks = armed.filter((watch) => watch.on);
    if (hooks.length) {
      const { events } = await readJournal(join(tasksOf(root), "journal.jsonl"));
      const rows = hooks.some((watch) => watch.on.phase) ? (await projectGraph({ root, op: "graph" })).rows ?? [] : [];
      const phases = new Map(rows.map((row) => [row.id, row.phase]));
      for (const watch of hooks) {
        const found = match(watch, events, phases);
        if (found) await fire(watch, folded, found.reason, found.seen);
      }
    }
    const graphPath = existsSync(tasksOf(root)) ? tasksOf(root) : join(root, ".agent");
    for (const path of followers.keys()) if (path !== directoryOf(root) && (!hooks.length || path !== graphPath)) unfollow(path);
    if (hooks.length) follow(graphPath);
    const next = armedOf(await load(root, clock())).flatMap((watch) => [watch.nextAt, watch.until]).filter(Boolean);
    // A time already past is a watch held by the budget: look again later, do not spin.
    const wait = next.length ? Math.min(...next) - clock() : null;
    if (wait !== null) timer = setTimer(scan, Math.min(wait > 0 ? wait : 5 * MINUTE, LONGEST_SLEEP));
  }

  /** Scans run in turn, so a firing is decided once. */
  function scan() {
    queue = queue.then(scanNow).catch((error) => log(`watch: ${error.message}`));
    return queue;
  }

  return {
    scan,
    drain: () => queue,
    idle: () => !timer && followers.size <= 1 && !acting.size,
    /** Begin watching, unless another live Pi already does. */
    async start() {
      await ensureAgentDirectory(root, "pi");
      if (watcherRunning(root)) return false;
      writeFileSync(ownerOf(root), JSON.stringify({ pid: process.pid }));
      stopped = false;
      // Whatever has no result now lost its Pi: nothing here is running it.
      for (const { id, n } of (await load(root, clock())).running)
        await appendEvent(journalOf(root), { kind: "result", at: clock(), id, n, ok: false, unknown: true });
      follow(directoryOf(root));
      await scan();
      return true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(timer);
      clearTimer(settle);
      for (const path of [...followers.keys()]) unfollow(path);
      rmSync(ownerOf(root), { force: true });
    },
  };
}
