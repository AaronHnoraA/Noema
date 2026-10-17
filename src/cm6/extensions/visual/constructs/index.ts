/**
 * Rendered constructs: the one layer every visual construct goes through.
 *
 * - `reveal.ts`: when the selection opens a construct's source.
 * - `mode.ts`: whether Vim pins rendered constructs, as state.
 * - `literal-ranges.ts`: code and math, where no construct is recognized.
 * - `registry.ts`: what is drawn where, for navigation and selection.
 * - `inline-construct.ts`: a whole inline construct family from a matcher.
 * - `decoration-patch.ts`: redrawing only what a transaction changed.
 * - `view-plugin.ts`: when a viewport family rebuilds, written once.
 * - `edit.ts`: writing to the document from a construct's own controls.
 */

export {
  anySelectionRevealsSource,
  rangeRevealsSource,
  selectionProbeOffsets,
  selectionOpensSource,
  selectionRevealsSource,
  type ConstructRole,
  type RevealPolicy,
} from "./reveal.ts";
export { constructsPinnedField, setConstructsPinned, renderedConstructsPinned, transactionChangesPinning } from "./mode.ts";
export { literalRangesIn, literalRangesOnLine, mathRangesIn } from "./literal-ranges.ts";
export {
  constructRevealedBySelection,
  constructSources,
  drawnConstructSource,
  objectAtEdge,
  renderedConstructAt,
  type ConstructSource,
  type RenderedConstruct,
} from "./registry.ts";
export { inlineConstruct, type InlineConstructMatch, type InlineConstructSpec } from "./inline-construct.ts";
export {
  mergeSpans,
  openedKey,
  rebuildDecorations,
  rebuildForRevealChange,
  replaceDecorations,
  spansFromKey,
  type Span,
} from "./decoration-patch.ts";
export { constructViewPlugin, type ConstructViewPluginSpec } from "./view-plugin.ts";
export { CONSTRUCT_EDIT, dispatchConstructEdit } from "./edit.ts";
