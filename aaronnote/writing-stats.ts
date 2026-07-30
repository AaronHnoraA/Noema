import type { Text } from "@codemirror/state";
import { tocIndexFromState } from "../src/cm6/toc-index.ts";
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

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const NON_CJK_WORD_RE = /[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu;
const NON_SPACE_RE = /\S/gu;

function countText(text: string): Omit<WritingStats, "words"> {
  const characters = [...text.matchAll(NON_SPACE_RE)].length;
  const cjkCharacters = [...text.matchAll(CJK_RE)].length;
  // Remove CJK characters so adjacent Latin runs remain ordinary words.
  const nonCjkWords = [...text.replace(CJK_RE, " ").matchAll(NON_CJK_WORD_RE)].length;
  return { characters, cjkCharacters, nonCjkWords };
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
  let characters = 0;
  let cjkCharacters = 0;
  let nonCjkWords = 0;
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
    for (const [visibleFrom, visibleTo] of visibleSegments) {
      if (visibleTo <= visibleFrom) continue;
      const stats = countText(line.text.slice(visibleFrom - line.from, visibleTo - line.from));
      characters += stats.characters;
      cjkCharacters += stats.cjkCharacters;
      nonCjkWords += stats.nonCjkWords;
    }
  }
  return { words: cjkCharacters + nonCjkWords, characters, cjkCharacters, nonCjkWords };
}

export function readingMinutes(stats: WritingStats): number {
  const minutes = stats.cjkCharacters / 300 + stats.nonCjkWords / 200;
  return stats.words === 0 ? 0 : Math.max(1, Math.ceil(minutes));
}

/** Return the Markdown heading subtree containing POS, including its heading line. */
export function headingSubtreeRange(state: EditorState, pos: number): { from: number; to: number } | null {
  const headings = tocIndexFromState(state).headings
    .filter((heading) => heading.source === "markdown")
    .sort((a, b) => (a.markerFrom ?? a.pos) - (b.markerFrom ?? b.pos));
  let currentIndex = -1;
  for (let index = 0; index < headings.length; index += 1) {
    if ((headings[index]!.markerFrom ?? headings[index]!.pos) > pos) break;
    currentIndex = index;
  }
  if (currentIndex < 0) return null;
  const current = headings[currentIndex]!;
  const level = current.renderLevel ?? current.level;
  let to = state.doc.length;
  for (let index = currentIndex + 1; index < headings.length; index += 1) {
    const next = headings[index]!;
    if ((next.renderLevel ?? next.level) <= level) {
      to = state.doc.lineAt(next.markerFrom ?? next.pos).from;
      break;
    }
  }
  return { from: state.doc.lineAt(current.markerFrom ?? current.pos).from, to };
}
