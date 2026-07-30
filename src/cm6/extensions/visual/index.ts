/**
 * Visual Markdown composition root.
 *
 * Extension order is intentionally explicit. Existing viewport-local scans,
 * incremental mapping, caches and measured widgets remain owned by their
 * feature modules; this file only composes them.
 */

import type { Extension } from "@codemirror/state";
import { blockMathRangesExtension } from "../../math-ranges.ts";
import { livePreviewExtension } from "../../live-preview.ts";
import { blockExtrasExtension } from "./widgets/block-extras.ts";
import { fencedCodeExtension } from "./widgets/fenced-code.ts";
import { footnoteExtension } from "./widgets/footnotes.ts";
import { imageExtension } from "./widgets/image.ts";
import { inlineCommandsExtension } from "./widgets/inline-commands.ts";
import { leanExtension } from "./widgets/lean-block.ts";
import {
  leanPlaceholderEditingExtension,
  leanPlaceholderPreviewExtension,
} from "./widgets/lean-placeholder.ts";
import { mathExtension } from "./widgets/math.ts";
import {
  noteCodeEditingExtension,
  noteCodePreviewExtension,
} from "./widgets/note-code.ts";
import { taskListExtension } from "./widgets/task-list.ts";
import { pointerSelectionExtension } from "./selection.ts";
import { visualTypographyExtension } from "./typography.ts";
import { blockMoveGutterExtension } from "../../block-move.ts";

export function createVisualMarkdownExtensions(): Extension {
  return [
    blockMoveGutterExtension,
    visualTypographyExtension,
    pointerSelectionExtension,
    blockMathRangesExtension,
    livePreviewExtension,
    blockExtrasExtension,
    mathExtension,
    fencedCodeExtension,
    footnoteExtension,
    taskListExtension,
    imageExtension,
    leanPlaceholderPreviewExtension,
    noteCodePreviewExtension,
    inlineCommandsExtension,
    leanExtension,
  ];
}

export function createVisualMarkdownEditingExtensions(): Extension {
  return [
    leanPlaceholderEditingExtension,
    noteCodeEditingExtension,
  ];
}

export { orgEnvExitTarget } from "./widgets/block-extras.ts";
export {
  hasVisualMode,
  isVisualMode,
  setVisualMode,
  visualMode,
} from "./visual-mode.ts";
