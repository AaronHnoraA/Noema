import type { Text, Transaction } from "@codemirror/state";

const plainProse = /^\p{L}[\p{L}\p{M}\p{N} .,!?'’“”–—…，。！？、；：]*$/u;

function insideIsolatedProse(doc: Text, from: number, to: number): boolean {
  const line = doc.lineAt(from);
  return to <= line.to
    && (line.number === 1 || doc.line(line.number - 1).length === 0)
    && (line.number === doc.lines || doc.line(line.number + 1).length === 0)
    && plainProse.test(line.text);
}

/** An isolated plain-text paragraph cannot open, close or name a Markdown block. */
export function isIsolatedProseEdit(transaction: Transaction): boolean {
  const before = transaction.startState.doc;
  const after = transaction.newDoc;
  if (!transaction.docChanged || before.lines !== after.lines) return false;
  let isolated = true;
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (isolated) isolated = insideIsolatedProse(before, fromA, toA) && insideIsolatedProse(after, fromB, toB);
  });
  return isolated;
}
