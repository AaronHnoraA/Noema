import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { scanInlineMathRanges } from "../inline-math.ts";
import { blockMathRangeAt } from "./math-ranges.ts";

const MAX_SCOPE_CHARS = 16 * 1024;
const BLOCK_NODE_NAMES = new Set([
  "Paragraph",
  "ListItem",
  "Blockquote",
  "TableCell",
  "TableHeader",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
]);

type Pair = { open: number; close: number };
type Scope = { from: number; to: number; math: boolean };

function escapedAt(text: string, index: number): boolean {
  let count = 0;
  for (let pos = index - 1; pos >= 0 && text[pos] === "\\"; pos--) count += 1;
  return count % 2 === 1;
}

function jumpScope(view: EditorView, cursor: number): Scope {
  const state = view.state;
  const display = blockMathRangeAt(state, cursor);
  if (display) return boundedScope(display.contentFrom, display.contentTo, cursor, true);

  const line = state.doc.lineAt(cursor);
  const inline = scanInlineMathRanges(line.text, line.from)
    .find((range) => cursor > range.from && cursor < range.to);
  if (inline) return boundedScope(inline.from + 2, inline.to - 2, cursor, true);

  let node: SyntaxNode | null = syntaxTree(state).resolveInner(cursor, -1);
  let block: { from: number; to: number } | null = null;
  while (node && node.name !== "Document") {
    if (/Link|URL/.test(node.name)) return boundedScope(node.from, node.to, cursor, false);
    if (!block && BLOCK_NODE_NAMES.has(node.name)) block = { from: node.from, to: node.to };
    node = node.parent;
  }
  return block
    ? boundedScope(block.from, block.to, cursor, false)
    : boundedScope(line.from, line.to, cursor, false);
}

function boundedScope(
  from: number,
  to: number,
  cursor: number,
  math: boolean,
): Scope {
  if (to - from <= MAX_SCOPE_CHARS) return { from, to, math };
  const half = MAX_SCOPE_CHARS >> 1;
  const boundedFrom = Math.max(from, Math.min(cursor - half, to - MAX_SCOPE_CHARS));
  return { from: boundedFrom, to: Math.min(to, boundedFrom + MAX_SCOPE_CHARS), math };
}

export function structuralPairs(text: string, baseOffset = 0, math = false): Pair[] {
  const stack: Array<{ char: string; pos: number }> = [];
  const pairs: Pair[] = [];
  const closeFor: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const openerFor: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let inlineCode = false;
  for (let pos = 0; pos < text.length; pos++) {
    const char = text[pos]!;
    if (!math && char === "`" && !escapedAt(text, pos)) {
      inlineCode = !inlineCode;
      continue;
    }
    if (inlineCode || escapedAt(text, pos)) continue;
    if (closeFor[char]) {
      stack.push({ char, pos });
      continue;
    }
    const opener = openerFor[char];
    if (!opener) continue;
    for (let index = stack.length - 1; index >= 0; index--) {
      if (stack[index]!.char !== opener) continue;
      const open = stack[index]!.pos;
      stack.splice(index);
      pairs.push({ open: baseOffset + open, close: baseOffset + pos });
      break;
    }
  }
  return pairs;
}

export function structuralJumpTarget(view: EditorView, direction: 1 | -1): number | null {
  const cursor = view.state.selection.main.head;
  const scope = jumpScope(view, cursor);
  const pairs = structuralPairs(view.state.doc.sliceString(scope.from, scope.to), scope.from, scope.math);

  if (direction > 0) {
    let containing: Pair | null = null;
    let following: Pair | null = null;
    for (const pair of pairs) {
      if (pair.open < cursor && pair.close + 1 > cursor) {
        if (!containing || pair.close < containing.close
          || (pair.close === containing.close && pair.open > containing.open)) containing = pair;
      } else if (pair.open >= cursor && pair.close + 1 > cursor) {
        if (!following || pair.open < following.open
          || (pair.open === following.open && pair.close < following.close)) following = pair;
      }
    }
    return containing || following ? (containing ?? following)!.close + 1 : null;
  }

  let containing: Pair | null = null;
  let preceding: Pair | null = null;
  for (const pair of pairs) {
    if (pair.open + 1 < cursor && pair.close + 1 >= cursor) {
      if (!containing || pair.open > containing.open
        || (pair.open === containing.open && pair.close < containing.close)) containing = pair;
    } else if (pair.close < cursor && pair.open + 1 < cursor) {
      if (!preceding || pair.close > preceding.close
        || (pair.close === preceding.close && pair.open > preceding.open)) preceding = pair;
    }
  }
  const target = containing ?? preceding;
  return target ? target.open + 1 : null;
}

export function jumpStructuralDelimiter(view: EditorView, direction: 1 | -1): boolean {
  const target = structuralJumpTarget(view, direction);
  if (target == null || target === view.state.selection.main.head) return false;
  view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
  return true;
}

function texIdentifierCharacter(character: string): boolean {
  return /[\p{L}\p{N}]/u.test(character);
}

/** Source-safe boundaries for the same command/group units MathLive displays. */
export function texUnitBoundaries(source: string, baseOffset = 0): number[] {
  const boundaries: number[] = [baseOffset];
  for (let position = 0; position < source.length;) {
    const start = position;
    const character = source[position]!;
    if (/\s/.test(character)) {
      while (position < source.length && /\s/.test(source[position]!)) position++;
    } else if (character === "%" && !escapedAt(source, position)) {
      const newline = source.indexOf("\n", position);
      position = newline < 0 ? source.length : newline;
    } else if (character === "\\") {
      position++;
      if (/[A-Za-z@]/.test(source[position] ?? "")) {
        while (position < source.length && /[A-Za-z@]/.test(source[position]!)) position++;
      } else if (position < source.length) {
        position += (source.codePointAt(position) ?? 0) > 0xffff ? 2 : 1;
      }
    } else {
      const codePoint = String.fromCodePoint(source.codePointAt(position)!);
      if (texIdentifierCharacter(codePoint)) {
        position += codePoint.length;
        while (position < source.length) {
          const next = String.fromCodePoint(source.codePointAt(position)!);
          if (!texIdentifierCharacter(next)) break;
          position += next.length;
        }
      } else {
        position += codePoint.length;
      }
    }
    const absoluteStart = baseOffset + start;
    if (boundaries[boundaries.length - 1] !== absoluteStart) boundaries.push(absoluteStart);
    const absoluteEnd = baseOffset + position;
    if (boundaries[boundaries.length - 1] !== absoluteEnd) boundaries.push(absoluteEnd);
  }
  return boundaries;
}

export function texUnitJumpTarget(view: EditorView, direction: 1 | -1): number | null {
  const selection = view.state.selection.main;
  const cursor = direction > 0 ? selection.to : selection.from;
  const scope = jumpScope(view, cursor);
  if (!scope.math) return null;
  const boundaries = texUnitBoundaries(
    view.state.doc.sliceString(scope.from, scope.to),
    scope.from,
  );
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (boundaries[mid]! <= cursor) low = mid + 1;
    else high = mid;
  }
  if (direction > 0) return boundaries[low] ?? null;
  let previous = low - 1;
  if (boundaries[previous] === cursor) previous--;
  return boundaries[previous] ?? null;
}

export function jumpTexUnit(view: EditorView, direction: 1 | -1): boolean {
  const target = texUnitJumpTarget(view, direction);
  if (target == null || target === view.state.selection.main.head) return false;
  view.dispatch({ selection: { anchor: target }, scrollIntoView: true, userEvent: "select" });
  return true;
}
