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

export function createMarkdownLanguageExtension(): Extension {
  return markdown({
    // @codemirror/lang-markdown otherwise injects Prec.high bindings for Enter
    // and Backspace that outrank this editor's own keymap, pre-empting the
    // canonical chain in src/cm6/input-commands.ts (notably the empty-list and
    // empty-quote exits). That chain already calls insertNewlineContinueMarkup
    // and deleteMarkupBackward itself, so nothing is lost by opting out.
    addKeymap: false,
    base: markdownLanguage,
    extensions: [inlineMathMarkdownExtension, nestingAwareLinkExtension],
  });
}

export { nestingAwareLinkExtension } from "./nested-links.ts";
