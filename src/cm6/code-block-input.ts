/**
 * Typing inside a fenced code block.
 *
 * Markdown has no language for the code it fences, so CodeMirror's own
 * newline and indent commands treat code like prose. MarkText's code block
 * (`muya/src/block/content/codeBlockContent/index.ts`) shows what writing code
 * in a note needs, restated here for the source editor:
 *
 *   - Enter between a bracket pair (`{}`, `[]`, `()`, `><`) opens an indented
 *     line between them;
 *   - Tab with a bare caret inserts indentation at the caret instead of
 *     shifting the whole line; a selection still indents its lines;
 *   - Mod-Enter leaves the block for the line after its closing fence
 *     (MarkText's Shift+Enter; Noema already uses Mod-Enter to leave an
 *     org environment).
 *
 * The indentation unit is the block's own: a tab when it indents with tabs,
 * otherwise its smallest space indentation, else four spaces.
 */

import { EditorSelection, type ChangeSpec, type EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

type FencedBody = {
  /** Start of the line after the opening fence. */
  bodyFrom: number;
  /** End of the last body line (before the closing fence line), or doc end. */
  bodyTo: number;
  /** Start of the closing fence line, or null for an unclosed block. */
  closeLineFrom: number | null;
};

const OPEN_TO_CLOSE: Record<string, string> = { "{": "}", "[": "]", "(": ")", ">": "<" };
const INDENT_SCAN_LINES = 200;

/** The body of the fenced code block whose body contains POS, if any. */
export function fencedBodyAt(state: EditorState, pos: number): FencedBody | null {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + 1), 100) ?? syntaxTree(state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, -1);
  while (node && node.name !== "FencedCode") node = node.parent;
  if (!node) return null;
  const marks = node.getChildren("CodeMark");
  const open = marks[0];
  if (!open) return null;
  const doc = state.doc;
  const openLine = doc.lineAt(open.from);
  const close = marks.length > 1 ? marks[marks.length - 1]! : null;
  const closeLine = close ? doc.lineAt(close.from) : null;
  if (closeLine && closeLine.number === openLine.number) return null;
  const bodyFrom = Math.min(doc.length, openLine.to + 1);
  const bodyTo = closeLine ? Math.max(bodyFrom, closeLine.from - 1) : node.to;
  if (pos < bodyFrom || pos > bodyTo) return null;
  return { bodyFrom, bodyTo, closeLineFrom: closeLine?.from ?? null };
}

function blockIndentUnit(state: EditorState, body: FencedBody): string {
  const doc = state.doc;
  const first = doc.lineAt(body.bodyFrom).number;
  const last = Math.min(doc.lineAt(body.bodyTo).number, first + INDENT_SCAN_LINES);
  let smallest = 0;
  for (let number = first; number <= last; number++) {
    const text = doc.line(number).text;
    if (!text.trim()) continue;
    if (text.startsWith("\t")) return "\t";
    const spaces = /^ */u.exec(text)![0].length;
    if (spaces > 0 && (smallest === 0 || spaces < smallest)) smallest = spaces;
  }
  return " ".repeat(smallest > 0 && smallest <= 8 ? smallest : 4);
}

/** Enter between a bracket pair in code opens an indented line between them. */
export function explodeCodeBracketsOnEnter(view: EditorView): boolean {
  const state = view.state;
  const range = state.selection.main;
  if (state.selection.ranges.length > 1 || !range.empty) return false;
  const pos = range.head;
  const before = state.doc.sliceString(pos - 1, pos);
  const after = state.doc.sliceString(pos, pos + 1);
  if (!before || OPEN_TO_CLOSE[before] !== after) return false;
  const body = fencedBodyAt(state, pos);
  if (!body) return false;
  const line = state.doc.lineAt(pos);
  const indent = /^[ \t]*/u.exec(line.text)![0];
  const unit = blockIndentUnit(state, body);
  const insert = `\n${indent}${unit}\n${indent}`;
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + 1 + indent.length + unit.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/** Lines touched by the selection; a range ending at a line start excludes that line. */
function selectedLineNumbers(state: EditorState): number[] {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const endPos = range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
    const last = state.doc.lineAt(Math.max(range.from, endPos)).number;
    for (let number = first; number <= last; number++) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Shift every selected line one block unit right, or left when OUTDENT. */
function shiftCodeLines(view: EditorView, unit: string, outdent: boolean): boolean {
  const state = view.state;
  const changes = selectedLineNumbers(state).flatMap((number): ChangeSpec[] => {
    const line = state.doc.line(number);
    if (!outdent) return line.text.trim() ? [{ from: line.from, insert: unit }] : [];
    const leading = /^[ \t]*/u.exec(line.text)![0];
    if (!leading) return [];
    const drop = leading.startsWith("\t") ? 1 : Math.min(leading.length, unit === "\t" ? 4 : unit.length);
    return [{ from: line.from, to: line.from + drop }];
  });
  if (changes.length === 0) return true;
  view.dispatch(state.update({ changes, userEvent: outdent ? "delete.dedent" : "input.indent", scrollIntoView: true }));
  return true;
}

/** Tab / Shift-Tab inside a fenced code body. */
export function codeBlockTab(view: EditorView, shift: boolean): boolean {
  const state = view.state;
  const ranges = state.selection.ranges;
  if (!ranges.every((range) => fencedBodyAt(state, range.head) !== null)) return false;
  const body = fencedBodyAt(state, state.selection.main.head)!;
  const unit = blockIndentUnit(state, body);
  if (shift || ranges.some((range) => !range.empty)) return shiftCodeLines(view, unit, shift);
  view.dispatch(state.changeByRange((range) => {
    let insert = unit;
    if (unit !== "\t") {
      // Advance to the next indentation stop, as an editor's soft tab does.
      const column = range.head - state.doc.lineAt(range.head).from;
      insert = " ".repeat(unit.length - (column % unit.length));
    }
    return {
      changes: { from: range.head, insert },
      range: EditorSelection.cursor(range.head + insert.length),
    };
  }), { scrollIntoView: true, userEvent: "input.indent" });
  return true;
}

/** Mod-Enter in a code body moves to the line after the closing fence. */
export function exitFencedCode(view: EditorView): boolean {
  const state = view.state;
  const body = fencedBodyAt(state, state.selection.main.head);
  if (!body || body.closeLineFrom === null) return false;
  const closeLine = state.doc.lineAt(body.closeLineFrom);
  if (closeLine.to < state.doc.length) {
    const next = state.doc.line(closeLine.number + 1);
    view.dispatch({ selection: { anchor: next.text.trim() ? next.from : next.to }, scrollIntoView: true });
    return true;
  }
  view.dispatch({
    changes: { from: closeLine.to, insert: "\n" },
    selection: { anchor: closeLine.to + 1 },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}
