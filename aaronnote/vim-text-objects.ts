/**
 * Vim text objects (`iw`, `a"`, `i(`, `ap`, …) as pure functions over a CM6
 * `Text`.  They return source ranges; the caller decides whether an operator
 * or Visual mode consumes them.  Charwise results are half-open `[from, to)`.
 * Linewise results (`ip`/`ap`) name a position on the first and the last line
 * so the caller can expand them through the same line-span builder `dd` uses.
 */

import type { Text } from "@codemirror/state";
import { graphemeEndPosition, isWordChar } from "../src/cm6/text-boundaries.ts";

export type TextObjectRange = { from: number; to: number; linewise: boolean };

type Category = "space" | "word" | "punct";

type Run = { from: number; to: number; category: Category };

/** Bracket searches give up past this many characters in either direction. */
const BRACKET_SCAN_LIMIT = 200_000;

function category(ch: string, big: boolean): Category {
  if (/\s/u.test(ch)) return "space";
  if (big || isWordChar(ch)) return "word";
  return "punct";
}

/** The line split into runs of whitespace, word and punctuation graphemes. */
function lineRuns(text: Text, pos: number, big: boolean): { runs: Run[]; index: number } | null {
  const line = text.lineAt(pos);
  if (line.from === line.to) return null;
  const runs: Run[] = [];
  let index = -1;
  let at = line.from;
  while (at < line.to) {
    const end = Math.max(at + 1, graphemeEndPosition(text, at));
    const cat = category(text.sliceString(at, end), big);
    const last = runs[runs.length - 1];
    if (last && last.category === cat) last.to = end;
    else runs.push({ from: at, to: end, category: cat });
    if (index < 0 && pos < end) index = runs.length - 1;
    at = end;
  }
  if (index < 0) index = runs.length - 1;
  return { runs, index };
}

/** `iw`/`aw`/`iW`/`aW`: COUNT words, staying on the caret's line. */
export function wordObject(
  text: Text,
  pos: number,
  count: number,
  inner: boolean,
  big: boolean,
): TextObjectRange | null {
  const found = lineRuns(text, pos, big);
  if (!found) return null;
  const { runs, index } = found;
  const at = runs[index]!;
  if (inner) {
    // Inner objects count whitespace runs as objects of their own.
    const last = runs[Math.min(runs.length - 1, index + count - 1)]!;
    return { from: at.from, to: last.to, linewise: false };
  }

  let from = at.from;
  let cursor = index;
  let to = at.to;
  let trailingSpace = false;
  for (let step = 0; step < count && cursor < runs.length; step++) {
    const run = runs[cursor]!;
    if (run.category === "space") {
      // `aw` on whitespace: that whitespace plus the following word.
      to = run.to;
      const word = runs[cursor + 1];
      if (word) { to = word.to; cursor += 2; } else cursor += 1;
      trailingSpace = false;
      continue;
    }
    to = run.to;
    const space = runs[cursor + 1];
    if (space?.category === "space") {
      to = space.to;
      trailingSpace = true;
      cursor += 2;
    } else {
      trailingSpace = false;
      cursor += 1;
    }
  }
  // Without trailing whitespace, `aw` takes the whitespace before the word
  // instead — unless that whitespace is only the line's indentation.
  if (!trailingSpace && at.category !== "space") {
    const before = runs[index - 1];
    if (before?.category === "space" && index - 1 > 0) from = before.from;
  }
  return { from, to, linewise: false };
}

function isEscaped(line: string, index: number): boolean {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && line[at] === "\\"; at--) slashes += 1;
  return slashes % 2 === 1;
}

/**
 * `i"`/`a"` and friends.  Quotes pair up from the start of the line, the way
 * Vim decides which quotes open a string; a caret between strings or before
 * the first one takes the next string on the line.
 */
export function quoteObject(
  text: Text,
  pos: number,
  quote: string,
  inner: boolean,
): TextObjectRange | null {
  const line = text.lineAt(pos);
  const source = line.text;
  const column = pos - line.from;
  const quotes: number[] = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === quote && !isEscaped(source, index)) quotes.push(index);
  }
  let pair: [number, number] | null = null;
  for (let index = 0; index + 1 < quotes.length; index += 2) {
    const open = quotes[index]!;
    const close = quotes[index + 1]!;
    if (column >= open && column <= close) { pair = [open, close]; break; }
    if (open > column) { pair = [open, close]; break; }
  }
  if (!pair) return null;
  const [open, close] = pair;
  if (inner) return { from: line.from + open + 1, to: line.from + close, linewise: false };
  let from = open;
  let to = close + 1;
  let trailing = to;
  while (trailing < source.length && /[ \t]/u.test(source[trailing]!)) trailing += 1;
  if (trailing > to) to = trailing;
  else {
    let leading = from;
    while (leading > 0 && /[ \t]/u.test(source[leading - 1]!)) leading -= 1;
    if (leading > 0) from = leading;
  }
  return { from: line.from + from, to: line.from + to, linewise: false };
}

/**
 * `i(`/`a(`, `i[`, `i{`, `i<`: the COUNT-th enclosing pair.  Standing on either
 * bracket of a pair selects that pair.
 */
export function bracketObject(
  text: Text,
  pos: number,
  open: string,
  close: string,
  inner: boolean,
  count: number,
): TextObjectRange | null {
  const windowFrom = Math.max(0, pos - BRACKET_SCAN_LIMIT);
  const windowTo = Math.min(text.length, pos + BRACKET_SCAN_LIMIT);
  const source = text.sliceString(windowFrom, windowTo);
  const local = pos - windowFrom;

  const matchForward = (openAt: number): number | null => {
    let depth = 0;
    for (let at = openAt; at < source.length; at++) {
      const ch = source[at];
      if (ch === open) depth += 1;
      else if (ch === close && --depth === 0) return at;
    }
    return null;
  };
  const enclosingOpen = (before: number): number | null => {
    let depth = 0;
    for (let at = before; at >= 0; at--) {
      const ch = source[at];
      if (ch === close) depth += 1;
      else if (ch === open) {
        if (depth === 0) return at;
        depth -= 1;
      }
    }
    return null;
  };

  let openAt: number | null;
  if (source[local] === open) openAt = local;
  else if (source[local] === close) openAt = enclosingOpen(local - 1);
  else openAt = enclosingOpen(local - 1);
  for (let level = 1; level < count && openAt != null; level++) openAt = enclosingOpen(openAt - 1);
  if (openAt == null) return null;
  const closeAt = matchForward(openAt);
  if (closeAt == null || closeAt < local) return null;

  if (!inner) return { from: windowFrom + openAt, to: windowFrom + closeAt + 1, linewise: false };
  let from = openAt + 1;
  let to = closeAt;
  // A pair whose brackets sit on their own lines owns only the lines between:
  // `di{` keeps both braces and the line breaks that frame them.
  if (source[from] === "\n") from += 1;
  const lineStart = source.lastIndexOf("\n", to - 1) + 1;
  if (lineStart > from && /^[ \t]*$/u.test(source.slice(lineStart, to))) to = lineStart;
  if (to < from) to = from;
  return { from: windowFrom + from, to: windowFrom + to, linewise: false };
}

function isBlankLine(text: Text, number: number): boolean {
  return text.line(number).text.trim().length === 0;
}

/**
 * `ip`/`ap`: a run of lines sharing the caret line's blankness.  `ap` also
 * takes the blank lines after the paragraph, or before it when none follow.
 */
export function paragraphObject(
  text: Text,
  pos: number,
  count: number,
  inner: boolean,
): TextObjectRange {
  const blockAround = (number: number): [number, number] => {
    const blank = isBlankLine(text, number);
    let first = number;
    let last = number;
    while (first > 1 && isBlankLine(text, first - 1) === blank) first -= 1;
    while (last < text.lines && isBlankLine(text, last + 1) === blank) last += 1;
    return [first, last];
  };

  const start = text.lineAt(pos).number;
  let [first, last] = blockAround(start);
  for (let step = 1; step < count && last < text.lines; step++) last = blockAround(last + 1)[1];

  if (!inner) {
    // A paragraph takes the gap after it and a gap takes the paragraph after
    // it; with nothing after, a paragraph takes the gap before it instead.
    if (last < text.lines) last = blockAround(last + 1)[1];
    else if (!isBlankLine(text, start) && first > 1) first = blockAround(first - 1)[0];
  }
  return { from: text.line(first).from, to: text.line(last).from, linewise: true };
}
