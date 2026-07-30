/*
 * Adapted from Overleaf:
 * services/web/frontend/js/features/source-editor/extensions/effect-listeners.ts
 * upstream commit 28ad3b03b71cb4311decdcb55c36b33ec10d72db
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { StateEffect, StateField, type StateEffectType } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

type EffectListener<T = unknown> = {
  effect: StateEffectType<T>;
  callback: (value: T) => void;
  once: boolean;
};

const addEffectListenerEffect = StateEffect.define<EffectListener>();
const removeEffectListenerEffect = StateEffect.define<EffectListener>();

const effectListenersField = StateField.define<readonly EffectListener[]>({
  create: () => [],
  update(current, transaction) {
    let listeners = [...current];
    for (const effect of transaction.effects) {
      if (effect.is(addEffectListenerEffect)) listeners.push(effect.value);
      if (effect.is(removeEffectListenerEffect)) {
        listeners = listeners.filter((listener) => (
          listener.effect !== effect.value.effect || listener.callback !== effect.value.callback
        ));
      }

      const keep: EffectListener[] = [];
      for (const listener of listeners) {
        if (effect.is(listener.effect)) {
          queueMicrotask(() => listener.callback(effect.value));
          if (!listener.once) keep.push(listener);
        } else {
          keep.push(listener);
        }
      }
      listeners = keep;
    }
    return listeners;
  },
});

export const effectListenersExtension = effectListenersField;

export function addEffectListener<T>(
  view: EditorView,
  effect: StateEffectType<T>,
  callback: (value: T) => void,
  options: { once?: boolean } = {},
): () => void {
  const listener: EffectListener<T> = { effect, callback, once: options.once === true };
  view.dispatch({ effects: addEffectListenerEffect.of(listener as EffectListener) });
  return () => view.dispatch({ effects: removeEffectListenerEffect.of(listener as EffectListener) });
}

