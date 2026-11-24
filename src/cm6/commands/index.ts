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
import { EditorSelection, type ChangeSet, type EditorState, type Line, type Text, type TransactionSpec } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  buildMarkdownTableSource,
  parseMarkdownTable,
  parseTableModel,
  formatTableLines,
  splitTableCells,
  sortTableBodyRows,
  tableRowsToCSV,
  tableTooLarge,
  type TableAlign,
} from "../table-model.ts";
import {
  findTableAtPos,
  hasUnescapedPipe,
  isTableSeparatorLine,
  tableCellTarget,
  tableSourceRowParts,
} from "../table-source-cells.ts";
import { getFencedCodeRanges } from "../code-ranges.ts";
import { getBlockMathRanges } from "../math-ranges.ts";
import { moveByVisualRow, rowLayoutAvailable, screenRowAt } from "../screen-rows.ts";
import { readLayoutAttrsLine } from "../../layout-attrs.ts";
import { writeSystemClipboard } from "../../system-clipboard.ts";
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
import { revisionAdviceRange, revisionSource, type RevisionSourceOptions } from "../../authoring-syntax.ts";
import { deleteBlockAtCursor, duplicateBlockAtCursor, moveBlockAtCursor } from "../block-move.ts";
import { clearInlineFormatSpec, inlineFormatsAvailable, toggleInlineFormatSpec, type InlineFormatKind } from "../inline-format.ts";
import { changeHeadingLevelSpec, toggleBlockquoteSpec, toggleHeadingSpec, toggleListSpec, toggleTaskCheckSpec, type ListKind } from "../block-format.ts";
import { markdownInlineContext } from "../languages/markdown/index.ts";
import { scanInlineMathRanges } from "../../inline-math.ts";
import { orgMetaOpenLineNumber } from "../../org-meta.ts";

// ---------------------------------------------------------------------------
// Inline wrap (bold / italic / highlight / strike / code / link / image)
// ---------------------------------------------------------------------------

function toggleInline(view: EditorView, kind: InlineFormatKind): boolean {
  const spec = toggleInlineFormatSpec(view.state, kind);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

function dispatchSpec(view: EditorView, spec: ReturnType<typeof toggleListSpec>): boolean {
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

function wordAround(doc: Text, pos: number): { from: number; to: number } | null {
  const line = doc.lineAt(pos);
  const offset = pos - line.from;
  const isWord = (char: string | undefined): boolean => Boolean(char && /[\p{L}\p{N}_]/u.test(char));
  if (!isWord(line.text[offset - 1]) || !isWord(line.text[offset])) return null;
  let start = offset;
  let end = offset;
  while (start > 0 && isWord(line.text[start - 1])) start--;
  while (end < line.text.length && isWord(line.text[end])) end++;
  return { from: line.from + start, to: line.from + end };
}

function insideImage(state: EditorView["state"], pos: number): boolean {
  const { tree, base } = markdownInlineContext(state, pos);
  const local = pos - base;
  for (let node: SyntaxNode | null = tree.resolveInner(local, 1); node; node = node.parent) {
    if (node.name === "Image" && node.from < local) return true;
  }
  return false;
}

function insideInlineCode(state: EditorView["state"], pos: number): boolean {
  const { tree, base } = markdownInlineContext(state, pos);
  const local = pos - base;
  for (let node: SyntaxNode | null = tree.resolveInner(local, 1); node; node = node.parent) {
    if (node.name === "InlineCode" && node.from < local && local < node.to) return true;
  }
  return false;
}

type LocalLink = { node: SyntaxNode; base: number };

function linkAtSelection(state: EditorView["state"]): LocalLink | null {
  const { from, to } = state.selection.main;
  const { tree, base } = markdownInlineContext(state, from, to);
  const localFrom = from - base;
  const localTo = to - base;
  const linkAt = (side: -1 | 1) => {
    let node: SyntaxNode | null = tree.resolveInner(localFrom, side);
    while (node && node.name !== "Link") node = node.parent;
    return node && node.from <= localFrom && node.to >= localTo ? { node, base } : null;
  };
  return linkAt(1) ?? linkAt(-1);
}

function linkLabel(state: EditorView["state"], { node, base }: LocalLink): string | null {
  const marks = node.getChildren("LinkMark");
  const open = marks[0];
  const close = marks[1];
  return open && close && state.doc.sliceString(base + open.from, base + open.to) === "["
    ? state.doc.sliceString(base + open.to, base + close.from)
    : null;
}

/** Keep source constructs whole; flatten existing links before making one link. */
function linkSelectionText(state: EditorView["state"], from: number, to: number): { from: number; to: number; text: string } | null {
  const { tree, base } = markdownInlineContext(state, from, to);
  // A soft line break is valid link text; a blank line or another block is not.
  const localFrom = from - base;
  const localTo = to - base;
  let block: SyntaxNode | null = null;
  for (let node: SyntaxNode | null = tree.resolveInner(localFrom, 1); node; node = node.parent) {
    if ((node.name === "Paragraph" || node.name === "TableCell" || /^(?:ATX|Setext)Heading[1-6]?$/u.test(node.name))
        && node.to >= localTo) { block = node; break; }
  }
  if (!block) return null;
  const atomic = new Set(["Link", "Image", "Autolink", "InlineCode", "InlineMath"]);
  let start = localFrom;
  let end = localTo;
  if (/Heading/u.test(block.name)) {
    for (const mark of block.getChildren("HeaderMark")) {
      if (mark.from === block.from) start = Math.max(start, mark.to);
      else end = Math.min(end, mark.from);
    }
    const text = state.doc.sliceString(base + start, base + Math.max(start, end));
    start += text.length - text.trimStart().length;
    end -= text.length - text.trimEnd().length;
    if (start >= end) return null;
  }
  for (let node: SyntaxNode | null = tree.resolveInner(start, 1); node; node = node.parent) {
    if (atomic.has(node.name) && node.from < start && start < node.to) start = Math.min(start, node.from);
  }
  for (let node: SyntaxNode | null = tree.resolveInner(end, -1); node; node = node.parent) {
    if (atomic.has(node.name) && node.from < end && end < node.to) end = Math.max(end, node.to);
  }
  let text = "";
  let cursor = start;
  let invalid = false;
  tree.iterate({
    from: start,
    to: end,
    enter(node) {
      if (node.name !== "Link" && node.name !== "Autolink") return;
      const label = node.name === "Link"
        ? linkLabel(state, { node: node.node, base })
        : state.doc.sliceString(base + node.from + 1, base + node.to - 1);
      if (label === null) { invalid = true; return false; }
      text += state.doc.sliceString(base + cursor, base + node.from) + label;
      cursor = node.to;
      return false;
    },
  });
  if (invalid) return null;
  return { from: base + start, to: base + end, text: text + state.doc.sliceString(base + cursor, base + end) };
}

/**
 * The link command on an existing link removes it and keeps its text, the
 * way Marker's `toggleLink` and MarkText's link format toggle. Images are
 * left alone.
 */
function unlinkAtSelection(view: EditorView): boolean {
  const state = view.state;
  // A caret on either edge of the link counts: a new link glued to an
  // existing one is never what the command was for.
  const found = linkAtSelection(state);
  if (!found) return false;
  const { node, base } = found;
  const marks = node.getChildren("LinkMark");
  const open = marks[0];
  const close = marks[1];
  const label = linkLabel(state, found);
  if (!open || !close || label === null) return false;
  // Keep the caret on the same character of the text it was in.
  const place = (pos: number): number => base + node.from + Math.max(0, Math.min(label.length, pos - base - open.to));
  const anchor = state.selection.main.anchor;
  const head = state.selection.main.head;
  view.dispatch({
    changes: { from: base + node.from, to: base + node.to, insert: label },
    selection: { anchor: place(anchor), head: place(head) },
    scrollIntoView: true,
  });
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
  if (!value.trim()) return { advice: "replacement", reason: "", style: "suggest" };
  try {
    const parsed = JSON.parse(value) as Partial<RevisionSourceOptions>;
    return {
      advice: String(parsed.advice || "replacement"),
      reason: String(parsed.reason || ""),
      style: String(parsed.style || "suggest"),
    };
  } catch {
    return { advice: value, reason: "", style: "suggest" };
  }
}

/**
 * Write `source` over [from, to) and leave the selection on its advice value.
 *
 * Landing the caret after the whole command meant the one field the author came
 * to fill sat behind a quoted attribute they had to navigate back into.
 */
function dispatchRevisionSource(view: EditorView, from: number, to: number, prefix: string, source: string, suffix: string): boolean {
  const insert = `${prefix}${source}${suffix}`;
  const advice = revisionAdviceRange(source);
  const base = from + prefix.length;
  view.dispatch({
    changes: { from, to, insert },
    selection: advice
      ? { anchor: base + advice.from, head: base + advice.to }
      : { anchor: from + insert.length },
    scrollIntoView: true,
  });
  return true;
}

function insertRevision(view: EditorView, value: string): boolean {
  const { from, to } = view.state.selection.main;
  const raw = from === to ? "" : view.state.doc.sliceString(from, to);
  // Whitespace at the edges of a selection is surrounding document text, not
  // part of the revised span. Folding it into `[...]` glued the command onto
  // the preceding word.
  const leading = raw.match(/^\s*/)?.[0] ?? "";
  const trailing = raw.length > leading.length ? (raw.match(/\s*$/)?.[0] ?? "") : "";
  const original = raw.slice(leading.length, raw.length - trailing.length) || "original";
  return dispatchRevisionSource(view, from, to, leading, revisionSource(original, revisionOptions(value)), trailing);
}

/**
 * Rewrite one existing `@@revision` in place.
 *
 * Editing used to mean selecting the whole raw command, where the next keypress
 * destroyed it. Callers pass the command's source range plus the decoded
 * original so the suggestion can be re-authored without retyping the span.
 */
function editRevision(view: EditorView, value: string): boolean {
  type EditRevisionRequest = Partial<RevisionSourceOptions> & { from?: number; to?: number; original?: string };
  let parsed: EditRevisionRequest | null = null;
  try { parsed = JSON.parse(value) as EditRevisionRequest; } catch { return false; }
  const from = Number(parsed?.from);
  const to = Number(parsed?.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > view.state.doc.length || from >= to) return false;
  const source = revisionSource(String(parsed?.original ?? ""), {
    advice: String(parsed?.advice || "replacement"),
    reason: String(parsed?.reason || ""),
    style: String(parsed?.style || "suggest"),
  });
  return dispatchRevisionSource(view, from, to, "", source, "");
}

function focusMetaProperties(view: EditorView): boolean {
  const existing = view.dom.querySelector<HTMLDetailsElement>(".noema-meta-properties");
  if (!existing) return false;
  existing.open = true;
  existing.querySelector<HTMLElement>("input, textarea, summary")?.focus({ preventScroll: true });
  return true;
}

function editProperties(view: EditorView): boolean {
  if (focusMetaProperties(view)) return true;
  // Whether the note has a metadata block is a fact about the document. Its
  // panel is only in the DOM while the block is on screen in preview mode, so
  // asking the DOM made this command add a second block to a note that was
  // scrolled down or shown as source, and the index then read the new, empty
  // block as the note's identity.
  const metaLine = orgMetaOpenLineNumber(view.state.doc);
  if (metaLine > 0) {
    const open = view.state.doc.line(metaLine);
    const body = Math.min(view.state.doc.length, open.to + 1);
    view.dispatch({ selection: { anchor: body }, scrollIntoView: true });
    view.focus();
    view.requestMeasure({ read: () => null, write: () => { focusMetaProperties(view); } });
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
// List markup (headings / blockquote / list toggles live in ../block-format.ts)
// ---------------------------------------------------------------------------

// A list item whose marker (and optional task box) is all there is. Every
// bullet kind and ordered markers can carry a task box.
const EMPTY_LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])(?:[ \t]+\[[ xX]\][ \t]*|[ \t]+)$/;
const EMPTY_QUOTE_RE = /^\s{0,3}>\s?$/;
const EMPTY_QUOTE_LIST_RE = /^(\s{0,3}(?:>\s*)+)(?:[-*+]|\d+[.)])(?:[ \t]+\[[ xX]\])?[ \t]*$/;
// Groups: 1 quote prefix, 2 indent, 3 bullet, 4 ordinal, 5 delimiter, 6 task
// box, 7 content.
const CONTINUE_MARKUP_RE = /^(\s{0,3}(?:>\s*)*)(\s*)(?:([-*+])|(\d+)([.)]))\s+(\[[ xX]\]\s+)?(.*)$/;
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

type MarkdownListRegion = { startLine: number; endLine: number };
let markdownListVisitedLines = 0;

export function markdownListCommandLineVisitCount(): number {
  return markdownListVisitedLines;
}

function listLineText(doc: Text, lineNumber: number): string {
  markdownListVisitedLines += 1;
  return doc.line(lineNumber).text;
}

function listContinuationLine(text: string): boolean {
  if (!text.trim()) return true;
  if (markdownListLine(text)) return true;
  return lineIndentWidth(text) > 0;
}

/**
 * Bound list rewrites to the contiguous list block around the edit.  The old
 * implementation materialized every line in the document for each Enter or
 * Tab, which made a one-character edit scale with the entire note.
 */
function markdownListRegion(doc: Text, aroundLine: number): MarkdownListRegion {
  let startLine = Math.max(1, Math.min(aroundLine, doc.lines));
  let endLine = startLine;
  while (startLine > 1 && listContinuationLine(listLineText(doc, startLine - 1))) startLine--;
  while (endLine < doc.lines && listContinuationLine(listLineText(doc, endLine + 1))) endLine++;
  // Blank separator lines belong to neither neighbouring block. Keeping them
  // out also prevents a list beside a long blank tail from becoming O(doc).
  while (startLine < aroundLine && !listLineText(doc, startLine).trim()) startLine++;
  while (endLine > aroundLine && !listLineText(doc, endLine).trim()) endLine--;
  return { startLine, endLine };
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

/**
 * Insert `---` on its own paragraph.  A `---` line directly below text is a
 * setext H2 underline, so a blank line is always kept above the rule; the
 * cursor lands on a fresh line below it.
 */
function insertThematicBreak(view: EditorView): void {
  const doc = view.state.doc;
  const line = doc.lineAt(view.state.selection.main.from);
  let from: number;
  let to: number;
  let insert: string;
  if (line.text.trim().length === 0) {
    const previous = line.number > 1 ? doc.line(line.number - 1).text : "";
    from = line.from;
    to = line.to;
    insert = `${previous.trim().length > 0 ? "\n" : ""}---\n`;
  } else {
    from = to = line.to;
    insert = "\n\n---\n";
  }
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
  });
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
    const raw = (match[1] || "").trim();
    if (!raw) continue;
    const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
    const language = parts[0] || "python";
    const secondLooksLikeLegacyKernel = /python3|sage|julia|ir|bash|zsh|node|javascript|typescript|lean4?/i.test(parts[1] || "");
    const session = parts.length >= 3
      ? (parts[2] || "default")
      : secondLooksLikeLegacyKernel ? "default" : (parts[1] || "default");
    const args = `${language}, ${session}`;
    if (lineNumber <= cursorLineNumber) previous = args;
    else {
      next = args;
      break;
    }
  }
  return previous || next || "python, default";
}

// Groups: 1 quote markers, 2 list indent + marker (+ task box), 3 fence indent,
// 4 fence, 5 info string. A fence may open inside a quote or a list item.
const OPENING_FENCE_RE = /^((?:[ \t]{0,3}>[ \t]?)*)([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?([ \t]{0,3})(`{3,}|~{3,})([^\n]*)$/;

/**
 * Enter at the end of an opening code fence that has no closing fence yet
 * inserts the closing fence and puts the caret on the blank line between —
 * MarkText converts the paragraph to a code block on the same Enter, and
 * files.md closes the fence as it is typed. Without it, every line below the
 * new fence turns into code until the author remembers to close it.
 *
 * The syntax tree decides: a fence line that closes an earlier block, or an
 * opener that is already closed further down, is left to the ordinary Enter.
 */
export function closeFencedCodeOnEnter(view: EditorView): boolean {
  const state = view.state;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false;
  const match = OPENING_FENCE_RE.exec(line.text);
  if (!match) return false;
  const quote = match[1] ?? "";
  const item = match[2] ?? "";
  const fenceIndent = match[3] ?? "";
  const fence = match[4] ?? "```";
  const info = match[5] ?? "";
  // A backtick fence's info string cannot contain a backtick.
  if (fence.startsWith("`") && info.includes("`")) return false;
  const markFrom = line.from + quote.length + item.length + fenceIndent.length;
  // New lines continue the containers: the quote marker, then the list item's
  // content column, then the fence's own indentation.
  const indent = `${quote}${" ".repeat(item.length)}${fenceIndent}`;
  const tree = ensureSyntaxTree(state, line.to, 100) ?? syntaxTree(state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(markFrom + 1, 1);
  while (node && node.name !== "FencedCode") node = node.parent;
  if (!node || node.from !== markFrom) return false;
  const marks = node.getChildren("CodeMark");
  if (marks.length !== 1) return false;
  const insert = `\n${indent}\n${indent}${fence}`;
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + 1 + indent.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/** HTML elements that open a block and are written with a closing tag. */
const HTML_BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "dialog", "div", "dl", "fieldset",
  "figure", "footer", "form", "header", "main", "nav", "ol", "section", "table", "ul",
]);

/**
 * Enter at the end of a line that is only an opening block tag (`<details>`,
 * `<div class="x">`) closes it and puts the caret on the line between, as
 * MarkText converts such a paragraph into an HTML block. A tag that is
 * already closed further down is left to the ordinary Enter.
 */
export function closeHtmlBlockOnEnter(view: EditorView): boolean {
  const state = view.state;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false;
  const match = /^([ \t]{0,3})<([A-Za-z][\w-]*)(?:\s[^<>]*)?>[ \t]*$/u.exec(line.text);
  const tag = match?.[2]?.toLowerCase();
  if (!match || !tag || !HTML_BLOCK_TAGS.has(tag)) return false;
  const lookahead = state.doc.sliceString(line.to, Math.min(state.doc.length, line.to + 20_000)).toLowerCase();
  if (lookahead.includes(`</${tag}>`)) return false;
  const indent = match[1] ?? "";
  const insert = `\n${indent}\n${indent}</${tag}>`;
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + 1 + indent.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/**
 * Enter with the caret at the start of a heading's text opens an empty line
 * above the heading and leaves the heading whole. The marker is hidden in the
 * preview, so the caret looks like it is at the line start; splitting there
 * left an empty `# ` and demoted the title to a paragraph. MarkText's
 * `AtxHeadingContent.enterHandler` inserts a paragraph before the heading for
 * any caret inside the marker.
 */
export function insertLineBeforeHeading(view: EditorView): boolean {
  const state = view.state;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(sel.head);
  const match = /^((?:[ \t]{0,3}>[ \t]?)*)([ \t]{0,3}#{1,6})(?:[ \t]+|$)/u.exec(line.text);
  if (!match || !line.text.slice(match[0].length).trim()) return false;
  const markerEnd = line.from + match[0].length;
  if (sel.head < line.from + match[1]!.length || sel.head > markerEnd) return false;
  const insert = `${match[1]!.trimEnd()}\n`;
  view.dispatch({
    changes: { from: line.from, insert },
    selection: { anchor: markerEnd + insert.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/**
 * The list item an indented empty item belongs to: the nearest line above
 * with a list marker at a smaller indent. Blank and more-indented lines are
 * the parent's own body; anything else at or left of the item ends the search.
 */
function parentListLineAbove(doc: Text, lineNumber: number, indentWidth: number, limit = 200): string | null {
  for (let number = lineNumber - 1; number >= 1 && lineNumber - number <= limit; number -= 1) {
    const text = doc.line(number).text;
    if (!text.trim()) continue;
    const item = markdownListLine(text);
    if (item && item.indentWidth < indentWidth) return text;
    if (lineIndentWidth(text) < indentWidth && !item) return null;
  }
  return null;
}

/**
 * Leave a list item or quote through an empty line that keeps a blank line
 * on each side wherever text would otherwise touch it.
 *
 * Markdown continues a paragraph onto the next unindented line ("lazy"
 * continuation), so clearing `- ` under `- a` and typing `foo` produced
 * `- a\nfoo` — one list item whose text runs on. MarkText's block model makes
 * the exit a paragraph between lists; in source that paragraph needs its
 * blank lines. SEPARATOR is the blank line's own container prefix.
 */
function exitToSeparatedLine(view: EditorView, line: { from: number; to: number; number: number }, keep: string, separator: string): void {
  const doc = view.state.doc;
  const strip = (text: string): string => text.startsWith(separator) ? text.slice(separator.length) : text;
  const touches = (number: number): boolean =>
    number >= 1 && number <= doc.lines && /\S/u.test(strip(doc.line(number).text).replace(/^\s*>?/u, ""));
  const before = touches(line.number - 1) ? `${separator}\n` : "";
  const after = touches(line.number + 1) ? `\n${separator}` : "";
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: before + keep + after },
    selection: { anchor: line.from + before.length + keep.length },
    scrollIntoView: true,
    userEvent: "input",
  });
}

export function exitEmptyMarkdownBlock(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const doc = view.state.doc;
  const line = doc.lineAt(sel.from);
  const quoteList = line.text.match(EMPTY_QUOTE_LIST_RE);
  if (quoteList) {
    const prefix = quoteList[1] ?? "";
    exitToSeparatedLine(view, line, prefix, prefix.trimEnd());
    return true;
  }
  const emptyItem = EMPTY_LIST_RE.exec(line.text);
  if (emptyItem) {
    // A nested empty item steps out one level and continues the parent list,
    // as Shift-Tab would; only a top-level item leaves the list.
    const indentWidth = lineIndentWidth(emptyItem[1] ?? "");
    const parent = indentWidth > 0 ? parentListLineAbove(doc, line.number, indentWidth) : null;
    const parentMarkup = parent?.match(CONTINUE_MARKUP_RE);
    if (parentMarkup) {
      const insert = `${parentMarkup[1] ?? ""}${parentMarkup[2] ?? ""}${nextListMarker(parentMarkup)}`;
      dispatchRenumbered(view, {
        changes: { from: line.from, to: line.to, insert },
        selection: { anchor: line.from + insert.length },
        scrollIntoView: true,
        userEvent: "input",
      });
      return true;
    }
    exitToSeparatedLine(view, line, "", "");
    return true;
  }
  if (!EMPTY_QUOTE_RE.test(line.text)) return false;
  exitToSeparatedLine(view, line, "", "");
  return true;
}

/**
 * The marker for the item after a CONTINUE_MARKUP_RE match: the same bullet,
 * the next ordinal, and an unchecked box when the item was a task — a new task
 * is never born done (HyperMD and MarkText both reset it).
 */
function nextListMarker(match: RegExpMatchArray): string {
  const base = match[3] ? `${match[3]} ` : `${Number(match[4]) + 1}${match[5] ?? "."} `;
  return match[6] ? `${base}[ ] ` : base;
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
  const insert = `\n${quotePrefix}${indent}${nextListMarker(match)}`;
  dispatchRenumbered(view, {
    changes: { from: sel.from, insert },
    selection: { anchor: sel.from + insert.length },
    scrollIntoView: true,
  });
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

/**
 * The prefix a new line must start with to continue TEXT's Markdown block —
 * its list marker, task box, quote marker, or just its indentation.
 *
 * Shared so that opening a line (Vim's `o`/`O`) and pressing Enter agree.
 * `openLine` used to copy only the leading whitespace, so `o` on `- item` gave
 * a bare indented line while Enter gave `- `. An item with no content yields
 * bare indentation, matching the way Enter declines to continue an empty item.
 */
export function markdownContinuationPrefix(text: string): string {
  const markup = text.match(CONTINUE_MARKUP_RE);
  if (markup && (markup[7] ?? "").trim().length > 0) {
    return `${markup[1] ?? ""}${markup[2] ?? ""}${nextListMarker(markup)}`;
  }
  const quote = text.match(CONTINUE_QUOTE_RE);
  if (quote && (quote[2] ?? "").trim().length > 0) return quote[1] ?? "";
  return text.match(/^[ \t]*/u)?.[0] ?? "";
}

export function continueMarkdownBlock(view: EditorView): boolean {
  return continueMarkdownMarkup(view) || continueMarkdownQuote(view);
}

function orderedListRenumberChanges(state: EditorState, around: number): ChangeSet | null {
  const doc = state.doc;
  const aroundLine = doc.lineAt(Math.max(0, Math.min(around, doc.length))).number;
  const { startLine, endLine } = markdownListRegion(doc, aroundLine);
  const oldLines = Array.from(
    { length: endLine - startLine + 1 },
    (_, index) => listLineText(doc, startLine + index),
  );
  const newLines = renumberOrderedListLines(oldLines);
  const changes = oldLines.flatMap((text, index) => {
    if (text === newLines[index]) return [];
    const line = doc.line(startLine + index);
    return [{ from: line.from, to: line.to, insert: newLines[index]! }];
  });
  return changes.length === 0 ? null : state.changes(changes);
}

export function renumberMarkdownOrderedLists(
  view: EditorView,
  around = view.state.selection.main.from,
): boolean {
  const changeSet = orderedListRenumberChanges(view.state, around);
  if (!changeSet) return false;
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

/**
 * Apply SPEC and the list renumbering it makes necessary as one transaction.
 * Dispatching the renumbering separately made it a second undo step: one undo
 * took back the numbers and left the edit that had caused them.
 */
function dispatchRenumbered(view: EditorView, spec: TransactionSpec): void {
  const edit = view.state.update(spec);
  const renumber = orderedListRenumberChanges(edit.state, edit.state.selection.main.from);
  if (!renumber) {
    view.dispatch(edit);
    return;
  }
  view.dispatch({
    changes: edit.changes.compose(renumber),
    selection: edit.state.selection.map(renumber, 1),
    scrollIntoView: edit.scrollIntoView,
    ...(typeof spec.userEvent === "string" ? { userEvent: spec.userEvent } : {}),
  });
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

  const region = markdownListRegion(doc, startLine);
  const oldLines = Array.from(
    { length: region.endLine - region.startLine + 1 },
    (_, index) => listLineText(doc, region.startLine + index),
  );
  const indentedLines = [...oldLines];
  // The selection can reach past the list (into the paragraph or table after
  // it); only lines of the list's own region are indented.
  for (let lineNum = Math.max(startLine, region.startLine); lineNum <= Math.min(blockEndLine, region.endLine); lineNum += 1) {
    const localIndex = lineNum - region.startLine;
    const text = indentedLines[localIndex]!;
    if (!text.trim()) continue;
    indentedLines[localIndex] = direction > 0
      ? `    ${text}`
      : text.replace(/^ {1,4}/, "").replace(/^\t/, "");
  }
  if (direction > 0 && root.orderedNumber != null) {
    const rootIndex = startLine - region.startLine;
    indentedLines[rootIndex] = withOrderedNumber(indentedLines[rootIndex]!, 1);
  }
  const newLines = renumberOrderedListLines(indentedLines);
  const changes = oldLines.flatMap((text, index) => {
    if (text === newLines[index]) return [];
    const line = doc.line(region.startLine + index);
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
// Table manipulation (unified GFM model — works with or without outer pipes)
// ---------------------------------------------------------------------------

type TableInfo = {
  lines: string[];
  startLineNum: number; // 1-based doc line number
  currentRowIdx: number; // 0-based index within table
  currentColIdx: number; // 0-based index within current row
  from: number;
  sourceTo: number;
  sepIdx: number;
};

function findTableInfo(view: EditorView): TableInfo | null {
  const state = view.state;
  const { from } = state.selection.main;
  const excluded = [...getBlockMathRanges(state), ...getFencedCodeRanges(state)];
  const found = findTableAtPos(state.doc, from, excluded);
  if (!found) return null;
  return {
    lines: found.lines,
    startLineNum: found.startLineNum,
    currentRowIdx: found.currentRowIdx,
    currentColIdx: found.currentColIdx,
    from: found.from,
    sourceTo: found.sourceTo,
    sepIdx: found.sepLineNum - found.startLineNum,
  };
}

function splitCells(row: string): string[] {
  return splitTableCells(row).map((cell) => cell || " ");
}

function buildRow(cells: string[]): string {
  return "| " + cells.join(" | ") + " |";
}

function isSeparatorRow(row: string): boolean {
  return isTableSeparatorLine(row);
}

function rowOffset(lines: string[], rowIdx: number): number {
  return lines.slice(0, rowIdx).reduce((s, line) => s + line.length + 1, 0);
}

function cellOffset(row: string, colIdx: number): number {
  return tableCellTarget(row, colIdx).anchor;
}

/**
 * Where Tab/Enter lands in cell COLIDX of ROW, relative to the row: the cell's
 * text selected, so typing replaces it as in a spreadsheet — or the caret
 * inside an empty cell. Works for rows with or without outer pipes.
 */
export function cellTarget(row: string, colIdx: number): { anchor: number; head: number } {
  const { anchor, head } = tableCellTarget(row, colIdx);
  return { anchor, head };
}

function emptyRowMatchingStyle(sampleLine: string, colCount: number): string {
  const { hasLeadingPipe, hasTrailingPipe } = tableSourceRowParts(sampleLine);
  if (!hasLeadingPipe && !hasTrailingPipe) {
    return Array(colCount).fill(" ").join(" | ");
  }
  return `| ${Array(colCount).fill("").join(" | ")} |`;
}

function runTableCommandCM6(view: EditorView, command: EditorCommand): boolean {
  const info = findTableInfo(view);
  if (!info) return false;
  const { lines, startLineNum, currentRowIdx, currentColIdx, sepIdx } = info;
  const doc = view.state.doc;
  const { from } = view.state.selection.main;
  const startPos = info.from;
  const endPos = info.sourceTo;
  const colCount = Math.max(1, splitCells(lines[0] ?? "").length);

  if (command === "table-delete-table") {
    const lastLineNum = startLineNum + lines.length - 1;
    let removeTo = endPos;
    if (lastLineNum < doc.lines && readLayoutAttrsLine(doc.line(lastLineNum + 1).text)) {
      removeTo = doc.line(lastLineNum + 1).to;
    }
    const to = removeTo < doc.length && doc.sliceString(removeTo, removeTo + 1) === "\n" ? removeTo + 1 : removeTo;
    view.dispatch({
      changes: { from: startPos, to },
      selection: { anchor: startPos },
      scrollIntoView: true,
    });
    return true;
  }

  let newLines = [...lines];
  let newCursorRow = currentRowIdx;
  let newCursorCol = currentColIdx;

  if (command === "table-insert-row") {
    const emptyRow = buildRow(Array(colCount).fill(" "));
    const insertAt = Math.max(currentRowIdx + 1, sepIdx + 1);
    newLines.splice(insertAt, 0, emptyRow);
    newCursorRow = insertAt;
  } else if (command === "table-insert-row-above") {
    const emptyRow = buildRow(Array(colCount).fill(" "));
    const insertAt = Math.max(sepIdx + 1, currentRowIdx);
    newLines.splice(insertAt, 0, emptyRow);
    newCursorRow = insertAt;
  } else if (command === "table-duplicate-row") {
    if (currentRowIdx <= sepIdx) return false;
    const insertAt = currentRowIdx + 1;
    newLines.splice(insertAt, 0, lines[currentRowIdx]!);
    newCursorRow = insertAt;
  } else if (command === "table-delete-row") {
    if (lines.length <= 2 || currentRowIdx <= sepIdx || isSeparatorRow(lines[currentRowIdx] ?? "")) {
      return false;
    }
    newLines.splice(currentRowIdx, 1);
    newCursorRow = Math.max(sepIdx + 1, currentRowIdx - 1);
  } else if (command === "table-insert-column" || command === "table-insert-column-left") {
    newCursorCol = command === "table-insert-column-left" ? currentColIdx : currentColIdx + 1;
    newLines = newLines.map((line, rowIdx) => {
      const cells = splitCells(line);
      while (cells.length < colCount) cells.push(" ");
      const cell = rowIdx === sepIdx ? "---" : " ";
      cells.splice(newCursorCol, 0, cell);
      return buildRow(cells);
    });
  } else if (command === "table-duplicate-column") {
    newCursorCol = currentColIdx + 1;
    newLines = newLines.map((line) => {
      const cells = splitCells(line);
      while (cells.length < colCount) cells.push(" ");
      cells.splice(newCursorCol, 0, cells[currentColIdx] ?? " ");
      return buildRow(cells);
    });
  } else if (command === "table-delete-column") {
    if (colCount <= 1) return false;
    const cursorCol = Math.max(0, Math.min(colCount - 1, currentColIdx));
    newLines = newLines.map((line) => {
      const cells = splitCells(line);
      while (cells.length < colCount) cells.push(" ");
      if (cells.length > 1) cells.splice(cursorCol, 1);
      return buildRow(cells);
    });
    newCursorCol = Math.max(0, Math.min(cursorCol, colCount - 2));
  } else if (command === "table-clear-cell") {
    if (currentRowIdx === sepIdx) return false;
    const data = parseMarkdownTable(lines.join("\n"));
    const dataRow = currentRowIdx === 0 ? 0 : currentRowIdx - 1;
    if (data.rows[dataRow]) data.rows[dataRow]![currentColIdx] = "";
    newLines = buildMarkdownTableSource(data).split("\n");
  } else if (command === "table-align-left" || command === "table-align-center" || command === "table-align-right") {
    const model = parseTableModel(lines, startLineNum, currentRowIdx, from - doc.line(startLineNum + currentRowIdx).from);
    if (model.sepIdx < 0) return false;
    const targetAlign: TableAlign = command === "table-align-left" ? "left" : command === "table-align-center" ? "center" : "right";
    const currentAlign = model.aligns[currentColIdx] ?? "none";
    model.aligns[currentColIdx] = currentAlign === targetAlign ? "none" : targetAlign;
    const sepCells = splitCells(lines[model.sepIdx] ?? "");
    while (sepCells.length < colCount) sepCells.push("---");
    sepCells[currentColIdx] = model.aligns[currentColIdx] === "center"
      ? ":---:"
      : model.aligns[currentColIdx] === "left"
        ? ":---"
        : model.aligns[currentColIdx] === "right"
          ? "---:"
          : "---";
    newLines[model.sepIdx] = buildRow(sepCells);
    newCursorRow = currentRowIdx;
    newCursorCol = currentColIdx;
  } else if (command === "table-move-row-up" || command === "table-move-row-down") {
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
    const swapWith = command === "table-move-column-left" ? currentColIdx - 1 : currentColIdx + 1;
    if (swapWith < 0 || swapWith >= colCount) return false;
    newLines = newLines.map((line) => {
      const cells = splitCells(line);
      while (cells.length < colCount) cells.push(" ");
      const tmp = cells[currentColIdx]!;
      cells[currentColIdx] = cells[swapWith]!;
      cells[swapWith] = tmp;
      return buildRow(cells);
    });
    newCursorCol = swapWith;
  } else if (command === "table-format") {
    const model = parseTableModel(lines, startLineNum, currentRowIdx, from - doc.line(startLineNum + currentRowIdx).from);
    if (tableTooLarge(model)) return false;
    newLines = formatTableLines(model);
    newCursorRow = currentRowIdx;
    newCursorCol = currentColIdx;
  } else if (command === "table-sort-ascending" || command === "table-sort-descending") {
    const model = parseTableModel(lines, startLineNum, currentRowIdx, from - doc.line(startLineNum + currentRowIdx).from);
    if (model.sepIdx < 0 || tableTooLarge(model) || model.sepIdx + 1 >= lines.length) return false;
    newLines = sortTableBodyRows(lines, currentColIdx,
      command === "table-sort-ascending" ? 1 : -1, splitCells, model.sepIdx + 1);
    newCursorRow = model.sepIdx + 1;
  } else if (command === "table-copy-csv") {
    const model = parseTableModel(lines, startLineNum, currentRowIdx, from - doc.line(startLineNum + currentRowIdx).from);
    if (model.sepIdx < 0 || tableTooLarge(model)) return false;
    void writeSystemClipboard(tableRowsToCSV(model.rows.filter((_, index) => index !== model.sepIdx)));
    return true;
  } else {
    return false;
  }

  const newText = newLines.join("\n");
  const cursorRowIdx = Math.max(0, Math.min(newCursorRow, newLines.length - 1));
  const cursorRow = newLines[cursorRowIdx] ?? "";
  const cursor = startPos + rowOffset(newLines, cursorRowIdx) + cellOffset(cursorRow, newCursorCol);
  view.dispatch({
    changes: { from: startPos, to: endPos, insert: newText },
    selection: { anchor: cursor },
    scrollIntoView: true,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Table navigation & native cell editing ergonomics
// ---------------------------------------------------------------------------

/**
 * Tab / Shift-Tab cell navigation. Moves cleanly without rewriting existing
 * rows' whitespace (zero phantom undo steps or Git diff churn). Tab at the
 * last cell of the last row appends a new empty row and enters its first cell.
 */
export function tableNavigateCell(view: EditorView, dir: 1 | -1): boolean {
  const info = findTableInfo(view);
  if (!info) return false;
  const { lines, startLineNum, currentRowIdx, currentColIdx, sepIdx } = info;
  const doc = view.state.doc;
  const endPos = info.sourceTo;
  const colCount = Math.max(1, splitCells(lines[0] ?? "").length);

  type Cell = { rowIdx: number; colIdx: number };
  const cells: Cell[] = [];
  for (let r = 0; r < lines.length; r++) {
    if (r === sepIdx) continue;
    for (let c = 0; c < colCount; c++) cells.push({ rowIdx: r, colIdx: c });
  }
  const curCellIdx = cells.findIndex((c) => c.rowIdx === currentRowIdx && c.colIdx === currentColIdx);
  const targetCellIdx = curCellIdx + dir;

  // Append a new row when Tabbing past the last cell (without touching earlier rows).
  if (dir === 1 && targetCellIdx >= cells.length) {
    const emptyRow = emptyRowMatchingStyle(lines[lines.length - 1] ?? lines[0] ?? "", colCount);
    const cell = tableCellTarget(emptyRow, 0);
    const cursor = endPos + 1 + cell.anchor;
    view.dispatch({
      changes: { from: endPos, to: endPos, insert: `\n${emptyRow}` },
      selection: { anchor: cursor },
      scrollIntoView: true,
    });
    return true;
  }
  if (targetCellIdx < 0 || targetCellIdx >= cells.length) return false;

  const target = cells[targetCellIdx]!;
  const targetLine = doc.line(startLineNum + target.rowIdx);
  const cell = tableCellTarget(targetLine.text, target.colIdx);
  view.dispatch({
    selection: { anchor: targetLine.from + cell.anchor, head: targetLine.from + cell.head },
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

/**
 * Enter at the end of a lone `| a | b |` line makes it a table header: the
 * delimiter row and an empty body row are added and the caret moves into the
 * first body cell.
 */
function createTableFromHeaderRow(view: EditorView): boolean {
  const state = view.state;
  const { from, to } = state.selection.main;
  if (from !== to) return false;
  const line = state.doc.lineAt(from);
  if (from !== line.to || !/^\s*\|.*\|\s*$/.test(line.text)) return false;
  const doc = state.doc;
  if (line.number > 1 && /^\s*\|.*\|\s*$/.test(doc.line(line.number - 1).text)) return false;
  if (line.number < doc.lines && /^\s*\|.*\|\s*$/.test(doc.line(line.number + 1).text)) return false;
  const columns = splitCells(line.text).length;
  if (columns < 2) return false;
  const sep = buildRow(Array(columns).fill("---"));
  const body = `| ${Array(columns).fill("").join(" | ")} |`;
  const insert = `${line.text}\n${sep}\n${body}`;
  const cursor = line.from + line.text.length + 1 + sep.length + 1 + tableCellTarget(body, 0).anchor;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: cursor },
    scrollIntoView: true,
  });
  return true;
}

/** The table cell holding the caret: its row's line, column, raw and text spans (absolute). */
type CaretTableCell = {
  info: TableInfo;
  separator: number;
  rowLine: Line;
  col: number;
  colCount: number;
  raw: { from: number; to: number };
  text: { from: number; to: number };
};

function caretTableCell(view: EditorView, allowNonEmptyInCell = false): CaretTableCell | null {
  const range = view.state.selection.main;
  if (view.state.selection.ranges.length > 1) return null;
  if (!allowNonEmptyInCell && !range.empty) return null;
  const info = findTableInfo(view);
  if (!info || info.sepIdx < 0 || info.currentRowIdx === info.sepIdx) return null;
  const line = view.state.doc.line(info.startLineNum + info.currentRowIdx);
  if (allowNonEmptyInCell && (range.from < line.from || range.to > line.to)) return null;
  const target = tableCellTarget(line.text, info.currentColIdx);
  const rawFrom = line.from + target.from;
  const rawTo = line.from + target.to;
  if (allowNonEmptyInCell && (range.from < rawFrom || range.to > rawTo)) return null;
  return {
    info,
    separator: info.sepIdx,
    rowLine: line,
    col: info.currentColIdx,
    colCount: Math.max(1, splitCells(info.lines[0] ?? "").length),
    raw: { from: rawFrom, to: rawTo },
    text: { from: line.from + Math.min(target.anchor, target.head), to: line.from + Math.max(target.anchor, target.head) },
  };
}

/** Put the caret in cell COL of table row ROW at start or end of its text. */
function moveToTableCell(view: EditorView, info: TableInfo, row: number, col: number, atStart: boolean): boolean {
  const line = view.state.doc.line(info.startLineNum + row);
  const target = tableCellTarget(line.text, col);
  const at = line.from + (atStart ? Math.min(target.anchor, target.head) : Math.max(target.anchor, target.head));
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true, userEvent: "select" });
  return true;
}

/** Put the caret in cell COL of table row ROW preserving horizontal character offset. */
function moveToTableCellAtOffset(view: EditorView, info: TableInfo, row: number, col: number, offset: number): boolean {
  const line = view.state.doc.line(info.startLineNum + row);
  const target = tableCellTarget(line.text, col);
  const textFrom = line.from + Math.min(target.anchor, target.head);
  const textTo = line.from + Math.max(target.anchor, target.head);
  const at = Math.max(textFrom, Math.min(textTo, textFrom + offset));
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true, userEvent: "select" });
  return true;
}

/**
 * ArrowDown/ArrowUp in a table cell: step through wrapped visual rows inside
 * the active cell first (`screen-rows.ts`); at the cell's first/last visual
 * row, move to the same column of the previous/next table row (skipping the
 * separator row) while preserving horizontal offset. Past the first or last
 * row it leaves the table cleanly (opening a line at EOF).
 */
export function tableMoveVertical(view: EditorView, dir: 1 | -1): boolean {
  const cell = caretTableCell(view);
  if (!cell) return false;
  const range = view.state.selection.main;
  if (rowLayoutAvailable(view)) {
    const visualRow = screenRowAt(view, range.head, range.assoc < 0 ? -1 : 1);
    const hasMoreVisualRowsInCell = dir > 0
      ? visualRow.to < cell.text.to
      : visualRow.from > cell.text.from;
    if (hasMoreVisualRowsInCell) {
      const moved = moveByVisualRow(view, range, dir > 0);
      if (moved.head >= cell.rowLine.from && moved.head <= cell.rowLine.to) {
        const clamped = Math.max(cell.text.from, Math.min(cell.text.to, moved.head));
        if (clamped !== range.head) {
          view.dispatch({
            selection: EditorSelection.cursor(clamped, moved.assoc, undefined, moved.goalColumn),
            scrollIntoView: true,
            userEvent: "select",
          });
          return true;
        }
      }
    }
  }

  let row = cell.info.currentRowIdx + dir;
  if (row === cell.separator) row += dir;
  if (row >= cell.info.lines.length) {
    const doc = view.state.doc;
    if (cell.info.startLineNum + cell.info.lines.length - 1 !== doc.lines) return false;
    view.dispatch({
      changes: { from: doc.length, insert: "\n" },
      selection: { anchor: doc.length + 1 },
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  }
  if (row < 0) return false;
  const offsetInCell = Math.max(0, range.head - cell.text.from);
  return moveToTableCellAtOffset(view, cell.info, row, cell.col, offsetInCell);
}

/**
 * ArrowRight at a cell text's end enters the next cell's start; ArrowLeft at
 * its start enters the previous cell's end, wrapping between rows. Elsewhere
 * the caret moves through the text natively.
 */
export function tableMoveHorizontal(view: EditorView, dir: 1 | -1): boolean {
  const cell = caretTableCell(view);
  if (!cell) return false;
  const head = view.state.selection.main.head;
  if (dir > 0 ? head < cell.text.to : head > cell.text.from) return false;
  let row = cell.info.currentRowIdx;
  let col = cell.col + dir;
  if (col < 0 || col >= cell.colCount) {
    row += dir;
    if (row === cell.separator) row += dir;
    if (row < 0 || row >= cell.info.lines.length) return false;
    col = dir > 0 ? 0 : cell.colCount - 1;
  }
  return moveToTableCell(view, cell.info, row, col, dir > 0);
}

/**
 * Backspace at a cell text's start: the previous cell's end, never the pipe
 * between them, which would break the table. In the first cell it does nothing.
 */
export function tableBackspaceAtCellStart(view: EditorView): boolean {
  const cell = caretTableCell(view);
  if (!cell || view.state.selection.main.head > cell.text.from) return false;
  return tableMoveHorizontal(view, -1) || true;
}

/**
 * Forward Delete at a cell text's end: move to the next cell's start, never
 * deleting the closing pipe delimiter. In the last cell it does nothing.
 */
export function tableDeleteAtCellEnd(view: EditorView): boolean {
  const cell = caretTableCell(view);
  if (!cell) return false;
  const head = view.state.selection.main.head;
  if (head < cell.text.to) return false;
  return tableMoveHorizontal(view, 1) || true;
}

/**
 * Cell-scoped Home / End / Mod-ArrowLeft / Mod-ArrowRight: stay inside the
 * active cell's text span instead of jumping across pipes into another column.
 */
export function tableMoveCellBoundary(view: EditorView, forward: boolean, extend = false): boolean {
  const cell = caretTableCell(view, true);
  if (!cell) return false;
  const range = view.state.selection.main;
  const target = forward ? cell.text.to : cell.text.from;
  const selection = extend
    ? EditorSelection.range(range.anchor, target)
    : EditorSelection.cursor(target);
  if (selection.anchor === range.anchor && selection.head === range.head) return true;
  view.dispatch({ selection, scrollIntoView: true, userEvent: "select" });
  return true;
}

/**
 * Cell-scoped Mod-Backspace: delete back to the start of the active cell's text,
 * never eating preceding columns or pipe delimiters.
 */
export function tableDeleteToCellStart(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const cell = caretTableCell(view, true);
  if (!cell) return false;
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const from = cell.text.from;
  if (range.head <= from) return true;
  view.dispatch({
    changes: { from, to: range.head },
    selection: EditorSelection.cursor(from),
    scrollIntoView: true,
    userEvent: "delete.backward",
  });
  return true;
}

/**
 * Three-stage Obsidian/Typora Select All inside a table:
 * 1) Select active cell's text; 2) Select the entire table; 3) Fall through to document.
 */
export function tableSelectAll(view: EditorView): boolean {
  const info = findTableInfo(view);
  if (!info || info.sepIdx < 0) return false;
  const range = view.state.selection.main;
  if (view.state.selection.ranges.length > 1) return false;
  const doc = view.state.doc;
  const lastLineNum = info.startLineNum + info.lines.length - 1;
  const tableTo = lastLineNum < doc.lines && readLayoutAttrsLine(doc.line(lastLineNum + 1).text)
    ? doc.line(lastLineNum + 1).to
    : info.sourceTo;

  if (info.currentRowIdx !== info.sepIdx) {
    const line = doc.line(info.startLineNum + info.currentRowIdx);
    const cell = tableCellTarget(line.text, info.currentColIdx);
    const cellFrom = line.from + Math.min(cell.anchor, cell.head);
    const cellTo = line.from + Math.max(cell.anchor, cell.head);
    if (cellFrom < cellTo && range.from >= cellFrom && range.to <= cellTo
        && (range.from !== cellFrom || range.to !== cellTo)) {
      view.dispatch({ selection: { anchor: cellFrom, head: cellTo }, userEvent: "select" });
      return true;
    }
  }

  if (range.from !== info.from || range.to !== tableTo) {
    view.dispatch({ selection: { anchor: info.from, head: tableTo }, userEvent: "select" });
    return true;
  }

  return false;
}

/**
 * Auto-escape a typed `|` inside an active table cell to `\|` so typing math
 * absolute values or conditional probabilities never splits table columns.
 */
export function handleTablePipeInput(
  view: EditorView,
  from: number,
  to: number,
  text: string,
): boolean {
  if (text !== "|" || view.compositionStarted || view.state.readOnly) return false;
  const state = view.state;
  const excluded = [...getBlockMathRanges(state), ...getFencedCodeRanges(state)];
  const found = findTableAtPos(state.doc, from, excluded);
  if (!found || found.currentRowIdx === found.sepLineNum - found.startLineNum) return false;
  const line = state.doc.lineAt(from);
  if (state.doc.lineAt(to).number !== line.number) return false;
  // If the author already typed an odd number of backslashes right before `|`, keep literal `|`.
  let slashes = 0;
  for (let i = from - line.from - 1; i >= 0 && line.text[i] === "\\"; i--) slashes++;
  if (slashes % 2 === 1) return false;
  view.dispatch({
    changes: { from, to, insert: "\\|" },
    selection: EditorSelection.cursor(from + 2),
    scrollIntoView: true,
    userEvent: "input.type",
  });
  return true;
}

/**
 * Shift-Enter in a table cell: a line break inside the cell (`<br>`).
 */
export function tableCellLineBreak(view: EditorView): boolean {
  const info = findTableInfo(view);
  if (!info || info.sepIdx < 0) return false;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: "<br>" },
    selection: { anchor: from + 4 },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/** Mod-Enter in a table: a new body row below the current one, caret in its first cell. */
export function tableInsertRowBelow(view: EditorView): boolean {
  const info = findTableInfo(view);
  if (!info || info.sepIdx < 0) return false;
  if (!runTableCommandCM6(view, "table-insert-row")) return false;
  const row = view.state.doc.lineAt(view.state.selection.main.head);
  const target = tableCellTarget(row.text, 0);
  view.dispatch({ selection: { anchor: row.from + target.anchor, head: row.from + target.head }, scrollIntoView: true });
  return true;
}

/** Enter in a table cell: move to same column in next body row; on empty last row exit the table. */
export function tableEnterSameColumn(view: EditorView): boolean {
  const info = findTableInfo(view);
  if (!info) return createTableFromHeaderRow(view);
  const { lines, startLineNum, currentRowIdx, currentColIdx, sepIdx } = info;
  const doc = view.state.doc;
  const startPos = info.from;
  const endPos = info.sourceTo;

  const firstBodyRow = sepIdx + 1;
  const colCount = Math.max(1, splitCells(lines[0] ?? "").length);

  // If cursor is on an empty final table row (or empty final piped row before
  // non-piped prose) → delete that empty row and move below the table.
  const isFinalRow = currentRowIdx === lines.length - 1
    || (hasUnescapedPipe(lines[currentRowIdx] ?? "") && !hasUnescapedPipe(lines[currentRowIdx + 1] ?? ""));
  if (isFinalRow && currentRowIdx >= firstBodyRow) {
    const cells = splitCells(lines[currentRowIdx] ?? "");
    const isEmpty = cells.every((c) => c.trim() === "");
    if (isEmpty) {
      const curLine = doc.line(startLineNum + currentRowIdx);
      if (currentRowIdx === lines.length - 1) {
        const newLines = lines.slice(0, currentRowIdx);
        const newText = newLines.join("\n");
        const replacement = endPos === doc.length ? `${newText}\n` : newText;
        view.dispatch({
          changes: { from: startPos, to: endPos, insert: replacement },
          selection: { anchor: startPos + newText.length + 1 },
          scrollIntoView: true,
        });
      } else {
        // Remove the empty piped row + its trailing newline, landing on the following line.
        view.dispatch({
          changes: { from: curLine.from, to: curLine.to + 1, insert: "" },
          selection: { anchor: curLine.from },
          scrollIntoView: true,
        });
      }
      return true;
    }
  }

  // Find next body row (skip separator)
  let nextRow = currentRowIdx + 1;
  if (nextRow === sepIdx) nextRow++;
  if (nextRow >= lines.length) {
    const emptyRow = emptyRowMatchingStyle(lines[lines.length - 1] ?? lines[0] ?? "", colCount);
    const cell = tableCellTarget(emptyRow, currentColIdx);
    const cursor = endPos + 1 + cell.anchor;
    view.dispatch({
      changes: { from: endPos, to: endPos, insert: `\n${emptyRow}` },
      selection: { anchor: cursor },
      scrollIntoView: true,
    });
    return true;
  }

  const targetLine = doc.line(startLineNum + nextRow);
  const cell = tableCellTarget(targetLine.text, currentColIdx);
  view.dispatch({
    selection: { anchor: targetLine.from + cell.anchor, head: targetLine.from + cell.head },
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/** The fenced block containing POS, as its opening and closing fence lines. */
function fencedBlockAt(state: EditorView["state"], pos: number): { open: Line; close: Line | null } | null {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + 1), 100) ?? syntaxTree(state);
  for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
    if (node.name !== "FencedCode") continue;
    const open = state.doc.lineAt(node.from);
    const last = state.doc.lineAt(node.to);
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(open.text)?.[1];
    if (!fence) return null;
    // An unterminated fence runs to the end of the document and has no closer.
    const closed = last.number > open.number
      && new RegExp(`^[ \\t]{0,3}${fence[0]}{${fence.length},}[ \\t]*$`, "u").test(last.text);
    return { open, close: closed ? last : null };
  }
  return null;
}

/**
 * Toggle a fenced code block. Inside a fence the two fence lines go and the
 * code stays; a selection has its whole lines fenced; a bare caret gets an
 * empty block. The fence is made longer than any backtick run in the body, so
 * fencing text that itself shows a fence does not end early.
 */
function toggleCodeBlock(view: EditorView, lang: string): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const fenced = fencedBlockAt(state, from);
  if (fenced) {
    const { open, close } = fenced;
    const bodyFrom = Math.min(state.doc.length, open.to + 1);
    const bodyTo = close ? Math.max(bodyFrom, close.from - 1) : state.doc.length;
    const changes = [{ from: open.from, to: bodyFrom }];
    if (close) changes.push({ from: bodyTo, to: close.to });
    view.dispatch({
      changes,
      selection: { anchor: open.from, head: open.from + (bodyTo - bodyFrom) },
      scrollIntoView: true,
      userEvent: "input.format",
    });
    return true;
  }
  if (from === to) {
    insertBlock(view, `\`\`\`${lang}\n\n\`\`\``, lang.length + 4);
    return true;
  }
  const first = state.doc.lineAt(from);
  const last = state.doc.lineAt(state.doc.lineAt(to).from === to ? to - 1 : to);
  const body = state.doc.sliceString(first.from, last.to);
  const longest = Math.max(0, ...Array.from(body.matchAll(/`+/gu), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const bodyFrom = first.from + fence.length + lang.length + 1;
  view.dispatch({
    changes: { from: first.from, to: last.to, insert: `${fence}${lang}\n${body}\n${fence}` },
    selection: { anchor: bodyFrom, head: bodyFrom + body.length },
    scrollIntoView: true,
    userEvent: "input.format",
  });
  return true;
}

/**
 * Wrap the selection in `\(…\)`, or unwrap the formula the selection is in.
 * A bare caret gets an empty pair to type into. Math is a single-line span,
 * so a selection that crosses a line break is left alone.
 */
function toggleInlineMath(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  if (range.to > line.to || !inlineFormatsAvailable(state) || insideInlineCode(state, range.from)) return false;
  const formula = scanInlineMathRanges(line.text, line.from)
    .find((item) => item.from <= range.from && range.to <= item.to);
  if (formula) {
    view.dispatch({
      changes: [{ from: formula.from, to: formula.from + 2 }, { from: formula.to - 2, to: formula.to }],
      selection: { anchor: formula.from, head: formula.to - 4 },
      scrollIntoView: true,
      userEvent: "input.format",
    });
    return true;
  }
  // Edge whitespace stays outside the delimiters, as for the other marks.
  const selected = state.doc.sliceString(range.from, range.to);
  const from = range.from + (selected.length - selected.trimStart().length);
  const to = Math.max(from, range.to - (selected.length - selected.trimEnd().length));
  view.dispatch({
    changes: [{ from, insert: "\\(" }, { from: to, insert: "\\)" }],
    selection: { anchor: from + 2, head: to + 2 },
    scrollIntoView: true,
    userEvent: "input.format",
  });
  return true;
}

export function runCommandCM6(view: EditorView, command: EditorCommand, value = ""): boolean {
  if (command === "move-block-up") return moveBlockAtCursor(view, -1);
  if (command === "duplicate-block") return duplicateBlockAtCursor(view);
  if (command === "delete-block") return deleteBlockAtCursor(view);
  if (command === "move-block-down") return moveBlockAtCursor(view, 1);
  if (command === "fold-heading") return foldHeadingAtCursor(view);
  if (command === "unfold-heading") return unfoldHeadingAtCursor(view);
  if (command === "toggle-fold") return toggleFoldAtCursor(view);
  if (command === "fold-all-headings") return foldAllHeadings(view);
  if (command === "unfold-all-headings") return unfoldAllHeadings(view);

  // ── Inline marks ────────────────────────────────────────────────────────
  if (command === "bold") return toggleInline(view, "bold");
  if (command === "italic") return toggleInline(view, "italic");
  if (command === "highlight") return toggleInline(view, "highlight");
  if (command === "strike") return toggleInline(view, "strike");
  if (command === "code") return toggleInline(view, "code");
  if (command === "superscript") return toggleInline(view, "superscript");
  if (command === "subscript") return toggleInline(view, "subscript");
  if (command === "inline-math") return toggleInlineMath(view);
  if (command === "clear-format") return dispatchSpec(view, clearInlineFormatSpec(view.state));
  if (command === "insert-footnote") return insertFootnote(view);
  if (command === "insert-revision") return insertRevision(view, value);
  if (command === "edit-revision") return editRevision(view, value);
  if (command === "edit-properties") return editProperties(view);

  if (command === "link") {
    if (!inlineFormatsAvailable(view.state)) return false;
    if (!value && unlinkAtSelection(view)) return true;
    const existing = value ? linkAtSelection(view.state) : null;
    if (existing) {
      const label = linkLabel(view.state, existing);
      if (label === null) return false;
      const text = `[${label}](${value})`;
      const hrefFrom = existing.base + existing.node.from + label.length + 3;
      view.dispatch({
        changes: { from: existing.base + existing.node.from, to: existing.base + existing.node.to, insert: text },
        selection: { anchor: hrefFrom, head: hrefFrom + value.length },
        scrollIntoView: true,
      });
      return true;
    }
    let { from, to } = view.state.selection.main;
    if (from === to) {
      if (insideImage(view.state, from) || insideInlineCode(view.state, from)) return false;
      // A caret inside a word links that word, as Typora does.
      const word = wordAround(view.state.doc, from);
      if (word) ({ from, to } = word);
    }
    const selection = from === to ? null : linkSelectionText(view.state, from, to);
    if (from !== to && !selection) return false;
    if (selection) ({ from, to } = selection);
    const selected = selection?.text ?? "";
    if (!value && /^(?:https?:\/\/|mailto:)\S+$/i.test(selected)) {
      // A selected URL becomes its own target with the text selected to retitle.
      const text = `[${selected}](${selected})`;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + 1, head: from + 1 + selected.length },
        scrollIntoView: true,
      });
      return true;
    }
    const sel = from === to ? "link" : selected;
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
  if (command === "code-block") return toggleCodeBlock(view, value || "");

  if (command === "insert-table") {
    const md = "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |";
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const needNewline = line.text.trim().length > 0;
    const prefix = needNewline ? "\n\n" : "";
    const insertPos = needNewline ? line.to : line.from;
    const replaceTo = needNewline ? line.to : line.to;
    const start = insertPos + prefix.length;
    view.dispatch({
      changes: { from: insertPos, to: replaceTo, insert: prefix + md },
      selection: { anchor: start + 2, head: start + 10 },
      scrollIntoView: true,
    });
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

  if (command === "insert-horizontal-rule") {
    insertThematicBreak(view);
    return true;
  }

  if (command === "insert-org-env") {
    const kind = (value || "note").trim() || "note";
    const open = `#+begin ${kind}`;
    insertBlock(view, `${open}\n\n#+end ${kind}`, open.length + 1);
    return true;
  }

  if (command === "insert-columns") {
    const requested = /^(columns|flow)(?::([2-6]))?$/i.exec((value || "columns").trim());
    const mode = requested?.[1]?.toLowerCase() === "flow" ? "flow" : "columns";
    const count = Math.max(2, Math.min(mode === "flow" ? 4 : 6, Number(requested?.[2] || 2)));
    const open = mode === "flow" ? `#+begin columns {mode=flow cols=${count}}` : "#+begin columns";
    const close = "#+end columns";
    const { from, to } = view.state.selection.main;
    if (from === to) {
      if (mode === "flow") {
        insertBlock(view, `${open}\n\n${close}`, open.length + 1);
        return true;
      }
      const dividers = Array.from({ length: count - 1 }, () => "#+col").join("\n\n");
      insertBlock(view, `${open}\n\n${dividers}\n\n${close}`, open.length + 1);
      return true;
    }
    // Like the existing block commands, a selection claims every touched line.
    // Read only those lines and commit the wrap as one undoable change.
    const doc = view.state.doc;
    const start = doc.lineAt(from).from;
    const end = doc.lineAt(to - 1).to;
    const body = doc.sliceString(start, end);
    if (mode === "flow") {
      view.dispatch({
        changes: { from: start, to: end, insert: `${open}\n${body}\n${close}` },
        selection: { anchor: start + open.length + 1, head: start + open.length + 1 + body.length },
        scrollIntoView: true,
      });
      return true;
    }
    // Split selected top-level blank-line chunks outside fenced code / org envs.
    const rawLines = body.split("\n");
    const chunks: string[] = [];
    let currentChunk: string[] = [];
    let fenceChar = "";
    let fenceLen = 0;
    let envDepth = 0;
    for (const rawLine of rawLines) {
      if (fenceChar) {
        currentChunk.push(rawLine);
        const closeFence = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(rawLine);
        if (closeFence && closeFence[1]![0] === fenceChar && closeFence[1]!.length >= fenceLen) {
          fenceChar = "";
          fenceLen = 0;
        }
        continue;
      }
      const openFence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(rawLine);
      if (openFence) {
        fenceChar = openFence[1]![0]!;
        fenceLen = openFence[1]!.length;
        currentChunk.push(rawLine);
        continue;
      }
      if (/^[ \t]*#\+begin[ \t]+\S+/i.test(rawLine)) {
        envDepth++;
        currentChunk.push(rawLine);
        continue;
      }
      if (/^[ \t]*#\+end[ \t]+\S+[ \t]*$/i.test(rawLine)) {
        if (envDepth > 0) envDepth--;
        currentChunk.push(rawLine);
        continue;
      }
      if (envDepth === 0 && !rawLine.trim()) {
        if (currentChunk.length > 0) {
          chunks.push(currentChunk.join("\n"));
          currentChunk = [];
        }
      } else {
        currentChunk.push(rawLine);
      }
    }
    if (currentChunk.length > 0) chunks.push(currentChunk.join("\n"));

    if (chunks.length <= 1) {
      // Single selected block (e.g. "Put in 2 columns" on a figure or table):
      // put it in Column 1 and place caret directly in Column 2 ready to type.
      const extraPanes = Array.from({ length: count - 1 }, () => "").join("\n\n#+col\n\n");
      const wrappedBody = `${body}\n\n#+col\n${extraPanes}`;
      const caretPos = start + open.length + 1 + body.length + "\n\n#+col\n".length;
      view.dispatch({
        changes: { from: start, to: end, insert: `${open}\n${wrappedBody}\n${close}` },
        selection: { anchor: caretPos },
        scrollIntoView: true,
      });
      return true;
    }

    // Multiple selected blocks: distribute cleanly across `count` columns.
    const groups: string[] = [];
    for (let col = 0; col < count; col++) {
      const sliceFrom = Math.floor((col * chunks.length) / count);
      const sliceTo = Math.floor(((col + 1) * chunks.length) / count);
      groups.push(chunks.slice(sliceFrom, sliceTo).join("\n\n"));
    }
    const wrappedBody = groups.join("\n\n#+col\n\n");
    view.dispatch({
      changes: { from: start, to: end, insert: `${open}\n${wrappedBody}\n${close}` },
      selection: { anchor: start + open.length + 1, head: start + open.length + 1 + wrappedBody.length },
      scrollIntoView: true,
    });
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
    void writeSystemClipboard(text);
    return true;
  }

  // ── Table ────────────────────────────────────────────────────────────────
  if (
    command === "table-insert-row" ||
    command === "table-insert-row-above" ||
    command === "table-insert-column" ||
    command === "table-insert-column-left" ||
    command === "table-delete-row" ||
    command === "table-delete-column" ||
    command === "table-duplicate-row" ||
    command === "table-duplicate-column" ||
    command === "table-clear-cell" ||
    command === "table-delete-table" ||
    command === "table-align-left" ||
    command === "table-align-center" ||
    command === "table-align-right" ||
    command === "table-move-row-up" ||
    command === "table-move-row-down" ||
    command === "table-move-column-left" ||
    command === "table-move-column-right" ||
    command === "table-format" ||
    command === "table-sort-ascending" ||
    command === "table-sort-descending" ||
    command === "table-copy-csv"
  ) return runTableCommandCM6(view, command);

  // ── Line prefix commands (heading / blockquote / lists) ──────────────────
  const headingMatch = command.match(/^heading-([1-6])$/);
  if (headingMatch) return dispatchSpec(view, toggleHeadingSpec(view.state, Number(headingMatch[1])));
  if (command === "heading-promote") return dispatchSpec(view, changeHeadingLevelSpec(view.state, -1));
  if (command === "heading-demote") return dispatchSpec(view, changeHeadingLevelSpec(view.state, 1));

  if (command === "blockquote") return dispatchSpec(view, toggleBlockquoteSpec(view.state));
  if (command === "toggle-task") return dispatchSpec(view, toggleTaskCheckSpec(view.state));
  const listKind: ListKind | null = command === "bullet-list" ? "bullet"
    : command === "ordered-list" ? "ordered"
      : command === "task-list" ? "task"
        : null;
  if (listKind) {
    const spec = toggleListSpec(view.state, listKind);
    if (!spec) return false;
    if (listKind === "ordered") dispatchRenumbered(view, spec);
    else view.dispatch(spec);
    return true;
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
      // Callers filter with their own aliases (e.g. pinyin) before capping
      // the popup; truncating here would hide later items from any query.
      return [...byId.values()];
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
