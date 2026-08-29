/*
 * Adapted from Overleaf:
 * services/web/frontend/js/features/source-editor/extensions/visual/visual.ts
 * upstream commit 28ad3b03b71cb4311decdcb55c36b33ec10d72db
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type Text,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export const setVisualModeEffect = StateEffect.define<boolean>();

type AnyVisualStateField = StateField<unknown>;
type VisualStateCache = {
  valid: boolean;
  visual: boolean;
  doc: Text | null;
  selection: EditorSelection | null;
  values: ReadonlyMap<AnyVisualStateField, unknown>;
  pluginValues: Map<object, unknown>;
};

const registeredVisualStateFields = new Set<AnyVisualStateField>();
const emptyVisualStateCache = (visual: boolean): VisualStateCache => ({
  valid: false,
  visual,
  doc: null,
  selection: null,
  values: new Map(),
  pluginValues: new Map(),
});

/**
 * Retain expensive visual StateField values while Source mode is active.
 *
 * The visual compartment must still be removed in Source mode so replacement
 * decorations cannot hide Markdown text. CodeMirror normally destroys every
 * field value with that compartment and recreates it from the whole document
 * when Preview returns. This outside-compartment cache snapshots registered
 * immutable values on the same transaction that leaves Preview. If neither
 * document nor selection changes in Source, their `field.init()` extensions
 * restore those values directly. A real Source edit/motion invalidates the
 * snapshot and falls back to each field's authoritative create function.
 */
const visualStateCacheField = StateField.define<VisualStateCache>({
  create: () => emptyVisualStateCache(true),
  update(value, transaction) {
    let nextVisual = value.visual;
    for (const effect of transaction.effects) {
      if (effect.is(setVisualModeEffect)) nextVisual = effect.value;
    }

    if (value.visual && !nextVisual) {
      const values = new Map<AnyVisualStateField, unknown>();
      for (const field of registeredVisualStateFields) {
        const fieldValue = transaction.startState.field(field, false);
        if (fieldValue !== undefined) values.set(field, fieldValue);
      }
      return {
        valid: true,
        visual: false,
        doc: transaction.startState.doc,
        selection: transaction.startState.selection,
        values,
        pluginValues: new Map(),
      };
    }

    if (!value.visual && !nextVisual
        && (transaction.docChanged || transaction.selection != null)) {
      return emptyVisualStateCache(false);
    }
    return nextVisual === value.visual ? value : { ...value, visual: nextVisual };
  },
});

export function persistentVisualStateField<T>(
  field: StateField<T>,
  create: (state: EditorState) => T,
): Extension {
  registeredVisualStateFields.add(field as AnyVisualStateField);
  return field.init((state) => {
    const cache = state.field(visualStateCacheField, false);
    if (cache?.valid
        && cache.doc === state.doc
        && cache.selection?.eq(state.selection)
        && cache.values.has(field as AnyVisualStateField)) {
      return cache.values.get(field as AnyVisualStateField) as T;
    }
    return create(state);
  });
}

/** Per-editor cache for viewport ViewPlugin models destroyed by Source mode. */
export function restorePersistentVisualPluginState<T>(
  state: EditorState,
  key: object,
): T | undefined {
  const cache = state.field(visualStateCacheField, false);
  if (!cache?.valid || cache.doc !== state.doc || !cache.selection?.eq(state.selection)) return undefined;
  const value = cache.pluginValues.get(key) as T | undefined;
  cache.pluginValues.delete(key);
  return value;
}

export function rememberPersistentVisualPluginState<T>(
  view: EditorView,
  key: object,
  value: T,
): void {
  const cache = view.state.field(visualStateCacheField, false);
  if (!cache?.valid || cache.doc !== view.state.doc || !cache.selection?.eq(view.state.selection)) return;
  cache.pluginValues.set(key, value);
}

export function invalidatePersistentVisualState(view: EditorView): void {
  const state = view.state as EditorState & { field?: EditorState["field"] };
  if (typeof state.field !== "function") return;
  const cache = state.field(visualStateCacheField, false);
  if (!cache) return;
  cache.valid = false;
  cache.pluginValues.clear();
}

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
    visualStateCacheField.init(() => emptyVisualStateCache(visual)),
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
