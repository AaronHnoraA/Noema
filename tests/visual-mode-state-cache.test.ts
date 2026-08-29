import { EditorSelection, EditorState, StateField } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  persistentVisualStateField,
  invalidatePersistentVisualState,
  rememberPersistentVisualPluginState,
  restorePersistentVisualPluginState,
  setVisualMode,
  visualMode,
} from "../src/cm6/extensions/visual/visual-mode.ts";

describe("visual mode state cache", () => {
  test("restores an expensive visual field when Source did not change editor state", () => {
    let creates = 0;
    const field = StateField.define<number>({
      create: () => ++creates,
      update: (value) => value,
    });
    const extension = visualMode(
      true,
      persistentVisualStateField(field, () => ++creates),
    );
    let state = EditorState.create({ doc: "alpha\nbeta", extensions: [extension] });
    const previewValue = state.field(field);

    state = state.update(setVisualMode(false)).state;
    expect(state.field(field, false)).toBeUndefined();

    state = state.update(setVisualMode(true)).state;
    expect(state.field(field)).toBe(previewValue);
    expect(creates).toBe(1);
  });

  test("invalidates the snapshot after a Source edit", () => {
    let creates = 0;
    const field = StateField.define<number>({
      create: () => ++creates,
      update: (value) => value,
    });
    const extension = visualMode(
      true,
      persistentVisualStateField(field, () => ++creates),
    );
    let state = EditorState.create({ doc: "alpha", extensions: [extension] });

    state = state.update(setVisualMode(false)).state;
    state = state.update({ changes: { from: state.doc.length, insert: "!" } }).state;
    state = state.update(setVisualMode(true)).state;

    expect(state.field(field)).toBe(2);
    expect(creates).toBe(2);
  });

  test("invalidates the snapshot after a Source selection move", () => {
    let creates = 0;
    const field = StateField.define<number>({
      create: () => ++creates,
      update: (value) => value,
    });
    const extension = visualMode(
      true,
      persistentVisualStateField(field, () => ++creates),
    );
    let state = EditorState.create({ doc: "alpha", extensions: [extension] });

    state = state.update(setVisualMode(false)).state;
    state = state.update({ selection: EditorSelection.cursor(3) }).state;
    state = state.update(setVisualMode(true)).state;

    expect(state.field(field)).toBe(2);
    expect(creates).toBe(2);
  });

  test("moves a viewport plugin model through Source without sharing it across editors", () => {
    const key = {};
    const value = { decorations: "cached" };
    let state = EditorState.create({
      doc: "alpha",
      extensions: [visualMode(true, [])],
    });

    state = state.update(setVisualMode(false)).state;
    rememberPersistentVisualPluginState({ state } as unknown as EditorView, key, value);
    state = state.update(setVisualMode(true)).state;

    expect(restorePersistentVisualPluginState(state, key)).toBe(value);
    expect(restorePersistentVisualPluginState(state, key)).toBeUndefined();
  });

  test("invalidates viewport plugin models after a Source edit", () => {
    const key = {};
    let state = EditorState.create({
      doc: "alpha",
      extensions: [visualMode(true, [])],
    });

    state = state.update(setVisualMode(false)).state;
    rememberPersistentVisualPluginState({ state } as unknown as EditorView, key, "cached");
    state = state.update({ changes: { from: state.doc.length, insert: "!" } }).state;
    state = state.update(setVisualMode(true)).state;

    expect(restorePersistentVisualPluginState(state, key)).toBeUndefined();
  });

  test("invalidates viewport models after Source scroll interaction", () => {
    const key = {};
    let state = EditorState.create({
      doc: "alpha",
      extensions: [visualMode(true, [])],
    });

    state = state.update(setVisualMode(false)).state;
    const view = { state } as unknown as EditorView;
    rememberPersistentVisualPluginState(view, key, "cached");
    invalidatePersistentVisualState(view);
    state = state.update(setVisualMode(true)).state;

    expect(restorePersistentVisualPluginState(state, key)).toBeUndefined();
  });
});
