import {
  CharCategory,
  EditorSelection,
  MapMode,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";
import { deleteBracketPair } from "@codemirror/autocomplete";

// Stock @codemirror/autocomplete `closeBrackets()` only auto-closes a bracket
// when the following character is end-of-line, whitespace, or one of
// `)]}:;>` (its `before` languageData option is a finite allow-list). That
// makes `(`/`[`/`{` fail to pair inside inline/block math (`\(here\)`), where
// the next character is almost always `\` or other TeX punctuation. VSCode's
// rule is the complement: close unless the next character is a word
// character. This extension reimplements just the open/close pairing for
// `( [ {` with that broader rule and registers before `closeBrackets()`, so
// stock behavior (quotes, backtick wrap via `wrapSelectedMarkdownInput`)
// is unaffected — this only widens when `(`/`[`/`{` auto-close.

const OPEN_TO_CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const OPENERS = new Set(Object.keys(OPEN_TO_CLOSE));
const CLOSERS = new Set(Object.values(OPEN_TO_CLOSE));

const androidUA = typeof navigator === "object" && /Android\b/.test(navigator.userAgent);

class ClosedBracketMark extends RangeValue {}
const closedBracketMark = new ClosedBracketMark();
closedBracketMark.startSide = 1;
closedBracketMark.endSide = -1;

const markClosedBracket = StateEffect.define<number>({
  map(value, mapping) {
    const mapped = mapping.mapPos(value, -1, MapMode.TrackAfter);
    return mapped == null ? undefined : mapped;
  },
});

const vscodeBracketState = StateField.define<RangeSet<ClosedBracketMark>>({
  create() {
    return RangeSet.empty;
  },
  update(value, tr) {
    value = value.map(tr.changes);
    if (tr.selection) {
      const line = tr.state.doc.lineAt(tr.selection.main.head);
      value = value.update({ filter: (from) => from >= line.from && from <= line.to });
    }
    for (const effect of tr.effects) {
      if (effect.is(markClosedBracket)) {
        value = value.update({ add: [closedBracketMark.range(effect.value, effect.value + 1)] });
      }
    }
    return value;
  },
});

function hasClosedBracketMarkAt(state: { field(f: typeof vscodeBracketState): RangeSet<ClosedBracketMark> }, pos: number): boolean {
  let found = false;
  state.field(vscodeBracketState).between(pos, pos, (from) => {
    if (from === pos) found = true;
  });
  return found;
}

function nextChar(doc: { sliceString(from: number, to: number): string }, pos: number): string {
  return doc.sliceString(pos, pos + 1);
}

const vscodeCloseBracketsInputHandler = EditorView.inputHandler.of((view, from, to, insert) => {
  if ((androidUA ? view.composing : view.compositionStarted) || view.state.readOnly) return false;
  const sel = view.state.selection.main;
  if (from !== sel.from || to !== sel.to || insert.length !== 1) return false;

  if (OPENERS.has(insert)) {
    if (view.state.selection.ranges.some((range) => !range.empty)) return false;
    const close = OPEN_TO_CLOSE[insert];
    let dont: unknown = null;
    const spec = view.state.changeByRange((range) => {
      const next = nextChar(view.state.doc, range.head);
      if (next && view.state.charCategorizer(range.head)(next) === CharCategory.Word) {
        dont = range;
        return { range };
      }
      return {
        changes: { insert: insert + close, from: range.head },
        effects: markClosedBracket.of(range.head + insert.length),
        range: EditorSelection.cursor(range.head + insert.length),
      };
    });
    if (dont) return false;
    view.dispatch(view.state.update(spec, { scrollIntoView: true, userEvent: "input.type" }));
    return true;
  }

  if (CLOSERS.has(insert)) {
    let dont: unknown = null;
    const spec = view.state.changeByRange((range) => {
      if (range.empty && nextChar(view.state.doc, range.head) === insert && hasClosedBracketMarkAt(view.state, range.head)) {
        return {
          changes: { from: range.head, to: range.head + insert.length, insert },
          range: EditorSelection.cursor(range.head + insert.length),
        };
      }
      dont = range;
      return { range };
    });
    if (dont) return false;
    view.dispatch(view.state.update(spec, { scrollIntoView: true, userEvent: "input.type" }));
    return true;
  }

  return false;
});

export const vscodeDeleteBracketPairKeymap: KeyBinding[] = [{ key: "Backspace", run: deleteBracketPair }];

export function vscodeCloseBrackets(): Extension {
  return [vscodeCloseBracketsInputHandler, vscodeBracketState];
}
