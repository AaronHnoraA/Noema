import { deleteBracketPair } from "@codemirror/autocomplete";
import { countColumn, EditorSelection, type Transaction } from "@codemirror/state";
import { getIndentUnit } from "@codemirror/language";
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

import {
  continueMarkdownBlock,
  exitEmptyMarkdownBlock,
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
      || deleteBracketPair(view)
      || deleteMarkupBackward(view)
      || deleteIndentUnitBackward(view)
      || deleteGraphemes(view, direction);
  }

  return deleteTexSourceAutoPairForward(view)
    || deleteGraphemes(view, direction);
}

/** Canonical Enter behavior shared by CM6, desktop and xwidget input. */
export function runEditorEnter(view: EditorView): boolean {
  if (view.state.readOnly) return true;

  // The Markdown/table helpers are intentionally single-caret commands.
  // Falling back immediately preserves CM6's native multi-selection behavior.
  if (view.state.selection.ranges.length > 1) return insertNewlineAndIndent(view);

  return tableEnterSameColumn(view)
    || exitEmptyMarkdownBlock(view)
    || continueMarkdownBlock(view)
    || insertNewlineContinueMarkup(view)
    || insertNewlineAndIndent(view);
}

/** Canonical Tab behavior shared by native CM6, desktop and xwidget input. */
export function runEditorTab(view: EditorView, shift = false): boolean {
  if (view.state.readOnly) return true;
  const direction = shift ? -1 : 1;
  return tableNavigateCell(view, direction) || indentMarkdownBlock(view, direction);
}
