const DEFAULT_DEBOUNCE_MS = 24 * 60 * 60_000;
const DEFAULT_STARTUP_MS = 2_000;
const DEFAULT_PERIODIC_MS = 24 * 60 * 60_000;
const DEFAULT_PERIODIC_JITTER_MS = 10 * 60_000;
const DEFAULT_BUSY_RETRY_MS = 5_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

function timerDelay(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/**
 * Repository-scoped automatic synchronization. Each repository gets its own
 * debounce timer and at most one active sync. Changes arriving during a sync
 * schedule one follow-up pass instead of overlapping Git processes. Retryable
 * results supply their own delay; semantic conflicts and actionable errors
 * pause the repository while remembering later edits. A repository held by
 * another Noema host uses a short retry and is not reported as a failure.
 * Reportable failures from a concurrent batch are collected once.
 */
export function createWikiAutoSync(options = {}) {
  if (typeof options.sync !== "function") throw new TypeError("Wiki auto sync requires a sync function");
  let debounceMs = timerDelay(options.debounceMs, DEFAULT_DEBOUNCE_MS);
  const startupMs = timerDelay(options.startupMs, DEFAULT_STARTUP_MS);
  const syncOnStart = options.syncOnStart !== false;
  let periodicMs = timerDelay(options.periodicMs, DEFAULT_PERIODIC_MS);
  const periodicJitterMs = timerDelay(options.periodicJitterMs, DEFAULT_PERIODIC_JITTER_MS);
  const busyRetryMs = timerDelay(options.busyRetryMs, DEFAULT_BUSY_RETRY_MS);
  const maxConcurrency = Math.max(1, Math.floor(Number(options.maxConcurrency) || 2));
  const maxConsecutiveFailures = Math.max(
    1,
    Math.floor(Number(options.maxConsecutiveFailures) || DEFAULT_MAX_CONSECUTIVE_FAILURES),
  );
  const known = new Set();
  const pending = new Map();
  const active = new Map();
  const waiting = new Set();
  const rerun = new Set();
  const blocked = new Set();
  const blockedDirty = new Set();
  const failures = new Map();
  const failureBlocked = new Set();
  const batchFailures = new Map();
  let periodicTimer = null;
  let batchReportTimer = null;
  let accepting = true;

  // A repository that keeps failing the same way will keep failing: a laptop
  // away from the network, a wedged worktree, a bad credential.  Retrying it on
  // every edit costs battery and produces nothing, so each repository gets a
  // small budget of consecutive identical failures and is then parked.  Later
  // edits are still remembered, the daily pass hands back a fresh budget, and an
  // explicit sync clears it at once — no new timer, no polling.
  function failureSignature(result, error) {
    if (error) return `thrown:${String(error?.message || error).slice(0, 200)}`;
    if (!result || result.phase === "conflicted") return "";
    const kind = String(result.errorKind || "");
    if (kind === "busy") return "";
    const detail = String(result.error || "").trim();
    if (!detail) return "";
    return `${kind || "error"}:${detail.slice(0, 200)}`;
  }

  function recordFailure(repositoryId, signature) {
    const previous = failures.get(repositoryId);
    const count = previous?.signature === signature ? previous.count + 1 : 1;
    failures.set(repositoryId, { count, signature });
    if (count < maxConsecutiveFailures) return false;
    blocked.add(repositoryId);
    failureBlocked.add(repositoryId);
    clearPending(repositoryId);
    waiting.delete(repositoryId);
    options.onExhausted?.(repositoryId, { attempts: count, signature });
    return true;
  }

  function clearFailureBudget(repositoryId) {
    failures.delete(repositoryId);
    failureBlocked.delete(repositoryId);
  }

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
      // also fetches remote-only work for clean repos.  It is also the one
      // moment a repository parked by the failure budget gets another chance —
      // a conflict still waits for the user.
      for (const repositoryId of failureBlocked) {
        blocked.delete(repositoryId);
        failures.delete(repositoryId);
      }
      failureBlocked.clear();
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
    if (blocked.has(repositoryId)) {
      blockedDirty.add(repositoryId);
      return;
    }
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
    let retryDelayMs = null;
    const task = Promise.resolve()
      .then(() => options.sync(repositoryId))
      .then((result) => {
        options.onResult?.(repositoryId, result);
        if (result?.phase === "conflicted" || (result?.phase === "error" && result?.retryable === false)) {
          blocked.add(repositoryId);
        } else if (result?.phase === "idle") {
          blocked.delete(repositoryId);
          blockedDirty.delete(repositoryId);
        }
        const signature = failureSignature(result, null);
        if (signature) recordFailure(repositoryId, signature);
        else clearFailureBudget(repositoryId);
        if (result?.retryable === true && !blocked.has(repositoryId)) {
          retryDelayMs = timerDelay(result.retryAfterMs, busyRetryMs);
        }
        if (result?.phase === "error" || result?.reportError === true) {
          recordBatchFailure(repositoryId, result.error);
        }
        return result;
      })
      .catch((error) => {
        options.onError?.(repositoryId, error);
        recordBatchFailure(repositoryId, error);
        recordFailure(repositoryId, failureSignature(null, error));
        return null;
      });
    const tracked = task.finally(() => {
      if (active.get(repositoryId) === tracked) active.delete(repositoryId);
      const rerunRequested = rerun.delete(repositoryId);
      if (blocked.has(repositoryId)) {
        if (rerunRequested) blockedDirty.add(repositoryId);
      } else if (retryDelayMs !== null) schedule(repositoryId, retryDelayMs, true);
      else if (rerunRequested) schedule(repositoryId, debounceMs, true);
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

  function retry(repositoryId, delayMs = busyRetryMs) {
    const id = String(repositoryId || "");
    blocked.delete(id);
    blockedDirty.delete(id);
    clearFailureBudget(id);
    schedule(id, timerDelay(delayMs, busyRetryMs), true);
  }

  function pause(repositoryId) {
    const id = String(repositoryId || "");
    if (!id) return;
    clearPending(id);
    waiting.delete(id);
    blocked.add(id);
  }

  function resume(repositoryId, { immediate = true } = {}) {
    const id = String(repositoryId || "");
    const wasDirty = blockedDirty.delete(id);
    blocked.delete(id);
    clearFailureBudget(id);
    if (immediate || wasDirty) schedule(id, immediate ? 0 : debounceMs, true);
  }

  function start(repositoryIds = []) {
    for (const repositoryId of repositoryIds) {
      const id = String(repositoryId || "");
      if (!id) continue;
      known.add(id);
      // Hosts that already have a durable daily sync schedule may register
      // repositories without immediately walking/checkpointing every working
      // tree. Real filesystem mutations still enter through mark(), explicit
      // sync still enters through syncNow(), and the periodic remote pass is
      // unchanged.
      if (syncOnStart) schedule(id, startupMs, false);
    }
    scheduleNextPeriodicSync();
  }

  async function syncNow(repositoryId) {
    const id = String(repositoryId || "");
    if (!id) return null;
    known.add(id);
    blocked.delete(id);
    blockedDirty.delete(id);
    clearFailureBudget(id);
    cancel(id);
    while (active.size >= maxConcurrency && !active.has(id)) {
      await Promise.race([...active.values()]);
    }
    return await run(id);
  }

  async function close({ flush = false } = {}) {
    if (!accepting) return;
    accepting = false;
    if (periodicTimer) clearTimeout(periodicTimer);
    periodicTimer = null;
    const queued = new Set([...pending.keys(), ...waiting, ...rerun, ...blockedDirty]);
    for (const repositoryId of pending.keys()) clearPending(repositoryId);
    rerun.clear();
    waiting.clear();
    blockedDirty.clear();
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

  // The cadence is a user setting now, so it can change while the scheduler is
  // running.  Re-arm the periodic timer against the new interval instead of
  // waiting out the old one.
  function reconfigure({ debounceMs: nextDebounce, periodicMs: nextPeriodic } = {}) {
    if (nextDebounce !== undefined) debounceMs = timerDelay(nextDebounce, debounceMs);
    if (nextPeriodic === undefined || timerDelay(nextPeriodic, periodicMs) === periodicMs) return;
    periodicMs = timerDelay(nextPeriodic, periodicMs);
    if (periodicTimer) clearTimeout(periodicTimer);
    periodicTimer = null;
    scheduleNextPeriodicSync();
  }

  return {
    mark,
    cancel,
    retry,
    pause,
    resume,
    start,
    syncNow,
    reconfigure,
    close,
    snapshot() {
      return {
        known: [...known],
        pending: [...pending.keys()],
        active: [...active.keys()],
        waiting: [...waiting],
        rerun: [...rerun],
        blocked: [...blocked],
        blockedDirty: [...blockedDirty],
        failureBlocked: [...failureBlocked],
      };
    },
  };
}
