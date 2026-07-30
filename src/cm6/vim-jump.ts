import { StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export type VimJumpDirection = 1 | -1;

export type VimJumpCandidate = {
  from: number;
  to: number;
  label: string;
};

export type VimJumpSession = {
  doc: Text;
  candidates: readonly VimJumpCandidate[];
};

export const VIM_JUMP_LABELS = "asdfghjklqweruiop";

const setVimJumpHints = StateEffect.define<readonly VimJumpCandidate[]>();

function jumpDecorations(candidates: readonly VimJumpCandidate[]): DecorationSet {
  return Decoration.set(candidates.map((candidate) => Decoration.mark({
    class: candidate.label ? "cm-vim-jump-label" : "cm-vim-jump-preview",
    attributes: candidate.label
      ? { "data-vim-jump-label": candidate.label }
      : undefined,
  }).range(candidate.from, candidate.to)), true);
}

const vimJumpHintsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setVimJumpHints)) return jumpDecorations(effect.value);
    }
    if (transaction.docChanged) return Decoration.none;
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const vimJumpExtension = vimJumpHintsField;

export function clearVimJump(view: EditorView): void {
  view.dispatch({ effects: setVimJumpHints.of([]) });
}

// Generous safety cap so a pathological viewport cannot create an unbounded
// array. Labels themselves are prefix trees, so this is a safety limit rather
// than a one-key label budget.
const MAX_SCAN_MATCHES = 4096;

/**
 * Build a prefix-free avy-style label set.
 *
 * The nearest candidates retain short labels. When the one-key alphabet is
 * exhausted, the least-preferred leaf is expanded into another level instead
 * of dropping the remaining visible candidates.
 */
export function buildVimJumpLabels(
  count: number,
  alphabet: string = VIM_JUMP_LABELS,
): string[] {
  const keys = [...new Set(alphabet)];
  const target = Math.max(0, Math.floor(count));
  if (target === 0 || keys.length === 0) return [];
  if (keys.length === 1 && target > 1) {
    throw new RangeError("Vim jump labels need at least two distinct keys");
  }

  const rank = new Map(keys.map((key, index) => [key, index]));
  const leaves = [...keys];
  while (leaves.length < target) {
    let expandAt = 0;
    for (let index = 1; index < leaves.length; index += 1) {
      if (leaves[index]!.length <= leaves[expandAt]!.length) expandAt = index;
    }
    const prefix = leaves[expandAt]!;
    leaves.splice(expandAt, 1, ...keys.map((key) => `${prefix}${key}`));
  }

  leaves.sort((left, right) => {
    if (left.length !== right.length) return left.length - right.length;
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const delta = (rank.get(left[index]!) ?? 0) - (rank.get(right[index]!) ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  });
  return leaves.slice(0, target);
}

function candidatePositions(view: EditorView, needle: string): number[] {
  if (!needle) return [];
  const positions: number[] = [];
  const foldedNeedle = needle.toLowerCase();
  for (const range of view.visibleRanges) {
    const text = view.state.doc.sliceString(range.from, range.to);
    const foldedText = text.toLowerCase();
    let offset = 0;
    while (offset <= text.length - needle.length) {
      const found = foldedText.indexOf(foldedNeedle, offset);
      if (found < 0) break;
      positions.push(range.from + found);
      offset = found + Math.max(1, needle.length);
      if (positions.length >= MAX_SCAN_MATCHES) return positions;
    }
  }
  return positions;
}

function orderedPositions(positions: readonly number[], cursor: number, direction: VimJumpDirection): number[] {
  const forward = positions.filter((position) => position > cursor).sort((a, b) => a - b);
  const backward = positions.filter((position) => position < cursor).sort((a, b) => b - a);
  const current = positions.filter((position) => position === cursor);
  return direction > 0
    ? [...forward, ...backward, ...current]
    : [...backward, ...forward, ...current];
}

// Order all matches by direction/proximity before applying an explicit safety
// limit. Capping before ordering (the previous bug) filled the slots with
// whatever matched first while scanning the viewport top-down, so the nearest
// in-direction targets — often all of them — were dropped.
export function selectJumpCandidates(
  positions: readonly number[],
  cursor: number,
  direction: VimJumpDirection,
  max: number = positions.length,
): number[] {
  return orderedPositions(positions, cursor, direction).slice(0, max);
}

export function previewVimJump(view: EditorView, needle: string, direction: VimJumpDirection): number {
  const cursor = view.state.selection.main.head;
  const positions = orderedPositions(candidatePositions(view, needle), cursor, direction);
  view.dispatch({
    effects: setVimJumpHints.of(positions.map((from) => ({
      from,
      to: Math.min(from + needle.length, view.state.doc.length),
      label: "",
    }))),
  });
  return positions.length;
}

export function beginVimJump(view: EditorView, needle: string, direction: VimJumpDirection): VimJumpSession {
  const cursor = view.state.selection.main.head;
  const positions = selectJumpCandidates(candidatePositions(view, needle), cursor, direction, MAX_SCAN_MATCHES);
  const labels = buildVimJumpLabels(positions.length);
  const candidates = positions
    .map((from, index) => ({
      from,
      to: Math.min(from + needle.length, view.state.doc.length),
      label: labels[index]!,
    }));
  view.dispatch({ effects: setVimJumpHints.of(candidates) });
  return { doc: view.state.doc, candidates };
}

export function narrowVimJump(
  view: EditorView,
  session: VimJumpSession,
  prefix: string,
): readonly VimJumpCandidate[] {
  if (view.state.doc !== session.doc) {
    clearVimJump(view);
    return [];
  }
  const candidates = session.candidates.filter((candidate) => candidate.label.startsWith(prefix));
  view.dispatch({
    effects: setVimJumpHints.of(candidates.map((candidate) => ({
      ...candidate,
      label: candidate.label.slice(prefix.length),
    }))),
  });
  return candidates;
}

export function applyVimJump(view: EditorView, session: VimJumpSession, label: string): boolean {
  if (view.state.doc !== session.doc) {
    clearVimJump(view);
    return false;
  }
  const candidate = session.candidates.find((entry) => entry.label === label);
  clearVimJump(view);
  if (!candidate) return false;
  view.dispatch({
    selection: { anchor: candidate.from },
    effects: EditorView.scrollIntoView(candidate.from, { y: "nearest" }),
  });
  view.focus();
  return true;
}
