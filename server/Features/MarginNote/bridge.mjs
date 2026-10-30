import { randomBytes, randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export async function ensureMarginNoteToken(stateRoot) {
  const file = join(stateRoot, "marginnote-token");
  try {
    const token = (await readFile(file, "utf8")).trim();
    if (!/^[\w-]{43}$/.test(token)) throw fail("Invalid MarginNote token");
    await chmod(file, 0o600);
    return token;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    const token = randomBytes(32).toString("base64url");
    await writeFile(file, token + "\n", { mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return ensureMarginNoteToken(stateRoot);
  }
}

/** An ephemeral RPC mailbox. Native objects and business state stay in MarginNote. */
export function createMarginNoteBridge({ pollMs = 20_000, staleMs = 60_000 } = {}) {
  const sessions = new Map();
  const requests = new Map();
  let closed = false;

  function finish(job, result) {
    clearTimeout(job.timer);
    job.result = { requestId: job.id, sessionId: job.session.id, ...result };
    job.resolve(job.result);
  }
  function disconnect(id) {
    const session = sessions.get(id);
    if (!session) return;
    session.waiter?.(null);
    for (const job of requests.values()) {
      if (job.session !== session || job.result) continue;
      finish(job, { ok: false, state: "disconnected", execution: job.claimed ? "unknown" : "not_started" });
    }
    sessions.delete(id);
  }
  function prune() {
    const now = Date.now();
    for (const session of sessions.values()) {
      const expectedAliveUntil = Math.max(session.lastSeen, session.running?.deadline || 0);
      if (now - expectedAliveUntil > staleMs) disconnect(session.id);
    }
    for (const [id, job] of requests) if (job.result && now - job.created > 15 * 60_000) requests.delete(id);
    if (requests.size >= 256) {
      for (const [id, job] of requests) {
        if (job.result && job.session.running !== job) requests.delete(id);
        if (requests.size < 128) break;
      }
    }
  }
  function next(session) {
    // An HTTP response may be lost after the mailbox handed it out. The native
    // runtime caches IDs and polls only after execution finishes; replaying the
    // same envelope recovers delivery without repeating an executed operation.
    if (session.running) {
      const job = session.running;
      return job.result ? null : { id: job.id, code: job.code, args: job.args, deadline: job.deadline };
    }
    const job = session.queue.find((item) => !item.result);
    session.queue = session.queue.filter((item) => !item.result && item !== job);
    if (!job) return null;
    job.claimed = true;
    session.running = job;
    return { id: job.id, code: job.code, args: job.args, deadline: job.deadline };
  }
  function list() {
    prune();
    return { ok: true, sessions: [...sessions.values()].map((session) => ({
      id: session.id, info: session.info, lastSeen: session.lastSeen,
      running: session.running?.id || null, queued: session.queue.filter((job) => !job.result).length,
    })) };
  }
  function submit({ code, args = {}, sessionId, timeoutMs = 30_000, requestId = randomUUID() } = {}) {
    if (closed) throw fail("MarginNote bridge is shutting down", 503);
    if (typeof code !== "string" || !code.trim() || Buffer.byteLength(code) > 256 * 1024) throw fail("Expected JavaScript function body (maximum 256 KiB)");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw fail("timeoutMs must be between 100 and 120000");
    if (typeof requestId !== "string" || !/^[\w-]{1,100}$/.test(requestId)) throw fail("Invalid requestId");
    prune();
    const prior = requests.get(requestId);
    if (prior) {
      if (prior.code !== code || JSON.stringify(prior.args) !== JSON.stringify(args) || (sessionId && prior.session.id !== sessionId)) throw fail("requestId already names different code or arguments", 409);
      return prior.promise;
    }
    const session = sessionId ? sessions.get(sessionId) : sessions.size === 1 ? sessions.values().next().value : null;
    if (!session) throw fail(sessions.size > 1 ? "Choose sessionId: multiple MarginNote windows are connected" : "No MarginNote window connected; enable Noema Agent in MarginNote", 409);
    if (session.queue.filter((job) => !job.result).length >= 16 || requests.size >= 256) throw fail("MarginNote queue is full", 429);
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const job = { id: requestId, session, code, args, created: Date.now(), claimed: false, promise, resolve };
    job.deadline = job.created + timeoutMs;
    job.timer = setTimeout(() => {
      finish(job, { ok: false, state: "timed_out", execution: job.claimed ? "unknown" : "not_started" });
      session.queue = session.queue.filter((item) => item !== job);
    }, timeoutMs);
    requests.set(job.id, job);
    session.queue.push(job);
    if (session.waiter) session.waiter(next(session));
    return promise;
  }
  async function poll({ sessionId, info = {}, completed } = {}, signal) {
    if (closed) throw fail("MarginNote bridge is shutting down", 503);
    if (typeof sessionId !== "string" || !/^[\w-]{1,100}$/.test(sessionId)) throw fail("Invalid sessionId");
    prune();
    let session = sessions.get(sessionId);
    if (!session) {
      if (sessions.size >= 16) throw fail("Too many MarginNote sessions", 429);
      session = { id: sessionId, info, queue: [], lastSeen: Date.now(), running: null, waiter: null };
      sessions.set(sessionId, session);
    }
    session.lastSeen = Date.now();
    session.info = info;
    if (completed) {
      const job = requests.get(completed.id);
      if (job && (job.session.id !== session.id || !job.claimed)) throw fail("Result does not belong to this window", 409);
      if (job) {
        const result = { ok: completed.ok === true, state: "completed", value: completed.value ?? null, error: completed.error, logs: completed.logs || [] };
        if (job.result) {
          if (job.result.execution === "unknown") job.result.lateResult = result;
        } else finish(job, result);
        if (session.running === job) session.running = null;
      }
    }
    if (session.waiter) throw fail("A poll for this window is already pending", 409);
    const available = next(session);
    if (available) return { ok: true, task: available };
    if (signal?.aborted) return { ok: true, task: null };
    return new Promise((resolve) => {
      const done = (task) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        session.waiter = null;
        resolve({ ok: true, task });
      };
      const abort = () => done(null);
      const timer = setTimeout(() => done(null), pollMs);
      session.waiter = done;
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  function request(id) {
    const job = requests.get(id);
    if (!job) throw fail("Unknown requestId", 404);
    return job.result || { ok: true, requestId: id, state: job.claimed ? "running" : "queued" };
  }
  return { list, submit, poll, request, disconnect,
    heartbeat({ sessionId, info }) {
      const session = sessions.get(sessionId);
      if (session) { session.lastSeen = Date.now(); session.info = info || session.info; }
      return { ok: Boolean(session) };
    },
    close() { closed = true; for (const id of [...sessions.keys()]) disconnect(id); },
  };
}
