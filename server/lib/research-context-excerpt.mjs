// What survives of an automatic context item that must be cut to a byte
// budget, and what the cut tells the agent about the rest. Pure and
// deterministic: a frozen RunSpec depends on it.

import { segment, shingles } from "./headroom-segment.mjs";
import { memoryTerms, termSequence } from "./research-memory.mjs";

// Below this a passage cannot fit beside a useful beginning and end, and a
// marker has no room to describe what it replaces.
const EXCERPT_MIN_BYTES = 4096;
// A passage is kept for carrying at least this share of what the request
// asks, counted in rare terms. Measured on Noema's own long documents, a
// lower share admits passages that only repeat the document's common words.
const PASSAGE_MIN_SHARE = 0.25;
// A passage most of whose word windows are already kept says nothing new.
const PASSAGE_REPEAT_SHARE = 0.85;
// Room a marker may spend naming the sections it skips and the one it resumes in.
const MARKER_OUTLINE_BYTES = 160;
const TITLE_MAX_BYTES = 60;

const utf8Back = (bytes, at) => {
  while (at > 0 && at < bytes.byteLength && (bytes[at] & 0xc0) === 0x80) at--;
  return at;
};
const utf8Forward = (bytes, at) => {
  while (at < bytes.byteLength && (bytes[at] & 0xc0) === 0x80) at++;
  return at;
};

// A heading as a marker names it: a Chinese title costs three bytes a character.
function shortTitle(title) {
  const bytes = Buffer.from(title);
  if (bytes.byteLength <= TITLE_MAX_BYTES) return title;
  return `${bytes.subarray(0, utf8Back(bytes, TITLE_MAX_BYTES - 3)).toString("utf8")}…`;
}

// Headings and fenced code blocks of Markdown TEXT, by byte offset.
function outlineOf(text) {
  const headings = [];
  const fences = [];
  let offset = 0;
  let open = null;
  for (const line of text.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      if (fence && fence[1][0] === open.mark[0] && fence[1].length >= open.mark.length && !fence[2].trim()) {
        fences.push([open.start, offset + Buffer.byteLength(line) + 1]);
        open = null;
      }
    } else if (fence) {
      open = { start: offset, mark: fence[1] };
    } else {
      const heading = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(line);
      if (heading) {
        headings.push({ at: offset, level: heading[1].length, title: shortTitle(heading[2]) });
      }
    }
    offset += Buffer.byteLength(line) + 1;
  }
  const size = Buffer.byteLength(text);
  if (open) fences.push([open.start, size]);
  return { headings, fences: fences.map(([start, end]) => [start, Math.min(end, size)]) };
}

const fenceAround = (fences, at) => fences.find(([start, end]) => start < at && at < end);

// The records of TEXT with their byte ranges. A code block is never split,
// and a heading stays with the text it introduces: kept alone it says nothing.
function passagesOf(text, fences) {
  const passages = [];
  let offset = 0;
  for (const part of segment(text)) {
    const end = offset + Buffer.byteLength(part);
    const last = passages.at(-1);
    if (last && (fenceAround(fences, last.end) || /^#{1,6}[ \t][^\n]*\n\s*$/.test(last.text))) {
      last.end = end;
      last.text += part;
    } else {
      passages.push({ start: offset, end, text: part });
    }
    offset = end;
  }
  return passages;
}

// Move a cut out of a code block when that costs less than half of its side.
function settle(bytes, fences, headEnd, tailStart) {
  headEnd = utf8Back(bytes, headEnd);
  tailStart = utf8Forward(bytes, tailStart);
  const head = fenceAround(fences, headEnd);
  if (head && head[0] >= headEnd / 2) headEnd = head[0];
  const tail = fenceAround(fences, tailStart);
  if (tail && bytes.byteLength - tail[1] >= (bytes.byteLength - tailStart) / 2) tailStart = tail[1];
  return [headEnd, tailStart];
}

// RANGES in order, joined where they touch or where the gap between two is
// no larger than the GAP-BYTES its marker would cost.
function merged(ranges, gapBytes = 0) {
  const result = [];
  for (const range of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && range[0] - last[1] <= gapBytes) last[1] = Math.max(last[1], range[1]);
    else result.push([...range]);
  }
  return result;
}

/**
 * Byte ranges [start, end) of BYTES to keep within PAYLOAD-BYTES: the
 * beginning, the end, and the passages in between that match TERMS best.
 * Each gap between two kept ranges is charged GAP-BYTES for its marker; the
 * caller has already paid for one. Returns null when no passage in between
 * answers the request, and the caller keeps the plain beginning and end.
 */
export function excerptRanges(bytes, payloadBytes, terms, gapBytes, outline = null) {
  if (terms.length < 2 || payloadBytes < EXCERPT_MIN_BYTES) return null;
  const text = bytes.toString("utf8");
  // Offsets below are byte offsets of the decoded text.
  if (Buffer.byteLength(text) !== bytes.byteLength) return null;
  const { fences } = outline || outlineOf(text);
  const passages = passagesOf(text, fences);
  if (passages.length < 4) return null;
  const wanted = new Set(terms);
  for (const passage of passages) passage.found = memoryTerms(passage.text).filter((term) => wanted.has(term));
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
  // The beginning and end are kept whatever happens; a passage that repeats
  // them, or a passage already chosen, would spend the budget on nothing new.
  const windows = (slice) => shingles(termSequence(slice.toString("utf8")));
  const seen = new Set([
    ...windows(bytes.subarray(0, utf8Back(bytes, quarter))),
    ...windows(bytes.subarray(utf8Forward(bytes, bytes.byteLength - quarter))),
  ]);
  let room = payloadBytes - 2 * quarter;
  const kept = [];
  for (const passage of ranked) {
    const cost = passage.end - passage.start + gapBytes;
    if (cost > room) continue;
    const own = shingles(termSequence(passage.text));
    let repeated = 0;
    for (const window of own) if (seen.has(window)) repeated += 1;
    if (own.size && repeated / own.size >= PASSAGE_REPEAT_SHARE) continue;
    for (const window of own) seen.add(window);
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
    const [head, tail] = settle(bytes, fences, headEnd, tailStart);
    ranges = merged([[0, head], ...kept, [tail, bytes.byteLength]], gapBytes);
    const used = ranges.reduce((sum, [start, end]) => sum + end - start, 0) + gapBytes * (ranges.length - 2);
    const spare = Math.floor((payloadBytes - used) / 2);
    if (spare < 64 || pass === 3) break;
    headEnd = head + spare;
    tailStart = tail - spare;
  }
  // Only a beginning and an end left: the plain cut says the same in fewer words.
  return ranges.length > 2 ? ranges : null;
}

// One "[Noema: ...]" line. REQUIRED clauses always appear; the sections the
// gap skips and the section the text resumes in are named while CAP allows.
function marker(required, skipped, under, last, cap) {
  const render = (shown, resume) => {
    const clauses = [...required];
    if (shown.length) {
      clauses.push(`skipped sections: ${shown.join(" | ")}${shown.length < skipped.length ? ` (+${skipped.length - shown.length} more)` : ""}`);
    }
    if (resume) clauses.push(`continues under: ${resume}`);
    return Buffer.from(`\n\n[Noema: ${[...clauses, ...last].join("; ")}]\n`);
  };
  for (let count = skipped.length; count >= 0; count--) {
    const line = render(skipped.slice(0, count), under);
    if (line.byteLength <= cap) return line;
  }
  return render([], "");
}

/**
 * Cut BYTES to MAX-BYTES. NOTE says why; TERMS are the request's; FULL-TEXT,
 * when the agent can fetch the original, is the call that does. KEEP-END
 * keeps the end as well as the beginning. Returns the cut bytes and the
 * reason a receipt shows.
 */
export function cutToBudget(bytes, maxBytes, { note, terms = [], fullText = "", keepEnd = true } = {}) {
  const text = bytes.toString("utf8");
  const valid = Buffer.byteLength(text) === bytes.byteLength;
  const outline = valid ? outlineOf(text) : { headings: [], fences: [] };
  const allowance = maxBytes >= EXCERPT_MIN_BYTES ? MARKER_OUTLINE_BYTES : 0;
  const pointer = fullText ? [`full text: ${fullText}`] : [];
  const omittedClause = (count) => `${count} bytes omitted`;
  const firstFloor = marker([note, omittedClause(bytes.byteLength)], [], "", pointer, Infinity).byteLength;
  const laterFloor = marker([omittedClause(bytes.byteLength)], [], "", [], Infinity).byteLength;

  let ranges = keepEnd && valid
    ? excerptRanges(bytes, maxBytes - firstFloor - allowance, terms, laterFloor + allowance, outline) : null;
  const matched = Boolean(ranges);
  if (!ranges) {
    const payload = Math.max(0, maxBytes - firstFloor - allowance);
    const head = keepEnd ? Math.ceil(payload / 2) : payload;
    const [headEnd, tailStart] = settle(bytes, outline.fences, Math.min(bytes.byteLength, head),
      keepEnd ? Math.max(head, bytes.byteLength - (payload - head)) : bytes.byteLength);
    ranges = keepEnd ? [[0, headEnd], [tailStart, bytes.byteLength]] : [[0, headEnd], [bytes.byteLength, bytes.byteLength]];
  }

  const assemble = (kept) => {
    const parts = [];
    kept.forEach(([start, end], index) => {
      if (index) {
        const from = kept[index - 1][1];
        const required = index === 1 ? [note] : [];
        // The plain cut keeps the wording receipts and people already know.
        if (matched || !keepEnd) required.push(...(matched ? [omittedClause(start - from)] : []));
        else required.push("middle omitted");
        const skipped = allowance ? outline.headings.filter((heading) => heading.at >= from && heading.at < start)
          .map((heading) => heading.title) : [];
        const stack = [];
        if (allowance && start < bytes.byteLength) {
          for (const heading of outline.headings) {
            if (heading.at > start) break;
            while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
            stack.push(heading);
          }
          // Text that opens with its own heading resumes under that heading's parents.
          if (stack.at(-1)?.at === start) stack.pop();
        }
        parts.push(marker(required, skipped, stack.slice(-2).map((heading) => heading.title).join(" > "),
          index === 1 ? pointer : [], (index === 1 ? firstFloor : laterFloor) + allowance));
      }
      parts.push(bytes.subarray(start, end));
    });
    return Buffer.concat(parts);
  };

  let cut = assemble(ranges);
  // Markers are budgeted at their longest; give what they did not use back
  // to the beginning and the end.
  const spare = maxBytes - cut.byteLength;
  if (spare >= 32 && ranges[0][1] < ranges[1][0]) {
    const grown = ranges.map((range) => [...range]);
    const half = keepEnd ? Math.floor(spare / 2) : spare;
    const [headEnd, tailStart] = settle(bytes, outline.fences,
      Math.min(grown[1][0], grown[0][1] + half),
      keepEnd ? Math.max(grown.at(-2)[1], grown.at(-1)[0] - (spare - half)) : bytes.byteLength);
    grown[0][1] = Math.max(grown[0][1], headEnd);
    if (keepEnd) grown.at(-1)[0] = Math.min(grown.at(-1)[0], tailStart);
    const again = assemble(merged(grown).length === grown.length ? grown : ranges);
    if (again.byteLength <= maxBytes) cut = again;
  }
  if (cut.byteLength > maxBytes) cut = cut.subarray(0, utf8Back(cut, maxBytes));
  const reason = !keepEnd ? note
    : `${note}; beginning and end retained${matched ? ", with the passages matching the request" : ""}`;
  return { bytes: cut, reason };
}
