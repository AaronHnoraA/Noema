import { deleteBracketPair } from "@codemirror/autocomplete";
import { countColumn, EditorSelection, type Transaction } from "@codemirror/state";
import { ensureSyntaxTree, getIndentUnit, syntaxTree } from "@codemirror/language";
import {
  cursorCharLeft,
  cursorCharRight,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorLineDown,
  cursorLineUp,
  cursorPageDown,
  cursorPageUp,
  insertNewlineAndIndent,
  selectCharLeft,
  selectCharRight,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
  selectLineDown,
  selectLineUp,
  selectPageDown,
  selectPageUp,
} from "@codemirror/commands";
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkup,
} from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";

import { inlineFormatExitTarget } from "./inline-format.ts";

import { codeBlockTab, explodeCodeBracketsOnEnter, fencedBodyAt } from "./code-block-input.ts";
import { getFencedCodeRanges } from "./code-ranges.ts";
import { getBlockMathRanges } from "./math-ranges.ts";
import {
  closeFencedCodeOnEnter,
  closeHtmlBlockOnEnter,
  continueMarkdownBlock,
  exitEmptyMarkdownBlock,
  insertLineBeforeHeading,
  indentMarkdownBlock,
  tableEnterSameColumn,
  tableNavigateCell,
} from "./commands/index.ts";
import {
  deleteTexSourceAutoPair,
  deleteTexSourceAutoPairForward,
} from "./tex-source-input.ts";
import { nextGraphemePosition, previousGraphemePosition } from "./text-boundaries.ts";
import {
  activateInlineMathFromArrow,
  moveInsertLineWithDisplayMathEntry,
  orgEnvExitTarget,
} from "./extensions/visual/index.ts";

export type EditorDeleteDirection = "backward" | "forward";
export type EditorMovementKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";
export type EditorMovementResult = false | "cursor" | "formula";

type EditorInputHandler = (
  view: EditorView,
  from: number,
  to: number,
  text: string,
  insert: () => Transaction,
) => boolean;

/** Run host-injected text through the same handlers as native CM6 typing. */
export function runEditorTextInput(view: EditorView, text: string): boolean {
  if (!text) return false;
  if (view.state.readOnly) return true;
  const selection = view.state.selection.main;
  const handlers = view.state.facet(EditorView.inputHandler) as readonly EditorInputHandler[];
  let defaultTransaction: Transaction | undefined;
  const defaultInsert = () => defaultTransaction ??= view.state.update(
    view.state.replaceSelection(text),
    { scrollIntoView: true, userEvent: "input.type" },
  );
  for (const handler of handlers) {
    if (handler(view, selection.from, selection.to, text, defaultInsert)) return true;
  }
  view.dispatch(defaultInsert());
  return true;
}

const TRAILING_FENCE_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*$/u;
const TRAILING_RULE_RE = /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;

function lastLineEndsRenderedBlock(view: EditorView): boolean {
  const state = view.state;
  const line = state.doc.line(state.doc.lines);
  if (TRAILING_RULE_RE.test(line.text)) return true;
  if (TRAILING_FENCE_RE.test(line.text)) {
    // An unmatched opening fence also has this shape. Only a paired closer
    // gives the user a rendered block to move below.
    return getFencedCodeRanges(state).some((range) => range.to === line.to && range.from < line.from);
  }
  if (/^[ \t]*\\\][ \t]*$/u.test(line.text)) {
    return getBlockMathRanges(state).some((range) => range.to === line.to);
  }
  if (/^[ \t]*\|.*\|[ \t]*$/u.test(line.text)) {
    // A lone pipe row is prose. Check the Markdown parser's actual table node
    // instead of treating the row's punctuation as proof of a table.
    const tree = ensureSyntaxTree(state, line.to, 25) ?? syntaxTree(state);
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(line.to - 1, -1); node; node = node.parent) {
      if (node.name === "Table") return true;
    }
    return false;
  }
  if (/^#\+end\b/iu.test(line.text)) return orgEnvExitTarget(state) === line.to;
  return false;
}

/**
 * ArrowDown on the document's last line, when that line ends a table, code
 * fence, display formula, environment or rule, opens an empty line below and
 * moves there. Otherwise the caret could never get below a block that ends the
 * note, and the next keystroke was appended to the block's own source
 * (`\`\`\`x`, `| 2 |x`). MarkText's `arrowHandler` appends a paragraph the same way.
 */
export function openLineAfterTrailingBlock(view: EditorView): boolean {
  const state = view.state;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1 || state.readOnly) return false;
  const line = state.doc.lineAt(range.head);
  // ArrowDown from inside the last source line may still move through a
  // wrapped visual line. Only the end of the document needs an escape line.
  if (range.head !== state.doc.length || line.number !== state.doc.lines || !lastLineEndsRenderedBlock(view)) return false;
  view.dispatch(state.update({
    changes: { from: line.to, insert: "\n" },
    selection: EditorSelection.cursor(line.to + 1),
    scrollIntoView: true,
    userEvent: "input",
  }));
  return true;
}

/** Canonical Insert-mode movement, including visual-math entry boundaries. */
export function runEditorMovement(
  view: EditorView,
  key: EditorMovementKey,
  extend = false,
): EditorMovementResult {
  if (!extend && (key === "ArrowLeft" || key === "ArrowRight")
      && activateInlineMathFromArrow(view, key)) return "formula";

  if (!extend && (key === "ArrowUp" || key === "ArrowDown")) {
    const moved = moveInsertLineWithDisplayMathEntry(view, key === "ArrowDown");
    if (moved) return moved;
  }
  if (!extend && key === "ArrowDown" && openLineAfterTrailingBlock(view)) return "cursor";

  const command = key === "ArrowLeft" ? (extend ? selectCharLeft : cursorCharLeft)
    : key === "ArrowRight" ? (extend ? selectCharRight : cursorCharRight)
      : key === "ArrowUp" ? (extend ? selectLineUp : cursorLineUp)
        : key === "ArrowDown" ? (extend ? selectLineDown : cursorLineDown)
          : key === "Home" ? (extend ? selectLineBoundaryBackward : cursorLineBoundaryBackward)
            : key === "End" ? (extend ? selectLineBoundaryForward : cursorLineBoundaryForward)
              : key === "PageUp" ? (extend ? selectPageUp : cursorPageUp)
                : (extend ? selectPageDown : cursorPageDown);
  return command(view) ? "cursor" : false;
}

/**
 * Backspace inside a line's leading whitespace removes a whole indent step.
 *
 * Tab inserts one indent unit, so deleting a single space made indentation
 * asymmetric: Tab then Backspace did not return the line to where it started.
 * This is CodeMirror's own `deleteCharBackward` rule; Noema's delete chain
 * bottoms out in a grapheme delete instead, so it has to be applied here.
 *
 * Only pure leading whitespace qualifies — a space between words is still one
 * character, and a literal tab is deleted whole.
 */
function deleteIndentUnitBackward(view: EditorView): boolean {
  const state = view.state;
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
  const before = line.text.slice(0, range.head - line.from);
  if (!before || /[^ \t]/u.test(before)) return false;
  if (before.endsWith("\t")) return false;

  const unit = getIndentUnit(state);
  if (unit <= 1) return false;
  const column = countColumn(before, state.tabSize);
  const drop = column % unit || unit;
  let from = range.head;
  for (let step = 0; step < drop && line.text[from - line.from - 1] === " "; step++) from--;
  if (from >= range.head) return false;

  view.dispatch(state.update({
    changes: { from, to: range.head },
    selection: EditorSelection.cursor(from),
    scrollIntoView: true,
    userEvent: "delete.backward",
  }));
  return true;
}

/**
 * Backspace right after a task box removes the box and keeps the list item:
 * `- [ ] |task` becomes `- |task`, and the next Backspace leaves the list.
 *
 * `deleteMarkupBackward` drops the whole `- [ ] ` at once, taking two levels
 * of structure with one key. Removing one level per press matches the empty
 * quoted list item exit and Typora; MarkText's own step lands on a paragraph,
 * which the following Backspace reaches here too.
 */
function deleteTaskBoxBackward(view: EditorView): boolean {
  const state = view.state;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(range.head);
  const before = line.text.slice(0, range.head - line.from);
  const match = /^((?:[ \t]{0,3}>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[[ xX]\][ \t]+$/u.exec(before);
  if (!match) return false;
  const from = line.from + match[1]!.length;
  view.dispatch(state.update({
    changes: { from, to: range.head },
    selection: EditorSelection.cursor(from),
    scrollIntoView: true,
    userEvent: "delete.backward",
  }));
  return true;
}

/**
 * Backspace at the start of a heading's text turns the heading back into a
 * paragraph, as MarkText's `AtxHeadingContent.backspaceHandler` and Typora
 * do. Deleting one character left `#Title`, which is no heading at all and
 * shows its `#` as text.
 */
function deleteHeadingMarkerBackward(view: EditorView): boolean {
  const state = view.state;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(range.head);
  const match = /^((?:[ \t]{0,3}>[ \t]?)*)[ \t]{0,3}#{1,6}[ \t]+/u.exec(line.text);
  if (!match || range.head !== line.from + match[0].length) return false;
  const from = line.from + match[1]!.length;
  view.dispatch(state.update({
    changes: { from, to: range.head },
    selection: EditorSelection.cursor(from),
    scrollIntoView: true,
    userEvent: "delete.backward",
  }));
  return true;
}

const STRUCTURAL_LINE_RE = /^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(?:`{3,}|~{3,}|\|.*\||\\\[|\\\]|(?:\*[ \t]*){3,}$|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$)/u;
const NEXT_BLOCK_PREFIX_RE = /^(?:[ \t]{0,3}>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)?/u;

/**
 * Delete at the end of a line joins the next block's text, not its markup.
 *
 * Joining raw lines pulled the hidden marker into view: `para` + `- item`
 * became `para- item`, `- a` + `- b` became `- a- b`. MarkText's
 * `Format.deleteHandler` appends the next paragraph's text and leaves code
 * and tables alone; a fence, table row, rule or display-math delimiter on
 * either side is likewise left unjoined here rather than broken.
 */
function deleteForwardJoinBlock(view: EditorView): boolean {
  const state = view.state;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(range.head);
  if (range.head !== line.to || line.number >= state.doc.lines) return false;
  const next = state.doc.line(line.number + 1);
  if (!next.text.trim()) return false;
  if (fencedBodyAt(state, range.head) && fencedBodyAt(state, next.from)) return false;
  if (STRUCTURAL_LINE_RE.test(line.text) || STRUCTURAL_LINE_RE.test(next.text)) return true;
  const prefix = NEXT_BLOCK_PREFIX_RE.exec(next.text)?.[0] ?? "";
  if (!/[>\-*+#.)\]]/u.test(prefix)) return false;
  view.dispatch(state.update({
    changes: { from: line.to, to: next.from + prefix.length },
    selection: EditorSelection.cursor(line.to),
    scrollIntoView: true,
    userEvent: "delete.forward",
  }));
  return true;
}

/**
 * The source range of the image (with any trailing `{...}` layout attributes)
 * that ends at POS, or that starts at POS when looking forward.
 */
function imageSourceAt(view: EditorView, pos: number, direction: EditorDeleteDirection): { from: number; to: number } | null {
  const state = view.state;
  const line = state.doc.lineAt(pos);
  const tree = ensureSyntaxTree(state, line.to, 25) ?? syntaxTree(state);
  const imageAt = (at: number, side: -1 | 1) => {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(at, side); node; node = node.parent) {
      if (node.name === "Image") return node;
    }
    return null;
  };
  const withAttrs = (from: number, to: number): { from: number; to: number } => {
    const rest = state.doc.sliceString(to, line.to);
    const attrs = /^\{[^{}\n]*\}/u.exec(rest);
    return { from, to: attrs ? to + attrs[0].length : to };
  };
  if (direction === "forward") {
    const image = imageAt(pos, 1);
    return image && image.from === pos ? withAttrs(image.from, image.to) : null;
  }
  let image = imageAt(pos, -1);
  if (image && image.to === pos) return withAttrs(image.from, image.to);
  if (state.doc.sliceString(pos - 1, pos) !== "}") return null;
  const open = state.doc.sliceString(line.from, pos).lastIndexOf("{");
  if (open < 0) return null;
  image = imageAt(line.from + open, -1);
  if (!image || image.to !== line.from + open) return null;
  const range = withAttrs(image.from, image.to);
  return range.to === pos ? range : null;
}

/**
 * Backspace after an image (Delete before one) selects it first; the next
 * press deletes it whole. One character at a time turned the picture into
 * broken source (`![](a.png`). MarkText selects the image the same way.
 */
function selectImageBeforeDelete(view: EditorView, direction: EditorDeleteDirection): boolean {
  const range = view.state.selection.main;
  if (!range.empty || view.state.selection.ranges.length > 1) return false;
  const image = imageSourceAt(view, range.head, direction);
  if (!image) return false;
  view.dispatch({
    selection: direction === "backward"
      ? EditorSelection.range(image.to, image.from)
      : EditorSelection.range(image.from, image.to),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

function deleteGraphemes(view: EditorView, direction: EditorDeleteDirection): boolean {
  let changed = false;
  const spec = view.state.changeByRange((range) => {
    const from = range.empty && direction === "backward"
      ? previousGraphemePosition(view.state.doc, range.from)
      : range.from;
    const to = range.empty && direction === "forward"
      ? nextGraphemePosition(view.state.doc, range.to)
      : range.to;
    if (from >= to) return { range };
    changed = true;
    return {
      changes: { from, to },
      range: EditorSelection.cursor(from),
    };
  });
  if (!changed) return false;
  view.dispatch(view.state.update(spec, {
    scrollIntoView: true,
    userEvent: direction === "backward" ? "delete.backward" : "delete.forward",
  }));
  return true;
}

/**
 * Canonical deletion for every host input path.
 *
 * Keep the ordering here instead of in DOM adapters.  In particular, calling
 * `replaceMarkdownRange` from a capture-phase handler used to bypass TeX pair
 * ownership, CodeMirror's close-bracket markers, Markdown marker outdent and
 * all secondary selections.
 */
export function runEditorDelete(
  view: EditorView,
  direction: EditorDeleteDirection,
): boolean {
  if (view.state.readOnly) return true;

  // A selection always wins over structural caret-only deletion.  The CM6
  // commands operate over every range and keep one coherent undo transaction.
  if (view.state.selection.ranges.some((range) => !range.empty)) {
    return deleteGraphemes(view, direction);
  }

  if (direction === "backward") {
    return deleteTexSourceAutoPair(view)
      || selectImageBeforeDelete(view, direction)
      || deleteBracketPair(view)
      || deleteTaskBoxBackward(view)
      || deleteHeadingMarkerBackward(view)
      || deleteMarkupBackward(view)
      || deleteIndentUnitBackward(view)
      || deleteGraphemes(view, direction);
  }

  return deleteTexSourceAutoPairForward(view)
    || selectImageBeforeDelete(view, direction)
    || deleteForwardJoinBlock(view)
    || deleteGraphemes(view, direction);
}

/** Canonical Enter behavior shared by native CM6 and xwidget input. */
export function runEditorEnter(view: EditorView): boolean {
  if (view.state.readOnly) return true;

  const run = (): boolean => {
    // The Markdown/table helpers are intentionally single-caret commands.
    // Falling back immediately preserves CM6's native multi-selection behavior.
    if (view.state.selection.ranges.length > 1) return insertNewlineAndIndent(view);

    return tableEnterSameColumn(view)
      || explodeCodeBracketsOnEnter(view)
      || closeFencedCodeOnEnter(view)
      || closeHtmlBlockOnEnter(view)
      || insertLineBeforeHeading(view)
      || exitEmptyMarkdownBlock(view)
      || continueMarkdownBlock(view)
      || insertNewlineContinueMarkup(view)
      || insertNewlineAndIndent(view);
  };

  return run();
}

/** Tab at the end of an inline span's content moves past its closing markup. */
function tabPastInlineFormat(view: EditorView): boolean {
  const state = view.state;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const target = inlineFormatExitTarget(state, range.head);
  if (target == null) return false;
  view.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true, userEvent: "select" });
  return true;
}

/** The prefix that keeps a new line inside TEXT's list item or quote, without a new marker. */
export function markdownSoftBreakPrefix(text: string): string {
  const item = /^((?:[ \t]{0,3}>[ \t]?)*)([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/u.exec(text);
  if (item) return `${item[1] ?? ""}${" ".repeat((item[2] ?? "").length)}`;
  const quote = /^((?:[ \t]{0,3}>[ \t]?)+)/u.exec(text);
  if (quote) return quote[1]!.endsWith(" ") || quote[1]!.endsWith("\t") ? quote[1]! : `${quote[1]!} `;
  // A continuation line already indented to an item's content keeps it.
  return /^[ \t]+(?=\S)/u.exec(text)?.[0] ?? "";
}

/**
 * Shift-Enter: a new line in the same paragraph, list item or quote — the
 * item's content indentation or the quote marker, never a new bullet
 * (HyperMD's `newline`, MarkText's soft break). A bare newline let the text
 * fall out of a quote's source and lazily join list text at column 0.
 */
export function runEditorSoftBreak(view: EditorView): boolean {
  if (view.state.readOnly) return true;
  const state = view.state;
  if (state.selection.ranges.length > 1 || fencedBodyAt(state, state.selection.main.head)) return insertNewlineAndIndent(view);
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  const insert = `\n${markdownSoftBreakPrefix(line.text)}`;
  view.dispatch(state.update({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(range.from + insert.length),
    scrollIntoView: true,
    userEvent: "input",
  }));
  return true;
}

/** Canonical Tab behavior shared by native CM6 and xwidget input. */
export function runEditorTab(view: EditorView, shift = false): boolean {
  if (view.state.readOnly) return true;
  const direction = shift ? -1 : 1;
  return tableNavigateCell(view, direction)
    || codeBlockTab(view, shift)
    || (!shift && tabPastInlineFormat(view))
    || indentMarkdownBlock(view, direction);
}
