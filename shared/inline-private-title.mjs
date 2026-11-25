import { isEscapedCommandStart, scanInlineCommands } from "./command-syntax.mjs";

function codeSpans(text) {
  const runs = [...text.matchAll(/`+/g)];
  const closeAt = new Map();
  const nextByLength = new Map();
  for (let index = runs.length - 1; index >= 0; index--) {
    const length = runs[index][0].length;
    closeAt.set(index, nextByLength.get(length));
    nextByLength.set(length, index);
  }
  const spans = [];
  for (let index = 0; index < runs.length; index++) {
    const end = closeAt.get(index);
    if (end === undefined || isEscapedCommandStart(text, runs[index].index)) continue;
    spans.push({ from: runs[index].index, to: runs[end].index + runs[end][0].length });
    index = end;
  }
  return spans;
}

/** Some document title attributes retain Markdown source for editing. Remove
 * closed source-only commands even if an adjacent attribute is incomplete. */
export function stripHiddenInlineTitle(text) {
  const matches = [...text.matchAll(/@@hidden\b/gi)];
  if (matches.length === 0) return text;
  const literal = codeSpans(text);
  for (const math of text.matchAll(/\\\([^\n]*?\\\)|(?<!\\)\$[^$\n]+?(?<!\\)\$/g)) {
    literal.push({ from: math.index, to: math.index + math[0].length });
  }
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    const from = match.index;
    if (from < cursor || isEscapedCommandStart(text, from) || literal.some((span) => from >= span.from && from < span.to)) continue;
    const command = scanInlineCommands(text.slice(from), "hidden")[0];
    if (!command || command.fullFrom !== 0) continue;
    result += text.slice(cursor, from);
    cursor = from + command.fullTo;
  }
  return cursor ? result + text.slice(cursor) : text;
}
