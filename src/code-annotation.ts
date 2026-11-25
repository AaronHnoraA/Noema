import type { CodeInfo } from "./code-info.ts";

type Paint = "highlight" | "add" | "remove" | "warning" | "error";
type CodeMark = { from: number; to: number; className: string };

const PAINT = new Map<string, Paint>([
  ["highlight", "highlight"], ["++", "add"], ["--", "remove"], ["warning", "warning"], ["error", "error"],
]);
const MARKER = /(?:^|[ \t]+)(?:(?:\/\/|#|;|--)[ \t]*)?\[!code[ \t]+([^\]\n]+)\][ \t]*$/;
const PAIRED_MARKER = /(?:^|[ \t]+)(<!--|\/\*)[ \t]*\[!code[ \t]+([^\]\n]+)\][ \t]*(-->|\*\/)[ \t]*$/;

export interface CodeRow {
  from: number;
  text: string;
  markerLength: number;
  paint: Paint | null;
  focus: number | null;
  focused: boolean;
  dim: boolean;
  words: string[];
  newline: boolean;
}

function codeRow(line: string, from: number, newline: boolean): CodeRow {
  let text = line;
  let paint: Paint | null = null;
  let focus: number | null = null;
  const words: string[] = [];
  while (text.includes("[!code")) {
    const paired = PAIRED_MARKER.exec(text);
    if (paired && ((paired[1] === "<!--") !== (paired[3] === "-->"))) break;
    const match = paired ?? MARKER.exec(text);
    const value = (paired ? paired[2] : match?.[1])?.trim();
    if (!match || !value) break;
    const cue = PAINT.get(value);
    const focusCount = /^focus(?::(\d+))?$/.exec(value);
    if (cue) paint ??= cue;
    else if (focusCount) focus ??= Math.min(Number(focusCount[1] ?? 0), 10_000);
    else if (value.startsWith("word:") && value.slice(5).trim()) {
      if (words.length < 32) words.push(value.slice(5).trim());
    } else break;
    text = text.slice(0, match.index);
  }
  return { from, text, markerLength: line.length - text.length, paint, focus, focused: false, dim: false, words, newline };
}

export function codeRows(source: string, retainTrailingRow = false): CodeRow[] {
  const lines = source.split("\n");
  const hasTrailingNewline = !retainTrailingRow && lines.length > 1 && lines.at(-1) === "";
  if (hasTrailingNewline) lines.pop();
  let from = 0;
  const rows = lines.map((line, index) => {
    const row = codeRow(line, from, hasTrailingNewline || index < lines.length - 1);
    from += line.length + 1;
    return row;
  });
  if (rows.some((row) => row.focus !== null)) {
    let focusThrough = -1;
    rows.forEach((row, index) => {
      if (row.focus !== null) focusThrough = Math.max(focusThrough, index + row.focus);
      row.dim = index > focusThrough;
      row.focused = !row.dim;
    });
  }
  return rows;
}

export function codeHighlightSource(source: string, rows: readonly CodeRow[]): string {
  if (!rows.some((row) => row.markerLength)) return source;
  // Keep character offsets so the same tokenizer ranges paint source and HTML.
  return rows.map((row) => row.text + " ".repeat(row.markerLength) + (row.newline ? "\n" : "")).join("");
}

export function enhancedCode(info: CodeInfo, source: string): boolean {
  return info.numbers !== null || info.collapsedLines !== null || info.words.length > 0
    || info.whitespace || info.indentGuides || source.includes("[!code");
}

export function codeRowClasses(row: CodeRow, highlight: boolean): string {
  const classes = [];
  if (row.paint) classes.push(`noema-code-${row.paint}`);
  if (highlight && row.paint !== "highlight") classes.push("noema-code-highlight");
  if (row.dim) classes.push("noema-code-dim");
  if (row.focused) classes.push("noema-code-focused");
  return classes.join(" ");
}

export function codeWordMarks(text: string, words: readonly string[]): CodeMark[] {
  const found: CodeMark[] = [];
  for (const word of words) {
    for (let from = text.indexOf(word); from >= 0; from = text.indexOf(word, from + word.length)) {
      found.push({ from, to: from + word.length, className: "noema-code-word" });
    }
  }
  found.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: CodeMark[] = [];
  for (const mark of found) {
    const last = merged.at(-1);
    if (last && mark.from < last.to) last.to = Math.max(last.to, mark.to);
    else merged.push(mark);
  }
  return merged;
}

export function codeWhitespaceMarks(text: string, info: CodeInfo): CodeMark[] {
  if (!info.whitespace && !info.indentGuides) return [];
  const marks: CodeMark[] = [];
  let indent = true;
  let column = 0;
  for (let from = 0; from < text.length; from++) {
    const char = text[from];
    if (char !== " " && char !== "\t") {
      indent = false;
      if (!info.whitespace) break;
      continue;
    }
    const guide = indent && info.indentGuides && (char === "\t" || (column !== 0 && column % 2 === 0));
    const classes = [info.whitespace ? (char === "\t" ? "noema-code-tab" : "noema-code-space") : "", guide ? "noema-code-guide" : ""].filter(Boolean);
    if (classes.length) marks.push({ from, to: from + 1, className: classes.join(" ") });
    column += char === "\t" ? 2 - column % 2 : 1;
  }
  return marks;
}
