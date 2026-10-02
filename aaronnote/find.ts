export type FindMatch = {
  from: number;
  to: number;
  match: RegExpExecArray;
};

export type FindPatternResult =
  | { pattern: RegExp; error?: undefined }
  | { pattern: null; error?: string };

export function escapeFindQuery(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type FindOptions = {
  regex?: boolean;
  /**
   * `"smart"` (the default) matches case-insensitively unless the query has an
   * uppercase letter, as Emacs isearch and Vim's smartcase do.
   */
  caseSensitive?: boolean | "smart";
  wholeWord?: boolean;
};

/** Whether QUERY asks for case-sensitive matching under smart case. */
export function smartCaseSensitive(query: string, regex = false): boolean {
  // In a regex, `\S`, `\W`, `\D`, `\B` are classes, not letters the author typed.
  const letters = regex ? query.replace(/\\./gu, "") : query;
  return /\p{Lu}/u.test(letters);
}

export function createFindPattern(query: string, options: boolean | FindOptions = {}): FindPatternResult {
  if (!query) return { pattern: null };
  const { regex = false, caseSensitive = "smart", wholeWord = false } =
    typeof options === "boolean" ? { regex: options, caseSensitive: true } : options;
  const sensitive = caseSensitive === "smart" ? smartCaseSensitive(query, regex) : caseSensitive;
  let source = regex ? query : escapeFindQuery(query);
  // `\b` only knows ASCII word characters; letters and digits of any script
  // are word characters here.
  if (wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  const flags = sensitive ? "g" : "gi";
  // Unicode mode makes `.` and classes take an emoji whole. A user pattern
  // that is only valid without it (`\-`) still works, as in MarkText's
  // search. Whole-word bounds need Unicode property escapes, so it stays on.
  const attempts = regex && !wholeWord ? [`${flags}u`, flags] : [`${flags}u`];
  let error = "";
  for (const attempt of attempts) {
    try {
      return { pattern: new RegExp(source, attempt) };
    } catch (err) {
      error ||= err instanceof Error ? err.message : "Bad regex";
    }
  }
  return { pattern: null, error: error || "Bad regex" };
}

export function collectFindMatches(markdown: string, pattern: RegExp | null): FindMatch[] {
  if (!pattern) return [];
  pattern.lastIndex = 0;
  const matches: FindMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const from = match.index;
    const text = match[0] ?? "";
    if (!text) {
      pattern.lastIndex += 1;
      if (pattern.lastIndex > markdown.length) break;
      continue;
    }
    matches.push({ from, to: from + text.length, match });
  }
  return matches;
}

export function collectFindMatchesInRanges(
  markdown: string,
  pattern: RegExp | null,
  ranges: readonly { from: number; to: number }[],
): FindMatch[] {
  if (!pattern) return [];
  const matches: FindMatch[] = [];
  for (const range of ranges) {
    const from = Math.max(0, Math.min(range.from, markdown.length));
    const to = Math.max(from, Math.min(range.to, markdown.length));
    const slice = markdown.slice(from, to);
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(slice)) !== null) {
      const text = match[0] ?? "";
      if (!text) {
        pattern.lastIndex += 1;
        if (pattern.lastIndex > slice.length) break;
        continue;
      }
      matches.push({ from: from + match.index, to: from + match.index + text.length, match });
    }
  }
  return matches;
}

export function replacementText(
  match: RegExpExecArray,
  replacement: string,
  regex: boolean,
): string {
  if (!regex) return replacement;
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (_token, key: string) => {
    if (key === "$") return "$";
    if (key === "&") return match[0] ?? "";
    const index = Number(key);
    return Number.isFinite(index) ? match[index] ?? "" : "";
  });
}

export function replaceAllFindMatches(
  markdown: string,
  pattern: RegExp | null,
  replacement: string,
  regex: boolean,
): string {
  if (!pattern) return markdown;
  const matches = collectFindMatches(markdown, pattern);
  if (matches.length === 0) return markdown;
  let cursor = 0;
  let next = "";
  for (const item of matches) {
    next += markdown.slice(cursor, item.from);
    next += replacementText(item.match, replacement, regex);
    cursor = item.to;
  }
  next += markdown.slice(cursor);
  return next;
}
