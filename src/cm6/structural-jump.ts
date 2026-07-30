import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { scanInlineMathRanges } from "../inline-math.ts";
import { getBlockMathRanges, rangeAtPosition } from "./math-ranges.ts";

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
  const display = rangeAtPosition(cursor, getBlockMathRanges(state));
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

function boundedScope(from: number, to: number, cursor: number, math: boolean): Scope {
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
  if (pairs.length === 0) return null;

  if (direction > 0) {
    const containing = pairs
      .filter((pair) => pair.open < cursor && pair.close + 1 >= cursor)
      .sort((a, b) => a.close - b.close || b.open - a.open);
    const following = pairs
      .filter((pair) => pair.open >= cursor)
      .sort((a, b) => a.open - b.open || a.close - b.close);
    return (containing[0] ?? following[0])?.close == null
      ? null
      : (containing[0] ?? following[0])!.close + 1;
  }

  const containing = pairs
    .filter((pair) => pair.open + 1 <= cursor && pair.close + 1 >= cursor)
    .sort((a, b) => b.open - a.open || a.close - b.close);
  const preceding = pairs
    .filter((pair) => pair.close < cursor)
    .sort((a, b) => b.close - a.close || b.open - a.open);
  const target = containing[0] ?? preceding[0];
  return target ? target.open + 1 : null;
}

export function jumpStructuralDelimiter(view: EditorView, direction: 1 | -1): boolean {
  const target = structuralJumpTarget(view, direction);
  if (target == null) return false;
  if (target !== view.state.selection.main.head) {
    view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
  }
  return true;
}
