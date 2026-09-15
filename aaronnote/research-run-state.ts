/** Metadata refreshes are not authority to clear a live Run binding. */
export function mergeRunRef<T extends { runId?: string; sessionId?: string; sessionName?: string; agent?: string }>(current: T, incoming: Partial<T>): T {
  const merged = { ...current, ...incoming };
  if (!incoming.runId || incoming.runId === current.runId) {
    for (const key of ["runId", "sessionId", "sessionName", "agent"] as const) {
      if (!incoming[key]) merged[key] = current[key];
    }
  }
  return merged;
}

export function runSnapshotMatches(runId: string | undefined, snapshot: Record<string, unknown>): boolean {
  const run = snapshot.run as { id?: string } | undefined;
  return Boolean(runId && run?.id === runId);
}

export function appendRunEvents(previous: Array<Record<string, unknown>>, incoming: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set(previous.map((event) => Number(event.seq)));
  const added = incoming.filter((event) => {
    const seq = Number(event.seq);
    if (!Number.isFinite(seq) || seen.has(seq)) return false;
    seen.add(seq);
    return true;
  });
  return added.length ? [...previous, ...added] : previous;
}
