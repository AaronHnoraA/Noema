/**
 * Where a paste lands decides what it should become.
 *
 * The clipboard pipeline (`src/paste.ts`) turns a clipboard into Markdown once,
 * without knowing the caret. MarkText's paste (`muya/src/clipboard/paste.ts`)
 * shows that the destination matters as much as the source, and its rules are
 * restated here for a source editor:
 *
 *   - code (fenced, indented or inline) takes the clipboard's plain text
 *     literally, never HTML converted to Markdown;
 *   - a table row holds one line: the paste is trimmed, its newlines become
 *     `<br>` and its pipes are escaped, so the row keeps its columns;
 *   - inside a link destination `](|)` a pasted Markdown link contributes only
 *     its URL, instead of nesting `[t]([t](url))`;
 *   - a URL pasted over selected text makes the selection a link (files.md,
 *     Tiptap's link paste rule);
 *   - with several carets, a paste with exactly one line per caret is
 *     distributed line by line, as CodeMirror's own paste does.
 */

import {
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type TransactionSpec,
} from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";

export type PasteSourceText = {
  /** The Markdown the clipboard pipeline produced. */
  markdown: string;
  /** The clipboard's own plain text, when it had one. */
  plainText?: string;
};

type PasteContextKind = "code-block" | "inline-code" | "table-row" | "link-destination" | "text";

const CODE_BLOCK_NODES = new Set(["FencedCode", "CodeBlock", "IndentedCode"]);
const TABLE_NODES = new Set(["Table", "TableHeader", "TableRow", "TableCell", "TableDelimiter"]);
const SINGLE_URL_RE = /^(?:https?:\/\/|mailto:|file:\/\/|zotero:\/\/)[^\s<>]+$/i;
const LINK_NODES = new Set(["Link", "Image", "Autolink", "URL", "InlineCode"]);
/** Quote markers, list indentation, and a list marker with optional task box. */
const CONTAINER_RE = /^((?:[ \t]{0,3}>[ \t]?)*)([ \t]*)((?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/u;
const PASTED_LIST_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/u;
const MARKDOWN_LINK_RE = /^\[[^\]\n]*\]\(\s*<?([^\s<>()]+(?:\([^\s()]*\))*[^\s<>()]*)>?(?:\s+"[^"\n]*")?\s*\)$/;

function contextAt(state: EditorState, range: SelectionRange): PasteContextKind {
  const doc = state.doc;
  const line = doc.lineAt(range.from);
  const tree = ensureSyntaxTree(state, line.to, 100) ?? syntaxTree(state);
  for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(range.from, -1); node; node = node.parent) {
    if (CODE_BLOCK_NODES.has(node.name)) return "code-block";
    if (node.name === "InlineCode" && range.from > node.from && range.from < node.to) return "inline-code";
    if (TABLE_NODES.has(node.name) && doc.lineAt(range.to).number === line.number) return "table-row";
  }
  const before = doc.sliceString(line.from, range.from);
  const after = doc.sliceString(range.to, line.to);
  if (/\]\(\s*$/.test(before) && /^\s*\)/.test(after)) return "link-destination";
  return "text";
}

/** Whether [from, to] lies inside a link, image, URL or code span. */
function insideLinkOrCode(state: EditorState, from: number, to: number): boolean {
  const tree = ensureSyntaxTree(state, to, 100) ?? syntaxTree(state);
  for (const pos of [from, to]) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, pos === from ? 1 : -1); node; node = node.parent) {
      if (LINK_NODES.has(node.name) && node.from < to && node.to > from) return true;
    }
  }
  return false;
}

/**
 * Multi-line text pasted inside a quote or list item stays in that container.
 *
 * MarkText inserts pasted blocks as children of the block at the caret and
 * merges a pasted list into the list it lands in (`tryMergeListPaste`). In
 * source the same result needs the container's prefix on every following
 * line: a quote's `> `, a list item's continuation indent, or — for a pasted
 * list — the list's own indentation so the items stay siblings. A pasted list
 * on an empty item takes over that item's marker; at the end of an item it
 * starts the next item.
 */
function adaptToContainer(state: EditorState, range: SelectionRange, text: string): string {
  if (!text.includes("\n")) return text;
  const line = state.doc.lineAt(range.from);
  if (state.doc.lineAt(range.to).number !== line.number) return text;
  const match = CONTAINER_RE.exec(line.text)!;
  const [prefix, quote = "", indent = "", marker = ""] = match;
  if (!quote && !marker) return text;
  if (range.from - line.from < prefix.length) return text;
  const before = line.text.slice(prefix.length, range.from - line.from);
  const after = line.text.slice(range.to - line.from);
  const lines = text.split("\n");
  const pastedList = Boolean(marker) && PASTED_LIST_RE.test(lines[0]!);
  const quoteBlank = quote.trimEnd();
  if (pastedList && !after.trim()) {
    const base = PASTED_LIST_RE.exec(lines[0]!)![1]!.length;
    const sibling = (raw: string): string => {
      if (!raw.trim()) return quoteBlank;
      const own = /^[ \t]*/u.exec(raw)![0].length;
      return `${quote}${indent}${raw.slice(Math.min(own, base))}`;
    };
    if (!before.trim()) {
      // The empty item keeps its marker; the first pasted item supplies text.
      const first = lines[0]!.replace(PASTED_LIST_RE, "");
      const keepBox = /\[[ xX]\][ \t]+$/u.test(marker);
      return [keepBox ? first.replace(/^\[[ xX]\][ \t]+/u, "") : first, ...lines.slice(1).map(sibling)].join("\n");
    }
    return ["", ...lines.map(sibling)].join("\n");
  }
  const continuation = `${quote}${" ".repeat(indent.length + marker.length)}`;
  return [lines[0]!, ...lines.slice(1).map((raw) => (raw.trim() ? `${continuation}${raw}` : quoteBlank))].join("\n");
}

function singleUrl(source: PasteSourceText): string | null {
  for (const candidate of [source.plainText, source.markdown]) {
    const text = (candidate ?? "").trim();
    if (SINGLE_URL_RE.test(text)) return text;
  }
  return null;
}

function escapeTablePipes(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && index + 1 < text.length) {
      out += char + text[index + 1];
      index++;
      continue;
    }
    out += char === "|" ? "\\|" : char;
  }
  return out;
}

function looksLikeMarkdownTable(text: string): boolean {
  const lines = text.trim().split("\n");
  return lines.length >= 2 && lines.every((line) => /^\s*\|.*\|\s*$/.test(line));
}

/** The text a paste of SOURCE should insert over RANGE. */
export function adaptPasteText(state: EditorState, range: SelectionRange, source: PasteSourceText): string {
  const literal = source.plainText ?? source.markdown;
  switch (contextAt(state, range)) {
    case "code-block":
      return literal;
    case "inline-code":
      return literal.replace(/\s*\n\s*/g, " ");
    case "table-row": {
      if (looksLikeMarkdownTable(source.markdown)) return source.markdown;
      return escapeTablePipes(source.markdown.trim().replace(/[ \t]*\r?\n[ \t]*/g, "<br>"));
    }
    case "link-destination": {
      const url = singleUrl(source);
      if (url) return url;
      const link = MARKDOWN_LINK_RE.exec(source.markdown.trim());
      return link?.[1] ?? source.markdown;
    }
    case "text": {
      if (!range.empty) {
        const selected = state.doc.sliceString(range.from, range.to);
        const url = singleUrl(source);
        if (url && selected.trim() && !/[\n[\]]/.test(selected) && !SINGLE_URL_RE.test(selected.trim())
            && !insideLinkOrCode(state, range.from, range.to)) {
          return `[${selected}](${url})`;
        }
      }
      return adaptToContainer(state, range, source.markdown);
    }
  }
}

/**
 * One transaction that pastes SOURCE over RANGES (default: the selection),
 * each range adapted to its own context, leaving a caret after every insert.
 */
export function pasteTransactionSpec(
  state: EditorState,
  source: PasteSourceText,
  ranges: readonly SelectionRange[] = state.selection.ranges,
): TransactionSpec {
  const lines = source.markdown.split(/\r?\n/);
  const distribute = ranges.length > 1 && lines.length === ranges.length;
  const ordered = ranges.map((range, index) => ({ range, index })).sort((a, b) => a.range.from - b.range.from);
  const inserts = ordered.map(({ range, index }) => {
    const own = distribute ? { markdown: lines[index]!, plainText: lines[index]! } : source;
    return { from: range.from, to: range.to, insert: adaptPasteText(state, range, own) };
  });
  const changes = state.changes(inserts);
  const carets = inserts.map((insert) => EditorSelection.cursor(changes.mapPos(insert.from, -1) + insert.insert.length));
  const mainIndex = Math.max(0, ordered.findIndex(({ index }) => index === state.selection.mainIndex));
  return {
    changes,
    selection: EditorSelection.create(carets, Math.min(mainIndex, carets.length - 1)),
    scrollIntoView: true,
    userEvent: "input.paste",
  };
}
