/** Word-level differences between two texts, for Google Docs-style suggestions (C72). */

export interface WordChange { kind: "same" | "del" | "ins"; text: string }

const MAX_CELLS = 250_000;

function tokens(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

export interface SequenceChange { kind: WordChange["kind"]; values: string[] }

export function sequenceDiff(a: readonly string[], b: readonly string[]): SequenceChange[] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail, m = b.length - head - tail;
  if (n * m > MAX_CELLS) return null;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    lcs[i][j] = a[head + i] === b[head + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: SequenceChange[] = head ? [{ kind: "same", values: a.slice(0, head) }] : [];
  const push = (kind: WordChange["kind"], value: string) => {
    const last = out.at(-1);
    if (last?.kind === kind) last.values.push(value);
    else out.push({ kind, values: [value] });
  };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) { push("same", a[head + i]); i++; j++; }
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { push("ins", b[head + j]); j++; }
    else { push("del", a[head + i]); i++; }
  }
  if (tail) {
    const last = out.at(-1);
    const values = a.slice(a.length - tail);
    if (last?.kind === "same") last.values = last.values.concat(values);
    else out.push({ kind: "same", values });
  }
  return out;
}

/** Return the changes turning OLD into NEW, word by word; null when too large to diff. */
export function wordDiff(oldText: string, newText: string): WordChange[] | null {
  return sequenceDiff(tokens(oldText), tokens(newText))?.map(({ kind, values }) => ({ kind, text: values.join("") })) ?? null;
}

/** Whether TEXT holds math or other markup a source-level word diff would show raw. */
export function needsRenderedComparison(text: string): boolean {
  return /\\[([]|\$|```|#\+begin|<[a-z]/i.test(text);
}
