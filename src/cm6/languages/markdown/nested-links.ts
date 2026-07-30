/**
 * Additive parser for inline links/images whose labels contain balanced,
 * unescaped brackets, for example `[outer [inner] text](target.md)`.
 *
 * The stock Lezer parser eagerly resolves `[inner]` as a shortcut reference,
 * which prevents the enclosing link from forming.  The previous workaround
 * replaced `LinkEnd` and mutated Lezer's delimiter stack.  That changed the
 * resolution order of unrelated `_`/`*` delimiters and could turn plain text
 * such as `_[[_]` into emphasis.
 *
 * This parser runs before the stock Link parser and only claims a range when
 * it can prove that the entire nested-label link (including its destination)
 * is complete. All other input falls through untouched to Lezer's built-in
 * parsers, so malformed/plain bracket text retains stock semantics.
 */

import {
  InlineContext,
  type Element,
  type MarkdownConfig,
} from "@lezer/markdown";

type Destination = {
  end: number;
  children: Element[];
};

function isSpaceCode(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13;
}

function skipCodeSpan(cx: InlineContext, start: number): number {
  let openTo = start + 1;
  while (cx.char(openTo) === 96 /* ` */) openTo++;
  const size = openTo - start;
  for (let pos = openTo; pos < cx.end;) {
    if (cx.char(pos) !== 96) {
      pos++;
      continue;
    }
    let closeTo = pos + 1;
    while (cx.char(closeTo) === 96) closeTo++;
    if (closeTo - pos === size) return closeTo;
    pos = closeTo;
  }
  return start + 1;
}

const nestedLabelCache = new WeakMap<InlineContext, Map<number, number>>();

function nestedLabelCloses(cx: InlineContext): Map<number, number> {
  const cached = nestedLabelCache.get(cx);
  if (cached) return cached;
  const closes = new Map<number, number>();
  const stack: Array<{ open: number; nested: boolean }> = [];
  for (let pos = cx.offset; pos < cx.end; pos++) {
    const ch = cx.char(pos);
    if (ch === 92 /* \\ */) {
      pos++;
      continue;
    }
    if (ch === 96 /* ` */) {
      pos = skipCodeSpan(cx, pos) - 1;
      continue;
    }
    if (ch === 91 /* [ */) {
      if (stack.length) stack[stack.length - 1]!.nested = true;
      stack.push({ open: pos, nested: false });
      continue;
    }
    if (ch !== 93 /* ] */) continue;
    const entry = stack.pop();
    if (entry?.nested) closes.set(entry.open, pos);
  }
  nestedLabelCache.set(cx, closes);
  return closes;
}

function nestedLabelClose(cx: InlineContext, open: number): number {
  return nestedLabelCloses(cx).get(open) ?? -1;
}

const balancedLabelCache = new WeakMap<InlineContext, Map<number, number>>();

function balancedLabelCloses(cx: InlineContext): Map<number, number> {
  const cached = balancedLabelCache.get(cx);
  if (cached) return cached;
  const closes = new Map<number, number>();
  const stack: number[] = [];
  for (let pos = cx.offset; pos < cx.end; pos++) {
    const ch = cx.char(pos);
    if (ch === 92 /* \\ */) {
      pos++;
      continue;
    }
    if (ch === 96 /* ` */) {
      pos = skipCodeSpan(cx, pos) - 1;
      continue;
    }
    if (ch === 91 /* [ */) stack.push(pos);
    else if (ch === 93 /* ] */) {
      const open = stack.pop();
      if (open != null) closes.set(open, pos);
    }
  }
  balancedLabelCache.set(cx, closes);
  return closes;
}

function balancedLabelClose(cx: InlineContext, open: number): number {
  return balancedLabelCloses(cx).get(open) ?? -1;
}

function parseUrl(cx: InlineContext, start: number): { from: number; to: number } | null {
  if (cx.char(start) === 60 /* < */) {
    for (let pos = start + 1; pos < cx.end; pos++) {
      const ch = cx.char(pos);
      if (ch === 62 /* > */) return { from: start, to: pos + 1 };
      if (ch === 60 || ch === 10) return null;
    }
    return null;
  }

  let depth = 0;
  let escaped = false;
  let pos = start;
  for (; pos < cx.end; pos++) {
    const ch = cx.char(pos);
    if (isSpaceCode(ch)) break;
    if (escaped) {
      escaped = false;
    } else if (ch === 92 /* \\ */) {
      escaped = true;
    } else if (ch === 40 /* ( */) {
      depth++;
    } else if (ch === 41 /* ) */) {
      if (depth === 0) break;
      depth--;
    }
  }
  return pos > start ? { from: start, to: pos } : null;
}

function parseTitle(cx: InlineContext, start: number): { from: number; to: number } | null {
  const open = cx.char(start);
  if (open !== 34 && open !== 39 && open !== 40 /* " ' ( */) return null;
  const close = open === 40 ? 41 : open;
  let escaped = false;
  for (let pos = start + 1; pos < cx.end; pos++) {
    const ch = cx.char(pos);
    if (escaped) escaped = false;
    else if (ch === 92) escaped = true;
    else if (ch === close) return { from: start, to: pos + 1 };
  }
  return null;
}

function parseReferenceLabel(cx: InlineContext, start: number): { from: number; to: number } | null {
  if (cx.char(start) !== 91 /* [ */) return null;
  let escaped = false;
  for (let pos = start + 1; pos < Math.min(cx.end, start + 1000); pos++) {
    const ch = cx.char(pos);
    if (escaped) escaped = false;
    else if (ch === 92) escaped = true;
    else if (ch === 91 || ch === 10) return null;
    else if (ch === 93) return { from: start, to: pos + 1 };
  }
  return null;
}

function parseDestination(cx: InlineContext, afterLabel: number): Destination | null {
  const next = cx.char(afterLabel);
  if (next === 91 /* [ */) {
    const label = parseReferenceLabel(cx, afterLabel);
    return label
      ? { end: label.to, children: [cx.elt("LinkLabel", label.from, label.to)] }
      : null;
  }
  if (next !== 40 /* ( */) return null;

  let pos = cx.skipSpace(afterLabel + 1);
  const url = parseUrl(cx, pos);
  if (url) pos = cx.skipSpace(url.to);

  let title: { from: number; to: number } | null = null;
  if (url && pos !== url.to) {
    title = parseTitle(cx, pos);
    if (!title) return null;
    pos = cx.skipSpace(title.to);
  }
  if (cx.char(pos) !== 41 /* ) */) return null;

  const children: Element[] = [cx.elt("LinkMark", afterLabel, afterLabel + 1)];
  if (url) children.push(cx.elt("URL", url.from, url.to));
  if (title) children.push(cx.elt("LinkTitle", title.from, title.to));
  children.push(cx.elt("LinkMark", pos, pos + 1));
  return { end: pos + 1, children };
}

function labelChildrenWithoutNestedLinks(cx: InlineContext, from: number, to: number): Element[] {
  const source = cx.slice(from, to);
  let escaped = false;
  let masked = "";
  for (const ch of source) {
    if (escaped) {
      masked += ch;
      escaped = false;
    } else if (ch === "\\") {
      masked += ch;
      escaped = true;
    } else {
      // A private-use character is neither punctuation nor whitespace, so it
      // cannot start another Link parser. It is one UTF-16 code unit, keeping
      // every child offset aligned with the original source.
      masked += ch === "[" || ch === "]" ? "\uE000" : ch;
    }
  }
  return cx.parser.parseInline(masked, from);
}

function parseCompleteNestedLink(cx: InlineContext, next: number, start: number): number {
  const isImage = next === 33 /* ! */ && cx.char(start + 1) === 91 /* [ */;
  if (!isImage && next !== 91 /* [ */) return -1;
  const open = start + (isImage ? 1 : 0);
  const close = nestedLabelClose(cx, open);
  if (close < 0) return -1;

  const destination = parseDestination(cx, close + 1);
  if (!destination) return -1;

  const children: Element[] = [
    cx.elt("LinkMark", start, open + 1),
    ...labelChildrenWithoutNestedLinks(cx, open + 1, close),
    cx.elt("LinkMark", close, close + 1),
    ...destination.children,
  ];
  return cx.addElement(cx.elt(isImage ? "Image" : "Link", start, destination.end, children));
}

function parseSpacedFragmentLink(cx: InlineContext, next: number, start: number): number {
  if (next !== 91 /* [ */) return -1;
  const close = balancedLabelClose(cx, start);
  if (close < 0 || cx.char(close + 1) !== 40 /* ( */) return -1;

  let hrefFrom = close + 2;
  while (cx.char(hrefFrom) === 32 || cx.char(hrefFrom) === 9) hrefFrom++;
  if (cx.char(hrefFrom) !== 35 /* # */) return -1;

  let escaped = false;
  let depth = 0;
  let destinationClose = -1;
  for (let pos = hrefFrom; pos < cx.end; pos++) {
    const ch = cx.char(pos);
    if (ch === 10 || ch === 13) return -1;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === 92 /* \\ */) {
      escaped = true;
      continue;
    }
    if (ch === 40 /* ( */) depth++;
    else if (ch === 41 /* ) */) {
      if (depth === 0) {
        destinationClose = pos;
        break;
      }
      depth--;
    }
  }
  if (destinationClose < 0) return -1;

  let hrefTo = destinationClose;
  while (hrefTo > hrefFrom && isSpaceCode(cx.char(hrefTo - 1))) hrefTo--;
  const href = cx.slice(hrefFrom, hrefTo);
  if (!/\s/u.test(href)) return -1;

  const children: Element[] = [
    cx.elt("LinkMark", start, start + 1),
    ...labelChildrenWithoutNestedLinks(cx, start + 1, close),
    cx.elt("LinkMark", close, close + 1),
    cx.elt("LinkMark", close + 1, close + 2),
    cx.elt("URL", hrefFrom, hrefTo),
    cx.elt("LinkMark", destinationClose, destinationClose + 1),
  ];
  return cx.addElement(cx.elt("Link", start, destinationClose + 1, children));
}

export const nestingAwareLinkExtension: MarkdownConfig = {
  parseInline: [
    {
      name: "CompleteNestedLink",
      before: "Link",
      parse: parseCompleteNestedLink,
    },
    {
      name: "SpacedFragmentLink",
      before: "Link",
      parse: parseSpacedFragmentLink,
    },
  ],
};
