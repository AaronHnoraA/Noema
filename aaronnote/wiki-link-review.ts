export type WikiLinkTarget = {
  id: string;
  title: string;
  aliases: string[];
  repositoryId: string;
  namespace: string;
  partition: "public" | "private";
  file: string;
  kind?: string;
};

export type WikiLinkSuggestion = {
  from: number;
  to: number;
  text: string;
  context: string;
  targets: WikiLinkTarget[];
};

function maskedMarkdown(markdown: string): string {
  // Keep every UTF-16 offset intact so a reviewed edit can address the source.
  const mask = markdown.split("");
  const hide = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) if (mask[i] !== "\n") mask[i] = " ";
  };
  const lines = markdown.split("\n");
  let offset = 0;
  let fence = "";
  let orgBlock = false;
  let frontMatter = lines[0]?.trim() === "---";
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber] || "";
    const trimmed = line.trim();
    if (frontMatter) {
      hide(offset, offset + line.length);
      if (lineNumber > 0 && (trimmed === "---" || trimmed === "...")) frontMatter = false;
    } else {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (/^\s*#\+begin\b/i.test(line)) {
        orgBlock = true;
        hide(offset, offset + line.length);
      } else if (orgBlock) {
        hide(offset, offset + line.length);
        if (/^\s*#\+end\b/i.test(line)) orgBlock = false;
      } else if (marker) {
        if (!fence) fence = marker[1]![0]!.repeat(marker[1]!.length);
        else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = "";
        hide(offset, offset + line.length);
      } else if (fence || /^\s{4,}\S/.test(line) || /^\s*(?:#{1,6}\s|#\+|>|[-*+]\s|\d+[.)]\s)/.test(line)
        || /^\s*<!--/.test(line) || /^\s*<\/?[A-Za-z][^>]*>/.test(line)) {
        hide(offset, offset + line.length);
      }
    }
    offset += line.length + 1;
  }
  // Existing links, code, formulas, and bare URLs already carry meaning.
  const protectedSyntax = /(?<!\\)\[\[[^\]\n]+\]\]|!?\[[^\]\n]*\]\([^\n)]*\)|!?\[[^\]\n]*\]\[[^\]\n]*\]|`+[^`\n]*`+|\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|<!--[\s\S]*?-->|<https?:\/\/[^>\n]+>|https?:\/\/\S+/g;
  for (const match of markdown.matchAll(protectedSyntax)) hide(match.index, match.index + match[0].length);
  return mask.join("");
}

const wordCharacter = /[\p{L}\p{N}_]/u;
function bounded(source: string, from: number, to: number, phrase: string): boolean {
  return (!wordCharacter.test(phrase[0]!) || from === 0 || !wordCharacter.test(source[from - 1]!))
    && (!wordCharacter.test(phrase.at(-1)!) || to === source.length || !wordCharacter.test(source[to]!));
}

/** Scan prose only. Every suggestion remains a proposed source edit until accepted. */
export function scanWikiLinkSuggestions(
  markdown: string,
  pages: WikiLinkTarget[],
  options: { sourceFile?: string; sourcePartition?: "public" | "private"; limit?: number } = {},
): WikiLinkSuggestion[] {
  const terms = new Map<string, { spelling: string; targets: WikiLinkTarget[] }>();
  for (const page of pages) {
    if (page.kind === "redirect" || page.file === options.sourceFile
      || (options.sourcePartition === "public" && page.partition === "private")) continue;
    for (const name of [page.title, ...page.aliases]) {
      const spelling = name.trim();
      if (spelling.length < 2 || spelling.length > 100 || /[\n\[\]<>]/.test(spelling)) continue;
      const key = spelling.normalize("NFKC").toLocaleLowerCase();
      const entry = terms.get(key) || { spelling, targets: [] };
      if (!entry.targets.some((target) => target.id === page.id)) entry.targets.push(page);
      terms.set(key, entry);
    }
  }
  const orderedTerms = [...terms.values()].sort((a, b) => b.spelling.length - a.spelling.length);
  const byInitial = new Map<string, typeof orderedTerms>();
  for (const term of orderedTerms) {
    const initial = term.spelling[0]!.normalize("NFKC").toLocaleLowerCase();
    const bucket = byInitial.get(initial) || [];
    bucket.push(term);
    byInitial.set(initial, bucket);
  }
  const visible = maskedMarkdown(markdown);
  const suggestions: WikiLinkSuggestion[] = [];
  const limit = Math.max(1, Math.min(options.limit ?? 80, 200));
  let position = 0;
  while (position < visible.length && suggestions.length < limit) {
    let matched: { spelling: string; targets: WikiLinkTarget[] } | undefined;
    for (const term of byInitial.get(visible[position]!.normalize("NFKC").toLocaleLowerCase()) || []) {
      const length = term.spelling.length;
      if (length > visible.length - position) continue;
      const sourceText = visible.slice(position, position + length);
      if (sourceText.normalize("NFKC").toLocaleLowerCase() === term.spelling.normalize("NFKC").toLocaleLowerCase()
        && bounded(visible, position, position + length, term.spelling)) { matched = term; break; }
    }
    if (!matched) { position += 1; continue; }
    const from = position;
    const to = from + matched.spelling.length;
    const lineStart = markdown.lastIndexOf("\n", from - 1) + 1;
    const lineEnd = markdown.indexOf("\n", to);
    suggestions.push({
      from, to, text: markdown.slice(from, to),
      context: markdown.slice(Math.max(lineStart, from - 60), Math.min(lineEnd < 0 ? markdown.length : lineEnd, to + 60)).trim(),
      targets: matched.targets,
    });
    position = to;
  }
  return suggestions;
}

export function reviewedWikiLinkChange(
  markdown: string,
  suggestion: WikiLinkSuggestion,
  pageId: string,
): { from: number; to: number; insert: string } | null {
  if (!suggestion.targets.some((target) => target.id === pageId)
    || markdown.slice(suggestion.from, suggestion.to) !== suggestion.text
    || !/^[0-9a-f-]{36}$/i.test(pageId)) return null;
  return { from: suggestion.from, to: suggestion.to, insert: `[[roam://${pageId}|${suggestion.text}]]` };
}
