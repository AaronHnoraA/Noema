import { ChangeSet, type ChangeSpec } from "@codemirror/state";

/**
 * Merge another writer's save (an agent edit, Emacs) into a page that still
 * has unsaved typing, so the person never has to stop for it.
 *
 * BASE is the text the page last saved or loaded, LOCAL the page's unsaved
 * changes from BASE, REMOTE the text now on disk. REMOTE's changes from BASE
 * are found line by line and rebased over LOCAL, the way @codemirror/collab
 * rebases a peer's update over unconfirmed local ones. A remote change that
 * touches a range the person also changed is a real conflict: nothing is
 * merged and the caller keeps its review path.
 */

/** Most changed lines a merge will diff; beyond it the caller keeps its review path. */
const MAX_DIFF_EDITS = 4000;

type LineHunk = { fromLine: number; toLine: number; insertLines: string[] };

function splitLines(text: string): string[] {
  // Keep each line's own break, so offsets add back up to the text.
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Myers' O(ND) diff over lines, after trimming the common prefix and suffix. */
function lineHunks(base: string[], next: string[], maxEdits: number): LineHunk[] | null {
  let start = 0;
  while (start < base.length && start < next.length && base[start] === next[start]) start++;
  let endBase = base.length;
  let endNext = next.length;
  while (endBase > start && endNext > start && base[endBase - 1] === next[endNext - 1]) {
    endBase--;
    endNext--;
  }
  const a = base.slice(start, endBase);
  const b = next.slice(start, endNext);
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ fromLine: start, toLine: endBase, insertLines: b }];

  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
        ? v[offset + k + 1]!
        : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;

  // Walk the trace back into a list of kept line pairs.
  const kept: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = prev[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; kept.push([x, y]); }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { x--; y--; kept.push([x, y]); }
  kept.reverse();

  const hunks: LineHunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ka, kb] of [...kept, [n, m] as [number, number]]) {
    if (ka > ai || kb > bi) {
      hunks.push({ fromLine: start + ai, toLine: start + ka, insertLines: b.slice(bi, kb) });
    }
    ai = ka + 1;
    bi = kb + 1;
  }
  return hunks;
}

/** REMOTE's changes from BASE as a ChangeSet over BASE, or null when too large to diff. */
export function textChangeSet(base: string, remote: string, maxEdits = MAX_DIFF_EDITS): ChangeSet | null {
  const baseLines = splitLines(base);
  const hunks = lineHunks(baseLines, splitLines(remote), maxEdits);
  if (!hunks) return null;
  const lineStart: number[] = [0];
  for (const line of baseLines) lineStart.push(lineStart[lineStart.length - 1]! + line.length);
  const specs: ChangeSpec[] = hunks.map((hunk) => ({
    from: lineStart[hunk.fromLine]!,
    to: lineStart[hunk.toLine]!,
    insert: hunk.insertLines.join(""),
  }));
  return ChangeSet.of(specs, base.length);
}

function touchedRanges(changes: ChangeSet): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  changes.iterChangedRanges((fromA, toA) => { ranges.push([fromA, toA]); });
  return ranges;
}

/**
 * Whether REMOTE and LOCAL, both over BASE, change the same text. Two
 * insertions at one point count as touching, since their order is a guess.
 * A change ending where the other starts does not: the agent rewrote one
 * paragraph while the person typed at the start of the next.
 */
export function changesConflict(remote: ChangeSet, local: ChangeSet): boolean {
  const a = touchedRanges(remote);
  const b = touchedRanges(local);
  for (const [af, at] of a) {
    for (const [bf, bt] of b) {
      if (af < bt && bf < at) return true;
      if (af === at && bf === bt && af === bf) return true;
      if (af === at && bf < af && af < bt) return true;
      if (bf === bt && af < bf && bf < at) return true;
    }
  }
  return false;
}

export type ExternalMerge =
  | { ok: true; remote: ChangeSet; local: ChangeSet }
  | { ok: false; reason: "conflict" | "too-large" | "mismatch" };

/**
 * Rebase REMOTE over LOCAL. The result's `remote` applies to the page's
 * current text; its `local` is the person's unsaved changes, now over REMOTE.
 */
export function mergeExternalText(base: string, remote: string, local: ChangeSet): ExternalMerge {
  if (local.length !== base.length) return { ok: false, reason: "mismatch" };
  const remoteChanges = textChangeSet(base, remote);
  if (!remoteChanges) return { ok: false, reason: "too-large" };
  if (changesConflict(remoteChanges, local)) return { ok: false, reason: "conflict" };
  return { ok: true, remote: remoteChanges.map(local, true), local: local.map(remoteChanges) };
}
