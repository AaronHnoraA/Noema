/**
 * A code fence's info string: `python title="ridge.py" {2-3}`.
 *
 * The language is the first word, as CommonMark and every other renderer
 * read it, so the attributes cost nothing in an editor that ignores them.
 * `title="…"` names the file shown above the code; `{2-3,5}` marks lines of
 * the body (counted from 1) as highlighted. The syntax is the one AutumnMark,
 * Docusaurus and VitePress use.
 */
export type CodeInfo = {
  lang: string;
  /** Offsets of the language word inside the info string. */
  langFrom: number;
  langTo: number;
  title: string;
  /** Highlighted body lines, 1-based, sorted, without duplicates. */
  highlight: number[];
  numbers: number | null;
  collapsedLines: number | null;
  words: string[];
  whitespace: boolean;
  indentGuides: boolean;
};

/** Most lines one range may mark; a typo like {1-99999999} must not allocate. */
const MAX_HIGHLIGHT_LINES = 5000;
const MAX_FENCE_NUMBER = 10_000_000;
const MAX_WORDS = 32;
const FENCE_OPTION = /^(?::)?(line-numbers|collapsed-lines|no-line-numbers|no-collapsed-lines|whitespace|indent-guides)(?:=(\d+))?$/;
const FENCE_PARTS = /(?:^|\s+)(title=(?:"[^"]*"|'[^']*'|\S+)|\{[\d\s,-]+\}|\/[^/\s][^/\n]*\/|\S+)/g;

export function parseCodeInfo(info: string): CodeInfo {
  const source = String(info || "");
  let lang = "";
  let langFrom = source.length - source.trimStart().length;
  let langTo = langFrom;
  let title = "";
  let numbers: number | null = null;
  let collapsedLines: number | null = null;
  let whitespace = false;
  let indentGuides = false;
  const words = new Set<string>();
  const lines = new Set<number>();
  for (const match of source.matchAll(FENCE_PARTS)) {
    const part = match[1]!;
    const option = FENCE_OPTION.exec(part);
    if (part.startsWith("title=")) {
      const value = part.slice("title=".length);
      if (!title) title = (/^(?:"([^"]*)"|'([^']*)')$/.exec(value)?.slice(1).find((item) => item !== undefined) ?? value).trim();
    } else if (/^\{[\d\s,-]+\}$/.test(part)) {
      for (const entry of part.slice(1, -1).split(",")) {
        const range = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(entry);
        if (!range) continue;
        const from = Number(range[1]);
        const to = range[2] ? Number(range[2]) : from;
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to - from >= MAX_HIGHLIGHT_LINES) continue;
        for (let line = from; line <= to && lines.size < MAX_HIGHLIGHT_LINES; line++) lines.add(line);
      }
    } else if (part.length > 2 && part.startsWith("/") && part.endsWith("/")) {
      if (words.size < MAX_WORDS) words.add(part.slice(1, -1));
    } else if (option) {
      const amount = option[2] === undefined ? null : Number(option[2]);
      if (amount !== null && (!Number.isSafeInteger(amount) || amount > MAX_FENCE_NUMBER)) continue;
      switch (option[1]) {
        case "line-numbers": numbers = amount ?? 1; break;
        case "no-line-numbers": numbers = null; break;
        case "collapsed-lines": collapsedLines = Math.max(1, amount ?? 15); break;
        case "no-collapsed-lines": collapsedLines = null; break;
        case "whitespace": whitespace = true; break;
        case "indent-guides": indentGuides = true; break;
      }
    } else if (!lang && (match.index + match[0].length - part.length) === langFrom && /^[^\s{="']+$/.test(part)) {
      lang = part;
      langTo = langFrom + lang.length;
    }
  }
  return {
    lang,
    langFrom,
    langTo,
    title,
    highlight: [...lines].sort((a, b) => a - b),
    numbers,
    collapsedLines,
    words: [...words],
    whitespace,
    indentGuides,
  };
}
