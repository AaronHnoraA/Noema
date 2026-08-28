import type { Text } from "@codemirror/state";
import { tocIndexFromState, type MarkdownHeading } from "../src/cm6/toc-index.ts";
import {
  orgMetaSummaryRangeFromLines,
  type MetaSummarySourceRange,
} from "../src/org-meta.ts";
import type { EditorState } from "@codemirror/state";

export type WritingStats = {
  words: number;
  characters: number;
  cjkCharacters: number;
  nonCjkWords: number;
};

const CJK_CHAR_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const WORD_CHAR_RE = /^[\p{L}\p{N}]$/u;
const WORD_CONNECTOR_RE = /^['’_-]$/u;

export type WritingStatsCounter = {
  add: (text: string) => void;
  boundary: () => void;
  value: () => WritingStats;
};

/** Streaming counter used by both synchronous ranges and idle-frame scans. */
export function createWritingStatsCounter(): WritingStatsCounter {
  let characters = 0;
  let cjkCharacters = 0;
  let nonCjkWords = 0;
  let inWord = false;
  let pendingConnector = false;
  return {
    add(text) {
      for (const char of text) {
        if (/\S/u.test(char)) characters += 1;
        if (CJK_CHAR_RE.test(char)) {
          cjkCharacters += 1;
          inWord = false;
          pendingConnector = false;
        } else if (WORD_CHAR_RE.test(char)) {
          if (!inWord) nonCjkWords += 1;
          inWord = true;
          pendingConnector = false;
        } else if (WORD_CONNECTOR_RE.test(char) && inWord && !pendingConnector) {
          pendingConnector = true;
        } else {
          inWord = false;
          pendingConnector = false;
        }
      }
    },
    boundary() {
      inWord = false;
      pendingConnector = false;
    },
    value() {
      return {
        words: cjkCharacters + nonCjkWords,
        characters,
        cjkCharacters,
        nonCjkWords,
      };
    },
  };
}

export function accumulateWritingStatsRange(
  counter: WritingStatsCounter,
  doc: Text,
  from: number,
  to: number,
  metaSummaryRange: MetaSummarySourceRange | null,
): void {
  const safeFrom = Math.max(0, Math.min(from, doc.length));
  const safeTo = Math.max(safeFrom, Math.min(to, doc.length));
  const firstLine = doc.lineAt(safeFrom).number;
  const lastLine = doc.lineAt(safeTo).number;
  for (let lineNo = firstLine; lineNo <= lastLine; lineNo += 1) {
    const line = doc.line(lineNo);
    const segmentFrom = lineNo === firstLine ? safeFrom : line.from;
    const segmentTo = lineNo === lastLine ? safeTo : line.to;
    const visibleSegments = !metaSummaryRange
      || segmentTo <= metaSummaryRange.from
      || segmentFrom >= metaSummaryRange.to
      ? [[segmentFrom, segmentTo] as const]
      : [
          [segmentFrom, Math.min(segmentTo, metaSummaryRange.from)] as const,
          [Math.max(segmentFrom, metaSummaryRange.to), segmentTo] as const,
        ];
    let wroteVisibleSegment = false;
    for (const [visibleFrom, visibleTo] of visibleSegments) {
      if (visibleTo <= visibleFrom) continue;
      if (wroteVisibleSegment) counter.boundary();
      counter.add(line.text.slice(visibleFrom - line.from, visibleTo - line.from));
      wroteVisibleSegment = true;
    }
    if (segmentTo >= line.to && lineNo < doc.lines) counter.boundary();
  }
}

/** Count a source range without materializing the whole CM6 document. */
export function countWritingStats(
  doc: Text,
  from = 0,
  to = doc.length,
  metaSummaryRange: MetaSummarySourceRange | null = orgMetaSummaryRangeFromLines(doc),
): WritingStats {
  const safeFrom = Math.max(0, Math.min(from, doc.length));
  const safeTo = Math.max(safeFrom, Math.min(to, doc.length));
  const counter = createWritingStatsCounter();
  accumulateWritingStatsRange(counter, doc, safeFrom, safeTo, metaSummaryRange);
  return counter.value();
}

export function readingMinutes(stats: WritingStats): number {
  const minutes = stats.cjkCharacters / 300 + stats.nonCjkWords / 200;
  return stats.words === 0 ? 0 : Math.max(1, Math.ceil(minutes));
}

/**
 * Markdown headings in document order, cached per TOC index.
 *
 * The index is a state field, so its heading array keeps its identity across
 * selection-only transactions — and this runs on every one of them while a
 * drag is in progress. Filtering and sorting thousands of headings each time is
 * pure repeat work.
 */
const orderedMarkdownHeadings = new WeakMap<object, MarkdownHeading[]>();

function headingStart(heading: MarkdownHeading): number {
  return heading.markerFrom ?? heading.pos;
}

function markdownHeadingsInOrder(state: EditorState): MarkdownHeading[] {
  const headings = tocIndexFromState(state).headings;
  const cached = orderedMarkdownHeadings.get(headings);
  if (cached) return cached;
  const ordered = headings
    .filter((heading) => heading.source === "markdown")
    .sort((a, b) => headingStart(a) - headingStart(b));
  orderedMarkdownHeadings.set(headings, ordered);
  return ordered;
}

/** Return the Markdown heading subtree containing POS, including its heading line. */
export function headingSubtreeRange(state: EditorState, pos: number): { from: number; to: number } | null {
  const headings = markdownHeadingsInOrder(state);
  // Last heading that starts at or before pos.
  let low = 0;
  let high = headings.length - 1;
  let currentIndex = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (headingStart(headings[mid]!) > pos) {
      high = mid - 1;
    } else {
      currentIndex = mid;
      low = mid + 1;
    }
  }
  if (currentIndex < 0) return null;
  const current = headings[currentIndex]!;
  const level = current.renderLevel ?? current.level;
  let to = state.doc.length;
  for (let index = currentIndex + 1; index < headings.length; index += 1) {
    const next = headings[index]!;
    if ((next.renderLevel ?? next.level) <= level) {
      to = state.doc.lineAt(headingStart(next)).from;
      break;
    }
  }
  return { from: state.doc.lineAt(headingStart(current)).from, to };
}
