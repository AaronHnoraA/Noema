/**
 * Whether rendered constructs stay rendered under the caret, as editor state.
 *
 * Vim's Normal and Visual modes navigate and select over what the reader sees,
 * so rendered constructs stay rendered under the caret ("pinned"); Insert mode,
 * and an editor without Vim, opens a construct's source where the caret enters
 * it. Keeping this in state lets every construct react to a mode change in the
 * same transaction, instead of each reading the DOM lazily and catching up on
 * the next selection change.
 *
 * Only the pinning is state: switching between Normal and Visual changes no
 * construct, so it dispatches nothing.
 */

import { StateEffect, StateField, type EditorState, type Transaction } from "@codemirror/state";

export const setConstructsPinned = StateEffect.define<boolean>();

export const constructsPinnedField = StateField.define<boolean>({
  create: () => false,
  update(pinned, tr) {
    for (const effect of tr.effects) if (effect.is(setConstructsPinned)) pinned = effect.value;
    return pinned;
  },
});

/** Whether rendered constructs stay rendered under the selection (Vim Normal/Visual). */
export function renderedConstructsPinned(state: EditorState): boolean {
  return state.field(constructsPinnedField, false) ?? false;
}

/** Whether TR pinned or released rendered constructs. */
export function transactionChangesPinning(tr: Transaction): boolean {
  return renderedConstructsPinned(tr.startState) !== renderedConstructsPinned(tr.state);
}
