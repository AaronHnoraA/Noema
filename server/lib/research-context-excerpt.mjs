// Which parts of an automatic context item survive when it must be cut to a
// byte budget. Pure and deterministic: a frozen RunSpec depends on it.

import { segment } from "./headroom-segment.mjs";
import { memoryTerms } from "./research-memory.mjs";

// Below this a passage cannot fit beside a useful beginning and end.
const EXCERPT_MIN_BYTES = 4096;
// A passage is kept for carrying at least this share of what the request
// asks, counted in rare terms. Measured on Noema's own long documents, a
// lower share admits passages that only repeat the document's common words.
const PASSAGE_MIN_SHARE = 0.25;

/**
 * Byte ranges [start, end) of BYTES to keep within PAYLOAD-BYTES: the
 * beginning, the end, and the passages in between that match TERMS best.
 * Each gap between two kept ranges is charged GAP-BYTES for its marker; the
 * caller has already paid for one. Returns null when no passage in between
 * answers the request, and the caller keeps the plain beginning and end.
 */
export function excerptRanges(bytes, payloadBytes, terms, gapBytes) {
  if (terms.length < 2 || payloadBytes < EXCERPT_MIN_BYTES) return null;
  const text = bytes.toString("utf8");
  // Offsets below are byte offsets of the decoded text.
  if (Buffer.byteLength(text) !== bytes.byteLength) return null;
  const segments = segment(text);
  if (segments.length < 4) return null;
  const wanted = new Set(terms);
  const passages = [];
  let offset = 0;
  for (const part of segments) {
    const start = offset;
    offset += Buffer.byteLength(part);
    passages.push({ start, end: offset, found: memoryTerms(part).filter((term) => wanted.has(term)) });
  }
  // A term most passages carry says little about which one the request means;
  // a term the document never uses still counts as asked for.
  const carriers = new Map();
  for (const { found } of passages) for (const term of found) carriers.set(term, (carriers.get(term) || 0) + 1);
  const weight = (term) => Math.log((passages.length + 1) / (carriers.get(term) || 1));
  const asked = terms.reduce((sum, term) => sum + weight(term), 0);
  const quarter = Math.floor(payloadBytes / 4);
  const ranked = passages
    .filter((passage) => passage.start >= quarter && passage.end <= bytes.byteLength - quarter)
    .map((passage) => ({ ...passage, score: passage.found.reduce((sum, term) => sum + weight(term), 0) }))
    .filter((passage) => passage.score >= PASSAGE_MIN_SHARE * asked)
    .sort((left, right) => right.score - left.score || left.start - right.start);
  let room = payloadBytes - 2 * quarter;
  const kept = [];
  for (const passage of ranked) {
    const cost = passage.end - passage.start + gapBytes;
    if (cost > room) continue;
    room -= cost;
    kept.push([passage.start, passage.end]);
  }
  if (!kept.length) return null;
  // What the passages left goes back to the beginning and the end. Growing
  // them can swallow a passage, which frees its bytes and its marker again.
  let headEnd = quarter;
  let tailStart = bytes.byteLength - quarter;
  let ranges = [];
  for (let pass = 0; ; pass++) {
    while (headEnd > 0 && (bytes[headEnd] & 0xc0) === 0x80) headEnd--;
    while (tailStart < bytes.byteLength && (bytes[tailStart] & 0xc0) === 0x80) tailStart++;
    ranges = [];
    for (const range of [[0, headEnd], ...kept, [tailStart, bytes.byteLength]].sort((a, b) => a[0] - b[0])) {
      const last = ranges.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else ranges.push([...range]);
    }
    const used = ranges.reduce((sum, [start, end]) => sum + end - start, 0) + gapBytes * (ranges.length - 2);
    const spare = Math.floor((payloadBytes - used) / 2);
    if (spare < 64 || pass === 3) break;
    headEnd += spare;
    tailStart -= spare;
  }
  // Only a beginning and an end left: the plain cut says the same in fewer words.
  return ranges.length > 2 ? ranges : null;
}
