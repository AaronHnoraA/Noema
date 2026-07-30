// Public API for the editor as a library.
//
// Consumers see only `createEditor` and the small `Editor` controller
// it returns. The controller's `view` getter is an opt-in CM6 escape
// hatch for advanced cases.

export { createEditor } from "./editor-api.ts";
export {
  createAaronnoteMarkdownExtensions,
  isAaronnoteMarkdownSource,
  toggleAaronnoteMarkdownSource,
} from "./cm6/editor-cm6.ts";
export type { AaronnoteMarkdownExtensionMode } from "./cm6/editor-cm6.ts";
export type {
  Editor,
  EditorBlockContext,
  EditorClipboardPayload,
  EditorCommand,
  EditorOptions,
  EditorPasteAssetStore,
  EditorPasteOptions,
  EditorPastePlacement,
  QuickInsertContext,
  QuickInsertItem,
  QuickInsertProvider,
  StoredPasteAsset,
  WritingModeOptions,
} from "./editor-api.ts";
