import { StateField, type ChangeSet, type EditorState, type Extension, type Text } from "@codemirror/state";

import { scanInlineCommands } from "../command-syntax.ts";
import { orgMetaSummaryRangeFromLines, type MetaSummarySourceRange } from "../org-meta.ts";
import { semanticMarkdownLevel, semanticOutlineFromCommand } from "../semantic-outline.ts";

export type MarkdownHeading = {
  /** Outline/TOC depth. Semantic outlines may demote markdown headings here. */
  level: number;
  /** Visual markdown heading depth used by the editor surface. */
  renderLevel?: number;
  text: string;
  pos: number;
  to?: number;
  markerFrom?: number;
  markerTo?: number;
  slug?: string;
  source?: "semantic" | "markdown";
  kind?: string;
  /** Excluded from [toc] widget and floating outline (heading-fold still works). */
  omit?: boolean;
};

export type InlineTagAnchor = {
  tag: string;
  pos: number;
  to: number;
  lineFrom: number;
};

export type TocIndex = {
  headings: MarkdownHeading[];
  anchors: InlineTagAnchor[];
  headingSignature: string;
  anchorSignature: string;
  hasFences: boolean;
  fenceRanges: Array<{ from: number; to: number }>;
};

type LineScan = {
  headings: MarkdownHeading[];
  anchors: InlineTagAnchor[];
  fenceToggle: boolean;
  hasSemanticHeading: boolean;
};

let sourceLinesScanned = 0;

/** Source lines visited by outline rebuilds and regional patches. */
export function tocIndexSourceLinesScanned(): number { return sourceLinesScanned; }

const FENCE_LINE_RE = /^\s*(```|~~~)/;
const OMIT_IN_TOC_RE = /<!--\s*omit\s+(?:in|from)\s+toc\s*-->\s*$/i;

function headingFromLine(text: string, from: number): MarkdownHeading | null {
  const match = text.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
  if (!match) return null;
  const rawText = match[2] ?? "";
  const renderLevel = match[1]!.length;
  const omit = OMIT_IN_TOC_RE.test(rawText);
  const cleanText = omit ? rawText.replace(OMIT_IN_TOC_RE, "").trimEnd() : rawText;
  return {
    level: renderLevel,
    renderLevel,
    text: cleanText.trim() || "Untitled",
    pos: from + Math.max(0, text.indexOf(rawText)),
    to: from + text.length,
    markerFrom: from,
    markerTo: from + Math.max(0, text.indexOf(rawText)),
    source: "markdown",
    ...(omit ? { omit: true } : {}),
  };
}

function semanticHeadingsFromLine(text: string, from: number, codeRanges = inlineCodeRanges(text)): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  for (const command of scanInlineCommands(text)) {
    if (command.name !== "part" && command.name !== "section") continue;
    if (overlapsRange(command.fullFrom, command.fullTo, codeRanges)) continue;
    const outline = semanticOutlineFromCommand(command);
    if (!outline) continue;
    headings.push({
      level: outline.level,
      text: outline.text,
      pos: from + command.contextFrom,
      to: from + command.contextTo,
      slug: outline.slug,
      source: "semantic",
      kind: outline.kind,
    });
  }
  return headings;
}

function inlineCodeRanges(line: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  const re = /`[^`\n]*`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  return ranges;
}

function overlapsRange(from: number, to: number, ranges: Array<{ from: number; to: number }>): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

function scanLine(text: string, from: number, inFence: boolean, hasSemanticInDocument = false): LineScan {
  const fenceToggle = FENCE_LINE_RE.test(text);
  if (inFence || fenceToggle) {
    return {
      headings: [],
      anchors: [],
      fenceToggle,
      hasSemanticHeading: false,
    };
  }

  const anchors: InlineTagAnchor[] = [];
  const codeRanges = inlineCodeRanges(text);
  const semanticHeadings = semanticHeadingsFromLine(text, from, codeRanges);
  for (const command of scanInlineCommands(text, "tag")) {
    if (overlapsRange(command.fullFrom, command.fullTo, codeRanges)) continue;
    const tag = command.context.trim().replace(/^#/, "");
    if (!tag) continue;
    anchors.push({
      tag,
      pos: from + command.contextFrom,
      to: from + command.contextTo,
      lineFrom: from,
    });
  }

  const markdownHeading = headingFromLine(text, from);
  const headings = [
    ...semanticHeadings,
    ...(markdownHeading ? [{ ...markdownHeading, level: semanticMarkdownLevel(markdownHeading.level, hasSemanticInDocument) }] : []),
  ];
  return { headings, anchors, fenceToggle, hasSemanticHeading: semanticHeadings.length > 0 };
}

function sortHeadings(items: MarkdownHeading[]): MarkdownHeading[] {
  return items.sort((a, b) => a.pos - b.pos || a.level - b.level || a.text.localeCompare(b.text));
}

function sortAnchors(items: InlineTagAnchor[]): InlineTagAnchor[] {
  return items.sort((a, b) => a.pos - b.pos || a.to - b.to || a.tag.localeCompare(b.tag));
}

function firstAtOrAfter<T>(items: readonly T[], position: number, start: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (start(items[middle]!) < position) low = middle + 1;
    else high = middle;
  }
  return low;
}

function headingSignature(headings: readonly MarkdownHeading[]): string {
  return headings.map((heading) => `${heading.source || "markdown"}:${heading.level}:${heading.pos}:${heading.text}:${heading.slug || ""}:${heading.omit ? 1 : 0}`).join("\n");
}

function anchorSignature(anchors: readonly InlineTagAnchor[]): string {
  return anchors.map((anchor) => `${anchor.lineFrom}:${anchor.pos}:${anchor.tag}`).join("\n");
}

function buildTocIndex(
  headings: MarkdownHeading[],
  anchors: InlineTagAnchor[],
  fenceRanges: Array<{ from: number; to: number }>,
  sorted = false,
): TocIndex {
  const sortedHeadings = sorted ? headings : sortHeadings(headings);
  const sortedAnchors = sorted ? anchors : sortAnchors(anchors);
  return {
    headings: sortedHeadings,
    anchors: sortedAnchors,
    headingSignature: headingSignature(sortedHeadings),
    anchorSignature: anchorSignature(sortedAnchors),
    hasFences: fenceRanges.length > 0,
    fenceRanges,
  };
}

export function markdownHeadingsFromText(doc: Text): MarkdownHeading[] {
  return outlineHeadingsFromText(doc);
}

function lineInsideSourceRange(line: { from: number; to: number }, range: MetaSummarySourceRange | null): boolean {
  return Boolean(range && line.from >= range.from && line.to <= range.to);
}

function docHasSemanticHeading(
  doc: Text,
  metaSummaryRange = orgMetaSummaryRangeFromLines(doc),
): boolean {
  let inFence = false;
  for (let lineNo = 1; lineNo <= doc.lines; lineNo += 1) {
    const line = doc.line(lineNo);
    if (lineInsideSourceRange(line, metaSummaryRange)) continue;
    const fenceToggle = FENCE_LINE_RE.test(line.text);
    if (fenceToggle) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (semanticHeadingsFromLine(line.text, line.from).length > 0) return true;
  }
  return false;
}

export function outlineHeadingsFromText(doc: Text): MarkdownHeading[] {
  const metaSummaryRange = orgMetaSummaryRangeFromLines(doc);
  const hasSemantic = docHasSemanticHeading(doc, metaSummaryRange);
  const headings: MarkdownHeading[] = [];
  let inFence = false;
  for (let lineNo = 1; lineNo <= doc.lines; lineNo += 1) {
    const line = doc.line(lineNo);
    if (lineInsideSourceRange(line, metaSummaryRange)) continue;
    const scan = scanLine(line.text, line.from, inFence, hasSemantic);
    headings.push(...scan.headings);
    if (scan.fenceToggle) inFence = !inFence;
  }
  return sortHeadings(headings);
}

function linesFromString(markdown: string): Array<{ text: string; from: number }> {
  const lines: Array<{ text: string; from: number }> = [];
  let from = 0;
  for (const text of markdown.split("\n")) {
    const clean = text.endsWith("\r") ? text.slice(0, -1) : text;
    lines.push({ text: clean, from });
    from += text.length + 1;
  }
  return lines;
}

export function inlineTagAnchorsFromText(doc: Text | string): InlineTagAnchor[] {
  const anchors: InlineTagAnchor[] = [];
  let inFence = false;
  const pushLine = (text: string, from: number, excluded = false): void => {
    if (excluded) return;
    const scan = scanLine(text, from, inFence);
    anchors.push(...scan.anchors);
    if (scan.fenceToggle) inFence = !inFence;
  };

  if (typeof doc === "string") {
    const lines = linesFromString(doc);
    const lineDoc = {
      lines: lines.length,
      line: (number: number) => {
        const line = lines[number - 1]!;
        return { ...line, to: line.from + line.text.length };
      },
    };
    const metaSummaryRange = orgMetaSummaryRangeFromLines(lineDoc);
    for (const line of lines) {
      pushLine(
        line.text,
        line.from,
        lineInsideSourceRange({ from: line.from, to: line.from + line.text.length }, metaSummaryRange),
      );
    }
    return anchors;
  }

  const metaSummaryRange = orgMetaSummaryRangeFromLines(doc);
  for (let lineNo = 1; lineNo <= doc.lines; lineNo += 1) {
    const line = doc.line(lineNo);
    pushLine(line.text, line.from, lineInsideSourceRange(line, metaSummaryRange));
  }
  return anchors;
}

function collectTocIndex(doc: Text): TocIndex {
  sourceLinesScanned += doc.lines;
  const headings: MarkdownHeading[] = [];
  const anchors: InlineTagAnchor[] = [];
  const fenceRanges: Array<{ from: number; to: number }> = [];
  let inFence = false;
  let fenceFrom = -1;
  const metaSummaryRange = orgMetaSummaryRangeFromLines(doc);
  const hasSemantic = docHasSemanticHeading(doc, metaSummaryRange);

  for (let lineNo = 1; lineNo <= doc.lines; lineNo += 1) {
    const line = doc.line(lineNo);
    if (lineInsideSourceRange(line, metaSummaryRange)) continue;
    const scan = scanLine(line.text, line.from, inFence, hasSemantic);
    headings.push(...scan.headings);
    anchors.push(...scan.anchors);
    if (scan.fenceToggle) {
      if (!inFence) {
        fenceFrom = line.from;
      } else if (fenceFrom >= 0) {
        fenceRanges.push({ from: fenceFrom, to: line.to });
        fenceFrom = -1;
      }
      inFence = !inFence;
    }
  }
  if (inFence && fenceFrom >= 0) fenceRanges.push({ from: fenceFrom, to: doc.length });

  return buildTocIndex(headings, anchors, fenceRanges);
}

function changedRange(doc: Text, changes: ChangeSet): {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
  textTouchesFence: boolean;
  textTouchesHeading: boolean;
} | null {
  let oldFrom = Number.POSITIVE_INFINITY;
  let oldTo = 0;
  let newFrom = Number.POSITIVE_INFINITY;
  let newTo = 0;
  let textTouchesFence = false;
  let textTouchesHeading = false;

  const textContainsFenceLine = (text: string): boolean => (
    text.split("\n").some((line) => FENCE_LINE_RE.test(line))
  );

  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    oldFrom = Math.min(oldFrom, fromA);
    oldTo = Math.max(oldTo, toA);
    newFrom = Math.min(newFrom, fromB);
    newTo = Math.max(newTo, toB);
    const insertedText = inserted.toString();
    const removedText = doc.sliceString(fromA, toA);
    if (textContainsFenceLine(insertedText)) textTouchesFence = true;
    if (textContainsFenceLine(removedText)) textTouchesFence = true;
    if (/@@(?:part|section)(?:\(|[ \t]+\[)|^\s{0,3}#{1,6}\s/m.test(insertedText) || /@@(?:part|section)(?:\(|[ \t]+\[)|^\s{0,3}#{1,6}\s/m.test(removedText)) textTouchesHeading = true;
  });

  if (!Number.isFinite(oldFrom)) return null;
  return { oldFrom, oldTo, newFrom, newTo, textTouchesFence, textTouchesHeading };
}

function lineWindow(doc: Text, from: number, to: number): { from: number; to: number; startLine: number; endLine: number } {
  const start = doc.lineAt(Math.max(0, Math.min(from, doc.length)));
  const endPos = Math.max(0, Math.min(to, doc.length));
  const end = doc.lineAt(endPos);
  return {
    from: start.from,
    to: end.to,
    startLine: start.number,
    endLine: end.number,
  };
}

function oldWindowTouchesFence(doc: Text, window: { startLine: number; endLine: number }): boolean {
  for (let lineNo = window.startLine; lineNo <= window.endLine; lineNo += 1) {
    if (FENCE_LINE_RE.test(doc.line(lineNo).text)) return true;
  }
  return false;
}

function fenceWindowStructureStable(
  oldDoc: Text,
  nextDoc: Text,
  oldWindow: { startLine: number; endLine: number },
  nextWindow: { startLine: number; endLine: number },
): boolean {
  if (oldWindow.endLine - oldWindow.startLine !== nextWindow.endLine - nextWindow.startLine) return false;
  for (let offset = 0; offset <= oldWindow.endLine - oldWindow.startLine; offset += 1) {
    if (FENCE_LINE_RE.test(oldDoc.line(oldWindow.startLine + offset).text)
        !== FENCE_LINE_RE.test(nextDoc.line(nextWindow.startLine + offset).text)) return false;
  }
  return true;
}

function lineInsideFence(from: number, to: number, fenceRanges: readonly { from: number; to: number }[]): boolean {
  return fenceRanges.some((range) => from >= range.from && to <= range.to);
}

function mapFenceRange(range: { from: number; to: number }, changes: ChangeSet): { from: number; to: number } {
  return {
    from: changes.mapPos(range.from, -1),
    to: changes.mapPos(range.to, 1),
  };
}

function mapHeading(heading: MarkdownHeading, changes: ChangeSet): MarkdownHeading {
  return {
    ...heading,
    pos: changes.mapPos(heading.pos, 1),
    to: heading.to == null ? undefined : changes.mapPos(heading.to, 1),
    markerFrom: heading.markerFrom == null ? undefined : changes.mapPos(heading.markerFrom, 1),
    markerTo: heading.markerTo == null ? undefined : changes.mapPos(heading.markerTo, 1),
  };
}

function mapAnchor(anchor: InlineTagAnchor, changes: ChangeSet): InlineTagAnchor {
  return {
    ...anchor,
    pos: changes.mapPos(anchor.pos, 1),
    to: changes.mapPos(anchor.to, 1),
    lineFrom: changes.mapPos(anchor.lineFrom, 1),
  };
}

function patchTocIndexFromFenceLine(
  index: TocIndex,
  oldDoc: Text,
  nextDoc: Text,
  from: number,
): TocIndex {
  const lineFrom = oldDoc.lineAt(Math.min(from, oldDoc.length)).from;
  const enclosing = index.fenceRanges.find((range) => range.from <= lineFrom && range.to >= lineFrom);
  const rescanFrom = enclosing?.from ?? lineFrom;
  const headings = index.headings.filter((heading) => heading.pos < rescanFrom);
  const anchors = index.anchors.filter((anchor) => anchor.lineFrom < rescanFrom);
  const fenceRanges = index.fenceRanges.filter((range) => range.to < rescanFrom);
  const metaSummaryRange = orgMetaSummaryRangeFromLines(nextDoc);
  let inFence = false;
  let fenceFrom = -1;
  const startLine = nextDoc.lineAt(Math.min(rescanFrom, nextDoc.length)).number;
  sourceLinesScanned += nextDoc.lines - startLine + 1;
  for (let lineNo = startLine;
       lineNo <= nextDoc.lines; lineNo += 1) {
    const line = nextDoc.line(lineNo);
    if (lineInsideSourceRange(line, metaSummaryRange)) continue;
    const scan = scanLine(line.text, line.from, inFence);
    headings.push(...scan.headings);
    anchors.push(...scan.anchors);
    if (scan.fenceToggle) {
      if (!inFence) fenceFrom = line.from;
      else if (fenceFrom >= 0) {
        fenceRanges.push({ from: fenceFrom, to: line.to });
        fenceFrom = -1;
      }
      inFence = !inFence;
    }
  }
  if (inFence && fenceFrom >= 0) fenceRanges.push({ from: fenceFrom, to: nextDoc.length });

  // Semantic headings change the level of Markdown headings across the whole
  // note. Recompute that one derived number from the indexed headings instead
  // of scanning every source line a second time.
  const hasSemantic = headings.some((heading) => heading.source === "semantic");
  const normalized = headings.map((heading) => {
    if (heading.source !== "markdown") return heading;
    const level = semanticMarkdownLevel(heading.renderLevel ?? heading.level, hasSemantic);
    return level === heading.level ? heading : { ...heading, level };
  });
  return buildTocIndex(normalized, anchors, fenceRanges);
}

function patchTocIndex(index: TocIndex, startDoc: Text, nextDoc: Text, changes: ChangeSet): TocIndex | null {
  const range = changedRange(startDoc, changes);
  if (!range) return index;
  const oldMetaSummary = orgMetaSummaryRangeFromLines(startDoc);
  const nextMetaSummary = orgMetaSummaryRangeFromLines(nextDoc);
  if (
    (oldMetaSummary && range.oldFrom <= oldMetaSummary.to)
    || (nextMetaSummary && range.newFrom <= nextMetaSummary.to)
  ) return null;
  const oldWindow = lineWindow(startDoc, range.oldFrom, range.oldTo);
  const nextWindow = lineWindow(nextDoc, range.newFrom, range.newTo);
  const stableFences = fenceWindowStructureStable(startDoc, nextDoc, oldWindow, nextWindow);
  if (!stableFences && (range.textTouchesFence || oldWindowTouchesFence(startDoc, oldWindow))) {
    return patchTocIndexFromFenceLine(index, startDoc, nextDoc, range.oldFrom);
  }
  if (range.textTouchesHeading) return null;
  const nextFenceRanges = index.fenceRanges.map((fenceRange) => mapFenceRange(fenceRange, changes));
  sourceLinesScanned += nextWindow.endLine - nextWindow.startLine + 1;

  const headings = index.headings
    .filter((heading) => heading.pos < oldWindow.from || heading.pos > oldWindow.to)
    .map((heading) => heading.pos < oldWindow.from ? heading : mapHeading(heading, changes));
  const anchors = index.anchors
    .filter((anchor) => anchor.lineFrom < oldWindow.from || anchor.lineFrom > oldWindow.to)
    .map((anchor) => anchor.lineFrom < oldWindow.from ? anchor : mapAnchor(anchor, changes));

  const rescannedHeadings: MarkdownHeading[] = [];
  const rescannedAnchors: InlineTagAnchor[] = [];
  const hasSemanticHeading = index.headings.some((heading) => heading.source === "semantic");
  for (let lineNo = nextWindow.startLine; lineNo <= nextWindow.endLine; lineNo += 1) {
    const line = nextDoc.line(lineNo);
    const scan = scanLine(line.text, line.from, lineInsideFence(line.from, line.to, nextFenceRanges), hasSemanticHeading);
    if (scan.fenceToggle && !stableFences) {
      return patchTocIndexFromFenceLine(index, startDoc, nextDoc, range.oldFrom);
    }
    if (scan.hasSemanticHeading && !hasSemanticHeading) return null;
    rescannedHeadings.push(...scan.headings);
    rescannedAnchors.push(...scan.anchors);
  }
  // Removing the final semantic heading restores the original Markdown
  // outline levels everywhere, including headings outside this line window.
  if (hasSemanticHeading && !headings.some((heading) => heading.source === "semantic")
      && !rescannedHeadings.some((heading) => heading.source === "semantic")) return null;
  // Mapping preserves the order of untouched entries. Only the changed line
  // window needs sorting; splice it back at its source position instead of
  // sorting every heading and tag in a multi-megabyte note on each keystroke.
  sortHeadings(rescannedHeadings);
  sortAnchors(rescannedAnchors);
  const headingInsert = firstAtOrAfter(headings, nextWindow.from, (heading) => heading.pos);
  const anchorInsert = firstAtOrAfter(anchors, nextWindow.from, (anchor) => anchor.lineFrom);
  const nextHeadings = headings.slice(0, headingInsert).concat(rescannedHeadings, headings.slice(headingInsert));
  const nextAnchors = anchors.slice(0, anchorInsert).concat(rescannedAnchors, anchors.slice(anchorInsert));
  return buildTocIndex(nextHeadings, nextAnchors, nextFenceRanges, true);
}

const tocIndexField = StateField.define<TocIndex>({
  create: (state) => collectTocIndex(state.doc),
  update(index, tr) {
    if (!tr.docChanged) return index;
    return patchTocIndex(index, tr.startState.doc, tr.state.doc, tr.changes)
      ?? collectTocIndex(tr.state.doc);
  },
});

export const tocIndexExtension: Extension = tocIndexField;

export function tocIndexFromState(state: EditorState): TocIndex {
  return state.field(tocIndexField, false) ?? collectTocIndex(state.doc);
}
