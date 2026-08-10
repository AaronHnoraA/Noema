const DEFAULT_DEBOUNCE_MS = 6 * 60 * 60_000;
const DEFAULT_STARTUP_MS = 2_000;
const DEFAULT_PERIODIC_MS = 6 * 60 * 60_000;
const DEFAULT_PERIODIC_JITTER_MS = 10 * 60_000;

function timerDelay(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/**
 * Repository-scoped automatic synchronization. Each repository gets its own
 * debounce timer and at most one active sync. Changes arriving during a sync
 * schedule one follow-up pass instead of overlapping Git processes. Failed
 * Git attempts wait for the next ordinary sync window. Failures from a
 * concurrent batch are collected so the host can emit one complete report.
 */
export function createWikiAutoSync(options = {}) {
  if (typeof options.sync !== "function") throw new TypeError("Wiki auto sync requires a sync function");
  const debounceMs = timerDelay(options.debounceMs, DEFAULT_DEBOUNCE_MS);
  const startupMs = timerDelay(options.startupMs, DEFAULT_STARTUP_MS);
  const periodicMs = timerDelay(options.periodicMs, DEFAULT_PERIODIC_MS);
  const periodicJitterMs = timerDelay(options.periodicJitterMs, DEFAULT_PERIODIC_JITTER_MS);
  const maxConcurrency = Math.max(1, Math.floor(Number(options.maxConcurrency) || 2));
  const known = new Set();
  const pending = new Map();
  const active = new Map();
  const waiting = new Set();
  const rerun = new Set();
  const batchFailures = new Map();
  let periodicTimer = null;
  let batchReportTimer = null;
  let accepting = true;

  function recordBatchFailure(repositoryId, error) {
    batchFailures.set(repositoryId, String(error?.message || error || "Git synchronization failed"));
  }

  function cancelBatchFailureReport() {
    if (batchReportTimer) clearTimeout(batchReportTimer);
    batchReportTimer = null;
  }

  function reportBatchFailures() {
    cancelBatchFailureReport();
    if (batchFailures.size === 0) return;
    const failures = [...batchFailures].map(([repositoryId, error]) => ({ repositoryId, error }));
    batchFailures.clear();
    options.onBatchError?.(failures);
  }

  function scheduleBatchFailureReport() {
    if (batchFailures.size === 0 || batchReportTimer) return;
    batchReportTimer = setTimeout(() => {
      batchReportTimer = null;
      if (active.size === 0 && waiting.size === 0) reportBatchFailures();
    }, 0);
    batchReportTimer.unref?.();
  }

  function scheduleNextPeriodicSync() {
    if (!accepting || periodicMs <= 0 || periodicTimer) return;
    const jitter = Math.round((Math.random() - 0.5) * 2 * periodicJitterMs);
    periodicTimer = setTimeout(() => {
      periodicTimer = null;
      // A periodic pass is authoritative: it flushes locally dirty repos and
      // also fetches remote-only work for clean repos.
      for (const repositoryId of known) schedule(repositoryId, 0, true);
      scheduleNextPeriodicSync();
    }, Math.max(0, periodicMs + jitter));
    periodicTimer.unref?.();
  }

  function clearPending(repositoryId) {
    const timer = pending.get(repositoryId);
    if (timer) clearTimeout(timer);
    pending.delete(repositoryId);
  }

  function schedule(repositoryId, delayMs, reset = true) {
    if (!accepting || !repositoryId) return;
    known.add(repositoryId);
    if (active.has(repositoryId)) {
      rerun.add(repositoryId);
      return;
    }
    if (!reset && pending.has(repositoryId)) return;
    clearPending(repositoryId);
    const timer = setTimeout(() => {
      pending.delete(repositoryId);
      void run(repositoryId);
    }, delayMs);
    timer.unref?.();
    pending.set(repositoryId, timer);
  }

  async function run(repositoryId) {
    if (!accepting || !repositoryId) return null;
    cancelBatchFailureReport();
    const current = active.get(repositoryId);
    if (current) {
      rerun.add(repositoryId);
      return current;
    }
    if (active.size >= maxConcurrency) {
      waiting.add(repositoryId);
      return null;
    }
    waiting.delete(repositoryId);
    clearPending(repositoryId);
    const task = Promise.resolve()
      .then(() => options.sync(repositoryId))
      .then((result) => {
        options.onResult?.(repositoryId, result);
        if (result?.phase === "error") recordBatchFailure(repositoryId, result.error);
        return result;
      })
      .catch((error) => {
        options.onError?.(repositoryId, error);
        recordBatchFailure(repositoryId, error);
        return null;
      });
    const tracked = task.finally(() => {
      if (active.get(repositoryId) === tracked) active.delete(repositoryId);
      if (rerun.delete(repositoryId)) schedule(repositoryId, debounceMs, true);
      if (accepting && waiting.size > 0) {
        const next = waiting.values().next().value;
        if (next) void run(next);
      }
      if (active.size === 0 && waiting.size === 0) scheduleBatchFailureReport();
    });
    active.set(repositoryId, tracked);
    return tracked;
  }

  function mark(repositoryId) {
    schedule(String(repositoryId || ""), debounceMs, true);
  }

  function cancel(repositoryId) {
    const id = String(repositoryId || "");
    clearPending(id);
    rerun.delete(id);
    waiting.delete(id);
  }

  function start(repositoryIds = []) {
    for (const repositoryId of repositoryIds) {
      const id = String(repositoryId || "");
      if (!id) continue;
      known.add(id);
      schedule(id, startupMs, false);
    }
    scheduleNextPeriodicSync();
  }

  async function syncNow(repositoryId) {
    const id = String(repositoryId || "");
    if (!id) return null;
    known.add(id);
    cancel(id);
    return await run(id);
  }

  async function close({ flush = false } = {}) {
    if (!accepting) return;
    accepting = false;
    if (periodicTimer) clearTimeout(periodicTimer);
    periodicTimer = null;
    const queued = new Set([...pending.keys(), ...waiting, ...rerun]);
    for (const repositoryId of pending.keys()) clearPending(repositoryId);
    rerun.clear();
    waiting.clear();
    await Promise.allSettled([...active.values()]);
    cancelBatchFailureReport();
    if (flush) {
      for (const repositoryId of rerun) queued.add(repositoryId);
      const flush = typeof options.flush === "function" ? options.flush : options.sync;
      await Promise.allSettled([...queued].map((repositoryId) => flush(repositoryId)
        .then((result) => {
          options.onResult?.(repositoryId, result);
          if (result?.phase === "error") recordBatchFailure(repositoryId, result.error);
        })
        .catch((error) => {
          options.onError?.(repositoryId, error);
          recordBatchFailure(repositoryId, error);
        })));
    }
    reportBatchFailures();
  }

  return {
    mark,
    cancel,
    start,
    syncNow,
    close,
    snapshot() {
      return {
        known: [...known],
        pending: [...pending.keys()],
        active: [...active.keys()],
        waiting: [...waiting],
        rerun: [...rerun],
      };
    },
  };
}
