import { scanInlineMathRanges, type InlineMathRange } from "../inline-math.ts";

export type TableCellCompletionDetail = {
  input: HTMLInputElement;
};

function escapedAt(source: string, position: number): boolean {
  let slashes = 0;
  for (let index = position - 1; index >= 0 && source[index] === "\\"; index--) slashes++;
  return slashes % 2 === 1;
}

/** Inline code is literal, so its formula-looking text cannot own a MathLive editor. */
function inlineCodeRanges(source: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (let from = 0; from < source.length; from++) {
    if (source[from] !== "`" || escapedAt(source, from)) continue;
    let width = 1;
    while (source[from + width] === "`") width++;
    const fence = "`".repeat(width);
    let close = source.indexOf(fence, from + width);
    while (close >= 0 && (source[close + width] === "`" || source[close - 1] === "`")) {
      close = source.indexOf(fence, close + width);
    }
    if (close < 0) { from += width - 1; continue; }
    ranges.push({ from, to: close + width });
    from = close + width - 1;
  }
  return ranges;
}

export function tableCellMathRanges(source: string): InlineMathRange[] {
  const code = inlineCodeRanges(source);
  let codeIndex = 0;
  return scanInlineMathRanges(source).filter((range) => {
    while (codeIndex < code.length && code[codeIndex]!.to <= range.from) codeIndex++;
    const literal = code[codeIndex];
    return range.tex.length > 0
      && !escapedAt(source, range.from)
      && !(literal && range.from >= literal.from && range.from < literal.to);
  });
}

/** Snippet recognition reads only the active cell prefix. */
export function tableCellSnippetContext(source: string, caret: number): { prefix: string; mode: "markdown-mode" | "tex-mode" } {
  const cursor = Math.max(0, Math.min(source.length, caret));
  const before = source.slice(0, cursor);
  const code = inlineCodeRanges(source);
  const inCode = code.some((range) => cursor > range.from && cursor < range.to);
  let mathOpen = false;
  let codeIndex = 0;
  for (let index = 0; index < before.length - 1; index++) {
    while (codeIndex < code.length && code[codeIndex]!.to <= index) codeIndex++;
    const literal = code[codeIndex];
    if (literal && index >= literal.from) { index = literal.to - 1; continue; }
    if (before[index] !== "\\" || escapedAt(before, index)) continue;
    if (before[index + 1] === "(") { mathOpen = true; index++; }
    else if (before[index + 1] === ")") { mathOpen = false; index++; }
  }
  return {
    prefix: inCode ? "" : before.match(/([A-Za-z0-9_:/;.+\\-]{1,40})$/)?.[1] ?? "",
    mode: mathOpen && !inCode ? "tex-mode" : "markdown-mode",
  };
}
