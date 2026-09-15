const TERMINAL_RUN_STATUSES = new Set(["completed", "cancelled", "failed", "interrupted"]);

/**
 * Pump cursor-based Run snapshots into a caller-owned stream.
 *
 * WRITE receives the exact durable delta returned after the prior sequence.
 * The function has no in-memory event authority: reconnecting with AFTER
 * simply resumes from Go's append-only ledger.  It ends after publishing a
 * terminal status and never retries execution.
 */
export async function pumpResearchRunStream({
  service,
  root,
  runId,
  after = 0,
  limit = 200,
  pollMs = 150,
  detail = "full",
  write,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  closed = () => false,
} = {}) {
  if ((!service?.liveRun && !service?.run) || typeof write !== "function") {
    throw new Error("Run stream requires a Run service and writer");
  }
  let seq = Math.max(0, Number(after) || 0);
  const pageSize = Math.min(1000, Math.max(1, Number(limit) || 200));
  const baseDelay = Math.max(25, Number(pollMs) || 150);
  let delay = baseDelay;
  let previousMetadata;
  while (!closed()) {
    const snapshot = detail === "status" && service.run
      ? { ...(await service.run({ root, runId })), seq, events: [] }
      : await service.liveRun({ root, runId, after: seq, limit: pageSize });
    if (closed()) break;
    const hasMore = detail !== "status" && Array.isArray(snapshot?.events) && snapshot.events.length >= pageSize;
    const metadata = JSON.stringify({ ...snapshot, events: undefined });
    const changed = metadata !== previousMetadata || Boolean(snapshot?.events?.length);
    if (changed) await write(hasMore ? { ...snapshot, hasMore: true } : snapshot);
    previousMetadata = metadata;
    const next = Number(snapshot?.seq);
    if (Number.isFinite(next) && next >= seq) seq = next;
    // A terminal Run may still have several pages of durable events to drain.
    if (TERMINAL_RUN_STATUSES.has(String(snapshot?.run?.status || "")) && !hasMore) {
      if (!changed) await write(snapshot);
      break;
    }
    if (hasMore) continue;
    delay = changed ? baseDelay : Math.min(Math.max(baseDelay, 1000), delay * 2);
    await wait(delay);
  }
  return seq;
}
