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
    base: markdownLanguage,
    extensions: [inlineMathMarkdownExtension, nestingAwareLinkExtension],
  });
}

export { nestingAwareLinkExtension } from "./nested-links.ts";
