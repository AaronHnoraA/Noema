/*
 * Adapted from Overleaf:
 * services/web/frontend/js/features/source-editor/extensions/visual/visual.ts
 * upstream commit 28ad3b03b71cb4311decdcb55c36b33ec10d72db
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export const setVisualModeEffect = StateEffect.define<boolean>();

const visualModeState = StateField.define<boolean>({
  create: () => true,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setVisualModeEffect)) return effect.value;
    }
    return value;
  },
});

function modeOnly(activeWhenVisual: boolean, visual: boolean, extension: Extension): Extension {
  const compartment = new Compartment();
  const configure = (nextVisual: boolean): Extension => nextVisual === activeWhenVisual ? extension : [];
  return [
    compartment.of(configure(visual)),
    EditorState.transactionExtender.of((transaction) => {
      for (const effect of transaction.effects) {
        if (effect.is(setVisualModeEffect)) {
          return { effects: compartment.reconfigure(configure(effect.value)) };
        }
      }
      return null;
    }),
  ];
}

export const visualOnly = (visual: boolean, extension: Extension): Extension =>
  modeOnly(true, visual, extension);

export const sourceOnly = (visual: boolean, extension: Extension): Extension =>
  modeOnly(false, visual, extension);

export function visualMode(
  visual: boolean,
  visualExtensions: Extension,
  sourceExtensions: Extension = [],
): Extension {
  return [
    visualModeState.init(() => visual),
    visualOnly(visual, visualExtensions),
    sourceOnly(visual, sourceExtensions),
  ];
}

export function setVisualMode(visual: boolean): TransactionSpec {
  return { effects: setVisualModeEffect.of(visual) };
}

export function isVisualMode(view: EditorView): boolean {
  return view.state.field(visualModeState, false) ?? true;
}

export function hasVisualMode(view: EditorView): boolean {
  return view.state.field(visualModeState, false) !== undefined;
}
