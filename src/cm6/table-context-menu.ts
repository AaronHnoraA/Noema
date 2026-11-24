/**
 * Shared Obsidian/Typora-style table context menu and mutation helpers.
 *
 * Works identically whether the user right-clicks a preview TableWidget cell,
 * clicks a row/column drag handle, or right-clicks inside the live CM6 editing
 * grid (.cm-table-source-row). Every document write goes through
 * `dispatchConstructEdit` so each table action is one undoable step.
 */

import type { EditorView } from "@codemirror/view";
import type { NoemaMenuItem } from "../menu-system.ts";
import { writeSystemClipboard } from "../system-clipboard.ts";
import { readLayoutAttrsLine } from "../layout-attrs.ts";
import { dispatchConstructEdit } from "./extensions/visual/constructs/index.ts";
import { getFencedCodeRanges } from "./code-ranges.ts";
import { getBlockMathRanges } from "./math-ranges.ts";
import {
  buildMarkdownTableSource,
  formatTableLines,
  parseMarkdownTable,
  parseTableModel,
  sortTableBodyRows,
  tableRowsToCSV,
  tableTooLarge,
  type MarkdownTableData,
  type TableCellAlign,
} from "./table-model.ts";
import {
  findTableAtPos,
  tableCellColumnAtOffset,
  tableCellTarget,
} from "./table-source-cells.ts";
import { preserveEditorViewport } from "./viewport-stability.ts";

export type TableMenuTarget = {
  from: number;
  sourceTo: number;
  to: number;
  /** 0 = header row, 1..N = body rows (matches MarkdownTableData.rows index). */
  row: number;
  col: number;
  rowCount: number;
  colCount: number;
  align: TableCellAlign;
  /** Whether the click came from an open live editing grid vs preview widget. */
  isEditing: boolean;
};

function tableRangeToWithAttrs(view: EditorView, sourceTo: number): number {
  const doc = view.state.doc;
  const line = doc.lineAt(Math.min(sourceTo, doc.length));
  if (line.number >= doc.lines) return sourceTo;
  const next = doc.line(line.number + 1);
  return readLayoutAttrsLine(next.text) ? next.to : sourceTo;
}

/** Resolve the clicked table and (row, col) cell from either preview or editing DOM. */
export function tableMenuTargetFromEvent(
  view: EditorView,
  node: EventTarget | null,
): TableMenuTarget | null {
  const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  if (!element || !view.dom.contains(element)) return null;

  const excluded = [...getBlockMathRanges(view.state), ...getFencedCodeRanges(view.state)];

  // 1. Preview TableWidget cell or drag handle
  const previewBlock = element.closest<HTMLElement>(".cm-table-block");
  if (previewBlock) {
    const previewCell = element.closest<HTMLElement>("td, th");
    let pos = Number(previewBlock.dataset.cmSourceFrom);
    if (!Number.isSafeInteger(pos)) {
      try { pos = view.posAtDOM(previewBlock); } catch { return null; }
    }
    const found = findTableAtPos(view.state.doc, pos, excluded);
    if (!found) return null;
    const data = parseMarkdownTable(view.state.doc.sliceString(found.from, found.sourceTo));
    const row = previewCell ? Number(previewCell.dataset.row) : 0;
    const col = previewCell ? Number(previewCell.dataset.col) : 0;
    const safeRow = Number.isFinite(row) ? Math.max(0, Math.min(row, data.rows.length - 1)) : 0;
    const safeCol = Number.isFinite(col) ? Math.max(0, Math.min(col, (data.rows[0]?.length ?? 1) - 1)) : 0;
    return {
      from: found.from,
      sourceTo: found.sourceTo,
      to: tableRangeToWithAttrs(view, found.sourceTo),
      row: safeRow,
      col: safeCol,
      rowCount: data.rows.length,
      colCount: data.rows[0]?.length ?? 1,
      align: data.aligns[safeCol] ?? "",
      isEditing: false,
    };
  }

  // 2. Live editing source row (either rendered inactive cell or active CM6 cell)
  const sourceRow = element.closest<HTMLElement>(".cm-table-source-row");
  if (sourceRow) {
    let linePos: number;
    try { linePos = view.posAtDOM(sourceRow); } catch { return null; }
    const found = findTableAtPos(view.state.doc, linePos, excluded);
    if (!found) return null;
    const data = parseMarkdownTable(view.state.doc.sliceString(found.from, found.sourceTo));
    const renderedCell = element.closest<HTMLElement>(".cm-table-source-rendered-cell");
    let row: number;
    let col: number;
    if (renderedCell) {
      row = Number(renderedCell.dataset.row);
      col = Number(renderedCell.dataset.col);
    } else {
      const line = view.state.doc.lineAt(linePos);
      const sourceRowIdx = line.number - found.startLineNum;
      row = sourceRowIdx === 0 ? 0 : Math.max(1, sourceRowIdx - 1);
      const head = view.state.selection.main.head;
      const headLine = view.state.doc.lineAt(head);
      col = headLine.number === line.number
        ? tableCellColumnAtOffset(line.text, head - line.from, data.rows[0]?.length ?? 1)
        : 0;
    }
    const safeRow = Number.isFinite(row) ? Math.max(0, Math.min(row, data.rows.length - 1)) : 0;
    const safeCol = Number.isFinite(col) ? Math.max(0, Math.min(col, (data.rows[0]?.length ?? 1) - 1)) : 0;
    return {
      from: found.from,
      sourceTo: found.sourceTo,
      to: tableRangeToWithAttrs(view, found.sourceTo),
      row: safeRow,
      col: safeCol,
      rowCount: data.rows.length,
      colCount: data.rows[0]?.length ?? 1,
      align: data.aligns[safeCol] ?? "",
      isEditing: true,
    };
  }

  // 3. Fallback: caret itself is inside a table (e.g., separator row or toolbar)
  const head = view.state.selection.main.head;
  const found = findTableAtPos(view.state.doc, head, excluded);
  if (!found) return null;
  const data = parseMarkdownTable(view.state.doc.sliceString(found.from, found.sourceTo));
  const dataRow = found.currentRowIdx === 0 ? 0 : Math.max(1, found.currentRowIdx - 1);
  const safeRow = Math.max(0, Math.min(dataRow, data.rows.length - 1));
  const safeCol = Math.max(0, Math.min(found.currentColIdx, (data.rows[0]?.length ?? 1) - 1));
  return {
    from: found.from,
    sourceTo: found.sourceTo,
    to: tableRangeToWithAttrs(view, found.sourceTo),
    row: safeRow,
    col: safeCol,
    rowCount: data.rows.length,
    colCount: data.rows[0]?.length ?? 1,
    align: data.aligns[safeCol] ?? "",
    isEditing: true,
  };
}

function focusCellInTableSource(
  view: EditorView,
  tableFrom: number,
  targetRow: number,
  targetCol: number,
  select = false,
): void {
  const excluded = [...getBlockMathRanges(view.state), ...getFencedCodeRanges(view.state)];
  const found = findTableAtPos(view.state.doc, Math.min(tableFrom, view.state.doc.length), excluded);
  if (!found) return;
  const sourceRowIdx = targetRow === 0 ? 0 : targetRow + 1;
  const clampedLineNum = Math.max(found.startLineNum, Math.min(found.startLineNum + sourceRowIdx, found.endLineNum));
  const line = view.state.doc.line(clampedLineNum);
  const cell = tableCellTarget(line.text, targetCol);
  const from = line.from + cell.anchor;
  const to = line.from + cell.head;
  preserveEditorViewport(view, () => {
    view.dispatch({
      selection: select ? { anchor: from, head: to } : { anchor: to },
    });
    view.focus();
  }, found.from);
}

/** Mutate the table at TARGET as one undoable construct edit, then focus the target cell. */
export function applyTableMenuMutation(
  view: EditorView,
  target: TableMenuTarget,
  mutate: (next: MarkdownTableData) => { row: number; col: number; select?: boolean } | null | void,
  kind = "table",
): boolean {
  if (view.state.readOnly) return false;
  const excluded = [...getBlockMathRanges(view.state), ...getFencedCodeRanges(view.state)];
  const found = findTableAtPos(view.state.doc, Math.min(target.from, view.state.doc.length), excluded);
  if (!found) return false;
  const currentSource = view.state.doc.sliceString(found.from, found.sourceTo);
  const next = parseMarkdownTable(currentSource);
  const focus = mutate(next);
  const nextSource = buildMarkdownTableSource(next);
  if (nextSource !== currentSource) {
    dispatchConstructEdit(view, {
      changes: { from: found.from, to: found.sourceTo, insert: nextSource },
    }, kind);
  }
  if (focus) {
    focusCellInTableSource(view, found.from, focus.row, focus.col, Boolean(focus.select));
  }
  view.requestMeasure();
  return true;
}

/** Delete the entire table (including trailing layout attrs line if present). */
export function deleteTableAtTarget(view: EditorView, target: TableMenuTarget): boolean {
  if (view.state.readOnly) return false;
  const excluded = [...getBlockMathRanges(view.state), ...getFencedCodeRanges(view.state)];
  const found = findTableAtPos(view.state.doc, Math.min(target.from, view.state.doc.length), excluded);
  if (!found) return false;
  const doc = view.state.doc;
  const endWithAttrs = tableRangeToWithAttrs(view, found.sourceTo);
  const to = endWithAttrs < doc.length && doc.sliceString(endWithAttrs, endWithAttrs + 1) === "\n"
    ? endWithAttrs + 1
    : endWithAttrs;
  dispatchConstructEdit(view, {
    changes: { from: found.from, to },
    selection: { anchor: found.from },
    scrollIntoView: true,
  }, "table-delete");
  view.focus();
  return true;
}

/** Obsidian/Typora-style structured table context menu items. */
export function tableContextMenuItems(
  view: EditorView,
  target: TableMenuTarget,
  disabled = false,
): NoemaMenuItem[] {
  const { row, col, rowCount, colCount, align } = target;
  const isHeader = row === 0;
  const canDeleteRow = !isHeader && rowCount > 2;
  const canMoveRowUp = row > 1;
  const canMoveRowDown = !isHeader && row < rowCount - 1;
  const canDeleteCol = colCount > 1;
  const canMoveColLeft = col > 0;
  const canMoveColRight = col < colCount - 1;
  const canSort = rowCount > 2 && rowCount <= 100;

  const mutate = (
    fn: (next: MarkdownTableData) => { row: number; col: number; select?: boolean } | null | void,
    kind?: string,
  ) => () => {
    if (!disabled) applyTableMenuMutation(view, target, fn, kind);
  };

  const setAlign = (nextAlign: TableCellAlign) => mutate((next) => {
    next.aligns[col] = next.aligns[col] === nextAlign ? "" : nextAlign;
    return target.isEditing ? { row, col } : null;
  }, "table-align");

  const runFormat = () => {
    if (disabled) return;
    const excluded = [...getBlockMathRanges(view.state), ...getFencedCodeRanges(view.state)];
    const found = findTableAtPos(view.state.doc, Math.min(target.from, view.state.doc.length), excluded);
    if (!found) return;
    const model = parseTableModel(found.lines, found.startLineNum, 0, 0);
    if (tableTooLarge(model)) return;
    const formatted = formatTableLines(model).join("\n");
    const current = view.state.doc.sliceString(found.from, found.sourceTo);
    if (formatted !== current) {
      dispatchConstructEdit(view, {
        changes: { from: found.from, to: found.sourceTo, insert: formatted },
      }, "table-format");
    }
  };

  const runCopyCSV = () => {
    const excluded = [...getBlockMathRanges(view.state), ...getFencedCodeRanges(view.state)];
    const found = findTableAtPos(view.state.doc, Math.min(target.from, view.state.doc.length), excluded);
    if (!found) return;
    const data = parseMarkdownTable(view.state.doc.sliceString(found.from, found.sourceTo));
    if (data.rows.length <= 100) void writeSystemClipboard(tableRowsToCSV(data.rows));
  };

  return [
    {
      label: "Row",
      detail: isHeader ? "header" : `row ${row}`,
      disabled,
      submenu: [
        {
          label: "Insert Row Above",
          disabled: disabled || isHeader,
          run: mutate((next) => {
            const insertAt = Math.max(1, Math.min(row, next.rows.length));
            next.rows.splice(insertAt, 0, Array(next.rows[0]?.length ?? 1).fill(""));
            return { row: insertAt, col, select: true };
          }, "table-row"),
        },
        {
          label: "Insert Row Below",
          detail: "Mod+Enter",
          disabled,
          run: mutate((next) => {
            const insertAt = Math.max(1, Math.min(row + 1, next.rows.length));
            next.rows.splice(insertAt, 0, Array(next.rows[0]?.length ?? 1).fill(""));
            return { row: insertAt, col, select: true };
          }, "table-row"),
        },
        {
          label: "Duplicate Row",
          disabled: disabled || isHeader,
          run: mutate((next) => {
            const copy = [...(next.rows[row] ?? Array(next.rows[0]?.length ?? 1).fill(""))];
            const insertAt = Math.min(row + 1, next.rows.length);
            next.rows.splice(insertAt, 0, copy);
            return { row: insertAt, col };
          }, "table-row"),
        },
        { separator: true, label: "" },
        {
          label: "Move Row Up",
          disabled: disabled || !canMoveRowUp,
          run: mutate((next) => {
            if (row <= 1 || row >= next.rows.length) return null;
            const tmp = next.rows[row]!;
            next.rows[row] = next.rows[row - 1]!;
            next.rows[row - 1] = tmp;
            return { row: row - 1, col };
          }, "table-row"),
        },
        {
          label: "Move Row Down",
          disabled: disabled || !canMoveRowDown,
          run: mutate((next) => {
            if (row < 1 || row + 1 >= next.rows.length) return null;
            const tmp = next.rows[row]!;
            next.rows[row] = next.rows[row + 1]!;
            next.rows[row + 1] = tmp;
            return { row: row + 1, col };
          }, "table-row"),
        },
        { separator: true, label: "" },
        {
          label: "Delete Row",
          danger: true,
          disabled: disabled || !canDeleteRow,
          run: mutate((next) => {
            if (row < 1 || next.rows.length <= 2) return null;
            next.rows.splice(row, 1);
            return target.isEditing ? { row: Math.max(1, Math.min(row, next.rows.length - 1)), col } : null;
          }, "table-row"),
        },
      ],
    },
    {
      label: "Column",
      detail: `col ${col + 1}`,
      disabled,
      submenu: [
        {
          label: "Insert Column Left",
          disabled,
          run: mutate((next) => {
            const insertAt = Math.max(0, Math.min(col, next.rows[0]?.length ?? 1));
            next.rows.forEach((r) => r.splice(insertAt, 0, ""));
            next.aligns.splice(insertAt, 0, "");
            return { row, col: insertAt, select: true };
          }, "table-col"),
        },
        {
          label: "Insert Column Right",
          disabled,
          run: mutate((next) => {
            const insertAt = Math.max(0, Math.min(col + 1, next.rows[0]?.length ?? 1));
            next.rows.forEach((r) => r.splice(insertAt, 0, ""));
            next.aligns.splice(insertAt, 0, "");
            return { row, col: insertAt, select: true };
          }, "table-col"),
        },
        {
          label: "Duplicate Column",
          disabled,
          run: mutate((next) => {
            const insertAt = Math.min(col + 1, next.rows[0]?.length ?? 1);
            next.rows.forEach((r) => r.splice(insertAt, 0, r[col] ?? ""));
            next.aligns.splice(insertAt, 0, next.aligns[col] ?? "");
            return { row, col: insertAt };
          }, "table-col"),
        },
        { separator: true, label: "" },
        {
          label: "Move Column Left",
          disabled: disabled || !canMoveColLeft,
          run: mutate((next) => {
            if (col <= 0) return null;
            next.rows.forEach((r) => {
              const tmp = r[col]!;
              r[col] = r[col - 1]!;
              r[col - 1] = tmp;
            });
            const tmpAlign = next.aligns[col] ?? "";
            next.aligns[col] = next.aligns[col - 1] ?? "";
            next.aligns[col - 1] = tmpAlign;
            return { row, col: col - 1 };
          }, "table-col"),
        },
        {
          label: "Move Column Right",
          disabled: disabled || !canMoveColRight,
          run: mutate((next) => {
            const width = next.rows[0]?.length ?? 0;
            if (col + 1 >= width) return null;
            next.rows.forEach((r) => {
              const tmp = r[col]!;
              r[col] = r[col + 1]!;
              r[col + 1] = tmp;
            });
            const tmpAlign = next.aligns[col] ?? "";
            next.aligns[col] = next.aligns[col + 1] ?? "";
            next.aligns[col + 1] = tmpAlign;
            return { row, col: col + 1 };
          }, "table-col"),
        },
        { separator: true, label: "" },
        { label: "Align Left", checked: align === "left", disabled, run: setAlign("left") },
        { label: "Align Center", checked: align === "center", disabled, run: setAlign("center") },
        { label: "Align Right", checked: align === "right", disabled, run: setAlign("right") },
        { separator: true, label: "" },
        {
          label: "Sort Ascending (A → Z)",
          disabled: disabled || !canSort,
          run: mutate((next) => {
            if (next.rows.length > 100) return null;
            next.rows = sortTableBodyRows(next.rows, col, 1, (r) => r);
            return target.isEditing ? { row: Math.max(1, row), col } : null;
          }, "table-sort"),
        },
        {
          label: "Sort Descending (Z → A)",
          disabled: disabled || !canSort,
          run: mutate((next) => {
            if (next.rows.length > 100) return null;
            next.rows = sortTableBodyRows(next.rows, col, -1, (r) => r);
            return target.isEditing ? { row: Math.max(1, row), col } : null;
          }, "table-sort"),
        },
        { separator: true, label: "" },
        {
          label: "Delete Column",
          danger: true,
          disabled: disabled || !canDeleteCol,
          run: mutate((next) => {
            if ((next.rows[0]?.length ?? 0) <= 1) return null;
            next.rows.forEach((r) => r.splice(col, 1));
            next.aligns.splice(col, 1);
            return target.isEditing ? { row, col: Math.max(0, Math.min(col, (next.rows[0]?.length ?? 1) - 1)) } : null;
          }, "table-col"),
        },
      ],
    },
    {
      label: "Table Actions",
      detail: `${rowCount}×${colCount}`,
      submenu: [
        {
          label: "Clear Cell",
          disabled,
          run: mutate((next) => {
            if (next.rows[row]) next.rows[row]![col] = "";
            return target.isEditing ? { row, col } : null;
          }, "table-cell"),
        },
        { label: "Format Markdown Source", detail: "align pipes", disabled, run: runFormat },
        { label: "Copy as CSV", detail: "clipboard", run: runCopyCSV },
        { separator: true, label: "" },
        {
          label: "Delete Table",
          danger: true,
          disabled,
          run: () => { if (!disabled) deleteTableAtTarget(view, target); },
        },
      ],
    },
  ];
}
