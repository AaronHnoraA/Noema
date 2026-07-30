import { scanInlineCommands } from "./command-syntax.mjs";
import { orgMetaSummaryRange } from "./meta-summary.mjs";

const HIDDEN_CITATION_BLOCKS = new Set(["lean4", "src", "source"]);
const PRIVATE_CITATION_COMMANDS = new Set([
  "todo", "itodo", "project", "milestone", "clock", "comment", "cell", "lean4", "note-code",
]);

function lineRecords(text) {
  const records = [];
  let from = 0;
  while (from <= text.length) {
    const newline = text.indexOf("\n", from);
    const to = newline < 0 ? text.length : newline;
    records.push({ from, to, lineEnd: newline < 0 ? to : newline + 1, text: text.slice(from, to) });
    if (newline < 0) break;
    from = newline + 1;
  }
  return records;
}

function mergeRanges(ranges) {
  const sorted = ranges
    .filter((range) => range.to > range.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (!last || range.from > last.to) merged.push({ ...range });
    else last.to = Math.max(last.to, range.to);
  }
  return merged;
}

function addDelimitedRanges(source, ranges, open, close, allowNewlines = true) {
  let cursor = 0;
  while (cursor < source.length) {
    const from = source.indexOf(open, cursor);
    if (from < 0) break;
    const end = source.indexOf(close, from + open.length);
    if (end < 0 || (!allowNewlines && /[\r\n]/.test(source.slice(from + open.length, end)))) {
      cursor = from + open.length;
      continue;
    }
    ranges.push({ from, to: end + close.length });
    cursor = end + close.length;
  }
}

function markdownLinkRanges(source) {
  const ranges = [];
  for (let start = 0; start < source.length; start += 1) {
    const image = source[start] === "!" && source[start + 1] === "[";
    if (!image && source[start] !== "[") continue;
    const bracketStart = start + (image ? 1 : 0);
    let bracketDepth = 1;
    let cursor = bracketStart + 1;
    let escaped = false;
    for (; cursor < source.length && bracketDepth > 0; cursor += 1) {
      const char = source[cursor];
      if (char === "\n" || char === "\r") break;
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === "[") bracketDepth += 1;
      else if (char === "]") bracketDepth -= 1;
    }
    if (bracketDepth !== 0 || source[cursor] !== "(") continue;
    const destinationFrom = cursor;
    let parenDepth = 1;
    cursor += 1;
    escaped = false;
    for (; cursor < source.length && parenDepth > 0; cursor += 1) {
      const char = source[cursor];
      if (char === "\n" || char === "\r") break;
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === "(") parenDepth += 1;
      else if (char === ")") parenDepth -= 1;
    }
    if (parenDepth === 0) {
      // The destination is literal URL data; the visible label remains normal
      // Markdown and may legitimately contain an Noema citation.
      ranges.push({ from: destinationFrom, to: cursor });
      start = cursor - 1;
    }
  }
  return ranges;
}

function balancedBraceEnd(source, open) {
  let depth = 0;
  let quote = "";
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\" && index + 1 < source.length) index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "\\" && index + 1 < source.length) { index += 1; continue; }
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index + 1;
  }
  return source.length;
}

function addMetaCitationRanges(source, lines, ranges) {
  const summary = orgMetaSummaryRange(source);
  let meta = null;
  for (const line of lines) {
    if (!meta) {
      if (/^\s*#\+begin(?:_|\s+)meta\b/i.test(line.text)) {
        meta = { from: line.from, depth: 1 };
      }
      continue;
    }
    if (/^\s*#\+begin(?:_|\s+)meta\b/i.test(line.text)) meta.depth += 1;
    if (!/^\s*#\+end(?:_|\s+)meta\s*$/i.test(line.text)) continue;
    meta.depth -= 1;
    if (meta.depth !== 0) continue;
    if (summary && summary.from >= meta.from && summary.to <= line.lineEnd) {
      // Metadata stays private, but its nested summary is authored prose: cite
      // commands in the body must resolve exactly like citations in the note.
      ranges.push({ from: meta.from, to: summary.bodyFrom });
      ranges.push({ from: summary.bodyTo, to: line.lineEnd });
    } else {
      ranges.push({ from: meta.from, to: line.lineEnd });
    }
    meta = null;
  }
  if (meta) ranges.push({ from: meta.from, to: source.length });
}

/** Contexts in which `@@cite` is literal/private rather than resolvable. */
export function protectedCitationRanges(markdown) {
  const source = String(markdown || "");
  const ranges = [];

  // HTML comments, including an unfinished comment through EOF.
  let commentFrom = 0;
  while ((commentFrom = source.indexOf("<!--", commentFrom)) >= 0) {
    const close = source.indexOf("-->", commentFrom + 4);
    ranges.push({ from: commentFrom, to: close < 0 ? source.length : close + 3 });
    if (close < 0) break;
    commentFrom = close + 3;
  }

  const lines = lineRecords(source);
  addMetaCitationRanges(source, lines, ranges);
  let fence = null;
  let hidden = null;
  for (const line of lines) {
    const containerText = line.text.replace(/^ {0,3}(?:> ?)+/, "");
    const fenceMatch = containerText.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && fenceMatch) {
      fence = { from: line.from, char: fenceMatch[1][0], length: fenceMatch[1].length };
    } else if (fence && fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) {
      ranges.push({ from: fence.from, to: line.lineEnd });
      fence = null;
    }

    if (!hidden) {
      const open = line.text.match(/^\s*#\+begin(?:_|\s+)([A-Za-z][\w-]*)\b/i);
      const kind = open?.[1]?.toLowerCase() || "";
      if (HIDDEN_CITATION_BLOCKS.has(kind)) hidden = { kind, from: line.from, depth: 1 };
    } else {
      if (new RegExp(`^\\s*#\\+begin(?:_|\\s+)${hidden.kind}\\b`, "i").test(line.text)) hidden.depth += 1;
      if (new RegExp(`^\\s*#\\+end(?:_|\\s+)${hidden.kind}\\s*$`, "i").test(line.text)) {
        hidden.depth -= 1;
        if (hidden.depth === 0) {
          ranges.push({ from: hidden.from, to: line.lineEnd });
          hidden = null;
        }
      }
    }
  }
  if (fence) ranges.push({ from: fence.from, to: source.length });
  if (hidden) ranges.push({ from: hidden.from, to: source.length });

  // Private planning blocks may span lines after their visible header.
  const privateBlock = /@@(?:todo|itodo|project|milestone|clock|comment|cell|lean4|note-code)(?:\([^\n)]*\))?[ \t]+\[[^\]\n]*\][ \t]*\{/gi;
  for (const match of source.matchAll(privateBlock)) {
    const open = match.index + match[0].lastIndexOf("{");
    ranges.push({ from: match.index, to: balancedBraceEnd(source, open) });
  }
  for (const command of scanInlineCommands(source)) {
    if (PRIVATE_CITATION_COMMANDS.has(command.name)) ranges.push({ from: command.fullFrom, to: command.fullTo });
  }

  // Literal Markdown/code/math contexts.
  for (const match of source.matchAll(/(`+)[^\n]*?\1/g)) ranges.push({ from: match.index, to: match.index + match[0].length });
  addDelimitedRanges(source, ranges, "\\(", "\\)", false);
  addDelimitedRanges(source, ranges, "\\[", "\\]", true);
  addDelimitedRanges(source, ranges, "$$", "$$", true);
  for (const match of source.matchAll(/(?<!\\)\$(?!\s|\$)[^$\n]*?\S(?<!\\)\$/g)) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  ranges.push(...markdownLinkRanges(source));
  return mergeRanges(ranges);
}
