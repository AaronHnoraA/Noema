/**
 * CJK-friendly emphasis flanking for the editor (Lezer) and HTML (markdown-it).
 *
 * CommonMark §6.2 counts only whitespace and punctuation as delimiter-run
 * boundaries. CJK ideographs, kana and Hangul are letters, and CJK text has no
 * spaces between words, so a delimiter run between an ideograph and CJK
 * punctuation is never left- or right-flanking: `**（注）**说明`,
 * `前面**加粗。**后面` and `中文**“加粗”**中文` all stay literal asterisks.
 * Typora, MarkText (`muya/src/utils/marked/extensions/cjkEmStrong.ts`),
 * markdownlint and Joplin let CJK characters count as a boundary.
 *
 * The widening here is strictly additive: a run may open (close) when either
 * the CommonMark rule or the CJK-widened rule allows it, so text the spec
 * already parses — every Latin input — parses exactly as before. Treating CJK
 * as punctuation alone would not be additive: `a**中文**` would lose its
 * opener.
 */

import { markdownLanguage } from "@codemirror/lang-markdown";
import type { DelimiterType, InlineContext, MarkdownConfig, MarkdownParser } from "@lezer/markdown";
import type MarkdownIt from "markdown-it";

const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /^\s$/u;
// Kana, CJK Extension A, CJK Unified, CJK Compatibility, Hangul syllables,
// halfwidth katakana and CJK Extension B: the ranges MarkText widens.
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯ｦ-ﾝ\u{20000}-\u{2A6DF}]/u;

export type EmphasisMarker = "*" | "_" | "~";
export type Flanking = { open: boolean; close: boolean };

export function isCjkCharacter(char: string): boolean {
  return char.length > 0 && CJK.test(char);
}

/**
 * Whether a delimiter run of MARKER between BEFORE and AFTER (each one code
 * point, or "" at a line edge) can open or close, by the CommonMark rule or,
 * with WIDEN, with CJK characters counted as punctuation.
 */
export function emphasisFlanking(before: string, after: string, marker: EmphasisMarker, widen: boolean): Flanking {
  const sBefore = before === "" || WHITESPACE.test(before);
  const sAfter = after === "" || WHITESPACE.test(after);
  const pBefore = PUNCTUATION.test(before) || (widen && isCjkCharacter(before));
  const pAfter = PUNCTUATION.test(after) || (widen && isCjkCharacter(after));
  const left = !sAfter && (!pAfter || sBefore || pBefore);
  const right = !sBefore && (!pBefore || sAfter || pAfter);
  if (marker === "_") {
    return { open: left && (!right || pBefore), close: right && (!left || pAfter) };
  }
  return { open: left, close: right };
}

/** The additive union of the CommonMark and CJK-widened rules. */
export function cjkFriendlyFlanking(before: string, after: string, marker: EmphasisMarker): Flanking {
  const standard = emphasisFlanking(before, after, marker, false);
  const widened = emphasisFlanking(before, after, marker, true);
  return { open: standard.open || widened.open, close: standard.close || widened.close };
}

/** The code point ending just before FROM in TEXT ("" at the start). */
function codePointBefore(text: string, from: number): string {
  if (from <= 0) return "";
  const low = text.charCodeAt(from - 1);
  if (low >= 0xdc00 && low <= 0xdfff && from >= 2) {
    const high = text.charCodeAt(from - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(from - 2, from);
  }
  return text.slice(from - 1, from);
}

/** The code point starting at FROM in TEXT ("" at the end). */
function codePointAt(text: string, from: number): string {
  if (from >= text.length) return "";
  const point = text.codePointAt(from) ?? 0;
  return String.fromCodePoint(point);
}

// ---------------------------------------------------------------------------
// Lezer: run before the stock parsers and add the same delimiter types with
// the widened flags, only where widening changes the outcome.
// ---------------------------------------------------------------------------

/**
 * The stock emphasis and strikethrough delimiter types. Lezer keeps them
 * private and matches openers to closers by type identity, so they are read
 * once from a probe parse through the public `getDelimiterAt`.
 */
function captureDelimiterTypes(): Partial<Record<EmphasisMarker, DelimiterType>> {
  const types: Partial<Record<EmphasisMarker, DelimiterType>> = {};
  const probe = (markdownLanguage.parser as MarkdownParser).configure({
    parseInline: [{
      name: "NoemaCaptureEmphasisDelimiters",
      after: "Strikethrough",
      parse(cx: InlineContext) {
        for (let index = 0; index < 32; index++) {
          const delimiter = cx.getDelimiterAt(index);
          if (!delimiter) continue;
          const char = cx.slice(delimiter.from, delimiter.from + 1);
          if (char === "*" || char === "_" || char === "~") types[char] ??= delimiter.type;
        }
        return -1;
      },
    }],
  });
  probe.parse("*a* _b_ ~~c~~ x");
  return types;
}

const delimiterTypes = captureDelimiterTypes();

function lezerFlanking(cx: InlineContext, from: number, to: number, marker: EmphasisMarker): Flanking | null {
  const before = codePointBefore(cx.slice(Math.max(cx.offset, from - 2), from), Math.min(2, from - cx.offset));
  const after = codePointAt(cx.slice(to, Math.min(cx.end, to + 2)), 0);
  if (!isCjkCharacter(before) && !isCjkCharacter(after)) return null;
  const standard = emphasisFlanking(before, after, marker, false);
  const friendly = cjkFriendlyFlanking(before, after, marker);
  return friendly.open === standard.open && friendly.close === standard.close ? null : friendly;
}

export const cjkEmphasisMarkdownExtension: MarkdownConfig = {
  parseInline: [
    {
      name: "NoemaCjkEmphasis",
      before: "Emphasis",
      parse(cx, next, start) {
        if (next !== 42 && next !== 95) return -1;
        const marker = next === 42 ? "*" : "_";
        const type = delimiterTypes[marker];
        if (!type) return -1;
        let end = start + 1;
        while (cx.char(end) === next) end++;
        const flanking = lezerFlanking(cx, start, end, marker);
        return flanking ? cx.addDelimiter(type, start, end, flanking.open, flanking.close) : -1;
      },
    },
    {
      name: "NoemaCjkStrikethrough",
      before: "Strikethrough",
      parse(cx, next, start) {
        if (next !== 126 || cx.char(start + 1) !== 126 || cx.char(start + 2) === 126) return -1;
        const type = delimiterTypes["~"];
        if (!type) return -1;
        const flanking = lezerFlanking(cx, start, start + 2, "~");
        return flanking ? cx.addDelimiter(type, start, start + 2, flanking.open, flanking.close) : -1;
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// markdown-it: widen `scanDelims` on this instance's inline state only.
// ---------------------------------------------------------------------------

export function markdownItCjkEmphasis(md: MarkdownIt): void {
  const Base = md.inline.State;
  class CjkFriendlyState extends Base {
    override scanDelims(start: number, canSplitWord: boolean): { can_open: boolean; can_close: boolean; length: number } {
      const standard = super.scanDelims(start, canSplitWord);
      const before = codePointBefore(this.src, start);
      const after = start + standard.length < this.posMax ? codePointAt(this.src, start + standard.length) : "";
      if (!isCjkCharacter(before) && !isCjkCharacter(after)) return standard;
      const friendly = cjkFriendlyFlanking(before, after, canSplitWord ? "*" : "_");
      return {
        can_open: standard.can_open || friendly.open,
        can_close: standard.can_close || friendly.close,
        length: standard.length,
      };
    }
  }
  md.inline.State = CjkFriendlyState;
}
