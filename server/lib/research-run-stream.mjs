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
  write,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  closed = () => false,
} = {}) {
  if (!service?.liveRun || typeof write !== "function") throw new Error("Run stream requires a live service and writer");
  let seq = Math.max(0, Number(after) || 0);
  const pageSize = Math.min(1000, Math.max(1, Number(limit) || 200));
  while (!closed()) {
    const snapshot = await service.liveRun({ root, runId, after: seq, limit: pageSize });
    if (closed()) break;
    await write(snapshot);
    const next = Number(snapshot?.seq);
    if (Number.isFinite(next) && next >= seq) seq = next;
    if (TERMINAL_RUN_STATUSES.has(String(snapshot?.run?.status || ""))) break;
    if (Array.isArray(snapshot?.events) && snapshot.events.length >= pageSize) continue;
    await wait(Math.max(25, Number(pollMs) || 150));
  }
  return seq;
}
