/**
 * GFM markdown table model: parsing, serialization, formatting, column width
 * weights, sorting, CSV export, and multi-cell grid paste.
 *
 * Shared as the single table model by live preview, editing commands, context
 * menus, and clipboard paste.
 */

import { isTableSeparatorLine, splitTableRow, tableSourceRowParts } from "./table-source-cells.ts";

export type TableAlign = "left" | "center" | "right" | "none";
export type TableCellAlign = "left" | "center" | "right" | "";

export type MarkdownTableData = {
  rows: string[][];
  aligns: TableCellAlign[];
};

export type TableModel = {
  lines: string[];
  rows: string[][];
  sepIdx: number;
  aligns: TableAlign[];
  startLineNum: number;
  cursorRow: number;
  cursorCol: number;
};

const TABLE_LARGE_ROWS = 100;
const TABLE_LARGE_CHARS = 10_000;

export function tableTooLarge(model: TableModel): boolean {
  return model.rows.length > TABLE_LARGE_ROWS
    || model.lines.join("\n").length > TABLE_LARGE_CHARS;
}

/** East Asian wide characters count as width 2. */
export function displayWidth(text: string): number {
  let w = 0;
  for (const cp of text) {
    const code = cp.codePointAt(0) ?? 0;
    if (
      (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2329 && code <= 0x232a)
      || (code >= 0x2e80 && code <= 0x303e)
      || (code >= 0x3041 && code <= 0x33ff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x4e00 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff01 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1f9ff)
      || (code >= 0x20000 && code <= 0x2fffd)
      || (code >= 0x30000 && code <= 0x3fffd)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** Split a table row on unescaped | characters, keeping `\|` escaped for source operations. */
export function splitTableCells(line: string): string[] {
  const { cells } = tableSourceRowParts(line);
  return cells.map(({ from, to }) => line.slice(from, to).trim());
}

/** Sort body rows only. A click creates one collator; no sorting work runs
 * while typing, and equal keys keep their source order. */
export function sortTableBodyRows<T>(
  rows: readonly T[], column: number, direction: 1 | -1,
  cells: (row: T) => readonly string[], bodyStart = 1,
): T[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const number = (value: string): number | null => {
    const text = value.trim();
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) ? Number(text) : null;
  };
  return [
    ...rows.slice(0, bodyStart),
    ...rows.slice(bodyStart).map((row, index) => ({ row, index })).sort((a, b) => {
      const left = cells(a.row)[column] ?? "";
      const right = cells(b.row)[column] ?? "";
      const leftNumber = number(left);
      const rightNumber = number(right);
      const order = leftNumber !== null && rightNumber !== null
        ? Math.sign(leftNumber - rightNumber) : collator.compare(left, right);
      return direction * order || a.index - b.index;
    }).map(({ row }) => row),
  ];
}

/** RFC 4180 cells, with Markdown's escaped pipe restored for CSV consumers. */
export function tableRowsToCSV(rows: readonly (readonly string[])[]): string {
  const cell = (source: string): string => {
    const text = source.replace(/\\\|/g, "|");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(",")).join("\r\n");
}

export function cellAlignFromSeparator(separatorCell: string): TableCellAlign {
  const compact = separatorCell.replace(/\s+/g, "");
  const left = compact.startsWith(":");
  const right = compact.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

function parseSeparatorAlign(cell: string): TableAlign {
  return cellAlignFromSeparator(cell) || "none";
}

export function separatorForAlign(align: TableCellAlign): string {
  if (align === "left") return ":---";
  if (align === "center") return ":---:";
  if (align === "right") return "---:";
  return "---";
}

export function escapeTableCell(cell: string): string {
  return cell.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
}

export function parseMarkdownTable(source: string): MarkdownTableData {
  const lines = source.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const headerCells = splitTableRow(lines[0] ?? "");
  const separatorCells = splitTableRow(lines[1] ?? "");
  const bodyRows = lines.slice(2).map(splitTableRow);
  const colCount = Math.max(1, headerCells.length, ...bodyRows.map((row) => row.length));
  const normalize = (row: string[]): string[] => Array.from({ length: colCount }, (_, index) => row[index] ?? "");
  return {
    rows: [normalize(headerCells), ...bodyRows.map(normalize)],
    aligns: Array.from({ length: colCount }, (_, index) => cellAlignFromSeparator(separatorCells[index] ?? "")),
  };
}

export function buildMarkdownTableSource(data: MarkdownTableData): string {
  const header = data.rows[0] ?? [""];
  const body = data.rows.slice(1);
  const aligns = Array.from({ length: header.length }, (_, index) => data.aligns[index] ?? "");
  const rowSource = (row: string[]): string => `| ${row.map(escapeTableCell).join(" | ")} |`;
  return [
    rowSource(header),
    rowSource(aligns.map(separatorForAlign)),
    ...body.map(rowSource),
  ].join("\n");
}

/** Rough visible text width of a Markdown cell for content-aware column proportions. */
function visibleCellWidth(source: string): number {
  const plain = source
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g, (_, target, label) => label ?? target)
    .replace(/\\([\\|`*_~])/g, "$1")
    .replace(/(\*\*|__|~~|==|`)/g, "");
  let maxLine = 0;
  for (const part of plain.split("\n")) {
    maxLine = Math.max(maxLine, displayWidth(part.trim()));
  }
  return maxLine;
}

/**
 * Compute content-aware column percentage widths summing strictly to 100.
 * Shared identically by preview `<colgroup>` and editing CSS grid / active-row
 * geometry so switching between preview and editing never shifts column widths.
 */
export function computeTableColumnPercentages(rows: readonly (readonly string[])[]): number[] {
  const colCount = Math.max(1, rows[0]?.length ?? 1);
  if (colCount === 1) return [100];

  const sampleLimit = Math.min(rows.length, 60);
  const rawScores = new Array<number>(colCount).fill(4);
  for (let col = 0; col < colCount; col++) {
    const headerW = visibleCellWidth(rows[0]?.[col] ?? "");
    let maxBody = 0;
    let sumBody = 0;
    let bodyCount = 0;
    for (let r = 1; r < sampleLimit; r++) {
      const w = visibleCellWidth(rows[r]?.[col] ?? "");
      if (w > maxBody) maxBody = w;
      sumBody += w;
      bodyCount++;
    }
    const avgBody = bodyCount > 0 ? sumBody / bodyCount : 0;
    const effective = Math.max(4, Math.min(64, Math.max(headerW * 1.08, avgBody * 0.65 + maxBody * 0.45)));
    rawScores[col] = Math.pow(effective, 0.65);
  }

  const minPct = Math.min(14, Math.max(5, 55 / colCount));
  const totalScore = rawScores.reduce((acc, s) => acc + s, 0) || colCount;
  const pcts = rawScores.map((s) => Math.max(minPct, (s / totalScore) * 100));
  const pctSum = pcts.reduce((acc, p) => acc + p, 0);
  const normalized = pcts.map((p) => Number(((p / pctSum) * 100).toFixed(2)));
  const headSum = normalized.slice(0, -1).reduce((acc, p) => acc + p, 0);
  normalized[normalized.length - 1] = Number(Math.max(1, 100 - headSum).toFixed(2));
  return normalized;
}

/**
 * Parse a pasted GFM Markdown table or multi-cell TSV block into a 2D cell
 * grid (excluding any GFM separator row), or null for plain single-cell text.
 */
export function parseTablePasteGrid(text: string): string[][] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const rawLines = trimmed.split(/\r?\n/);

  if (rawLines.length >= 2 && isTableSeparatorLine(rawLines[1]!) && rawLines[0]!.includes("|")) {
    const rows = rawLines
      .filter((line, idx) => idx !== 1 && line.trim().length > 0)
      .map(splitTableRow);
    if (rows.length > 0 && rows.some((r) => r.length > 0)) return rows;
  }

  if (rawLines.some((line) => line.includes("\t"))) {
    const rows = rawLines.map((line) => line.split("\t").map((cell) => cell.trim()));
    if (rows.length > 1 || (rows[0]?.length ?? 0) > 1) return rows;
  }

  return null;
}

/**
 * Overlay a pasted 2D cell grid onto DATA starting at (startRow, startCol),
 * expanding rows and columns automatically when the pasted block is larger.
 */
export function applyTableGridPaste(
  data: MarkdownTableData,
  startRow: number,
  startCol: number,
  grid: readonly (readonly string[])[],
): MarkdownTableData {
  const rows = data.rows.map((r) => [...r]);
  const aligns = [...data.aligns];
  const pasteCols = Math.max(0, ...grid.map((r) => r.length));
  const targetRows = Math.max(rows.length, startRow + grid.length);
  const targetCols = Math.max(rows[0]?.length ?? 1, startCol + pasteCols);

  while (rows.length < targetRows) rows.push(Array(targetCols).fill(""));
  for (const row of rows) {
    while (row.length < targetCols) row.push("");
  }
  while (aligns.length < targetCols) aligns.push("");

  for (let r = 0; r < grid.length; r++) {
    const srcRow = grid[r]!;
    for (let c = 0; c < srcRow.length; c++) {
      rows[startRow + r]![startCol + c] = srcRow[c] ?? "";
    }
  }
  return { rows, aligns };
}

function buildSeparatorCell(width: number, align: TableAlign): string {
  const dashes = (n: number): string => "-".repeat(Math.max(1, n));
  if (align === "center") return `:${dashes(width - 2)}:`;
  if (align === "left") return `:${dashes(width - 1)}`;
  if (align === "right") return `${dashes(width - 1)}:`;
  return "-".repeat(Math.max(3, width));
}

export function parseTableModel(
  lines: string[],
  startLineNum: number,
  cursorLineIdx: number,
  cursorColOffset: number,
): TableModel {
  const rows = lines.map(splitTableCells);
  const colCount = Math.max(...rows.map((r) => r.length));

  // Pad rows to colCount
  for (const row of rows) {
    while (row.length < colCount) row.push("");
  }

  // Detect separator row: line that looks like `---|---:` etc.
  let sepIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.every((cell) => /^:?-{1,}:?$/.test(cell.trim()))) {
      sepIdx = i;
      break;
    }
  }

  const aligns: TableAlign[] = sepIdx >= 0
    ? rows[sepIdx]!.map(parseSeparatorAlign)
    : Array(colCount).fill("none");

  const cursorRow = Math.min(cursorLineIdx, rows.length - 1);
  const line = lines[cursorRow] ?? "";
  const { cells } = tableSourceRowParts(line);
  let col = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cursorColOffset >= cells[i]!.from && cursorColOffset <= cells[i]!.to) {
      col = i;
      break;
    }
    if (cursorColOffset > cells[i]!.to) col = i + 1;
  }

  return {
    lines,
    rows,
    sepIdx,
    aligns,
    startLineNum,
    cursorRow,
    cursorCol: Math.min(col, colCount - 1),
  };
}

export function formatTableLines(model: TableModel): string[] {
  const { rows, sepIdx, aligns } = model;
  const colCount = aligns.length;

  // Compute max display width per column
  const widths = Array<number>(colCount).fill(3);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? "";
      widths[c] = Math.max(widths[c]!, displayWidth(cell));
    }
  }

  function padCell(text: string, width: number): string {
    const pad = width - displayWidth(text);
    return text + " ".repeat(Math.max(0, pad));
  }

  return rows.map((row, rowIdx) => {
    if (rowIdx === sepIdx) {
      const cells = aligns.map((align, c) => buildSeparatorCell(widths[c]!, align));
      return `| ${cells.join(" | ")} |`;
    }
    const cells = row.map((cell, c) => padCell(cell, widths[c]!));
    return `| ${cells.join(" | ")} |`;
  });
}

/** Find the offset of a specific (row, col) cell in the formatted lines, positioned at cell content start. */
export function cellOffset(formattedLines: string[], rowIdx: number, colIdx: number): number {
  let offset = 0;
  for (let i = 0; i < rowIdx; i++) {
    offset += (formattedLines[i]?.length ?? 0) + 1; // +1 for newline
  }
  const line = formattedLines[rowIdx] ?? "";
  const { cells } = tableSourceRowParts(line);
  const cell = cells[Math.max(0, Math.min(colIdx, cells.length - 1))];
  return offset + (cell ? cell.textFrom : line.length);
}
