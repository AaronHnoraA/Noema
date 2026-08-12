/**
 * TeX tokenizer for the formula the caret is currently editing.
 *
 * This is deliberately *not* a LaTeX parser. It is a single forward pass that
 * classifies the source well enough to colour it and to pair up brackets, and
 * it only ever runs over one revealed formula, so it can afford to be exact
 * about the things that matter while editing (escapes, comments, text
 * arguments) and indifferent to everything else.
 *
 * Kept separate from `structural-jump.ts`'s `structuralPairs`, which serves
 * Cmd-[ / Cmd-] navigation: that one deliberately skips `\{` and knows nothing
 * about `\left…\right`, and widening it for colouring would move the cursor
 * targets.
 */

export type TexTokenKind =
  | "command"
  | "environment"
  | "delimiter"
  | "script"
  | "number"
  | "text"
  | "comment"
  | "align"
  | "bracket";

export type TexToken = {
  from: number;
  to: number;
  kind: TexTokenKind;
  /** Colour bucket for `kind === "bracket"`; -1 when the bracket is unmatched. */
  depth?: number;
};

/** How many colours the rainbow cycles through before repeating. */
export const TEX_BRACKET_DEPTH_COLORS = 6;

const TEXT_COMMANDS = new Set([
  "text", "textrm", "textsf", "texttt", "textnormal", "textbf", "textit",
  "textmd", "textup", "textsl", "textsc", "mbox",
]);

const DELIMITER_COMMANDS = new Set([
  "left", "right", "middle",
  "big", "Big", "bigg", "Bigg",
  "bigl", "Bigl", "biggl", "Biggl",
  "bigr", "Bigr", "biggr", "Biggr",
  "bigm", "Bigm", "biggm", "Biggm",
]);

/** Bracket-like control sequences, e.g. `\{ … \}` and `\langle … \rangle`. */
const COMMAND_BRACKETS: Record<string, string> = {
  "\\{": "\\}",
  "\\langle": "\\rangle",
  "\\lbrace": "\\rbrace",
  "\\lfloor": "\\rfloor",
  "\\lceil": "\\rceil",
  "\\lvert": "\\rvert",
  "\\lVert": "\\rVert",
};
const COMMAND_BRACKET_CLOSERS = new Set(Object.values(COMMAND_BRACKETS));

const PLAIN_BRACKETS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const PLAIN_BRACKET_CLOSERS = new Set(Object.values(PLAIN_BRACKETS));

type OpenBracket = { close: string; tokenIndex: number };

function isLetter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z@]/.test(character);
}

/**
 * End offset of the control sequence starting at `index` (which points at `\`).
 * A backslash before a non-letter consumes exactly one character, so `\\` and
 * `\{` come back whole.
 */
function readControlSequence(source: string, index: number): number {
  let position = index + 1;
  if (isLetter(source[position])) {
    while (position < source.length && isLetter(source[position])) position++;
    return position;
  }
  return Math.min(source.length, position + 1);
}

/** End offset of the `{…}` group starting at `index`, or -1 when unclosed. */
function readGroupEnd(source: string, index: number): number {
  if (source[index] !== "{") return -1;
  let depth = 0;
  let position = index;
  while (position < source.length) {
    const character = source[position]!;
    if (character === "\\") {
      position = readControlSequence(source, position);
      continue;
    }
    if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return position + 1;
    position++;
  }
  return -1;
}

/**
 * Classify `source` into highlight tokens, offset by `baseOffset`.
 *
 * Brackets carry the nesting depth they sit at so both halves of a pair get the
 * same colour; an unmatched bracket gets `depth: -1`.
 */
export function scanTexSource(source: string, baseOffset = 0): TexToken[] {
  const tokens: TexToken[] = [];
  const stack: OpenBracket[] = [];

  const push = (from: number, to: number, kind: TexTokenKind, depth?: number): number => {
    if (to <= from) return -1;
    tokens.push({ from: baseOffset + from, to: baseOffset + to, kind, depth });
    return tokens.length - 1;
  };
  const open = (from: number, to: number, close: string): void => {
    const depth = stack.length % TEX_BRACKET_DEPTH_COLORS;
    stack.push({ close, tokenIndex: push(from, to, "bracket", depth) });
  };
  const close = (from: number, to: number, closer: string): void => {
    for (let index = stack.length - 1; index >= 0; index--) {
      if (stack[index]!.close !== closer) continue;
      // Anything opened inside this one can no longer close: `{a(b}` leaves the
      // `(` orphaned, and it has to be flagged rather than keep the colour it
      // was optimistically given when it opened.
      // `splice` returns the match first, then the orphans above it.
      for (const orphan of stack.splice(index).slice(1)) {
        const token = tokens[orphan.tokenIndex];
        if (token) token.depth = -1;
      }
      push(from, to, "bracket", index % TEX_BRACKET_DEPTH_COLORS);
      return;
    }
    push(from, to, "bracket", -1);
  };

  let position = 0;
  while (position < source.length) {
    const character = source[position]!;

    if (character === "%") {
      const newline = source.indexOf("\n", position);
      const end = newline < 0 ? source.length : newline;
      push(position, end, "comment");
      position = end;
      continue;
    }

    if (character === "&") {
      push(position, position + 1, "align");
      position++;
      continue;
    }

    if (character === "^" || character === "_") {
      push(position, position + 1, "script");
      position++;
      continue;
    }

    if (character === "\\") {
      const end = readControlSequence(source, position);
      const command = source.slice(position, end);
      const name = command.slice(1);

      if (command === "\\\\") {
        push(position, end, "align");
      } else if (COMMAND_BRACKETS[command]) {
        open(position, end, COMMAND_BRACKETS[command]!);
      } else if (COMMAND_BRACKET_CLOSERS.has(command)) {
        close(position, end, command);
      } else if (name === "begin" || name === "end") {
        push(position, end, "command");
        const groupEnd = readGroupEnd(source, end);
        if (groupEnd > 0) {
          push(end, end + 1, "bracket", stack.length % TEX_BRACKET_DEPTH_COLORS);
          push(end + 1, groupEnd - 1, "environment");
          push(groupEnd - 1, groupEnd, "bracket", stack.length % TEX_BRACKET_DEPTH_COLORS);
          position = groupEnd;
          continue;
        }
      } else if (DELIMITER_COMMANDS.has(name)) {
        push(position, end, "delimiter");
      } else if (TEXT_COMMANDS.has(name)) {
        push(position, end, "command");
        const groupEnd = readGroupEnd(source, end);
        if (groupEnd > 0) {
          // The argument is prose, not math: colour it as one run so it reads
          // the way it will render.
          const depth = stack.length % TEX_BRACKET_DEPTH_COLORS;
          push(end, end + 1, "bracket", depth);
          push(end + 1, groupEnd - 1, "text");
          push(groupEnd - 1, groupEnd, "bracket", depth);
          position = groupEnd;
          continue;
        }
      } else {
        push(position, end, "command");
      }
      position = end;
      continue;
    }

    if (PLAIN_BRACKETS[character]) {
      open(position, position + 1, PLAIN_BRACKETS[character]!);
      position++;
      continue;
    }
    if (PLAIN_BRACKET_CLOSERS.has(character)) {
      close(position, position + 1, character);
      position++;
      continue;
    }

    if (character >= "0" && character <= "9") {
      let end = position;
      while (end < source.length && /[0-9.]/.test(source[end]!)) end++;
      push(position, end, "number");
      position = end;
      continue;
    }

    position++;
  }

  for (const entry of stack) {
    const token = tokens[entry.tokenIndex];
    if (token) token.depth = -1;
  }
  return tokens;
}

/** CSS classes for a token, ready for a CodeMirror mark decoration. */
export function texTokenClass(token: TexToken): string {
  if (token.kind !== "bracket") return `cm-tex-${token.kind}`;
  return token.depth === undefined || token.depth < 0
    ? "cm-tex-bracket cm-tex-bracket-unmatched"
    : `cm-tex-bracket cm-tex-bracket-${token.depth}`;
}
