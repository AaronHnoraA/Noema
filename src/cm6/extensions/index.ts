/**
 * CodeMirror feature composition root, following Overleaf's explicit
 * `extensions/index.ts` organization.
 *
 * Host policy (history, editable state, DOM events and callbacks) stays in the
 * editor shell. Markdown grammar and feature ordering live here.
 */

import type { Extension } from "@codemirror/state";
import { findHighlightExtension } from "../find-highlight.ts";
import { headingFoldExtension } from "../heading-fold.ts";
import { orderedListRenumber } from "../ordered-list-renumber.ts";
import { proseDiagnosticsExtension } from "../prose-diagnostics.ts";
import { roamLinkStatusExtension } from "../roam-link-status.ts";
import { tocIndexExtension } from "../toc-index.ts";
import { vimJumpExtension } from "../vim-jump.ts";
import { createMarkdownLanguageExtension } from "../languages/markdown/index.ts";
import { effectListenersExtension } from "./effect-listeners.ts";
import { parserWatcher } from "./parser-watcher.ts";
import {
  createVisualMarkdownEditingExtensions,
  createVisualMarkdownExtensions,
  visualMode,
} from "./visual/index.ts";

export type MarkdownFeatureExtensionOptions = {
  initialVisualMode: boolean;
};

export function createMarkdownFeatureExtensions(
  options: MarkdownFeatureExtensionOptions,
): Extension {
  return [
    createMarkdownLanguageExtension(),
    parserWatcher,
    effectListenersExtension,
    tocIndexExtension,
    orderedListRenumber,
    headingFoldExtension,
    createVisualMarkdownEditingExtensions(),
    visualMode(options.initialVisualMode, createVisualMarkdownExtensions()),
    findHighlightExtension,
    roamLinkStatusExtension,
    proseDiagnosticsExtension,
    vimJumpExtension,
  ];
}
