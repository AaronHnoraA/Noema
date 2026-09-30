/**
 * Shared scanner for code-span/code-block ranges in the current viewport.
 *
 * Several inline-preview features (inline math, links, CJK styling,
 * ==highlight==, @@commands) are driven by regex scans over raw text and must
 * NOT fire inside fenced/indented/inline code, where Markdown is meant to stay
 * literal. The Lezer syntax tree already marks these regions, so we collect them
 * once per scan and let callers exclude them.
 *
 * Performance: the walk is bounded to the supplied ranges (the caller's visible
 * ranges), and returns immediately on each code node without descending into its
 * children — so it never scans the whole document.
 */
import { syntaxTree } from "@codemirror/language";
import { StateField, type ChangeSet, type EditorState, type Extension, type Text } from "@codemirror/state";

const CODE_NODE_NAMES = new Set(["FencedCode", "CodeBlock", "IndentedCode", "InlineCode"]);
const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

export interface SourceRange {
  from: number;
  to: number;
}

/** Collect code-span/code-block ranges within `ranges`, sorted by start offset. */
export function scanCodeRanges(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (CODE_NODE_NAMES.has(node.name)) {
          out.push({ from: node.from, to: node.to });
          return false;
        }
        return true;
      },
    });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

export function isFencedCodeFenceLine(line: string): boolean {
  return FENCE_LINE_RE.test(line);
}

function fenceInfo(line: string): { char: "`" | "~"; length: number } | null {
  const match = FENCE_LINE_RE.exec(line);
  const marker = match?.[1];
  if (!marker) return null;
  return { char: marker[0] as "`" | "~", length: marker.length };
}

function fenceLineShape(line: string): string {
  const match = FENCE_LINE_RE.exec(line);
  const marker = match?.[1];
  if (!marker) return "";
  // An opener's marker and a possible closer's trailing whitespace determine
  // pairing. Editing the language name after an opener leaves both unchanged.
  return `${marker[0]}:${marker.length}:${line.slice(match[0].length).trim() === ""}`;
}

function closingFenceRe(info: { char: "`" | "~"; length: number }): RegExp {
  const ch = info.char === "`" ? "`" : "~";
  return new RegExp(`^[ \\t]{0,3}${ch}{${info.length},}[ \\t]*$`);
}

function scanFencedCodeRangesFromLine(doc: Text, startLine: number): SourceRange[] {
  const ranges: SourceRange[] = [];
  let lineNum = startLine;
  while (lineNum <= doc.lines) {
    const openLine = doc.line(lineNum);
    const info = fenceInfo(openLine.text);
    if (!info) {
      lineNum++;
      continue;
    }

    const closeRe = closingFenceRe(info);
    let closeLineNum = -1;
    for (let scanLine = lineNum + 1; scanLine <= doc.lines; scanLine++) {
      if (closeRe.test(doc.line(scanLine).text)) {
        closeLineNum = scanLine;
        break;
      }
    }

    if (closeLineNum < 0) {
      ranges.push({ from: openLine.from, to: doc.length });
      break;
    }

    ranges.push({ from: openLine.from, to: doc.line(closeLineNum).to });
    lineNum = closeLineNum + 1;
  }
  return ranges;
}

export function scanFencedCodeRangesInDoc(doc: Text): SourceRange[] {
  return scanFencedCodeRangesFromLine(doc, 1);
}

export function changesMightAffectFencedCodeRanges(doc: Text, changes: ChangeSet): boolean {
  let might = false;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (might) return;
    const removed = doc.sliceString(fromA, toA);
    const added = inserted.toString();

    const fromLine = doc.lineAt(Math.min(fromA, doc.length));
    const toLine = doc.lineAt(Math.min(Math.max(fromA, toA), doc.length));
    const oldText = doc.sliceString(fromLine.from, toLine.to);
    if (!/[`~]/.test(oldText) && !/[`~]/.test(removed) && !/[`~]/.test(added)) return;

    const relFrom = Math.max(0, fromA - fromLine.from);
    const relTo = Math.max(relFrom, toA - fromLine.from);
    const nextText = oldText.slice(0, relFrom) + added + oldText.slice(relTo);
    const oldLines = oldText.split("\n");
    const nextLines = nextText.split("\n");
    might = oldLines.length !== nextLines.length
      ? oldLines.some(isFencedCodeFenceLine) || nextLines.some(isFencedCodeFenceLine)
      : oldLines.some((line, index) => fenceLineShape(line) !== fenceLineShape(nextLines[index]!));
  });
  return might;
}

/** First unchanged line that must be replayed when fence pairing changes. */
export function fencedCodeRescanStart(
  doc: Text,
  ranges: readonly SourceRange[],
  changes: ChangeSet,
): number {
  let firstChanged = doc.length;
  changes.iterChanges((fromA) => { firstChanged = Math.min(firstChanged, fromA); });
  const changedLineFrom = doc.lineAt(firstChanged).from;
  const enclosing = ranges.find((range) => range.from <= changedLineFrom && range.to >= changedLineFrom);
  return enclosing?.from ?? changedLineFrom;
}

const fencedCodeRangesField = StateField.define<readonly SourceRange[]>({
  create: (state) => scanFencedCodeRangesInDoc(state.doc),
  update(ranges, tr) {
    if (!tr.docChanged) return ranges;
    if (changesMightAffectFencedCodeRanges(tr.startState.doc, tr.changes)) {
      const rescanFrom = fencedCodeRescanStart(tr.startState.doc, ranges, tr.changes);
      // Fence pairing before this line is unaffected. An edit inside a fence
      // restarts at its opener; the suffix may change all the way to EOF.
      const prefix = ranges.filter((range) => range.to < rescanFrom);
      return prefix.concat(scanFencedCodeRangesFromLine(
        tr.state.doc, tr.state.doc.lineAt(Math.min(rescanFrom, tr.state.doc.length)).number,
      ));
    }
    return ranges.map((range) => ({
      from: tr.changes.mapPos(range.from, -1),
      to: tr.changes.mapPos(range.to, 1),
    }));
  },
});

export const fencedCodeRangesExtension: Extension = fencedCodeRangesField;

export function getFencedCodeRanges(state: EditorState): readonly SourceRange[] {
  return state.field(fencedCodeRangesField, false) ?? scanFencedCodeRangesInDoc(state.doc);
}
