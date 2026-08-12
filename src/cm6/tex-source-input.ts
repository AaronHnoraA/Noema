import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { scanInlineMathRanges } from "../inline-math.ts";
import { blockMathRangeAt } from "./math-ranges.ts";
import { jumpStructuralDelimiter, jumpTexUnit } from "./structural-jump.ts";

type TexMathContentRange = { from: number; to: number };

type TexAutoPair = {
  id: number;
  openFrom: number;
  openTo: number;
  openText: string;
  closeFrom: number;
  closeTo: number;
  closeText: string;
  typeover: string;
};

type TexPairTemplate = {
  insert: string;
  cursorOffset: number;
  openText: string;
  closeText: string;
  openPrefixLength: number;
  typeover: string;
};

const texTextCommands = new Set([
  "text",
  "textrm",
  "textsf",
  "texttt",
  "textnormal",
  "textbf",
  "textit",
  "textmd",
  "textup",
  "textsl",
  "textsc",
  "mbox",
]);

/**
 * Every opener/closer this module generates, longest first so that
 * `\left\langle` is recognized before any shorter prefix of it. Used by the
 * document-scanning deletion path; the generation side builds the same pairs
 * from `texPairTemplate`.
 */
const TEX_DELIMITER_PAIRS: ReadonlyArray<readonly [open: string, close: string]> = [
  ["\\left\\langle", "\\right\\rangle"],
  ["\\left\\lbrace", "\\right\\rbrace"],
  ["\\left\\lfloor", "\\right\\rfloor"],
  ["\\left\\lceil", "\\right\\rceil"],
  ["\\left\\Vert", "\\right\\Vert"],
  ["\\left\\{", "\\right\\}"],
  ["\\left(", "\\right)"],
  ["\\left[", "\\right]"],
  ["\\left|", "\\right|"],
  ["\\left.", "\\right."],
  ["\\left<", "\\right>"],
  ["^{", "}"],
  ["_{", "}"],
];

let nextTexAutoPairId = 1;

const addTexAutoPair = StateEffect.define<TexAutoPair>();
const removeTexAutoPair = StateEffect.define<number>();

function mapTexAutoPair(pair: TexAutoPair, tr: Transaction): TexAutoPair {
  return {
    ...pair,
    openFrom: tr.changes.mapPos(pair.openFrom, -1),
    openTo: tr.changes.mapPos(pair.openTo, -1),
    closeFrom: tr.changes.mapPos(pair.closeFrom, 1),
    closeTo: tr.changes.mapPos(pair.closeTo, 1),
  };
}

const texAutoPairState = StateField.define<readonly TexAutoPair[]>({
  create: () => [],
  update(value, tr) {
    if (value.length === 0 && !tr.effects.some((effect) => effect.is(addTexAutoPair))) return value;
    // A generated pair belongs only to the TeX editing gesture that created
    // it. Once the selection leaves that pair, discard it before mapping any
    // later Markdown transaction. This is both the mode boundary and the hot
    // path: ordinary prose edits must do zero pair bookkeeping.
    if (value.length > 0) {
      const previousSelection = tr.startState.selection.main;
      const ownedByPreviousSelection = value.some((pair) => (
        previousSelection.from >= pair.openFrom
        && previousSelection.to <= pair.closeTo
      ));
      if (!ownedByPreviousSelection) return [];
    }
    let next = value.map((pair) => mapTexAutoPair(pair, tr));
    for (const effect of tr.effects) {
      if (effect.is(addTexAutoPair)) next = [...next, effect.value];
      if (effect.is(removeTexAutoPair)) next = next.filter((pair) => pair.id !== effect.value);
    }
    next = next.filter((pair) => (
      tr.state.doc.sliceString(pair.openFrom, pair.openTo) === pair.openText
      && tr.state.doc.sliceString(pair.closeFrom, pair.closeTo) === pair.closeText
    ));
    const selection = tr.state.selection.main;
    if (!next.some((pair) => selection.from >= pair.openFrom && selection.to <= pair.closeTo)) {
      return [];
    }
    // Auto-pairs are short-lived editor affordances, not a document index.
    // Bound the mapped set so a long authoring session never makes every
    // subsequent Markdown transaction progressively more expensive.
    return next.length <= 128 ? next : next.slice(-128);
  },
});

function texMathContentRangeAt(state: EditorState, position: number): TexMathContentRange | null {
  const block = blockMathRangeAt(state, position);
  if (block) return { from: block.contentFrom, to: block.contentTo };

  const line = state.doc.lineAt(position);
  const inline = scanInlineMathRanges(line.text, line.from).find((range) => {
    const contentFrom = range.from + 2;
    const contentTo = range.to - 2;
    return position >= contentFrom && position <= contentTo;
  });
  return inline ? { from: inline.from + 2, to: inline.to - 2 } : null;
}

/** Whether a source position is in a TeX text-command argument, not math mode. */
export function texSourceTextModeAt(
  state: EditorState,
  range: TexMathContentRange,
  position: number,
): boolean {
  const source = state.doc.sliceString(range.from, Math.min(position, range.to));
  const stack: boolean[] = [];
  let pendingTextCommand = false;
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (character === "\\") {
      index++;
      const commandFrom = index;
      while (index < source.length && /[A-Za-z@]/.test(source[index]!)) index++;
      if (index === commandFrom && index < source.length) index++;
      pendingTextCommand = texTextCommands.has(source.slice(commandFrom, index));
      continue;
    }
    if (character === "{") {
      stack.push((stack.at(-1) ?? false) || pendingTextCommand);
      pendingTextCommand = false;
      index++;
      continue;
    }
    if (character === "}") {
      stack.pop();
      pendingTextCommand = false;
      index++;
      continue;
    }
    if (!/\s/.test(character)) pendingTextCommand = false;
    index += String.fromCodePoint(source.codePointAt(index)!).length;
  }
  return stack.at(-1) ?? false;
}

function texPairTemplate(prefix: string, insert: string): TexPairTemplate | null {
  if (insert === "^" || insert === "_") {
    return {
      insert: `${insert}{}`,
      cursorOffset: 2,
      openText: `${insert}{`,
      closeText: "}",
      openPrefixLength: 0,
      typeover: "}",
    };
  }

  const delimiterPairs: Record<string, string> = {
    "(": ")",
    "[": "]",
    "|": "|",
    ".": ".",
    "<": ">",
  };
  const directClose = delimiterPairs[insert];
  if (directClose && /\\left$/.test(prefix)) {
    const closeText = `\\right${directClose}`;
    return {
      insert: `${insert}${closeText}`,
      cursorOffset: insert.length,
      openText: `\\left${insert}`,
      closeText,
      openPrefixLength: "\\left".length,
      typeover: directClose,
    };
  }

  if (insert === "{" && /\\left\\$/.test(prefix)) {
    const closeText = "\\right\\}";
    return {
      insert: `{${closeText}`,
      cursorOffset: 1,
      openText: "\\left\\{",
      closeText,
      openPrefixLength: "\\left\\".length,
      typeover: "}",
    };
  }

  const combined = `${prefix}${insert}`;
  const commandPairs: ReadonlyArray<[string, string, string]> = [
    ["\\left\\langle", "\\right\\rangle", ">"],
    ["\\left\\lbrace", "\\right\\rbrace", "}"],
    ["\\left\\lfloor", "\\right\\rfloor", "]"],
    ["\\left\\lceil", "\\right\\rceil", "]"],
    ["\\left\\Vert", "\\right\\Vert", "|"],
  ];
  const command = commandPairs.find(([open]) => combined.endsWith(open));
  if (!command) return null;
  const [openText, closeText, typeover] = command;
  return {
    insert: `${insert}${closeText}`,
    cursorOffset: insert.length,
    openText,
    closeText,
    openPrefixLength: openText.length - insert.length,
    typeover,
  };
}

function texAutoPairAt(state: EditorState, position: number, typed: string): TexAutoPair | null {
  return state.field(texAutoPairState).find((pair) => (
    pair.closeFrom === position
    && pair.typeover === typed
    && state.doc.sliceString(pair.closeFrom, pair.closeTo) === pair.closeText
  )) ?? null;
}

export function isTexSourceStructuralInput(prefix: string, insert: string): boolean {
  if (insert.length !== 1) return false;
  if ("^_([|.<{".includes(insert)) return true;
  return /[erlt]/.test(insert)
    && ["\\left\\langle", "\\left\\lbrace", "\\left\\lfloor", "\\left\\lceil", "\\left\\Vert"]
      .some((open) => `${prefix}${insert}`.endsWith(open));
}

const texSourceInputHandler = EditorView.inputHandler.of((view, from, to, insert) => {
  if (view.state.readOnly || view.composing || view.compositionStarted || insert.length !== 1) return false;
  const selection = view.state.selection.main;
  if (view.state.selection.ranges.length !== 1 || from !== selection.from || to !== selection.to) return false;

  if (selection.empty && "})]|>".includes(insert)) {
    const pair = texAutoPairAt(view.state, selection.head, insert);
    if (pair) {
      view.dispatch({
        selection: EditorSelection.cursor(pair.closeTo),
        scrollIntoView: true,
        userEvent: "input.type",
      });
      return true;
    }
  }

  // Everything below reads the text *before the insertion point*, which for a
  // range selection is its start, not its head — a left-to-right selection puts
  // `head` at the far end, where `\left` is no longer the preceding text, so
  // wrapping a selection in a large delimiter never triggered.
  const insertAt = selection.from;
  const localPrefix = view.state.doc.sliceString(Math.max(0, insertAt - 24), insertAt);
  if (!isTexSourceStructuralInput(localPrefix, insert)) return false;

  const math = texMathContentRangeAt(view.state, insertAt);
  if (!math || selection.from < math.from || selection.to > math.to) return false;
  if (texSourceTextModeAt(view.state, math, insertAt)) return false;
  const prefix = view.state.doc.sliceString(Math.max(math.from, insertAt - 32), insertAt);
  const template = texPairTemplate(prefix, insert);
  if (!template) return false;

  if ((insert === "^" || insert === "_") && selection.empty
    && view.state.doc.sliceString(selection.head, selection.head + 1) === "{") {
    view.dispatch({
      changes: { from: selection.head, insert },
      selection: EditorSelection.cursor(selection.head + 2),
      scrollIntoView: true,
      userEvent: "input.type",
    });
    return true;
  }

  const selected = view.state.doc.sliceString(selection.from, selection.to);
  // Typing a delimiter over a selection wraps it, exactly like typing an
  // ordinary bracket does. `template.insert` alone would have replaced the
  // selection, silently discarding it.
  const inserted = selected
    ? `${template.insert.slice(0, template.cursorOffset)}${selected}${template.insert.slice(template.cursorOffset)}`
    : template.insert;
  const openFrom = selection.from - template.openPrefixLength;
  const openTo = selection.from + template.cursorOffset;
  const closeFrom = selection.from + inserted.length - template.closeText.length;
  const closeTo = selection.from + inserted.length;
  const pair: TexAutoPair = {
    id: nextTexAutoPairId++,
    openFrom,
    openTo,
    openText: template.openText,
    closeFrom,
    closeTo,
    closeText: template.closeText,
    typeover: template.typeover,
  };
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: inserted },
    selection: selected
      ? EditorSelection.range(openTo, openTo + selected.length)
      : EditorSelection.cursor(openTo),
    effects: addTexAutoPair.of(pair),
    scrollIntoView: true,
    userEvent: "input.type",
  });
  return true;
});

/**
 * Delimiter pairs the source itself still spells out, whether or not the
 * transient auto-pair state still tracks them.
 *
 * `texAutoPairState` only remembers a pair while the caret has never left it,
 * so `\left(\right)` lost its paired deletion as soon as you moved away and
 * came back. Single-character brackets never had that problem because
 * CodeMirror's own `deleteBracketPair` reads the document. This does the same
 * for the multi-character TeX delimiters.
 */
function texDelimiterPairAt(
  state: EditorState,
  position: number,
): { openFrom: number; closeTo: number } | null {
  const math = texMathContentRangeAt(state, position);
  if (!math) return null;
  const before = state.doc.sliceString(math.from, position);
  const after = state.doc.sliceString(position, math.to);
  for (const [openText, closeText] of TEX_DELIMITER_PAIRS) {
    if (!before.endsWith(openText) || !after.startsWith(closeText)) continue;
    return { openFrom: position - openText.length, closeTo: position + closeText.length };
  }
  return null;
}

/**
 * Paired deletion, matching VSCode: a bracket only takes its partner with it
 * when the pair is empty and the caret sits between the two. Anything else
 * deletes a single character, so backspacing next to `x^{ab}` can never eat the
 * `ab`.
 */
function deleteTexSourcePair(view: EditorView, forward: boolean): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty || view.state.selection.ranges.length !== 1) return false;
  const head = selection.head;

  // Innermost first: nested pairs all contain the caret, and the one being
  // edited is the tightest.
  const tracked = view.state.field(texAutoPairState)
    .filter((candidate) => candidate.openTo === head && candidate.closeFrom === head)
    .sort((a, b) => (a.closeTo - a.openFrom) - (b.closeTo - b.openFrom))[0];
  if (tracked) {
    view.dispatch({
      changes: [
        { from: tracked.openFrom, to: tracked.openTo },
        { from: tracked.closeFrom, to: tracked.closeTo },
      ],
      selection: EditorSelection.cursor(tracked.openFrom),
      effects: removeTexAutoPair.of(tracked.id),
      scrollIntoView: true,
      userEvent: forward ? "delete.forward" : "delete.backward",
    });
    return true;
  }

  const delimiter = texDelimiterPairAt(view.state, head);
  if (!delimiter) return false;
  view.dispatch({
    changes: { from: delimiter.openFrom, to: delimiter.closeTo },
    selection: EditorSelection.cursor(delimiter.openFrom),
    scrollIntoView: true,
    userEvent: forward ? "delete.forward" : "delete.backward",
  });
  return true;
}

export function deleteTexSourceAutoPair(view: EditorView): boolean {
  return deleteTexSourcePair(view, false);
}

export function deleteTexSourceAutoPairForward(view: EditorView): boolean {
  return deleteTexSourcePair(view, true);
}

export function moveAcrossTexSourceAutoPair(view: EditorView, backward = false): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty || view.state.selection.ranges.length !== 1) return false;
  const pair = view.state.field(texAutoPairState)
    .filter((candidate) => selection.head >= candidate.openTo && selection.head <= candidate.closeFrom)
    .sort((a, b) => (a.closeFrom - a.openTo) - (b.closeFrom - b.openTo))[0];
  if (!pair) return false;
  view.dispatch({
    selection: EditorSelection.cursor(backward ? pair.openTo : pair.closeTo),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

/** Reserve Cmd-brackets for TeX navigation, including outside a TeX scope. */
export function moveAcrossTexSourceUnit(view: EditorView, direction: 1 | -1): boolean {
  jumpTexUnit(view, direction) || jumpStructuralDelimiter(view, direction);
  // Consuming the unmatched chord prevents CodeMirror's generic indentation
  // keymap from taking over when the caret is not currently inside math.
  return true;
}

export function texSourceInput(): Extension {
  return [
    texAutoPairState,
    Prec.high(texSourceInputHandler),
    Prec.high(keymap.of([
      { key: "Backspace", run: deleteTexSourceAutoPair },
      { key: "Delete", run: deleteTexSourceAutoPairForward },
      { key: "Tab", run: (view) => moveAcrossTexSourceAutoPair(view) },
      { key: "Shift-Tab", run: (view) => moveAcrossTexSourceAutoPair(view, true) },
      { key: "Mod-[", run: (view) => moveAcrossTexSourceUnit(view, -1) },
      { key: "Mod-]", run: (view) => moveAcrossTexSourceUnit(view, 1) },
    ])),
  ];
}
