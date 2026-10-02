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
      if (range.empty) return source.markdown;
      const selected = state.doc.sliceString(range.from, range.to);
      const url = singleUrl(source);
      if (url && selected.trim() && !/[\n[\]]/.test(selected) && !SINGLE_URL_RE.test(selected.trim())) {
        return `[${selected}](${url})`;
      }
      return source.markdown;
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
