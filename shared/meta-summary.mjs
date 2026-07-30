/** Shared preamble scanner for browser indexes and the Node note index. */

export const ORG_META_PREAMBLE_LINE_LIMIT = 12;

const META_OPEN_RE = /^[ \t]*#\+\s*begin\s+meta(?:[ \t]+[^\r\n]*)?[ \t]*$/i;
const META_CLOSE_RE = /^[ \t]*#\+\s*end\s+meta[ \t]*$/i;
const SUMMARY_OPEN_RE = /^[ \t]*#\+\s*begin\s+summary(?:[ \t]+[^\r\n]*)?[ \t]*$/i;
const SUMMARY_CLOSE_RE = /^[ \t]*#\+\s*end\s+summary[ \t]*$/i;

export function orgMetaSummaryRangeFromLines(doc) {
  let metaLine = 0;
  const preambleEnd = Math.min(doc.lines, ORG_META_PREAMBLE_LINE_LIMIT);
  for (let lineNumber = 1; lineNumber <= preambleEnd; lineNumber++) {
    if (META_OPEN_RE.test(doc.line(lineNumber).text)) {
      metaLine = lineNumber;
      break;
    }
  }
  if (metaLine === 0) return null;

  let summaryDepth = 0;
  let summaryFrom = -1;
  let summaryBodyFrom = -1;
  for (let lineNumber = metaLine + 1; lineNumber <= doc.lines; lineNumber++) {
    const line = doc.line(lineNumber);
    if (summaryDepth > 0) {
      if (SUMMARY_OPEN_RE.test(line.text)) summaryDepth++;
      else if (SUMMARY_CLOSE_RE.test(line.text)) summaryDepth--;
      if (summaryDepth === 0) {
        return { from: summaryFrom, to: line.to, bodyFrom: summaryBodyFrom, bodyTo: line.from };
      }
      continue;
    }
    if (SUMMARY_OPEN_RE.test(line.text)) {
      summaryDepth = 1;
      summaryFrom = line.from;
      summaryBodyFrom = lineNumber < doc.lines ? line.to + 1 : line.to;
      continue;
    }
    if (META_CLOSE_RE.test(line.text)) return null;
  }
  return null;
}

function stringLineDocument(source) {
  const lines = [];
  let from = 0;
  while (from <= source.length) {
    const newline = source.indexOf("\n", from);
    const to = newline < 0 ? source.length : newline;
    lines.push({ from, to, text: source.slice(from, to).replace(/\r$/, "") });
    if (newline < 0) break;
    from = newline + 1;
  }
  return {
    lines: lines.length,
    line(number) { return lines[number - 1]; },
  };
}

/** Return the first nested meta summary range in a Markdown string. */
export function orgMetaSummaryRange(markdown) {
  return orgMetaSummaryRangeFromLines(stringLineDocument(String(markdown || "")));
}

/** Blank summary source while preserving every offset and line break. */
export function maskMetaSummaryContent(markdown) {
  const source = String(markdown || "");
  const range = orgMetaSummaryRange(source);
  if (!range) return source;
  const masked = source.slice(range.from, range.to).replace(/[^\r\n]/g, " ");
  return source.slice(0, range.from) + masked + source.slice(range.to);
}
