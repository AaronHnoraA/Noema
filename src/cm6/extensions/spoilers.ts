import { MapMode, StateEffect, StateField, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeChangeDocumentEffect } from "./document-lifecycle.ts";

const selector = ".noema-inline-spoiler .noema-inline-toggle";
const revealAll = StateEffect.define<boolean>();
const setItem = StateEffect.define<{ position: number; reveal: boolean }>();
type SpoilerState = { reveal: boolean; items: ReadonlyMap<number, boolean> };
const initial: SpoilerState = { reveal: false, items: new Map() };

const spoilerState = StateField.define<SpoilerState>({
  create: () => initial,
  update(previous, transaction) {
    if (transaction.effects.some((effect) => effect.is(beforeChangeDocumentEffect))) return initial;
    const global = transaction.effects.find((effect) => effect.is(revealAll));
    if (global) return { reveal: global.value, items: new Map() };
    const individual = transaction.effects.find((effect) => effect.is(setItem))?.value;
    if (!individual && (!transaction.docChanged || previous.items.size === 0)) return previous;
    const items = new Map<number, boolean>();
    for (const [from, reveal] of previous.items) {
      const position = transaction.changes.mapPos(from, 1, MapMode.TrackAfter);
      if (position !== null) items.set(position, reveal);
    }
    if (individual) items.set(individual.position, individual.reveal);
    return { reveal: previous.reveal, items };
  },
});

export function editorSpoilerOpen(view: EditorView, position?: number): boolean {
  const state = view.state.field(spoilerState, false) ?? initial;
  return (position === undefined ? undefined : state.items.get(position)) ?? state.reveal;
}

export function rememberEditorSpoiler(view: EditorView, position: number, reveal: boolean): void {
  view.dispatch({ effects: setItem.of({ position, reveal }), annotations: Transaction.addToHistory.of(false) });
}

export function toggleEditorSpoilers(view: EditorView): boolean {
  if (!/@@spoiler\b/i.test(view.state.doc.toString())) return false;
  view.dispatch({ effects: revealAll.of(!editorSpoilerOpen(view)), annotations: Transaction.addToHistory.of(false) });
  return true;
}

export function applyEditorSpoilers(root: ParentNode, view: EditorView): void {
  const reveal = editorSpoilerOpen(view);
  for (const input of root.querySelectorAll<HTMLInputElement>(selector)) input.checked = reveal;
}

export const editorSpoilers = [spoilerState, EditorView.updateListener.of((update) => {
  if (!update.transactions.some((transaction) => transaction.effects.some((effect) =>
    effect.is(revealAll) || effect.is(beforeChangeDocumentEffect)))) return;
  applyEditorSpoilers(update.view.dom, update.view);
  update.view.requestMeasure();
})];
