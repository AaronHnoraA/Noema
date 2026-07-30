// Inline math detection shared by CM6 widgets and floating preview.
// Inline math uses explicit LaTeX bracket delimiters `\( … \)`. Unlike the old
// single-dollar syntax these are unambiguous and never occur in ordinary prose,
// so no prose heuristics are needed: a `\( … \)` span on a single line is math.

import type { InlineContext, MarkdownConfig } from "@lezer/markdown";

export const INLINE_MATH_RE = /\\\(([^\n]+?)\\\)/g;

export interface InlineMathRange {
  from: number;
  to: number;
  tex: string;
}

/**
 * Teach Lezer that a complete `\(…\)` range is one opaque inline node.
 *
 * Without this language-boundary rule, underscores inside two separate math
 * ranges can be paired as Markdown emphasis, incorrectly italicising all prose
 * between them. The cache keeps recognition linear even when a line contains
 * many incomplete `\(` openers: each InlineContext is scanned at most once.
 */
const inlineMathEndsCache = new WeakMap<InlineContext, Map<number, number>>();

function inlineMathEnds(cx: InlineContext): Map<number, number> {
  const cached = inlineMathEndsCache.get(cx);
  if (cached) return cached;

  const ends = new Map<number, number>();
  let open = -1;
  for (let pos = cx.offset; pos < cx.end; pos++) {
    const ch = cx.char(pos);
    if (ch === 10 /* \n */) {
      open = -1;
      continue;
    }
    if (open < 0) {
      if (ch === 92 /* \\ */ && cx.char(pos + 1) === 40 /* ( */) {
        open = pos;
        pos++;
      }
      continue;
    }
    // Match INLINE_MATH_RE's non-empty body and first closing delimiter.
    if (pos > open + 2 && ch === 92 /* \\ */ && cx.char(pos + 1) === 41 /* ) */) {
      ends.set(open, pos + 2);
      open = -1;
      pos++;
    }
  }
  inlineMathEndsCache.set(cx, ends);
  return ends;
}

export const inlineMathMarkdownExtension: MarkdownConfig = {
  defineNodes: ["InlineMath"],
  parseInline: [{
    name: "InlineMath",
    before: "Escape",
    parse(cx, next, start) {
      if (next !== 92 /* \\ */ || cx.char(start + 1) !== 40 /* ( */) return -1;
      const end = inlineMathEnds(cx).get(start);
      return end === undefined
        ? -1
        : cx.addElement(cx.elt("InlineMath", start, end));
    },
  }],
};

export function scanInlineMathRanges(text: string, baseOffset = 0): InlineMathRange[] {
  const ranges: InlineMathRange[] = [];
  INLINE_MATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_MATH_RE.exec(text)) !== null) {
    const tex = match[1]!;
    ranges.push({
      from: baseOffset + match.index,
      to: baseOffset + match.index + match[0].length,
      tex,
    });
  }
  return ranges;
}
