/**
 * Canonical GFM table detection, row/cell source spans, and rendered-to-source
 * offset mapping shared across live preview, editing commands, paste, and menus.
 */

import type { Text } from "@codemirror/state";
import { readLayoutAttrsLine } from "../layout-attrs.ts";
import { rangeOverlapsAny } from "./math-ranges.ts";

export type TableSourceCellSpan = {
  /** Raw cell span between pipe delimiters (relative to line start). */
  from: number;
  to: number;
  /** Trimmed cell text span (relative to line start); empty cell places caret inside padding. */
  textFrom: number;
  textTo: number;
};

/** Offsets of every unescaped `|` in TEXT. */
export function tablePipeOffsets(text: string): number[] {
  const pipes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\" && index + 1 < text.length) {
      index++;
      continue;
    }
    if (text[index] === "|") pipes.push(index);
  }
  return pipes;
}

/** Whether LINE has a `|` that is not backslash-escaped. */
export function hasUnescapedPipe(line: string): boolean {
  return tablePipeOffsets(line).length > 0;
}

function trimmedCellBounds(text: string, from: number, to: number): { textFrom: number; textTo: number } {
  let start = from;
  let end = to;
  while (start < end && (text[start] === " " || text[start] === "\t")) start++;
  while (end > start && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  if (start === end) {
    const caret = from < to && text[from] === " " ? Math.min(to, from + 1) : from;
    return { textFrom: caret, textTo: caret };
  }
  return { textFrom: start, textTo: end };
}

/**
 * Split a Markdown table row into its unescaped pipe offsets and cell spans.
 * Supports leading/trailing pipes, outer-pipe-less GFM rows (`a | b`),
 * partial outer pipes, and pipe-less body rows (`plain row`).
 */
export function tableSourceRowParts(text: string): {
  pipes: number[];
  cells: TableSourceCellSpan[];
  hasLeadingPipe: boolean;
  hasTrailingPipe: boolean;
} {
  const pipes = tablePipeOffsets(text);
  let firstNonSpace = 0;
  while (firstNonSpace < text.length && (text[firstNonSpace] === " " || text[firstNonSpace] === "\t")) firstNonSpace++;
  let lastNonSpace = text.length - 1;
  while (lastNonSpace >= firstNonSpace && (text[lastNonSpace] === " " || text[lastNonSpace] === "\t")) lastNonSpace--;

  const hasLeadingPipe = pipes.length > 0 && pipes[0] === firstNonSpace;
  const hasTrailingPipe = pipes.length > (hasLeadingPipe ? 1 : 0) && pipes[pipes.length - 1] === lastNonSpace;

  const innerPipes = pipes.slice(hasLeadingPipe ? 1 : 0, hasTrailingPipe ? -1 : undefined);
  const start = hasLeadingPipe ? pipes[0]! + 1 : firstNonSpace;
  const end = hasTrailingPipe ? pipes[pipes.length - 1]! : Math.max(start, text.length);

  const boundaries = [start, ...innerPipes.map((offset) => offset + 1), end];
  const cells: TableSourceCellSpan[] = boundaries.slice(0, -1).map((from, col) => {
    const to = col < boundaries.length - 2 ? boundaries[col + 1]! - 1 : boundaries[col + 1]!;
    const { textFrom, textTo } = trimmedCellBounds(text, from, to);
    return { from, to, textFrom, textTo };
  });

  return { pipes, cells, hasLeadingPipe, hasTrailingPipe };
}

/**
 * Split a table row into decoded cell text (unescaping `\|` -> `|`).
 * Used for rendering and structured editing; serialization escapes `|` back once.
 */
export function splitTableRow(line: string): string[] {
  const { cells } = tableSourceRowParts(line);
  return cells.map(({ from, to }) => {
    const raw = line.slice(from, to).trim();
    let decoded = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (ch === "\\" && i + 1 < raw.length) {
        const next = raw[++i]!;
        decoded += next === "|" ? "|" : `\\${next}`;
      } else {
        decoded += ch;
      }
    }
    return decoded;
  });
}

/** GFM delimiter row: one hyphen per cell is enough (`|-|:-:|`), as in export. */
export function isTableSeparatorLine(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, "")));
}

/**
 * GFM table start, by the rules export's markdown-it applies: the header has
 * an unescaped pipe, the delimiter row is made of `-`, `:`, `|` and spaces
 * with as many cells as the header, and neither is indented as code. Outer
 * pipes are optional (`a | b` / `--- | ---`).
 */
export function isTableStart(header: string, delimiter: string): boolean {
  if (/^(?: {4}|\t)/u.test(header) || /^(?: {4}|\t)/u.test(delimiter)) return false;
  if (!hasUnescapedPipe(header)) return false;
  if (!/^\s*[-:|][-:|\s]*$/u.test(delimiter) || /^\s*-\s/u.test(delimiter)) return false;
  if (!isTableSeparatorLine(delimiter)) return false;
  return splitTableRow(header).length === splitTableRow(delimiter).length;
}

/** A line that starts another block and so ends a table body (blank lines end it too). */
const TABLE_BODY_BREAK_RE = /^(?: {0,3}(?:#{1,6}(?:\s|$)|>|[-*+]\s|\d{1,9}[.)]\s|`{3,}|~{3,}|<[A-Za-z/!?]|(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$)| {4}|\t)/u;

export function isTableBodyLine(line: string): boolean {
  // A `{...}` layout line belongs to the table as its attributes, not a row.
  // Org environment boundaries (`#+begin`, `#+end`) and column separators
  // (`#+col`) always terminate an adjacent table rather than being swallowed
  // as pipe-less table rows.
  return line.trim().length > 0
    && !/^[ \t]*#\+(?:begin|end|col)(?:\s|\{|$)/i.test(line)
    && !TABLE_BODY_BREAK_RE.test(line)
    && !readLayoutAttrsLine(line);
}

/** Column index containing OFFSET (relative to line start), clamped to available columns. */
export function tableCellColumnAtOffset(line: string, offset: number, maxCols?: number): number {
  const { cells } = tableSourceRowParts(line);
  if (cells.length === 0) return 0;
  let found = -1;
  for (let col = 0; col < cells.length; col++) {
    const cell = cells[col]!;
    if (offset >= cell.from && offset <= cell.to) {
      found = col;
      break;
    }
  }
  if (found < 0) {
    found = offset < cells[0]!.from ? 0 : cells.length - 1;
  }
  const limit = maxCols != null ? Math.max(0, maxCols - 1) : cells.length - 1;
  return Math.max(0, Math.min(limit, found));
}

/** Target selection range inside cell COLIDX of ROW (relative to line start). */
export function tableCellTarget(row: string, colIdx: number): {
  anchor: number;
  head: number;
  from: number;
  to: number;
} {
  const { cells } = tableSourceRowParts(row);
  if (cells.length === 0) return { anchor: 0, head: 0, from: 0, to: row.length };
  const clamped = Math.max(0, Math.min(colIdx, cells.length - 1));
  const cell = cells[clamped]!;
  return {
    anchor: cell.textFrom,
    head: cell.textTo,
    from: cell.from,
    to: cell.to,
  };
}

export type FoundTableAtPos = {
  startLineNum: number;
  endLineNum: number;
  sepLineNum: number;
  lines: string[];
  from: number;
  sourceTo: number;
  currentRowIdx: number;
  currentColIdx: number;
};

/**
 * Find the GFM table containing POS using the exact same block rules as live
 * preview (supports tables with or without outer pipes, short delimiters, and
 * pipe-less body rows). Returns null if POS is not inside a table.
 */
export function findTableAtPos(
  doc: Text,
  pos: number,
  excludedRanges: readonly { from: number; to: number }[] = [],
): FoundTableAtPos | null {
  const safePos = Math.max(0, Math.min(pos, doc.length));
  const curLine = doc.lineAt(safePos);
  if (!curLine.text.trim()) return null;

  // Walk upward to the start of the contiguous non-blank block.
  let blockStart = curLine.number;
  while (blockStart > 1 && doc.line(blockStart - 1).text.trim().length > 0) {
    blockStart--;
  }

  let lineNum = blockStart;
  while (lineNum <= curLine.number && lineNum < doc.lines) {
    const header = doc.line(lineNum);
    const separator = doc.line(lineNum + 1);
    if (
      rangeOverlapsAny(header.from, separator.to, excludedRanges)
      || !isTableStart(header.text, separator.text)
    ) {
      lineNum++;
      continue;
    }

    let endLine = lineNum + 1;
    while (endLine + 1 <= doc.lines) {
      const next = doc.line(endLine + 1);
      if (rangeOverlapsAny(next.from, next.to, excludedRanges) || !isTableBodyLine(next.text)) break;
      endLine++;
    }

    if (curLine.number >= lineNum && curLine.number <= endLine) {
      const lines: string[] = [];
      for (let n = lineNum; n <= endLine; n++) lines.push(doc.line(n).text);
      const colCount = splitTableRow(header.text).length;
      return {
        startLineNum: lineNum,
        endLineNum: endLine,
        sepLineNum: lineNum + 1,
        lines,
        from: header.from,
        sourceTo: doc.line(endLine).to,
        currentRowIdx: curLine.number - lineNum,
        currentColIdx: tableCellColumnAtOffset(curLine.text, safePos - curLine.from, colCount),
      };
    }

    lineNum = endLine + 1;
  }

  return null;
}

/**
 * Map a clicked plain-text character offset inside a rendered cell back to
 * the corresponding character offset within the cell's raw Markdown source.
 */
export function mapRenderedOffsetToSource(
  cellSource: string,
  renderedOffset: number,
  renderedTotal?: number,
): number {
  if (!cellSource) return 0;
  if (renderedOffset <= 0) return 0;
  if (renderedTotal != null && renderedTotal > 0 && renderedOffset >= renderedTotal) {
    return cellSource.length;
  }

  // Build parallel map: map[renderedIndex] = sourceIndex for each visible char.
  const sourcePositions: number[] = [];
  let i = 0;
  while (i < cellSource.length) {
    const rest = cellSource.slice(i);
    // Inline <br> / <br/> -> treated as boundary (0 or 1 rendered char)
    const br = /^<br\s*\/?>/i.exec(rest);
    if (br) {
      i += br[0].length;
      continue;
    }
    // Paired inline HTML open/close tags
    const htmlTag = /^<\/?(?:kbd|sub|sup|mark|u|ins|small|strong|em|b|i|s|del|code|span)(?:\s[^>]*)?>/i.exec(rest);
    if (htmlTag) {
      i += htmlTag[0].length;
      continue;
    }
    // Inline math \(...\) -> opaque rendered span; step proportionally
    if (rest.startsWith("\\(")) {
      const close = cellSource.indexOf("\\)", i + 2);
      if (close >= 0) {
        for (let k = i + 2; k < close; k++) sourcePositions.push(k);
        i = close + 2;
        continue;
      }
    }
    // Markdown link [label](url) -> visible characters are label
    if (cellSource[i] === "[") {
      const link = /^\[([^\]\n]*)\]\([^)\n]*\)/.exec(rest);
      if (link) {
        const label = link[1]!;
        for (let k = 0; k < label.length; k++) sourcePositions.push(i + 1 + k);
        i += link[0].length;
        continue;
      }
      // Wiki link [[target|label]] or [[target]]
      const wiki = /^\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/.exec(rest);
      if (wiki) {
        const label = wiki[2] ?? wiki[1]!;
        const labelStart = wiki[2] != null ? i + 2 + wiki[1]!.length + 1 : i + 2;
        for (let k = 0; k < label.length; k++) sourcePositions.push(labelStart + k);
        i += wiki[0].length;
        continue;
      }
    }
    // Backslash escape (`\|`, `\*`, etc.)
    if (cellSource[i] === "\\" && i + 1 < cellSource.length) {
      sourcePositions.push(i + 1);
      i += 2;
      continue;
    }
    // Inline code `...`
    if (cellSource[i] === "`") {
      let ticks = 1;
      while (cellSource[i + ticks] === "`") ticks++;
      const fence = "`".repeat(ticks);
      const close = cellSource.indexOf(fence, i + ticks);
      if (close >= 0) {
        for (let k = i + ticks; k < close; k++) sourcePositions.push(k);
        i = close + ticks;
        continue;
      }
    }
    // Formatting delimiters (**, __, ~~, ==, *, _)
    if (rest.startsWith("**") || rest.startsWith("__") || rest.startsWith("~~") || rest.startsWith("==")) {
      i += 2;
      continue;
    }
    if (cellSource[i] === "*" || cellSource[i] === "_") {
      i += 1;
      continue;
    }
    sourcePositions.push(i);
    i++;
  }

  if (sourcePositions.length === 0) return cellSource.length;
  if (renderedOffset >= sourcePositions.length) return cellSource.length;
  return sourcePositions[renderedOffset]!;
}
