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
};

/** Most lines one range may mark; a typo like {1-99999999} must not allocate. */
const MAX_HIGHLIGHT_LINES = 5000;

export function parseCodeInfo(info: string): CodeInfo {
  const source = String(info || "");
  let lang = "";
  let langFrom = 0;
  let langTo = 0;
  const first = /^\s*([^\s{="']+)(?=\s|$)/.exec(source);
  if (first) {
    lang = first[1]!;
    langFrom = first[0].length - lang.length;
    langTo = first[0].length;
  } else {
    langFrom = langTo = source.length - source.trimStart().length;
  }
  const title = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(source);
  const lines = new Set<number>();
  for (const group of source.matchAll(/\{([\d\s,-]+)\}/g)) {
    for (const part of group[1]!.split(",")) {
      const range = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
      if (!range) continue;
      const from = Number(range[1]);
      const to = range[2] ? Number(range[2]) : from;
      if (from < 1 || to < from || to - from >= MAX_HIGHLIGHT_LINES) continue;
      for (let line = from; line <= to; line++) lines.add(line);
    }
  }
  return {
    lang,
    langFrom,
    langTo,
    title: (title?.[1] ?? title?.[2] ?? title?.[3] ?? "").trim(),
    highlight: [...lines].sort((a, b) => a - b),
  };
}
