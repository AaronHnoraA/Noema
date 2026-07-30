import { StateEffect, StateField } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export type FindHighlightRange = {
  from: number;
  to: number;
  current?: boolean;
};

export const setFindHighlightRanges = StateEffect.define<readonly FindHighlightRange[]>();

function buildFindDecorations(ranges: readonly FindHighlightRange[]): DecorationSet {
  const decos: Range<Decoration>[] = [];
  for (const range of ranges) {
    if (range.from >= range.to) continue;
    decos.push(
      Decoration.mark({
        class: range.current ? "cm-aaron-find-match cm-aaron-find-current" : "cm-aaron-find-match",
      }).range(range.from, range.to),
    );
  }
  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decos, true);
}

const findHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFindHighlightRanges)) return buildFindDecorations(effect.value);
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const findHighlightExtension = findHighlightField;
