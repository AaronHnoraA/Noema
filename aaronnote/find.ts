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

export function createFindPattern(query: string, regex: boolean): FindPatternResult {
  if (!query) return { pattern: null };
  try {
    return { pattern: new RegExp(regex ? query : escapeFindQuery(query), "gu") };
  } catch (err) {
    return {
      pattern: null,
      error: err instanceof Error ? err.message : "Bad regex",
    };
  }
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
