/**
 * Phase 5 — Command dispatch and quick-insert for the CM6 kernel.
 *
 * Since CM6 doc IS the markdown source, every command is a plain text
 * mutation. No schema round-trip is needed.
 *
 * runCommandCM6      — implements all EditorCommand variants
 * getBlockContextCM6 — reads the Lezer syntax tree at the cursor
 * createQuickInsertRegistry — factory for per-editor provider set
 */

import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { parseTableModel, formatTableLines, tableTooLarge, type TableAlign } from "../table-model.ts";
import type {
  EditorBlockContext,
  EditorCommand,
  QuickInsertContext,
  QuickInsertItem,
  QuickInsertProvider,
} from "../../editor-api.ts";
import {
  blockCommands,
  builtInQuickInsertProvider,
  quickMatches,
} from "../../editor-api.ts";
import { indentLess, indentMore } from "@codemirror/commands";
import {
  foldAllHeadings,
  foldHeadingAtCursor,
  toggleFoldAtCursor,
  unfoldAllHeadings,
  unfoldHeadingAtCursor,
} from "../heading-fold.ts";
import { revisionSource, type RevisionSourceOptions } from "../../authoring-syntax.ts";
import { moveBlockAtCursor } from "../block-move.ts";

// ---------------------------------------------------------------------------
// Inline wrap (bold / italic / highlight / strike / code / link / image)
// ---------------------------------------------------------------------------

function wrapInline(view: EditorView, open: string, close: string): boolean {
  const { from, to } = view.state.selection.main;
  if (from === to) {
    view.dispatch({
      changes: { from, insert: open + close },
      selection: { anchor: from + open.length },
      scrollIntoView: true,
    });
  } else {
    const selected = view.state.doc.sliceString(from, to);
    const wrapped = open + selected + close;
    view.dispatch({
      changes: { from, to, insert: wrapped },
      selection: { anchor: from + open.length, head: from + open.length + selected.length },
      scrollIntoView: true,
    });
  }
  return true;
}

function nextFootnoteId(view: EditorView): string {
  const used = new Set<number>();
  const source = view.state.doc.toString();
  for (const match of source.matchAll(/\[\^(\d+)\]/g)) used.add(Number(match[1]));
  let id = 1;
  while (used.has(id)) id += 1;
  return String(id);
}

function insertFootnote(view: EditorView): boolean {
  const selection = view.state.selection.main;
  const id = nextFootnoteId(view);
  const reference = `[^${id}]`;
  const definition = `[^${id}]: `;
  const doc = view.state.doc;
  const appendPrefix = doc.length === 0
    ? ""
    : doc.sliceString(Math.max(0, doc.length - 2), doc.length).endsWith("\n\n")
      ? ""
      : doc.sliceString(Math.max(0, doc.length - 1), doc.length) === "\n" ? "\n" : "\n\n";
  if (selection.to === doc.length) {
    view.dispatch({
      changes: { from: doc.length, insert: `${reference}${appendPrefix}${definition}` },
      selection: { anchor: doc.length + reference.length },
      scrollIntoView: true,
    });
  } else {
    view.dispatch({
      changes: [
        { from: selection.to, insert: reference },
        { from: doc.length, insert: `${appendPrefix}${definition}` },
      ],
      selection: { anchor: selection.to + reference.length },
      scrollIntoView: true,
    });
  }
  return true;
}

function revisionOptions(value: string): RevisionSourceOptions {
  if (!value.trim()) return { advice: "replacement", reason: "", style: "indigo" };
  try {
    const parsed = JSON.parse(value) as Partial<RevisionSourceOptions>;
    return {
      advice: String(parsed.advice || "replacement"),
      reason: String(parsed.reason || ""),
      style: String(parsed.style || "indigo"),
    };
  } catch {
    return { advice: value, reason: "", style: "indigo" };
  }
}

function insertRevision(view: EditorView, value: string): boolean {
  const { from, to } = view.state.selection.main;
  const original = from === to ? "original" : view.state.doc.sliceString(from, to);
  const source = revisionSource(original, revisionOptions(value));
  view.dispatch({
    changes: { from, to, insert: source },
    selection: { anchor: from + source.length },
    scrollIntoView: true,
  });
  return true;
}

function editProperties(view: EditorView): boolean {
  const existing = view.dom.querySelector<HTMLDetailsElement>(".aaronnote-meta-properties");
  if (existing) {
    existing.open = true;
    existing.querySelector<HTMLElement>("input, textarea, summary")?.focus();
    return true;
  }
  const text = view.state.doc.toString();
  const frontmatter = /^(?:---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$))/.exec(text);
  const at = frontmatter?.[0].length ?? 0;
  const prefix = at > 0 && !text.slice(0, at).endsWith("\n\n") ? "\n" : "";
  const block = `${prefix}#+begin meta\nproperty: \n#+end meta\n\n`;
  view.dispatch({ changes: { from: at, insert: block }, selection: { anchor: at + block.indexOf("property: ") + 10 } });
  return true;
}

// ---------------------------------------------------------------------------
// Line prefix transform (headings / blockquote / list types)
// ---------------------------------------------------------------------------

function mutateCurrentLine(view: EditorView, fn: (line: string) => string): boolean {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const newText = fn(line.text);
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: newText },
    selection: { anchor: line.from + newText.length },
    scrollIntoView: true,
  });
  return true;
}

// Strip common list/task prefixes so commands can re-apply cleanly.
const LIST_PREFIX_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|- \[[ xX]\]\s+)/;
const EMPTY_LIST_RE = /^(\s*)(?:[-*+]\s+|\d+[.)]\s+|- \[[ xX]\]\s*)$/;
const EMPTY_QUOTE_RE = /^\s{0,3}>\s?$/;
const EMPTY_QUOTE_LIST_RE = /^(\s{0,3}(?:>\s*)+)(?:[-*+]\s*|\d+[.)]\s*|- \[[ xX]\]\s*)$/;
const CONTINUE_MARKUP_RE = /^(\s{0,3}(?:>\s*)*)(\s*)(?:(- \[[ xX]\]\s+)|([-*+])\s+|(\d+)([.)])\s+)(.*)$/;
const CONTINUE_QUOTE_RE = /^(\s{0,3}(?:>\s*)+)(.*)$/;
const JUPYTER_CELL_LINE_RE = /^[ \t]*@@cell(?:[ \t]*\(([^)\n]*)\))?(?:[ \t]+\[[^\]\n]*\])?[ \t]*$/i;

type MarkdownListLine = {
  indent: string;
  indentWidth: number;
  marker: string;
  orderedNumber: number | null;
  orderedDelimiter: "." | ")" | "";
  spacing: string;
  content: string;
};

function markdownListLine(text: string): MarkdownListLine | null {
  const match = text.match(/^([ \t]*)(?:(- \[[ xX]\])|([-*+])|(\d+)([.)]))(\s+)(.*)$/);
  if (!match) return null;
  const indent = match[1] ?? "";
  const orderedNumber = match[4] ? Number(match[4]) : null;
  return {
    indent,
    indentWidth: [...indent].reduce((width, char) => width + (char === "\t" ? 4 : 1), 0),
    marker: match[2] || match[3] || `${match[4]}${match[5]}`,
    orderedNumber,
    orderedDelimiter: (match[5] as "." | ")" | undefined) ?? "",
    spacing: match[6] ?? " ",
    content: match[7] ?? "",
  };
}

function withOrderedNumber(text: string, number: number): string {
  const info = markdownListLine(text);
  if (!info || info.orderedNumber == null) return text;
  return `${info.indent}${number}${info.orderedDelimiter}${info.spacing}${info.content}`;
}

function renumberOrderedListLines(lines: readonly string[]): string[] {
  const output = [...lines];
  const active = new Map<number, { next: number; delimiter: "." | ")" }>();
  for (let index = 0; index < output.length; index += 1) {
    const text = output[index]!;
    const info = markdownListLine(text);
    if (info) {
      for (const depth of [...active.keys()]) {
        if (depth > info.indentWidth) active.delete(depth);
      }
      if (info.orderedNumber != null && info.orderedDelimiter) {
        const state = active.get(info.indentWidth);
        const number = state?.delimiter === info.orderedDelimiter ? state.next : info.orderedNumber;
        output[index] = withOrderedNumber(text, number);
        active.set(info.indentWidth, { next: number + 1, delimiter: info.orderedDelimiter });
      } else {
        active.delete(info.indentWidth);
      }
      continue;
    }
    if (!text.trim()) continue;
    const leading = text.match(/^[ \t]*/)?.[0] ?? "";
    const width = [...leading].reduce((sum, char) => sum + (char === "\t" ? 4 : 1), 0);
    for (const depth of [...active.keys()]) {
      if (depth >= width) active.delete(depth);
    }
  }
  return output;
}

// ---------------------------------------------------------------------------
// Block insert (inserts below current line when it is non-empty)
// ---------------------------------------------------------------------------

function insertBlock(view: EditorView, text: string, cursorOffset: number): void {
  const { from } = view.state.selection.main;
  const doc = view.state.doc;
  const line = doc.lineAt(from);

  if (line.text.trim().length === 0) {
    // Replace the blank line in-place
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: text },
      selection: { anchor: line.from + cursorOffset },
      scrollIntoView: true,
    });
  } else {
    // Insert after current line
    view.dispatch({
      changes: { from: line.to, insert: "\n" + text },
      selection: { anchor: line.to + 1 + cursorOffset },
      scrollIntoView: true,
    });
  }
}

function nearestJupyterCellArgs(view: EditorView): string {
  const doc = view.state.doc;
  const cursorLineNumber = doc.lineAt(view.state.selection.main.from).number;
  let previous = "";
  let next = "";
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber);
    const match = JUPYTER_CELL_LINE_RE.exec(line.text);
    if (!match) continue;
    const args = (match[1] || "").trim();
    if (!args) continue;
    if (lineNumber <= cursorLineNumber) previous = args;
    else {
      next = args;
      break;
    }
  }
  return previous || next || "python, python3";
}

export function exitEmptyMarkdownBlock(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.from);
  const quoteList = line.text.match(EMPTY_QUOTE_LIST_RE);
  if (quoteList) {
    const prefix = quoteList[1] ?? "";
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: prefix },
      selection: { anchor: line.from + prefix.length },
      scrollIntoView: true,
    });
    return true;
  }
  if (!EMPTY_LIST_RE.test(line.text) && !EMPTY_QUOTE_RE.test(line.text)) return false;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: "" },
    selection: { anchor: line.from },
    scrollIntoView: true,
  });
  return true;
}

export function continueMarkdownMarkup(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.from);
  const beforeCursor = view.state.doc.sliceString(line.from, sel.from);
  const match = beforeCursor.match(CONTINUE_MARKUP_RE);
  if (!match) return false;
  const content = match[7] ?? "";
  if (content.trim().length === 0) return false;

  const quotePrefix = match[1] ?? "";
  const indent = match[2] ?? "";
  const task = match[3];
  const bullet = match[4];
  const ordered = match[5];
  const orderedDelim = match[6] ?? ".";
  const nextMarker = task
    ? task
    : bullet
      ? `${bullet} `
      : `${Number(ordered) + 1}${orderedDelim} `;
  const insert = `\n${quotePrefix}${indent}${nextMarker}`;
  view.dispatch({
    changes: { from: sel.from, insert },
    selection: { anchor: sel.from + insert.length },
    scrollIntoView: true,
  });
  renumberMarkdownOrderedLists(view);
  return true;
}

export function continueMarkdownQuote(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.from);
  const beforeCursor = view.state.doc.sliceString(line.from, sel.from);
  const match = beforeCursor.match(CONTINUE_QUOTE_RE);
  if (!match) return false;
  const content = match[2] ?? "";
  if (content.trim().length === 0) return false;
  const prefix = match[1] ?? "";
  const insert = `\n${prefix}`;
  view.dispatch({
    changes: { from: sel.from, insert },
    selection: { anchor: sel.from + insert.length },
    scrollIntoView: true,
  });
  return true;
}

export function continueMarkdownBlock(view: EditorView): boolean {
  return continueMarkdownMarkup(view) || continueMarkdownQuote(view);
}

export function renumberMarkdownOrderedLists(view: EditorView): boolean {
  const doc = view.state.doc;
  const oldLines = Array.from({ length: doc.lines }, (_, index) => doc.line(index + 1).text);
  const newLines = renumberOrderedListLines(oldLines);
  const changes = oldLines.flatMap((text, index) => {
    if (text === newLines[index]) return [];
    const line = doc.line(index + 1);
    return [{ from: line.from, to: line.to, insert: newLines[index]! }];
  });
  if (changes.length === 0) return false;
  const changeSet = view.state.changes(changes);
  const sel = view.state.selection.main;
  view.dispatch({
    changes: changeSet,
    selection: {
      anchor: changeSet.mapPos(sel.anchor, 1),
      head: changeSet.mapPos(sel.head, 1),
    },
  });
  return true;
}

function lineIndentWidth(text: string): number {
  const leading = text.match(/^[ \t]*/)?.[0] ?? "";
  return [...leading].reduce((sum, char) => sum + (char === "\t" ? 4 : 1), 0);
}

export function indentMarkdownList(view: EditorView, direction: 1 | -1): boolean {
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  const startLine = doc.lineAt(sel.from).number;
  const endLine = doc.lineAt(Math.max(sel.from, sel.to - (sel.to > sel.from ? 1 : 0))).number;
  const root = markdownListLine(doc.line(startLine).text);
  if (!root) return false;

  if (direction > 0) {
    let hasPreviousSibling = false;
    for (let lineNum = startLine - 1; lineNum >= 1; lineNum -= 1) {
      const text = doc.line(lineNum).text;
      const candidate = markdownListLine(text);
      if (candidate) {
        if (candidate.indentWidth === root.indentWidth) hasPreviousSibling = true;
        if (candidate.indentWidth <= root.indentWidth) break;
        continue;
      }
      if (text.trim() && lineIndentWidth(text) <= root.indentWidth) break;
    }
    if (!hasPreviousSibling) return false;
  } else if (root.indentWidth === 0) {
    return false;
  }

  let blockEndLine = endLine;
  for (let lineNum = endLine + 1; lineNum <= doc.lines; lineNum += 1) {
    const text = doc.line(lineNum).text;
    const candidate = markdownListLine(text);
    if (candidate && candidate.indentWidth <= root.indentWidth) break;
    if (!candidate && text.trim() && lineIndentWidth(text) <= root.indentWidth) break;
    blockEndLine = lineNum;
  }

  const oldLines = Array.from({ length: doc.lines }, (_, index) => doc.line(index + 1).text);
  const indentedLines = [...oldLines];
  for (let lineNum = startLine; lineNum <= blockEndLine; lineNum += 1) {
    const text = indentedLines[lineNum - 1]!;
    if (!text.trim()) continue;
    indentedLines[lineNum - 1] = direction > 0
      ? `    ${text}`
      : text.replace(/^ {1,4}/, "").replace(/^\t/, "");
  }
  if (direction > 0 && root.orderedNumber != null) {
    indentedLines[startLine - 1] = withOrderedNumber(indentedLines[startLine - 1]!, 1);
  }
  const newLines = renumberOrderedListLines(indentedLines);
  const changes = oldLines.flatMap((text, index) => {
    if (text === newLines[index]) return [];
    const line = doc.line(index + 1);
    return [{ from: line.from, to: line.to, insert: newLines[index]! }];
  });
  if (changes.length === 0) return false;
  const changeSet = view.state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: {
      anchor: changeSet.mapPos(sel.anchor, 1),
      head: changeSet.mapPos(sel.head, 1),
    },
    scrollIntoView: true,
  });
  return true;
}

export function indentMarkdownBlock(view: EditorView, direction: 1 | -1): boolean {
  if (indentMarkdownList(view, direction)) return true;
  const fallback = direction > 0 ? indentMore : indentLess;
  fallback(view);
  return true;
}

// ---------------------------------------------------------------------------
// Block context from Lezer tree
// ---------------------------------------------------------------------------

export function getBlockContextCM6(view: EditorView): EditorBlockContext {
  const { from } = view.state.selection.main;
  const doc = view.state.doc;

  const curLine = doc.lineAt(from);
  let type = "paragraph";
  let blockFrom = curLine.from;
  let blockTo = curLine.to;
  let contentFrom = curLine.from;
  let contentTo = curLine.to;

  let cur = syntaxTree(view.state).resolve(from, -1);
  while (cur && cur.name !== "Document") {
    const name = cur.name;
    if (name === "FencedCode" || name === "CodeBlock" || name === "IndentedCode") {
      type = "code_block";
      blockFrom = cur.from;
      blockTo = cur.to;
      const textNode = cur.getChild("CodeText");
      contentFrom = textNode?.from ?? blockFrom;
      contentTo = textNode?.to ?? blockTo;
      break;
    }
    if (name === "TableCell" || name === "TableHeader" || name === "Table") {
      type = "table_cell";
      blockFrom = cur.from;
      blockTo = cur.to;
      contentFrom = blockFrom;
      contentTo = blockTo;
      break;
    }
    if (/^ATXHeading[1-6]$/.test(name) || /^SetextHeading[12]$/.test(name)) {
      type = "heading";
      blockFrom = cur.from;
      blockTo = cur.to;
      contentFrom = headingContentFrom(view, cur.from, cur.to);
      contentTo = cur.to;
      break;
    }
    if (name === "Blockquote") {
      type = "blockquote";
      blockFrom = cur.from;
      blockTo = cur.to;
      contentFrom = blockFrom;
      contentTo = blockTo;
      break;
    }
    if (name === "ListItem") {
      type = "list_item";
      blockFrom = cur.from;
      blockTo = cur.to;
      contentFrom = listItemContentFrom(view, cur.from, cur.to);
      contentTo = blockTo;
      break;
    }
    if (name === "Paragraph") {
      type = "paragraph";
      blockFrom = cur.from;
      blockTo = cur.to;
      contentFrom = blockFrom;
      contentTo = blockTo;
      break;
    }
    if (!cur.parent) break;
    cur = cur.parent;
  }

  const text = blockContextText(view, type, blockFrom, blockTo, contentFrom, contentTo);

  let rect: { left: number; top: number; bottom: number } | null = null;
  try {
    const coords = view.coordsAtPos(from);
    if (coords) rect = { left: coords.left, top: coords.top, bottom: coords.bottom };
  } catch { /* view may not be mounted yet */ }

  return {
    type,
    from: blockFrom,
    to: blockTo,
    contentFrom,
    contentTo,
    text,
    empty: text.trim().length === 0,
    depth: 1,
    parentType: null,
    sourceMode: false,
    commands: blockCommands(type),
    rect,
  };
}

function headingContentFrom(view: EditorView, from: number, to: number): number {
  const raw = view.state.doc.sliceString(from, to);
  const atx = raw.match(/^\s{0,3}#{1,6}\s+/);
  if (atx) return from + atx[0].length;
  return from;
}

function listItemContentFrom(view: EditorView, from: number, to: number): number {
  const raw = view.state.doc.sliceString(from, to);
  const marker = raw.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+|- \[[ xX]\]\s+)/);
  if (marker) return from + marker[0].length;
  return from;
}

function blockContextText(
  view: EditorView,
  type: string,
  from: number,
  to: number,
  contentFrom: number,
  contentTo: number,
): string {
  const doc = view.state.doc;
  if (type === "blockquote") {
    return doc.sliceString(from, to)
      .split("\n")
      .map((line) => line.replace(/^\s{0,3}>\s?/, ""))
      .join("\n");
  }
  return doc.sliceString(contentFrom, contentTo);
}

// ---------------------------------------------------------------------------
// Copy code block at cursor
// ---------------------------------------------------------------------------

function codeBlockAtCursor(view: EditorView): string | null {
  const { from } = view.state.selection.main;
  let cur = syntaxTree(view.state).resolve(from, -1);
  while (cur && cur.name !== "Document") {
    if (cur.name === "FencedCode") {
      const textNode = cur.getChild("CodeText");
      return textNode ? view.state.doc.sliceString(textNode.from, textNode.to) : "";
    }
    if (!cur.parent) break;
    cur = cur.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Table manipulation (text-level)
// ---------------------------------------------------------------------------

type TableInfo = {
  lines: string[];
  startLineNum: number; // 1-based doc line number
  currentRowIdx: number; // 0-based index within table
  currentColIdx: number; // 0-based index within current row
};

function findTableInfo(view: EditorView): TableInfo | null {
  const { from } = view.state.selection.main;
  const doc = view.state.doc;
  const curLine = doc.lineAt(from);
  if (!/^\s*\|.*\|\s*$/.test(curLine.text)) return null;

  let start = curLine.number;
  while (start > 1 && /^\s*\|.*\|\s*$/.test(doc.line(start - 1).text)) start--;
  let end = curLine.number;
  while (end < doc.lines && /^\s*\|.*\|\s*$/.test(doc.line(end + 1).text)) end++;

  const lines: string[] = [];
  for (let i = start; i <= end; i++) lines.push(doc.line(i).text);
  return {
    lines,
    startLineNum: start,
    currentRowIdx: curLine.number - start,
    currentColIdx: columnIndexAtOffset(curLine.text, from - curLine.from),
  };
}

function splitCells(row: string): string[] {
  return row.split("|").slice(1, -1).map((c) => c.trim() || " ");
}

function buildRow(cells: string[]): string {
  return "| " + cells.join(" | ") + " |";
}

function isSeparatorRow(row: string): boolean {
  const compact = row.replace(/\s/g, "");
  return compact.includes("-") && /^\|[-|:]+\|$/.test(compact);
}

function columnIndexAtOffset(row: string, offset: number): number {
  const cellCount = splitCells(row).length;
  if (cellCount <= 0) return 0;
  let col = 0;
  for (let i = 0; i < row.length; i++) {
    if (i >= offset) break;
    if (row[i] === "|") col++;
  }
  return Math.max(0, Math.min(cellCount - 1, col - 1));
}

function rowOffset(lines: string[], rowIdx: number): number {
  return lines.slice(0, rowIdx).reduce((s, line) => s + line.length + 1, 0);
}

function cellOffset(row: string, colIdx: number): number {
  let seen = -1;
  for (let i = 0; i < row.length; i++) {
    if (row[i] !== "|") continue;
    seen++;
    if (seen === colIdx) return Math.min(row.length, i + 2);
  }
  return Math.max(0, row.length - 1);
}

function runTableCommandCM6(view: EditorView, command: EditorCommand): boolean {
  const info = findTableInfo(view);
  if (!info) return false;
  const { lines, startLineNum, currentRowIdx, currentColIdx } = info;
  const doc = view.state.doc;
  const { from } = view.state.selection.main;
  const startPos = doc.line(startLineNum).from;
  const endPos = doc.line(startLineNum + lines.length - 1).to;

  let newLines = [...lines];
  let newCursorRow = currentRowIdx;
  let newCursorCol = currentColIdx;

  if (command === "table-insert-row") {
    const colCount = splitCells(lines[0] ?? "").length;
    const emptyRow = buildRow(Array(colCount).fill(" "));
    const insertAt = currentRowIdx + 1;
    newLines.splice(insertAt, 0, emptyRow);
    newCursorRow = insertAt;
  } else if (command === "table-delete-row") {
    // Don't delete header (row 0) or separator (row 1)
    if (lines.length <= 2 || currentRowIdx <= 1 || isSeparatorRow(lines[currentRowIdx] ?? "")) {
      return false;
    }
    newLines.splice(currentRowIdx, 1);
    newCursorRow = Math.max(2, currentRowIdx - 1);
  } else if (command === "table-insert-column") {
    newCursorCol = currentColIdx + 1;
    newLines = newLines.map((line, rowIdx) => {
      const cells = splitCells(line);
      const cell = rowIdx === 1 ? "---" : " ";
      cells.splice(newCursorCol, 0, cell);
      return buildRow(cells);
    });
  } else if (command === "table-delete-column") {
    const colCount = splitCells(lines[0] ?? "").length;
    if (colCount <= 1) return false;
    const cursorCol = Math.max(0, Math.min(colCount - 1, currentColIdx));
    newLines = newLines.map((line) => {
      const cells = splitCells(line);
      if (cells.length > 1) cells.splice(cursorCol, 1);
      return buildRow(cells);
    });
    newCursorCol = Math.max(0, Math.min(cursorCol, colCount - 2));
  } else if (command === "table-align-left" || command === "table-align-center" || command === "table-align-right") {
    const model = parseTableModel(lines, startLineNum, currentRowIdx, from - (doc.line(startLineNum + currentRowIdx).from));
    if (model.sepIdx < 0) return false;
    const targetAlign: TableAlign = command === "table-align-left" ? "left" : command === "table-align-center" ? "center" : "right";
    const currentAlign = model.aligns[currentColIdx] ?? "none";
    model.aligns[currentColIdx] = currentAlign === targetAlign ? "none" : targetAlign;
    if (!tableTooLarge(model)) {
      newLines = formatTableLines(model);
    } else {
      // Only update separator row
      const sepCells = splitCells(lines[model.sepIdx] ?? "");
      const colCount = sepCells.length;
      for (let c = 0; c < colCount; c++) {
        if (c === currentColIdx) {
          sepCells[c] = model.aligns[c] === "center" ? `:---:` : model.aligns[c] === "left" ? `:---` : model.aligns[c] === "right" ? `---:` : `---`;
        }
      }
      newLines[model.sepIdx] = buildRow(sepCells);
    }
    newCursorRow = currentRowIdx;
    newCursorCol = currentColIdx;
  } else if (command === "table-move-row-up" || command === "table-move-row-down") {
    const sepIdx = lines.findIndex(isSeparatorRow);
    const firstBodyRow = sepIdx >= 0 ? sepIdx + 1 : 2;
    if (currentRowIdx < firstBodyRow) return false;
    if (command === "table-move-row-up" && currentRowIdx === firstBodyRow) return false;
    if (command === "table-move-row-down" && currentRowIdx === lines.length - 1) return false;
    const swapWith = command === "table-move-row-up" ? currentRowIdx - 1 : currentRowIdx + 1;
    if (swapWith < firstBodyRow) return false;
    const tmp = newLines[currentRowIdx]!;
    newLines[currentRowIdx] = newLines[swapWith]!;
    newLines[swapWith] = tmp;
    newCursorRow = swapWith;
  } else if (command === "table-move-column-left" || command === "table-move-column-right") {
    const colCount = splitCells(lines[0] ?? "").length;
    const swapWith = command === "table-move-column-left" ? currentColIdx - 1 : currentColIdx + 1;
    if (swapWith < 0 || swapWith >= colCount) return false;
    newLines = newLines.map((line) => {
      const cells = splitCells(line);
      const tmp = cells[currentColIdx]!;
      cells[currentColIdx] = cells[swapWith]!;
      cells[swapWith] = tmp;
      return buildRow(cells);
    });
    newCursorCol = swapWith;
  } else if (command === "table-format") {
    const model = parseTableModel(lines, startLineNum, currentRowIdx, from - (doc.line(startLineNum + currentRowIdx).from));
    if (tableTooLarge(model)) return false;
    newLines = formatTableLines(model);
    newCursorRow = currentRowIdx;
    newCursorCol = currentColIdx;
  } else {
    return false;
  }

  const newText = newLines.join("\n");
  const cursorRow = newLines[Math.max(0, Math.min(newCursorRow, newLines.length - 1))] ?? "";
  const cursor = startPos + rowOffset(newLines, newCursorRow) + cellOffset(cursorRow, newCursorCol);
  view.dispatch({
    changes: { from: startPos, to: endPos, insert: newText },
    selection: { anchor: cursor },
    scrollIntoView: true,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Table navigation
// ---------------------------------------------------------------------------

/** Tab / Shift-Tab cell navigation. Tab at last cell of last row creates a new row. */
export function tableNavigateCell(view: EditorView, dir: 1 | -1): boolean {
  const info = findTableInfo(view);
  if (!info) return false;
  const { lines, startLineNum, currentRowIdx, currentColIdx } = info;
  const doc = view.state.doc;
  const startPos = doc.line(startLineNum).from;
  const endPos = doc.line(startLineNum + lines.length - 1).to;
  const { from } = view.state.selection.main;

  const sepIdx = lines.findIndex(isSeparatorRow);
  const colCount = splitCells(lines[0] ?? "").length;
  const bodyRows = lines.filter((_, i) => i !== sepIdx);

  // Build flat cell list (skip separator)
  type Cell = { rowIdx: number; colIdx: number };
  const cells: Cell[] = [];
  for (let r = 0; r < lines.length; r++) {
    if (r === sepIdx) continue;
    for (let c = 0; c < colCount; c++) cells.push({ rowIdx: r, colIdx: c });
  }
  const curCellIdx = cells.findIndex((c) => c.rowIdx === currentRowIdx && c.colIdx === currentColIdx);
  const targetCellIdx = curCellIdx + dir;

  // Append a new row when Tab past last cell
  if (dir === 1 && targetCellIdx >= cells.length) {
    const emptyRow = buildRow(Array(colCount).fill(" "));
    const newLines = [...lines, emptyRow];
    // Format if not too large
    const model = parseTableModel(newLines, startLineNum, newLines.length - 1, 0);
    const formatted = tableTooLarge(model) ? newLines : formatTableLines(model);
    const newText = formatted.join("\n");
    const targetRow = formatted.length - 1;
    const targetRowText = formatted[targetRow] ?? "";
    const cursor = startPos + rowOffset(formatted, targetRow) + cellOffset(targetRowText, 0);
    view.dispatch({
      changes: { from: startPos, to: endPos, insert: newText },
      selection: { anchor: cursor },
      scrollIntoView: true,
    });
    return true;
  }
  if (targetCellIdx < 0 || targetCellIdx >= cells.length) return false;

  const target = cells[targetCellIdx]!;
  // Format first if not too large
  const model = parseTableModel(lines, startLineNum, currentRowIdx, from - doc.line(startLineNum + currentRowIdx).from);
  const formatted = tableTooLarge(model) ? lines : formatTableLines(model);
  const newText = formatted.join("\n");
  const targetRowText = formatted[target.rowIdx] ?? "";
  const cursor = startPos + rowOffset(formatted, target.rowIdx) + cellOffset(targetRowText, target.colIdx);
  view.dispatch({
    changes: { from: startPos, to: endPos, insert: newText },
    selection: { anchor: cursor },
    scrollIntoView: true,
  });
  void bodyRows;
  return true;
}

/** Enter in a table cell: move to same column in next body row; on empty last row exit the table. */
export function tableEnterSameColumn(view: EditorView): boolean {
  const info = findTableInfo(view);
  if (!info) return false;
  const { lines, startLineNum, currentRowIdx, currentColIdx } = info;
  const doc = view.state.doc;
  const startPos = doc.line(startLineNum).from;
  const endPos = doc.line(startLineNum + lines.length - 1).to;
  const { from } = view.state.selection.main;

  const sepIdx = lines.findIndex(isSeparatorRow);
  const firstBodyRow = sepIdx >= 0 ? sepIdx + 1 : 2;
  const colCount = splitCells(lines[0] ?? "").length;

  // If cursor is in last row and the row is empty → delete it and move below table
  if (currentRowIdx === lines.length - 1 && currentRowIdx >= firstBodyRow) {
    const cells = splitCells(lines[currentRowIdx] ?? "");
    const isEmpty = cells.every((c) => c.trim() === "");
    if (isEmpty) {
      const newLines = lines.slice(0, currentRowIdx);
      const newText = newLines.join("\n");
      const afterTable = doc.line(startLineNum + lines.length - 1).to + 1;
      view.dispatch({
        changes: [
          { from: startPos, to: endPos, insert: newText },
        ],
        selection: { anchor: Math.min(startPos + newText.length + 1, doc.length) },
        scrollIntoView: true,
      });
      void afterTable;
      return true;
    }
  }

  // Find next body row (skip separator)
  let nextRow = currentRowIdx + 1;
  if (nextRow === sepIdx) nextRow++;
  if (nextRow >= lines.length) {
    // Append a new row
    const emptyRow = buildRow(Array(colCount).fill(" "));
    const newLines = [...lines, emptyRow];
    const model = parseTableModel(newLines, startLineNum, newLines.length - 1, 0);
    const formatted = tableTooLarge(model) ? newLines : formatTableLines(model);
    const newText = formatted.join("\n");
    const targetRow = formatted.length - 1;
    const targetRowText = formatted[targetRow] ?? "";
    const cursor = startPos + rowOffset(formatted, targetRow) + cellOffset(targetRowText, currentColIdx);
    view.dispatch({
      changes: { from: startPos, to: endPos, insert: newText },
      selection: { anchor: cursor },
      scrollIntoView: true,
    });
    return true;
  }

  const model = parseTableModel(lines, startLineNum, currentRowIdx, from - doc.line(startLineNum + currentRowIdx).from);
  const formatted = tableTooLarge(model) ? lines : formatTableLines(model);
  const newText = formatted.join("\n");
  const targetRowText = formatted[nextRow] ?? "";
  const cursor = startPos + rowOffset(formatted, nextRow) + cellOffset(targetRowText, currentColIdx);
  view.dispatch({
    changes: { from: startPos, to: endPos, insert: newText },
    selection: { anchor: cursor },
    scrollIntoView: true,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export function runCommandCM6(view: EditorView, command: EditorCommand, value = ""): boolean {
  if (command === "move-block-up") return moveBlockAtCursor(view, -1);
  if (command === "move-block-down") return moveBlockAtCursor(view, 1);
  if (command === "fold-heading") return foldHeadingAtCursor(view);
  if (command === "unfold-heading") return unfoldHeadingAtCursor(view);
  if (command === "toggle-fold") return toggleFoldAtCursor(view);
  if (command === "fold-all-headings") return foldAllHeadings(view);
  if (command === "unfold-all-headings") return unfoldAllHeadings(view);

  // ── Inline marks ────────────────────────────────────────────────────────
  if (command === "bold") return wrapInline(view, "**", "**");
  if (command === "italic") return wrapInline(view, "*", "*");
  if (command === "highlight") return wrapInline(view, "==", "==");
  if (command === "strike") return wrapInline(view, "~~", "~~");
  if (command === "code") return wrapInline(view, "`", "`");
  if (command === "superscript") return wrapInline(view, "^", "^");
  if (command === "subscript") return wrapInline(view, "~", "~");
  if (command === "insert-footnote") return insertFootnote(view);
  if (command === "insert-revision") return insertRevision(view, value);
  if (command === "edit-properties") return editProperties(view);

  if (command === "link") {
    const { from, to } = view.state.selection.main;
    const sel = from === to ? "link" : view.state.doc.sliceString(from, to);
    const href = value || "https://";
    const text = `[${sel}](${href})`;
    const hrefFrom = from + sel.length + 3;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: hrefFrom, head: hrefFrom + href.length },
      scrollIntoView: true,
    });
    return true;
  }

  if (command === "image-edit") {
    const { from, to } = view.state.selection.main;
    const sel = from === to ? "alt" : view.state.doc.sliceString(from, to);
    const src = value || "src";
    const text = `![${sel}](${src})`;
    const srcFrom = from + sel.length + 4;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: srcFrom, head: srcFrom + src.length },
      scrollIntoView: true,
    });
    return true;
  }

  // ── Block inserts ────────────────────────────────────────────────────────
  if (command === "code-block") {
    const { from, to } = view.state.selection.main;
    const lang = value || "";
    const body = from === to ? "" : view.state.doc.sliceString(from, to);
    const template = `\`\`\`${lang}\n${body}\n\`\`\``;
    insertBlock(view, template, lang.length + 4 + body.length);
    return true;
  }

  if (command === "insert-table") {
    insertBlock(view, "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |", 2);
    return true;
  }

  if (command === "insert-math-block") {
    insertBlock(view, "\\[\n\n\\]", 3);
    return true;
  }

  if (command === "insert-toc") {
    insertBlock(view, "[toc]", 5);
    return true;
  }

  if (command === "insert-org-env") {
    const kind = (value || "note").trim() || "note";
    const open = `#+begin ${kind}`;
    insertBlock(view, `${open}\n\n#+end ${kind}`, open.length + 1);
    return true;
  }

  if (command === "jupyter-cell") {
    const args = nearestJupyterCellArgs(view);
    const text = `@@cell(${args})`;
    insertBlock(view, text, text.length);
    return true;
  }

  // ── Utility ──────────────────────────────────────────────────────────────
  if (command === "paragraph-menu") return false;

  if (command === "copy-code") {
    const text = codeBlockAtCursor(view);
    if (text == null) return false;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  }

  // ── Table ────────────────────────────────────────────────────────────────
  if (
    command === "table-insert-row" ||
    command === "table-insert-column" ||
    command === "table-delete-row" ||
    command === "table-delete-column" ||
    command === "table-align-left" ||
    command === "table-align-center" ||
    command === "table-align-right" ||
    command === "table-move-row-up" ||
    command === "table-move-row-down" ||
    command === "table-move-column-left" ||
    command === "table-move-column-right" ||
    command === "table-format"
  ) return runTableCommandCM6(view, command);

  // ── Line prefix commands (heading / blockquote / lists) ──────────────────
  const headingMatch = command.match(/^heading-([1-6])$/);
  if (headingMatch) {
    const level = Number(headingMatch[1]);
    return mutateCurrentLine(view, (line) =>
      `${"#".repeat(level)} ${line.replace(/^\s{0,3}#{1,6}\s+/, "")}`);
  }

  if (command === "blockquote") {
    return mutateCurrentLine(view, (line) => line.startsWith("> ") ? line : `> ${line}`);
  }
  if (command === "bullet-list") {
    return mutateCurrentLine(view, (line) => `- ${line.replace(LIST_PREFIX_RE, "")}`);
  }
  if (command === "ordered-list") {
    return mutateCurrentLine(view, (line) => `1. ${line.replace(LIST_PREFIX_RE, "")}`);
  }
  if (command === "task-list") {
    return mutateCurrentLine(view, (line) => `- [ ] ${line.replace(LIST_PREFIX_RE, "")}`);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Quick-insert context + registry
// ---------------------------------------------------------------------------

function buildQuickInsertContext(view: EditorView, query: string): QuickInsertContext {
  const { from } = view.state.selection.main;
  const doc = view.state.doc;
  const maxChars = 1200;
  const before = doc.sliceString(Math.max(0, from - maxChars), from);
  const after = doc.sliceString(from, Math.min(doc.length, from + maxChars));
  return {
    query,
    block: getBlockContextCM6(view),
    before,
    after,
    sourceMode: false,
  };
}

export type QuickInsertRegistry = {
  register(provider: QuickInsertProvider): () => void;
  getItems(view: EditorView, query?: string): QuickInsertItem[];
  run(view: EditorView, item: QuickInsertItem): boolean;
};

export function createQuickInsertRegistry(): QuickInsertRegistry {
  const providers = new Set<QuickInsertProvider>();

  return {
    register(provider) {
      providers.add(provider);
      return () => providers.delete(provider);
    },

    getItems(view, query = "") {
      const ctx = buildQuickInsertContext(view, query);
      const items: QuickInsertItem[] = [
        ...builtInQuickInsertProvider(ctx),
        ...Array.from(providers).flatMap((p) => {
          try { return Array.from(p(ctx)).filter((item) => quickMatches(item, query)); }
          catch { return []; }
        }),
      ];
      const byId = new Map<string, QuickInsertItem>();
      for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
      return [...byId.values()].slice(0, 18);
    },

    run(view, item) {
      if (item.markdown != null) {
        const { from, to } = view.state.selection.main;
        const md = item.markdown;
        const cursorOffset = item.select === "start" ? 0 : md.length;
        view.dispatch({
          changes: { from, to, insert: md },
          selection: { anchor: from + cursorOffset },
          scrollIntoView: true,
        });
        return true;
      }
      if (item.command) return runCommandCM6(view, item.command, item.value);
      return false;
    },
  };
}
