/**
 * Noema's Markdown language boundary.
 *
 * Keep grammar configuration here so editor composition and visual features
 * consume one language definition instead of importing Lezer configuration
 * directly.
 */

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { Extension } from "@codemirror/state";
import { inlineMathMarkdownExtension } from "../../../inline-math.ts";
import { nestingAwareLinkExtension } from "./nested-links.ts";
import { cjkEmphasisMarkdownExtension } from "../../../cjk-emphasis.ts";

const markdownOptions = {
  addKeymap: false,
  base: markdownLanguage,
  extensions: [inlineMathMarkdownExtension, nestingAwareLinkExtension, cjkEmphasisMarkdownExtension],
};

// Commands that touch one source line need the same inline grammar without
// asking CM6 to parse every preceding megabyte of a large document.
const lineParser = markdown(markdownOptions).language.parser;

export function parseMarkdownLine(text: string) {
  return lineParser.parse(text);
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
