/**
 * `:name:` emoji shortcodes, from the table the HTML renderer already uses
 * (`markdown-it-emoji` full set), so the editor shows what export shows.
 * MarkText and files.md both render shortcodes in the editor and complete
 * them after `:`; Noema inserts the character itself, which reads the same
 * in every renderer.
 */

import emojiTable from "markdown-it-emoji/lib/data/full.mjs";

const EMOJI = emojiTable as Record<string, string>;
const NAMES = Object.keys(EMOJI);
const SHORTCODE_RE = /:([a-z0-9_+-]+):/g;

export function emojiForShortcode(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(EMOJI, name) ? EMOJI[name]! : null;
}

export type EmojiShortcodeMatch = { from: number; to: number; name: string; emoji: string };

/** Known shortcodes in TEXT; positions are offset by BASE. */
export function scanEmojiShortcodes(text: string, base = 0): EmojiShortcodeMatch[] {
  if (!text.includes(":")) return [];
  const matches: EmojiShortcodeMatch[] = [];
  SHORTCODE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SHORTCODE_RE.exec(text)) !== null) {
    const emoji = emojiForShortcode(match[1]!);
    if (!emoji) {
      // `:a:b:` — the closing colon may open the next shortcode.
      SHORTCODE_RE.lastIndex = match.index + match[0].length - 1;
      continue;
    }
    matches.push({ from: base + match.index, to: base + match.index + match[0].length, name: match[1]!, emoji });
  }
  return matches;
}

export type EmojiCompletionContext = { query: string; deleteBefore: number };

/**
 * A `:query` being typed: the colon starts the text or follows a space or
 * opening punctuation, and at least two name characters follow. Requiring
 * two keeps `a:b`, times (`10:3`) and `http:` from opening the menu.
 */
export function emojiCompletionContext(before: string): EmojiCompletionContext | null {
  const match = /(?:^|[\s(\[{"'“‘（【「])(:([a-z0-9_+-]{2,40}))$/i.exec(before);
  if (!match) return null;
  return { query: match[2]!.toLowerCase(), deleteBefore: match[1]!.length };
}

/** An exact name, then names starting with QUERY (shortest first), then names containing it. */
export function emojiCompletions(query: string, limit = 12): Array<{ name: string; emoji: string }> {
  const q = query.toLowerCase();
  const prefix: string[] = [];
  const inner: string[] = [];
  for (const name of NAMES) {
    if (name.startsWith(q)) prefix.push(name);
    else if (inner.length < limit && name.includes(q)) inner.push(name);
  }
  prefix.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return [...prefix, ...inner].slice(0, limit).map((name) => ({ name, emoji: EMOJI[name]! }));
}
