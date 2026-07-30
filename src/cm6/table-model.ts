/**
 * GFM markdown table model: parsing, formatting, and display-width utilities.
 *
 * All operations are bounded to the current table via findTableInfo.
 * Auto-formatting is skipped for tables exceeding the size threshold.
 */

export type TableAlign = "left" | "center" | "right" | "none";

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

/** Split a table row on unescaped | characters; strip leading/trailing | */
export function splitTableCells(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let i = 0;
  // Strip leading |
  if (line.trimStart().startsWith("|")) {
    i = line.indexOf("|") + 1;
  }
  while (i < line.length) {
    if (line[i] === "\\" && i + 1 < line.length) {
      current += line[i]! + line[i + 1]!;
      i += 2;
    } else if (line[i] === "|") {
      cells.push(current.trim());
      current = "";
      i++;
    } else {
      current += line[i]!;
      i++;
    }
  }
  // Strip trailing | (the last "cell" after it would be empty)
  const last = current.trim();
  if (last !== "") cells.push(last);
  return cells;
}

function parseSeparatorAlign(cell: string): TableAlign {
  const c = cell.trim();
  if (!c) return "none";
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return "none";
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

  // Find cursor cell
  const cursorRow = Math.min(cursorLineIdx, rows.length - 1);
  const line = lines[cursorRow] ?? "";
  let col = 0;
  let charCount = 0;
  let inCell = false;
  let cellStart = 0;
  if (line.trimStart().startsWith("|")) {
    cellStart = line.indexOf("|") + 1;
    charCount = cellStart;
  }
  for (let i = cellStart; i <= line.length; i++) {
    if (i === line.length || (line[i] === "|" && (i === 0 || line[i - 1] !== "\\"))) {
      if (charCount <= cursorColOffset && cursorColOffset <= i) {
        inCell = true;
        break;
      }
      col++;
      charCount = i + 1;
    }
  }
  if (!inCell) col = Math.max(0, col - 1);

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
  // Find the colIdx-th cell content start
  let col = 0;
  let i = 0;
  if (line.startsWith("|")) i = 1;
  while (i < line.length) {
    // skip whitespace before cell
    const spaceStart = i;
    while (i < line.length && line[i] === " ") i++;
    if (col === colIdx) return offset + i;
    // skip cell content (respecting \|)
    while (i < line.length) {
      if (line[i] === "\\" && i + 1 < line.length) { i += 2; continue; }
      if (line[i] === "|") { i++; break; }
      i++;
    }
    col++;
    void spaceStart;
  }
  return offset + line.length;
}
