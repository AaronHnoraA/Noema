import { MapMode, StateEffect, StateField, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { DocumentRun } from "../../../../../pages/api-client.ts";

interface TreeChoice {
  readonly file: string | undefined;
  readonly folders: ReadonlyMap<string, boolean>;
}

interface RunChoice {
  readonly launch: Promise<DocumentRun>;
  readonly note: string;
  readonly command: string;
  readonly cwd: string;
}

type Choice = number | string | readonly number[] | TreeChoice | RunChoice;
const setDocumentViewChoice = StateEffect.define<{ from: number; choice: Choice }>();

export const documentViewState = StateField.define<ReadonlyMap<number, Choice>>({
  create: () => new Map(),
  update(value, transaction) {
    const changed = transaction.effects.filter((effect) => effect.is(setDocumentViewChoice));
    if (!changed.length && (!transaction.docChanged || !value.size)) return value;
    const next = new Map<number, Choice>();
    for (const [position, choice] of value) {
      const mapped = transaction.changes.mapPos(position, 1, MapMode.TrackDel);
      if (mapped !== null) next.set(mapped, choice);
    }
    for (const effect of changed) {
      if (!effect.is(setDocumentViewChoice)) continue;
      next.set(effect.value.from, effect.value.choice);
    }
    return next;
  },
});

export function rememberDocumentView(view: EditorView, from: number, choice: Choice): void {
  view.dispatch({
    effects: setDocumentViewChoice.of({ from, choice }),
    annotations: Transaction.addToHistory.of(false),
  });
}
