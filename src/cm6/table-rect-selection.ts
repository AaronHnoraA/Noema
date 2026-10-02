/**
 * Rectangular cell selection over a rendered Markdown table — the model half.
 *
 * MarkText's `TableRectSelection` (and prosemirror-tables' CellSelection in
 * Marker) let a drag across cells select a rectangle that copies as a GFM
 * sub-table and deletes in two stages: the first Delete empties the cells,
 * the next removes whole selected rows or columns, or the table when the
 * rectangle covers all of it. These functions compute those results over
 * the table's cell sources; the widget owns the DOM and the transaction.
 */

export type TableCellPosition = { row: number; col: number };

/** Inclusive bounds; row 0 is the header row. */
export type TableCellRect = { top: number; left: number; bottom: number; right: number };

export function tableCellRect(anchor: TableCellPosition, focus: TableCellPosition): TableCellRect {
  return {
    top: Math.min(anchor.row, focus.row),
    left: Math.min(anchor.col, focus.col),
    bottom: Math.max(anchor.row, focus.row),
    right: Math.max(anchor.col, focus.col),
  };
}

export function rectContains(rect: TableCellRect, row: number, col: number): boolean {
  return row >= rect.top && row <= rect.bottom && col >= rect.left && col <= rect.right;
}

export function rectIsSingleCell(rect: TableCellRect): boolean {
  return rect.top === rect.bottom && rect.left === rect.right;
}

export function rectCoversTable(rect: TableCellRect, rowCount: number, colCount: number): boolean {
  return rect.top === 0 && rect.left === 0 && rect.bottom >= rowCount - 1 && rect.right >= colCount - 1;
}

/** The selected cells' sources, row by row. */
export function rectCellSources(rows: readonly (readonly string[])[], rect: TableCellRect): string[][] {
  const out: string[][] = [];
  for (let row = rect.top; row <= rect.bottom && row < rows.length; row++) {
    const cells: string[] = [];
    for (let col = rect.left; col <= rect.right; col++) cells.push(rows[row]?.[col] ?? "");
    out.push(cells);
  }
  return out;
}

/** ROWS with every selected cell emptied, or null when they were all empty already. */
export function clearRectCells(rows: readonly (readonly string[])[], rect: TableCellRect): string[][] | null {
  let changed = false;
  const next = rows.map((cells, row) => cells.map((cell, col) => {
    if (!rectContains(rect, row, col) || cell === "") return cell;
    changed = true;
    return "";
  }));
  return changed ? next : null;
}

export type TableStructureRemoval =
  | { kind: "table" }
  | { kind: "rows"; rows: string[][] }
  | { kind: "columns"; rows: string[][]; aligns: string[] };

/**
 * The structure an empty rectangle removes: the table when it covers all of
 * it, its columns when it spans every row, its rows when it spans every
 * column. A partial rectangle removes nothing. Removing the header row
 * promotes the first remaining row, so the table keeps a header.
 */
export function removeRectStructure(
  rows: readonly (readonly string[])[],
  aligns: readonly string[],
  rect: TableCellRect,
): TableStructureRemoval | null {
  const rowCount = rows.length;
  const colCount = rows[0]?.length ?? 0;
  if (rowCount === 0 || colCount === 0) return null;
  const allRows = rect.top === 0 && rect.bottom >= rowCount - 1;
  const allCols = rect.left === 0 && rect.right >= colCount - 1;
  if (allRows && allCols) return { kind: "table" };
  if (allRows) {
    const keep = (_: unknown, col: number): boolean => col < rect.left || col > rect.right;
    return {
      kind: "columns",
      rows: rows.map((cells) => cells.filter(keep)),
      aligns: Array.from({ length: colCount }, (_, col) => aligns[col] ?? "").filter(keep),
    };
  }
  if (allCols) {
    return { kind: "rows", rows: rows.filter((_, row) => row < rect.top || row > rect.bottom).map((cells) => [...cells]) };
  }
  return null;
}
