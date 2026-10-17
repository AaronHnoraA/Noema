/**
 * Writing to the document from a construct's own controls.
 *
 * A checkbox toggle, a code-language field, an AI suggestion's Accept, a
 * layout menu, a table's tools: each is one deliberate action, so each is one
 * undo step of its own. Left unlabelled, CodeMirror's history merged two quick
 * toggles into one step (undo then did nothing visible) and merged a toggle
 * into the typing just before it; labelled `input`, an action was taken for a
 * typing burst and drawn late. Every such edit goes through
 * `dispatchConstructEdit`, labelled `construct` (or `construct.<what>`).
 */

import { isolateHistory } from "@codemirror/commands";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** The user event of an edit made from a construct's controls. */
export const CONSTRUCT_EDIT = "construct";

/** Apply SPEC as one construct edit: its own undo step, labelled `construct[.KIND]`. */
export function dispatchConstructEdit(view: EditorView, spec: TransactionSpec, kind?: string): void {
  const annotations = spec.annotations == null ? [] : Array.isArray(spec.annotations) ? spec.annotations : [spec.annotations];
  view.dispatch({
    ...spec,
    userEvent: kind ? `${CONSTRUCT_EDIT}.${kind}` : CONSTRUCT_EDIT,
    annotations: [...annotations.filter((annotation) => annotation.type !== isolateHistory), isolateHistory.of("full")],
  });
}
