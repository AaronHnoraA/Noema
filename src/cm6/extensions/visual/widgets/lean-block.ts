import { StateEffect, StateField } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

type LeanSplice = {
  notePath: string;
  notesRoot: string;
  leanText: string;
  leanPath: string;
};

const setLeanNotePathEffect = StateEffect.define<{ notePath: string; notesRoot: string }>();

export const leanSpliceField = StateField.define<LeanSplice | null>({
  create() {
    return null;
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setLeanNotePathEffect)) {
        const notePath = effect.value.notePath;
        const notesRoot = effect.value.notesRoot;
        return notePath ? { notePath, notesRoot, leanText: "", leanPath: "" } : null;
      }
    }
    return value;
  },
});

export const leanExtension = [leanSpliceField];

export function getLeanNoteInfo(): null {
  return null;
}

export function setLeanNotePath(view: EditorView, notePath: string, notesRoot: string): void {
  view.dispatch({ effects: setLeanNotePathEffect.of({ notePath, notesRoot }) });
}
