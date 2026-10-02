/**
 * Noema's Markdown language boundary.
 *
 * Keep grammar configuration here so editor composition and visual features
 * consume one language definition instead of importing Lezer configuration
 * directly.
 */

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { EditorState, Extension, Text } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { inlineMathMarkdownExtension } from "../../../inline-math.ts";
import { nestingAwareLinkExtension } from "./nested-links.ts";
import { cjkEmphasisMarkdownExtension } from "../../../cjk-emphasis.ts";

const markdownOptions = {
  addKeymap: false,
  base: markdownLanguage,
  extensions: [inlineMathMarkdownExtension, nestingAwareLinkExtension, cjkEmphasisMarkdownExtension],
};

const localParser = markdown(markdownOptions).language.parser;

export type MarkdownInlineContext = { tree: Tree; base: number; to: number };
const contextCache = new WeakMap<Text, MarkdownInlineContext[]>();
const CACHE_CHAR_LIMIT = 256 * 1024;

function body(text: string): string {
  return text.replace(/^(?:[ \t]{0,3}>[ \t]?)*/u, "");
}

function startsList(text: string): boolean {
  return /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/u.test(body(text));
}

function singleLineBlock(text: string): boolean {
  return /^[ \t]{0,3}(?:#{1,6}(?:[ \t]+|$)|`{3,}|~{3,}|\||(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$|=+[ \t]*$|#\+(?:begin|end)\b)/iu.test(body(text));
}

/**
 * Inline syntax can cross soft line breaks. Use CM6's existing tree when ready;
 * otherwise parse the selected blocks and their paragraph continuations, rather
 * than forcing the parser through every earlier megabyte of the document.
 */
export function markdownInlineContext(state: EditorState, from: number, to = from): MarkdownInlineContext {
  if (syntaxTreeAvailable(state, to)) return { tree: syntaxTree(state), base: 0, to: state.doc.length };
  const doc = state.doc;
  const cached = contextCache.get(doc) ?? [];
  const hit = cached.find((context) => context.base <= from && context.to >= to);
  if (hit) return hit;
  let first = doc.lineAt(from);
  let last = doc.lineAt(to);
  // A table body row has no Table node without its header and delimiter row.
  // Include adjacent pipe rows so cell boundaries are available at distant
  // positions that CM6 has not parsed yet. The grammar decides whether these
  // lines actually form a table.
  if (first.text.includes("|")) {
    while (first.number > 1 && doc.line(first.number - 1).text.includes("|")) first = doc.line(first.number - 1);
  }
  if (last.text.includes("|")) {
    while (last.number < doc.lines && doc.line(last.number + 1).text.includes("|")) last = doc.line(last.number + 1);
  }
  if (!singleLineBlock(first.text) && !startsList(first.text)) {
    while (first.number > 1) {
      const previous = doc.line(first.number - 1);
      if (!body(previous.text).trim() || singleLineBlock(previous.text)) break;
      first = previous;
      if (startsList(previous.text)) break;
    }
  }
  if (!singleLineBlock(last.text)) {
    while (last.number < doc.lines) {
      const next = doc.line(last.number + 1);
      if (!body(next.text).trim() || singleLineBlock(next.text) || startsList(next.text)) break;
      last = next;
    }
  }
  const context = { tree: localParser.parse(doc.sliceString(first.from, last.to)), base: first.from, to: last.to };
  cached.push(context);
  let size = cached.reduce((sum, entry) => sum + entry.to - entry.base, 0);
  while (cached.length > 1 && (cached.length > 8 || size > CACHE_CHAR_LIMIT)) {
    const removed = cached.shift()!;
    size -= removed.to - removed.base;
  }
  contextCache.set(doc, cached);
  return context;
}

export function createMarkdownLanguageExtension(): Extension {
  return markdown({
    // @codemirror/lang-markdown otherwise injects Prec.high bindings for Enter
    // and Backspace that outrank this editor's own keymap, pre-empting the
    // canonical chain in src/cm6/input-commands.ts (notably the empty-list and
    // empty-quote exits). That chain already calls insertNewlineContinueMarkup
    // and deleteMarkupBackward itself, so nothing is lost by opting out.
    addKeymap: markdownOptions.addKeymap,
    base: markdownOptions.base,
    // CJK text needs emphasis next to its punctuation (`**（注）**说明`); the
    // widening is additive, so CommonMark input parses unchanged.
    extensions: markdownOptions.extensions,
  });
}

export { nestingAwareLinkExtension } from "./nested-links.ts";
