/**
 * Typora-style live preview for inline and block Markdown syntax.
 *
 * Phase 2 — Inline marks: EmphasisMark, CodeMark, StrikethroughMark, LinkMark/URL
 * Phase 3 — Block marks: HeaderMark (heading), QuoteMark (blockquote), ListMark
 * Phase 6 — HTML comments (CommentBlock / Comment), Escape backslash, Autolink brackets
 * Phase 7 — Raw HTML: HTMLBlock (block-level), HTMLTag (inline mid-prose)
 *
 * Strategy:
 *   • Inline marks: cursor OUTSIDE parent span → syntax-hidden (font-size:0)
 *                   cursor INSIDE  parent span → syntax-hint   (gray)
 *   • Block marks: cursor on SAME LINE → syntax-hint
 *                  cursor on OTHER line → syntax-hidden
 *   • ListMark: always visible, just adds a `.list-marker` class for styling
 *   • HTMLBlock: block widget (Decoration.replace) — hidden when cursor outside,
 *                source revealed when cursor moves inside the block
 *   • HTMLTag (inline): replace widget — hidden when cursor outside the tag run,
 *                       source revealed when cursor is inside
 *
 * Lezer markdown node names used (from @lezer/markdown / @codemirror/lang-markdown):
 *   EmphasisMark       — * / _ delimiting Emphasis and StrongEmphasis
 *   CodeMark           — ` delimiting InlineCode
 *   StrikethroughMark  — ~~ delimiting Strikethrough (GFM)
 *   LinkMark           — [ and ] in Link / Image
 *   URL                — (href) in Link / Image
 *   HeaderMark         — # prefix in ATX headings
 *   QuoteMark          — > prefix in Blockquote
 *   ListMark           — - / * / + / 1. in list items
 *   CommentBlock       — <!-- ... --> HTML comment block
 *   Comment            — <!-- ... --> HTML comment inline
 *   Escape             — \ before an escaped character
 *   Autolink           — <url> auto-link (< and > folded when cursor outside)
 *   HTMLBlock          — block-level raw HTML (e.g. <table>…</table> on its own lines)
 *   HTMLTag            — inline raw HTML tag (e.g. <sub>, <br>)
 *
 * CSS classes .syntax-hidden / .syntax-hint are defined in widgets.css under
 * the .cm-editor root.
 */

import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { MeasuredWidget } from "./extensions/visual/widgets/measured-widget.ts";
import { shortHash } from "./extensions/visual/widgets/measured-observer.ts";
import { StateField, type ChangeSet, type EditorState, type Text } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { getBlockMathRanges, mergeOverlappingRanges, rangeInsideAny, rangeOverlapsAny } from "./math-ranges.ts";
import { scanInlineMathRanges } from "../inline-math.ts";
import { sanitizeEmbeddedHtml } from "../sanitize-html.ts";
import { renderMarkdownHTML } from "../render-html.ts";
import {
  applyLayoutAttrs,
  layoutFromAttrs,
  readLayoutAttrsLine,
  type LayoutAttrs,
} from "../layout-attrs.ts";
import { tocIndexFromState } from "./toc-index.ts";
import { hasViewportDecorationRefresh, refreshViewportDecorations, viewportDecorationRefreshRanges } from "./viewport-refresh.ts";
import { getFencedCodeRanges } from "./code-ranges.ts";
import { orgEnvContextForRange } from "./extensions/visual/widgets/block-extras.ts";
import { markdownLinkDestination } from "../markdown-link.ts";
import {
  firstChangedLine,
  viewportDeltaRanges,
} from "./utils/tree-operations/change-ranges.ts";
import {
  isPointerSelecting,
  updateHasPointerSelectionEffect,
} from "./extensions/visual/selection.ts";
import { scanWikiLinks } from "../../shared/wiki-link.mjs";
import {
  isCoalescedVisualTyping,
  isCoalescedVisualTypingTransaction,
} from "./extensions/visual/typing-burst.ts";

// ---------------------------------------------------------------------------
// Asset URL helpers for raw HTML embedded in the live preview.
// Markdown images go through renderMarkdownHTML → md.renderer.rules.image →
// AaronnoteResolveAssetUrl automatically.  Raw <img> tags inside HTML
// inline/block widgets bypass that path, so we patch their src attributes
// explicitly after DOMPurify runs.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    AaronnoteResolveAssetUrl?: (src: string) => string;
  }
}

/** Apply AaronnoteResolveAssetUrl to every <img src> inside ROOT that looks like a local path. */
function resolveHtmlImgSrcs(root: HTMLElement): void {
  const resolver = window.AaronnoteResolveAssetUrl;
  if (!resolver) return;
  for (const img of root.querySelectorAll<HTMLImageElement>("img[src]")) {
    const src = img.getAttribute("src");
    if (!src || /^(?:data:|https?:|blob:|#)/i.test(src)) continue;
    img.setAttribute("src", resolver(src));
  }
}

// ---------------------------------------------------------------------------
// Node name sets
// ---------------------------------------------------------------------------

/** Inline delimiters: fold based on cursor inside/outside parent SPAN */
const INLINE_MARK_NODES = new Set([
  "EmphasisMark",      // * / _
  "CodeMark",          // `
  "StrikethroughMark", // ~~
]);

/** Link delimiters: fold based on cursor inside/outside Link/Image node */
const LINK_MARK_NODES = new Set([
  "LinkMark", // [ and ]
  "URL",      // (href)
]);

/** Block marks: fold based on cursor on same LINE */
const BLOCK_MARK_NODES = new Set([
  "QuoteMark",  // >
]);

const CJK_TEXT_RE = /[\u2E80-\u2EFF\u3000-\u303F\u31C0-\u31EF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]+/g;
const JUPYTER_LINK_RE = /\[([^\]\n]+)\]\(((?:file:(?:\/\/)?|\.{1,2}\/|\/|~\/)?[^)\n]*?\.ipynb(?:[@#][^)]+)?)\)/gi;
type CjkLineRanges = Array<{ relFrom: number; relTo: number }>;
type CjkLineCache = Map<number, { text: string; ranges: CjkLineRanges }>;
const cjkLineCacheLimit = 512;

function combineRanges(
  ...lists: Array<readonly { from: number; to: number }[]>
): Array<{ from: number; to: number }> {
  return mergeOverlappingRanges(lists.flatMap((list) => Array.from(list)));
}

function linkHrefFromSpan(state: EditorState, from: number, to: number): string {
  let href = "";
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (href) return false;
      if (node.name !== "URL") return;
      href = markdownLinkDestination(state.doc.sliceString(node.from, node.to));
      return false;
    },
  });
  return href;
}

function isRoamCoreHref(href: string): boolean {
  const raw = String(href || "").trim();
  if (!raw) return false;
  if (/^roam:\/\//i.test(raw)) return true;
  if (/^[A-Za-z][\w+.-]*:/i.test(raw)) return false;
  if (raw.startsWith("#") || raw.startsWith("@")) return false;
  if (/\.ipynb/i.test(raw)) return false;
  return raw.includes("#") || raw.includes("@");
}

function isJupyterHref(href: string): boolean {
  const raw = String(href || "").trim();
  if (!raw) return false;
  if (/^[A-Za-z][\w+.-]*:/i.test(raw) && !/^file:/i.test(raw)) return false;
  return /\.ipynb(?:[?@#]|$)/i.test(raw);
}

// ---------------------------------------------------------------------------
// Decoration builder
// ---------------------------------------------------------------------------

type LivePreviewToken =
  | { kind: "span"; from: number; to: number; spanFrom: number; spanTo: number; cls: string }
  | { kind: "delimiter"; from: number; to: number; spanFrom: number; spanTo: number }
  | { kind: "link-delimiter"; from: number; to: number; spanFrom: number; spanTo: number; linkClass: string }
  | { kind: "block-mark"; from: number; to: number; line: number }
  | { kind: "autolink"; from: number; to: number }
  | { kind: "static"; from: number; to: number; cls: string }
  | { kind: "html-inline"; from: number; to: number; source: string };

function mapLivePreviewTokens(tokens: readonly LivePreviewToken[], changes: ChangeSet): LivePreviewToken[] {
  return tokens.map((token) => {
    const mapped = {
      ...token,
      from: changes.mapPos(token.from, -1),
      to: changes.mapPos(token.to, 1),
    };
    if (token.kind === "span" || token.kind === "delimiter" || token.kind === "link-delimiter") {
      return {
        ...mapped,
        spanFrom: changes.mapPos(token.spanFrom, -1),
        spanTo: changes.mapPos(token.spanTo, 1),
      } as LivePreviewToken;
    }
    return mapped as LivePreviewToken;
  });
}

function selectionIntersectsSpan(sel: { from: number; to: number; empty: boolean }, from: number, to: number): boolean {
  return sel.empty ? sel.from > from && sel.from < to : sel.from < to && sel.to > from;
}

function escapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let pos = index - 1; pos >= 0 && text[pos] === "\\"; pos--) slashes++;
  return slashes % 2 === 1;
}

function addHighlightTokens(
  tokens: LivePreviewToken[],
  doc: Text,
  ranges: readonly { from: number; to: number }[],
  excludedRanges: readonly { from: number; to: number }[],
  codeRanges: readonly { from: number; to: number }[],
): void {
  const visited = new Set<number>();
  for (const { from: visibleFrom, to: visibleTo } of ranges) {
    const firstLine = doc.lineAt(visibleFrom).number;
    const lastLine = doc.lineAt(Math.min(toVisibleDocPos(doc, visibleTo))).number;
    for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
      if (visited.has(lineNum)) continue;
      visited.add(lineNum);
      const line = doc.line(lineNum);
      let open = 0;
      while ((open = line.text.indexOf("==", open)) >= 0) {
        if (
          escapedAt(line.text, open)
          || line.text[open + 2] === "="
          || rangeOverlapsAny(line.from + open, line.from + open + 2, codeRanges)
        ) {
          open += 2;
          continue;
        }
        const close = line.text.indexOf("==", open + 2);
        if (close < 0) break;
        if (close === open + 2 || escapedAt(line.text, close) || line.text[close + 2] === "=") {
          open = close + 2;
          continue;
        }
        const from = line.from + open;
        const to = line.from + close + 2;
        if (!rangeOverlapsAny(from, to, excludedRanges) && !rangeOverlapsAny(from, to, codeRanges)) {
          tokens.push({ kind: "span", from, to, spanFrom: from, spanTo: to, cls: "cm-highlight" });
          tokens.push({ kind: "delimiter", from, to: from + 2, spanFrom: from, spanTo: to });
          tokens.push({ kind: "delimiter", from: to - 2, to, spanFrom: from, spanTo: to });
        }
        open = close + 2;
      }
    }
  }
}

function toVisibleDocPos(doc: Text, pos: number): number {
  return Math.max(0, Math.min(pos, doc.length));
}

function collectLivePreviewTokens(
  view: EditorView,
  ranges: readonly { from: number; to: number }[] = view.visibleRanges,
  cjkLineCache?: CjkLineCache,
): LivePreviewToken[] {
  const tokens: LivePreviewToken[] = [];
  const doc = view.state.doc;
  const blockMathRanges = getBlockMathRanges(view.state);
  const inlineMathRanges = ranges.flatMap(({ from, to }) =>
    scanInlineMathRanges(doc.sliceString(from, to), from));
  const excludedRanges = combineRanges(blockMathRanges, inlineMathRanges);
  const codeRanges: Array<{ from: number; to: number }> = [];

  // Headings come from the syntax tree (never inside code), so they can run
  // before the main walk. CJK/Jupyter-link scanners are regex-based and must skip
  // code spans, so they run AFTER the walk below has populated `codeRanges` —
  // this reuses the same walk rather than adding a second pass (perf-neutral).
  addHeadingMarkTokens(tokens, view.state, ranges, excludedRanges);

  for (const { from, to } of ranges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (rangeInsideAny(node.from, node.to, excludedRanges)) return false;
        if (node.name === "InlineCode" || node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "IndentedCode") {
          codeRanges.push({ from: node.from, to: node.to });
        }

        // ── Span styling: bold / italic / code / strike ────────────────────
        // Applied to the whole parent span so the visible content gets
        // the right visual treatment even when delimiters are hidden.
        if (node.name === "StrongEmphasis") {
          tokens.push({ kind: "span", from: node.from, to: node.to, spanFrom: node.from, spanTo: node.to, cls: "cm-strong" });
        } else if (node.name === "Emphasis") {
          tokens.push({ kind: "span", from: node.from, to: node.to, spanFrom: node.from, spanTo: node.to, cls: "cm-em" });
        } else if (node.name === "InlineCode") {
          tokens.push({ kind: "span", from: node.from, to: node.to, spanFrom: node.from, spanTo: node.to, cls: "cm-inline-code" });
        } else if (node.name === "Strikethrough") {
          tokens.push({ kind: "span", from: node.from, to: node.to, spanFrom: node.from, spanTo: node.to, cls: "cm-strike" });
        }

        // ── Inline: emphasis / code / strikethrough ────────────────────────
        if (INLINE_MARK_NODES.has(node.name)) {
          const parent = node.node.parent;
          tokens.push({
            kind: "delimiter",
            from: node.from,
            to: node.to,
            spanFrom: parent?.from ?? node.from,
            spanTo: parent?.to ?? node.to,
          });
          return false; // no children to visit
        }

        // ── Link: [ ] and (url) fold; whole span gets link colour ────────
        if (LINK_MARK_NODES.has(node.name)) {
          let p = node.node.parent;
          while (p && p.name !== "Link" && p.name !== "Image") p = p.parent;

          // If the parent walk reached null the mark is inside a LinkReference
          // definition line (`[id]: url "title"`). Hiding it makes the whole
          // line look blank after reload (Lezer classifies the line as
          // LinkReference instead of Paragraph). Emit syntax-hint so the
          // definition is always visible but visually dimmed — Typora style.
          if (!p) {
            tokens.push({ kind: "static", from: node.from, to: node.to, cls: "syntax-hint" });
            return false;
          }

          const spanFrom = p.from;
          const spanTo = p.to;
          // `[[title]]` is intentionally plain text. Lezer treats the inner
          // `[title]` as a shortcut-reference Link even without a definition;
          // suppress that stock false positive now that Noema no longer
          // supports MediaWiki-style links.
          if (p.name === "Link"
            && spanFrom > 0 && spanTo < doc.length
            && doc.sliceString(spanFrom - 1, spanFrom) === "["
            && doc.sliceString(spanTo, spanTo + 1) === "]") {
            return false;
          }
          const href = p.name === "Link" ? linkHrefFromSpan(view.state, spanFrom, spanTo) : "";

          // Empty-text anchor link [](#slug) — show the URL token as clickable text
          // instead of hiding it, so the link is visible and clickable.
          if (p.name === "Link" && node.name === "URL"
            && view.state.doc.sliceString(p.from, p.from + 2) === "[]") {
            tokens.push({ kind: "static", from: node.from, to: node.to, cls: "cm-link-text cm-empty-anchor-text" });
            return false;
          }

          tokens.push({
            kind: "link-delimiter",
            from: node.from,
            to: node.to,
            spanFrom,
            spanTo,
            linkClass: isJupyterHref(href)
              ? "cm-link-text cm-jupyter-link-text"
              : isRoamCoreHref(href) ? "cm-link-text cm-roam-link-text" : "cm-link-text",
          });
          return false;
        }

        // ── Blockquote mark — line-aware ───────────────────────────────────
        if (BLOCK_MARK_NODES.has(node.name)) {
          tokens.push({ kind: "block-mark", from: node.from, to: node.to, line: doc.lineAt(node.from).number });
          return false;
        }

        // ── ListMark: always visible, styled ──────────────────────────────
        if (node.name === "ListMark") {
          // Don't hide list markers — Typora shows them. Just add a class
          // so CSS can style them (bullet, number). Also include trailing space.
          let markTo = node.to;
          if (markTo < doc.length && doc.sliceString(markTo, markTo + 1) === " ") {
            markTo += 1;
          }
          tokens.push({ kind: "static", from: node.from, to: markTo, cls: "list-marker" });
          return false;
        }

        // ── HTML comment: dim the whole comment ───────────────────────────
        if (node.name === "CommentBlock" || node.name === "Comment") {
          tokens.push({ kind: "static", from: node.from, to: node.to, cls: "syntax-hint" });
          return false;
        }

        // ── Escape backslash: hidden when cursor is outside the escape,
        // dimmed (not fully hidden) while the cursor sits inside it.
        //
        // Never fold Noema's TeX delimiters. During typing and formula
        // cut/move/paste, a closing `\]` may temporarily share a line with
        // prose and stop qualifying as block math. Lezer then reports it as a
        // Markdown Escape; hiding its slash makes source appear to have been
        // deleted precisely while the structure is being repaired.
        if (node.name === "Escape") {
          const source = doc.sliceString(node.from, node.to);
          if (source === "\\[" || source === "\\]" || source === "\\(" || source === "\\)") {
            return false;
          }
          tokens.push({ kind: "delimiter", from: node.from, to: node.from + 1, spanFrom: node.from, spanTo: node.to });
          return false;
        }

        // ── Autolink: fold < > brackets when cursor outside ───────────────
        if (node.name === "Autolink") {
          tokens.push({ kind: "autolink", from: node.from, to: node.to });
          return false;
        }

        // ── Inline HTML tag: replace with rendered DOM when cursor outside ─
        if (node.name === "HTMLTag") {
          const source = doc.sliceString(node.from, node.to);
          tokens.push({ kind: "html-inline", from: node.from, to: node.to, source });
          return false;
        }
      },
    });
  }
  const allExcluded = combineRanges(excludedRanges, codeRanges);
  addCjkTextTokens(tokens, doc, ranges, allExcluded, cjkLineCache);
  addWikiLinkTokens(tokens, doc, ranges, allExcluded);
  addJupyterLinkTokens(tokens, doc, ranges, allExcluded);
  addHighlightTokens(tokens, doc, ranges, allExcluded, codeRanges);

  return tokens;
}

function addWikiLinkTokens(
  tokens: LivePreviewToken[],
  doc: Text,
  ranges: readonly { from: number; to: number }[],
  excludedRanges: readonly { from: number; to: number }[],
): void {
  const visited = new Set<number>();
  for (const range of ranges) {
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(Math.min(range.to, doc.length)).number;
    for (let lineNumber = first; lineNumber <= last; lineNumber++) {
      if (visited.has(lineNumber)) continue;
      visited.add(lineNumber);
      const line = doc.line(lineNumber);
      for (const link of scanWikiLinks(line.text, line.from)) {
        if (rangeOverlapsAny(link.from, link.to, excludedRanges)) continue;
        const linkClass = "cm-link-text cm-internal-link-text cm-roam-link-text";
        tokens.push({ kind: "span", from: link.labelFrom, to: link.labelTo, spanFrom: link.from, spanTo: link.to, cls: linkClass });
        tokens.push({ kind: "delimiter", from: link.from, to: link.from + 2, spanFrom: link.from, spanTo: link.to });
        tokens.push({ kind: "delimiter", from: link.to - 2, to: link.to, spanFrom: link.from, spanTo: link.to });
        if (link.explicitLabel) {
          tokens.push({ kind: "delimiter", from: link.from + 2, to: link.labelFrom, spanFrom: link.from, spanTo: link.to });
        }
      }
    }
  }
}

function buildDecorations(view: EditorView, tokens = collectLivePreviewTokens(view)): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  const cursorLine = doc.lineAt(sel.from).number;
  // Every delimiter of a link (`[`, `]`, `(`, the URL, `)`) carries the same
  // whole-span class, so styling the span per delimiter wrapped each link in
  // five identical nested spans. Harmless for `color`, but the translucent
  // hover background of an internal link stacked five deep — and it is five
  // times the decoration and DOM work on every selection change.
  const styledLinkSpans = new Set<string>();

  for (const token of tokens) {
    switch (token.kind) {
      case "span": {
        const inSpan = selectionIntersectsSpan(sel, token.spanFrom, token.spanTo);
        if (!inSpan) pushMark(decos, token.from, token.to, token.cls);
        break;
      }
      case "delimiter": {
        const inSpan = selectionIntersectsSpan(sel, token.spanFrom, token.spanTo);
        pushMark(decos, token.from, token.to, inSpan ? "syntax-hint" : "syntax-hidden");
        break;
      }
      case "link-delimiter": {
        const inSpan = selectionIntersectsSpan(sel, token.spanFrom, token.spanTo);
        pushMark(decos, token.from, token.to, inSpan ? "syntax-hint" : "syntax-hidden");
        if (!inSpan) {
          const span = `${token.spanFrom}:${token.spanTo}:${token.linkClass}`;
          if (!styledLinkSpans.has(span)) {
            styledLinkSpans.add(span);
            pushMark(decos, token.spanFrom, token.spanTo, token.linkClass);
          }
        }
        break;
      }
      case "block-mark":
        pushMark(decos, token.from, token.to, cursorLine === token.line ? "syntax-hint" : "syntax-hidden");
        break;
      case "autolink": {
        const inSpan = selectionIntersectsSpan(sel, token.from, token.to);
        const cls = inSpan ? "syntax-hint" : "syntax-hidden";
        pushMark(decos, token.from, token.from + 1, cls);
        pushMark(decos, token.to - 1, token.to, cls);
        break;
      }
      case "static":
        pushMark(decos, token.from, token.to, token.cls);
        break;
      case "html-inline": {
        const inSpan = selectionIntersectsSpan(sel, token.from, token.to);
        if (!inSpan) {
          decos.push(
            Decoration.replace({ widget: new HtmlInlineWidget(token.source) }).range(token.from, token.to),
          );
        }
        break;
      }
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decos, true);
}

function selectionAffectingTokenKey(state: EditorState, tokens: readonly LivePreviewToken[]): string {
  const sel = state.selection.main;
  const cursorLine = state.doc.lineAt(sel.from).number;
  const keys: string[] = [];
  for (const token of tokens) {
    switch (token.kind) {
      case "span":
      case "delimiter":
      case "link-delimiter":
        if (selectionIntersectsSpan(sel, token.spanFrom, token.spanTo)) {
          keys.push(`${token.kind}:${token.spanFrom}:${token.spanTo}`);
        }
        break;
      case "autolink":
      case "html-inline":
        if (selectionIntersectsSpan(sel, token.from, token.to)) {
          keys.push(`${token.kind}:${token.from}:${token.to}`);
        }
        break;
      case "block-mark":
        if (cursorLine === token.line) keys.push(`block-mark:${token.line}`);
        break;
      case "static":
        break;
    }
  }
  return keys.join("|");
}

function addJupyterLinkTokens(
  tokens: LivePreviewToken[],
  doc: Text,
  ranges: readonly { from: number; to: number }[],
  blockMathRanges: readonly { from: number; to: number }[],
): void {
  for (const { from: visibleFrom, to: visibleTo } of ranges) {
    const text = doc.sliceString(visibleFrom, visibleTo);
    let match: RegExpExecArray | null;
    JUPYTER_LINK_RE.lastIndex = 0;
    while ((match = JUPYTER_LINK_RE.exec(text)) !== null) {
      const href = String(match[2] || "").trim();
      if (!isJupyterHref(href)) continue;
      const from = visibleFrom + match.index;
      const to = from + match[0].length;
      if (rangeOverlapsAny(from, to, blockMathRanges)) continue;
      const labelTo = from + 1 + (match[1] || "").length;
      const hrefFrom = labelTo + 2;
      const linkClass = "cm-link-text cm-jupyter-link-text";
      tokens.push({ kind: "link-delimiter", from, to: from + 1, spanFrom: from, spanTo: to, linkClass });
      tokens.push({ kind: "link-delimiter", from: labelTo, to: hrefFrom, spanFrom: from, spanTo: to, linkClass });
      tokens.push({ kind: "link-delimiter", from: hrefFrom, to, spanFrom: from, spanTo: to, linkClass });
    }
  }
}

function addHeadingMarkTokens(
  tokens: LivePreviewToken[],
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  excludedRanges: readonly { from: number; to: number }[],
): void {
  if (ranges.length === 0) return;
  const doc = state.doc;
  const visibleFrom = Math.min(...ranges.map((range) => range.from));
  const visibleTo = Math.max(...ranges.map((range) => range.to));
  for (const heading of tocIndexFromState(state).headings) {
    if (heading.source === "semantic") continue;
    const markFrom = heading.markerFrom ?? doc.lineAt(Math.max(0, Math.min(heading.pos, doc.length))).from;
    const markTo = heading.markerTo ?? heading.pos;
    if (markTo < visibleFrom) continue;
    if (markFrom > visibleTo) break;
    if (markFrom >= markTo) continue;
    if (rangeOverlapsAny(markFrom, markTo, excludedRanges)) continue;
    tokens.push({ kind: "block-mark", from: markFrom, to: markTo, line: doc.lineAt(markFrom).number });
  }
}

function addCjkTextTokens(
  tokens: LivePreviewToken[],
  doc: Text,
  ranges: readonly { from: number; to: number }[],
  blockMathRanges: readonly { from: number; to: number }[],
  cjkLineCache?: CjkLineCache,
): void {
  for (const { from: visibleFrom, to: visibleTo } of ranges) {
    const firstLineNum = doc.lineAt(visibleFrom).number;
    const lastLineNum = doc.lineAt(Math.min(visibleTo, doc.length > 0 ? doc.length : 0)).number;
    for (let lineNum = firstLineNum; lineNum <= lastLineNum; lineNum++) {
      const line = doc.line(lineNum);
      let ranges: CjkLineRanges;
      const cached = cjkLineCache?.get(lineNum);
      if (cached?.text === line.text) {
        ranges = cached.ranges;
      } else {
        ranges = [];
        CJK_TEXT_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = CJK_TEXT_RE.exec(line.text)) !== null) {
          ranges.push({ relFrom: match.index, relTo: match.index + match[0].length });
        }
        cjkLineCache?.set(lineNum, { text: line.text, ranges });
        if (cjkLineCache && cjkLineCache.size > cjkLineCacheLimit) {
          const oldest = cjkLineCache.keys().next().value;
          if (oldest !== undefined) cjkLineCache.delete(oldest);
        }
      }
      for (const { relFrom, relTo } of ranges) {
        const from = line.from + relFrom;
        const to = line.from + relTo;
        if (!rangeOverlapsAny(from, to, blockMathRanges)) tokens.push({ kind: "static", from, to, cls: "cm-cjk-text" });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inline HTML widget
// ---------------------------------------------------------------------------

class HtmlInlineWidget extends WidgetType {
  source: string;
  constructor(source: string) { super(); this.source = source; }

  eq(other: HtmlInlineWidget): boolean { return this.source === other.source; }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-html-inline-widget";
    span.innerHTML = sanitizeEmbeddedHtml(this.source);
    resolveHtmlImgSrcs(span);
    return span;
  }

  ignoreEvent(): boolean { return true; }
}

function pushMark(
  decos: Range<Decoration>[],
  from: number,
  to: number,
  cls: string,
): void {
  if (from >= to) return;
  decos.push(Decoration.mark({ class: cls }).range(from, to));
}

// ---------------------------------------------------------------------------
// ViewPlugin export
// ---------------------------------------------------------------------------

class LivePreviewPlugin {
  decorations: DecorationSet;
  tokens: LivePreviewToken[];
  private readonly cjkLineCache: CjkLineCache = new Map();
  private lastVpFrom: number;
  private lastVpTo: number;
  private selectionKey: string;

  constructor(view: EditorView) {
    const vr = view.visibleRanges;
    this.tokens = collectLivePreviewTokens(view, vr, this.cjkLineCache);
    this.lastVpFrom = vr[0]?.from ?? 0;
    this.lastVpTo = vr[vr.length - 1]?.to ?? 0;
    this.selectionKey = selectionAffectingTokenKey(view.state, this.tokens);
    this.decorations = buildDecorations(view, this.tokens);
  }

  update(update: ViewUpdate): void {
    if (update.view.compositionStarted && update.selectionSet && !update.docChanged && !update.viewportChanged) return;

    if (isCoalescedVisualTyping(update)) {
      this.tokens = mapLivePreviewTokens(this.tokens, update.changes);
      this.decorations = this.decorations.map(update.changes);
      this.lastVpFrom = update.changes.mapPos(this.lastVpFrom, -1);
      this.lastVpTo = update.changes.mapPos(this.lastVpTo, 1);
      this.selectionKey = selectionAffectingTokenKey(update.state, this.tokens);
      this.cjkLineCache.clear();
      return;
    }

    const forceRefresh = hasViewportDecorationRefresh(update);
    const pointerSelectionChanged = updateHasPointerSelectionEffect(update);
    const vr = update.view.visibleRanges;
    const newFrom = vr[0]?.from ?? 0;
    const newTo = vr[vr.length - 1]?.to ?? 0;

    if (update.docChanged || forceRefresh) {
      // Partial CJK invalidation: only clear lines at/after the first change.
      // Lines before the change have stable line numbers and valid cache entries.
      if (update.docChanged) {
        const minLine = firstChangedLine(update.changes, update.view.state.doc);
        if (minLine <= 1) {
          this.cjkLineCache.clear();
        } else {
          for (const lineNum of this.cjkLineCache.keys()) {
            if (lineNum >= minLine) this.cjkLineCache.delete(lineNum);
          }
        }
      }
      this.tokens = collectLivePreviewTokens(update.view, vr, this.cjkLineCache);
      this.lastVpFrom = newFrom;
      this.lastVpTo = newTo;
      this.selectionKey = selectionAffectingTokenKey(update.view.state, this.tokens);
      this.decorations = buildDecorations(update.view, this.tokens);
    } else if (update.viewportChanged) {
      // Incremental: collect tokens only for ranges newly scrolled into view.
      const delta = viewportDeltaRanges(this.lastVpFrom, this.lastVpTo, vr);
      const kept = this.tokens.filter(t => t.to > newFrom && t.from < newTo);
      if (delta.length > 0) {
        const fresh = collectLivePreviewTokens(update.view, delta, this.cjkLineCache);
        if (fresh.length > 0) {
          const merged = [...kept, ...fresh];
          merged.sort((a, b) => a.from - b.from || a.to - b.to);
          this.tokens = merged;
        } else {
          this.tokens = kept;
        }
      } else {
        this.tokens = kept;
      }
      this.lastVpFrom = newFrom;
      this.lastVpTo = newTo;
      this.selectionKey = selectionAffectingTokenKey(update.view.state, this.tokens);
      this.decorations = buildDecorations(update.view, this.tokens);
    } else if (update.selectionSet) {
      // Match Overleaf's selection model: a pointer drag can produce many
      // selection transactions. Keep current marks stable until mouseup, then
      // rebuild once from the final selection.
      if (isPointerSelecting(update.state)) return;
      const nextSelectionKey = selectionAffectingTokenKey(update.view.state, this.tokens);
      if (nextSelectionKey === this.selectionKey) return;
      this.selectionKey = nextSelectionKey;
      this.decorations = buildDecorations(update.view, this.tokens);
    } else if (pointerSelectionChanged && !isPointerSelecting(update.state)) {
      const nextSelectionKey = selectionAffectingTokenKey(update.view.state, this.tokens);
      if (nextSelectionKey === this.selectionKey) return;
      this.selectionKey = nextSelectionKey;
      this.decorations = buildDecorations(update.view, this.tokens);
    }
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (v) => v.decorations,
});

// ---------------------------------------------------------------------------
// Line-level decorations (StateField — Decoration.line cannot come from ViewPlugin)
//
// Adds a CSS class to the <div class="cm-line"> for each heading and
// blockquote line so themes can apply font-size / indentation / border.
// ---------------------------------------------------------------------------

const CODE_FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const SEMANTIC_HEADING_TEXT_RE = /@@(?:part|section)(?:\(|[ \t]+\[)/;

interface MarkdownTable {
  from: number;
  to: number;
  sourceTo: number;
  source: string;
  layout: LayoutAttrs;
}

interface MarkdownTableData {
  rows: string[][];
  aligns: Array<"left" | "center" | "right" | "">;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const ch of trimmed) {
    if (escaped) {
      cell += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      cell += ch;
      escaped = true;
      continue;
    }
    if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function isTableSeparatorLine(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function isTableRowLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isCodeFenceLine(line: string): boolean {
  return CODE_FENCE_LINE_RE.test(line);
}

function nextLayoutAttrsLine(doc: Text, sourceTo: number): { to: number; layout: LayoutAttrs } | null {
  const currentLine = doc.lineAt(sourceTo);
  if (currentLine.number >= doc.lines) return null;
  const nextLine = doc.line(currentLine.number + 1);
  const attrs = readLayoutAttrsLine(nextLine.text);
  if (!attrs) return null;
  return { to: nextLine.to, layout: layoutFromAttrs(attrs.attrs) };
}

function collectMarkdownTablesInLineRange(
  state: EditorState,
  startLine: number,
  endLine: number,
): readonly MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  const doc = state.doc;
  const blockMathRanges = getBlockMathRanges(state);
  let lineNum = Math.max(1, startLine);
  const lastLine = Math.min(doc.lines, endLine);

  while (lineNum <= lastLine) {
    const header = doc.line(lineNum);
    const separator = lineNum < lastLine ? doc.line(lineNum + 1) : null;
    if (
      !separator
      || rangeOverlapsAny(header.from, separator.to, blockMathRanges)
      || !isTableRowLine(header.text)
      || !isTableRowLine(separator.text)
      || !isTableSeparatorLine(separator.text)
    ) {
      lineNum++;
      continue;
    }

    let endLine = lineNum + 1;
    while (endLine + 1 <= lastLine) {
      const next = doc.line(endLine + 1);
      if (rangeOverlapsAny(next.from, next.to, blockMathRanges) || !isTableRowLine(next.text)) break;
      endLine++;
    }

    const end = doc.line(endLine).to;
    const trailing = nextLayoutAttrsLine(doc, end);
    tables.push({
      from: header.from,
      to: trailing?.to ?? end,
      sourceTo: end,
      source: doc.sliceString(header.from, end),
      layout: trailing?.layout ?? layoutFromAttrs({}),
    });
    lineNum = endLine + 1;
  }

  return tables;
}

function collectMarkdownTables(state: EditorState): readonly MarkdownTable[] {
  return collectMarkdownTablesInLineRange(state, 1, state.doc.lines);
}

function markdownTablesFromState(state: EditorState): readonly MarkdownTable[] {
  return state.field(markdownTablesField, false) ?? collectMarkdownTables(state);
}

function mapMarkdownTables(tables: readonly MarkdownTable[], changes: ChangeSet): readonly MarkdownTable[] {
  return tables.map((table) => ({
    ...table,
    from: changes.mapPos(table.from),
    to: changes.mapPos(table.to),
    sourceTo: changes.mapPos(table.sourceTo),
  }));
}

function canMapMarkdownTables(
  doc: Text,
  tables: readonly MarkdownTable[],
  changes: ChangeSet,
): boolean {
  let canMap = true;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!canMap) return;
    const removed = doc.sliceString(fromA, toA);
    const added = inserted.toString();
    if (removed.includes("|") || added.includes("|")) {
      canMap = false;
      return;
    }
    if (tables.some((table) => fromA <= table.to && toA >= table.from)) {
      canMap = false;
      return;
    }

    const startLine = doc.lineAt(Math.min(fromA, doc.length)).number;
    const endLine = doc.lineAt(Math.min(Math.max(fromA, toA), doc.length)).number;
    for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
      if (doc.line(lineNum).text.includes("|")) {
        canMap = false;
        return;
      }
    }
  });
  return canMap;
}

function expandedTableLineWindow(doc: Text, from: number, to: number): { startLine: number; endLine: number } {
  let startLine = Math.max(1, doc.lineAt(Math.min(from, doc.length)).number - 2);
  let endLine = Math.min(doc.lines, doc.lineAt(Math.min(to, doc.length)).number + 2);
  while (startLine > 1 && isTableRowLine(doc.line(startLine - 1).text)) startLine--;
  while (endLine < doc.lines && isTableRowLine(doc.line(endLine + 1).text)) endLine++;
  return { startLine, endLine };
}

function expandedCodeFenceLineWindow(doc: Text, from: number, to: number): { startLine: number; endLine: number } {
  const startCenter = doc.lineAt(Math.min(from, doc.length)).number;
  const endCenter = doc.lineAt(Math.min(Math.max(from, to), doc.length)).number;
  let startLine = startCenter;
  let endLine = endCenter;
  for (let lineNum = startCenter - 1; lineNum >= 1; lineNum--) {
    if (isCodeFenceLine(doc.line(lineNum).text)) {
      startLine = lineNum;
      break;
    }
  }
  for (let lineNum = endCenter + 1; lineNum <= doc.lines; lineNum++) {
    if (isCodeFenceLine(doc.line(lineNum).text)) {
      endLine = lineNum;
      break;
    }
  }
  return { startLine, endLine };
}

function updateMarkdownTablesNearChanges(
  state: EditorState,
  tables: readonly MarkdownTable[],
  changes: ChangeSet,
): readonly MarkdownTable[] | null {
  let fromB = Number.POSITIVE_INFINITY;
  let toB = 0;
  let changeCount = 0;
  changes.iterChanges((_fromA, _toA, nextFrom, nextTo) => {
    changeCount++;
    fromB = Math.min(fromB, nextFrom);
    toB = Math.max(toB, nextTo);
  });
  if (changeCount === 0 || !Number.isFinite(fromB)) return mapMarkdownTables(tables, changes);
  const { startLine, endLine } = expandedTableLineWindow(state.doc, fromB, toB);
  const affectedFrom = state.doc.line(startLine).from;
  const affectedTo = state.doc.line(endLine).to;
  const rescanned = collectMarkdownTablesInLineRange(state, startLine, endLine);
  const mapped = mapMarkdownTables(tables, changes)
    .filter((table) => table.to < affectedFrom || table.from > affectedTo);
  return [...mapped, ...rescanned].sort((a, b) => a.from - b.from || a.to - b.to);
}

function inlineMarkdownHTML(markdown: string): string {
  // Convert <img> HTML tags to markdown image syntax so renderMarkdownHTML
  // routes them through its image renderer (which applies AaronnoteResolveAssetUrl).
  const preprocessed = markdown.includes("<img")
    ? markdown.replace(/<img\b([^>]*)>/gi, (_tag, attrs: string) => {
        const src = /\bsrc=["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
        const alt = /\balt=["']([^"']*?)["']/i.exec(attrs)?.[1] ?? "";
        return src ? `![${alt}](${src})` : "";
      })
    : markdown;
  const html = renderMarkdownHTML(preprocessed);
  const match = /^<p>([\s\S]*)<\/p>\n?$/.exec(html.trim());
  return match ? match[1] : html;
}

function cellAlign(separatorCell: string): "left" | "center" | "right" | "" {
  const compact = separatorCell.replace(/\s+/g, "");
  const left = compact.startsWith(":");
  const right = compact.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

function parseMarkdownTable(source: string): MarkdownTableData {
  const lines = source.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const headerCells = splitTableRow(lines[0] ?? "");
  const separatorCells = splitTableRow(lines[1] ?? "");
  const bodyRows = lines.slice(2).map(splitTableRow);
  const colCount = Math.max(1, headerCells.length, ...bodyRows.map((row) => row.length));
  const normalize = (row: string[]): string[] => Array.from({ length: colCount }, (_, index) => row[index] ?? "");
  return {
    rows: [normalize(headerCells), ...bodyRows.map(normalize)],
    aligns: Array.from({ length: colCount }, (_, index) => cellAlign(separatorCells[index] ?? "")),
  };
}

function separatorForAlign(align: "left" | "center" | "right" | ""): string {
  if (align === "left") return ":---";
  if (align === "center") return ":---:";
  if (align === "right") return "---:";
  return "---";
}

function escapeTableCell(cell: string): string {
  return cell.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function buildMarkdownTableSource(data: MarkdownTableData): string {
  const header = data.rows[0] ?? [""];
  const body = data.rows.slice(1);
  const aligns = Array.from({ length: header.length }, (_, index) => data.aligns[index] ?? "");
  const rowSource = (row: string[]): string => `| ${row.map(escapeTableCell).join(" | ")} |`;
  return [
    rowSource(header),
    rowSource(aligns.map(separatorForAlign)),
    ...body.map(rowSource),
  ].join("\n");
}

type TableFocusTarget = {
  row: number;
  col: number;
  edit?: boolean;
  select?: boolean;
};

type TableFocusResolver = TableFocusTarget | ((data: MarkdownTableData) => TableFocusTarget | null);

class TableWidget extends MeasuredWidget {
  source: string;
  from: number;
  sourceTo: number;
  to: number;
  layout: LayoutAttrs;

  constructor(source: string, from: number, sourceTo: number, to: number, layout: LayoutAttrs) {
    super();
    this.source = source;
    this.from = from;
    this.sourceTo = sourceTo;
    this.to = to;
    this.layout = layout;
  }

  protected measureKey(): string { return "tbl:" + shortHash(this.source); }

  protected measureGroupKey(): string {
    const rows = parseMarkdownTable(this.source).rows.length;
    return ["tbl", this.layout.align, this.layout.wrap ? "wrap" : "block", Math.min(10, Math.ceil(rows / 6))].join(":");
  }

  protected estimatedHeightFallback(): number {
    const rows = parseMarkdownTable(this.source).rows.length;
    return Math.max(96, 64 + rows * 34);
  }

  eq(other: TableWidget): boolean {
    return this.source === other.source
      && this.from === other.from
      && this.sourceTo === other.sourceTo
      && this.to === other.to
      && this.layout.align === other.layout.align
      && this.layout.wrap === other.layout.wrap
      && this.layout.width === other.layout.width
      && this.layout.height === other.layout.height;
  }

  toDOM(view: EditorView): HTMLElement {
    const data = parseMarkdownTable(this.source);
    const wrap = document.createElement("div");
    wrap.className = "cm-table-block cm-table-editable-block";
    wrap.dataset.cmSourceFrom = String(this.from);
    wrap.dataset.cmSourceTo = String(this.to);
    wrap.dataset.cmOpenSource = "false";
    applyLayoutAttrs(wrap, "table", this.layout);
    const stopWidgetMouseEvent = (event: Event): void => {
      event.stopPropagation();
    };
    wrap.addEventListener("mousedown", stopWidgetMouseEvent);
    wrap.addEventListener("mouseup", stopWidgetMouseEvent);
    wrap.addEventListener("click", stopWidgetMouseEvent);
    wrap.addEventListener("dblclick", stopWidgetMouseEvent);

    let activeRow = 0;
    let activeCol = 0;
    let commitTimer: number | null = null;
    const cancelPendingCommit = (): void => {
      if (commitTimer != null) {
        window.clearTimeout(commitTimer);
        commitTimer = null;
      }
    };
    const commit = (focusTarget?: TableFocusTarget | null): void => {
      cancelPendingCommit();
      const rows = tableRowsFromDOM(table);
      if (rows.length === 0) return;
      const nextSource = buildMarkdownTableSource({ rows, aligns: data.aligns.slice(0, rows[0]!.length) });
      if (nextSource !== this.source) {
        view.dispatch({ changes: { from: this.from, to: this.sourceTo, insert: nextSource } });
        focusTableCellAfterRender(view, this.from, focusTarget);
      } else {
        focusTableCellInTable(table, focusTarget);
      }
      view.requestMeasure();
    };
    const scheduleCommit = (focusTarget?: TableFocusTarget | null): void => {
      cancelPendingCommit();
      commitTimer = window.setTimeout(() => {
        commitTimer = null;
        if (!wrap.isConnected) return;
        commit(focusTarget);
      }, 0);
    };
    const apply = (
      mutate: (next: MarkdownTableData) => void,
      focusTarget?: TableFocusResolver,
    ): void => {
      cancelPendingCommit();
      const rows = tableRowsFromDOM(table);
      const next = { rows, aligns: data.aligns.slice(0, rows[0]?.length ?? 1) };
      mutate(next);
      const nextSource = buildMarkdownTableSource(next);
      const target = typeof focusTarget === "function" ? focusTarget(next) : focusTarget;
      view.dispatch({ changes: { from: this.from, to: this.sourceTo, insert: nextSource } });
      focusTableCellAfterRender(view, this.from, target);
      view.requestMeasure();
    };

    const toolbar = document.createElement("div");
    toolbar.className = "cm-table-toolbar";
    toolbar.addEventListener("mousedown", stopEvent);
    toolbar.append(
      tableToolButton("+ Row", "Insert row below", () => {
        let insertAt = Math.max(1, activeRow + 1);
        apply((next) => {
          const width = next.rows[0]?.length ?? 1;
          insertAt = Math.min(insertAt, next.rows.length);
          next.rows.splice(insertAt, 0, Array(width).fill(""));
        }, () => ({ row: insertAt, col: activeCol, edit: true, select: true }));
      }),
      tableToolButton("- Row", "Delete current body row", () => apply((next) => {
        if (next.rows.length <= 2) return;
        const row = Math.max(1, activeRow);
        next.rows.splice(row, 1);
      }, (next) => ({ row: Math.max(1, Math.min(activeRow, next.rows.length - 1)), col: activeCol }))),
      tableToolButton("+ Col", "Insert column right", () => {
        let col = Math.max(0, activeCol + 1);
        apply((next) => {
          col = Math.min(col, next.rows[0]?.length ?? 1);
          next.rows.forEach((row) => row.splice(col, 0, ""));
          next.aligns.splice(col, 0, "");
        }, () => ({ row: activeRow, col, edit: true, select: true }));
      }),
      tableToolButton("- Col", "Delete current column", () => apply((next) => {
        if ((next.rows[0]?.length ?? 0) <= 1) return;
        const col = Math.max(0, Math.min(activeCol, (next.rows[0]?.length ?? 1) - 1));
        next.rows.forEach((row) => row.splice(col, 1));
        next.aligns.splice(col, 1);
      }, (next) => ({ row: activeRow, col: Math.max(0, Math.min(activeCol, (next.rows[0]?.length ?? 1) - 1)) }))),
      tableToolButton("L", "Align column left", () => apply((next) => { next.aligns[activeCol] = "left"; }, { row: activeRow, col: activeCol })),
      tableToolButton("C", "Align column center", () => apply((next) => { next.aligns[activeCol] = "center"; }, { row: activeRow, col: activeCol })),
      tableToolButton("R", "Align column right", () => apply((next) => { next.aligns[activeCol] = "right"; }, { row: activeRow, col: activeCol })),
      tableSizePickerButton((rows, columns) => apply((next) => {
        const targetRows = Math.max(2, Math.min(8, rows));
        const targetColumns = Math.max(1, Math.min(8, columns));
        while (next.rows.length < targetRows) next.rows.push(Array(next.rows[0]?.length ?? 1).fill(""));
        next.rows.length = targetRows;
        next.rows.forEach((row) => {
          while (row.length < targetColumns) row.push("");
          row.length = targetColumns;
        });
        while (next.aligns.length < targetColumns) next.aligns.push("");
        next.aligns.length = targetColumns;
      }, { row: 1, col: 0, edit: true, select: true })),
    );

    const table = renderEditableTable(data, (row, col) => {
      activeRow = row;
      activeCol = col;
    }, commit, scheduleCommit, () => view.requestMeasure());
    installTableDragHandles(table, {
      moveRow: (from, to) => apply((next) => {
        if (from < 1 || to < 1 || from >= next.rows.length || to >= next.rows.length || from === to) return;
        const [row] = next.rows.splice(from, 1);
        if (row) next.rows.splice(to, 0, row);
      }, { row: to, col: activeCol }),
      moveColumn: (from, to) => apply((next) => {
        const width = next.rows[0]?.length ?? 0;
        if (from < 0 || to < 0 || from >= width || to >= width || from === to) return;
        next.rows.forEach((row) => {
          const [cell] = row.splice(from, 1);
          row.splice(to, 0, cell ?? "");
        });
        const [align] = next.aligns.splice(from, 1);
        next.aligns.splice(to, 0, align ?? "");
      }, { row: activeRow, col: to }),
    });
    const addRowEdge = tableToolButton("+", "Add row at table edge", () => apply((next) => {
      next.rows.push(Array(next.rows[0]?.length ?? 1).fill(""));
    }, (next) => ({ row: next.rows.length - 1, col: activeCol, edit: true, select: true })));
    addRowEdge.className = "cm-table-edge-add cm-table-edge-add-row";
    const addColumnEdge = tableToolButton("+", "Add column at table edge", () => apply((next) => {
      next.rows.forEach((row) => row.push(""));
      next.aligns.push("");
    }, (next) => ({ row: activeRow, col: (next.rows[0]?.length ?? 1) - 1, edit: true, select: true })));
    addColumnEdge.className = "cm-table-edge-add cm-table-edge-add-column";
    wrap.append(toolbar, table, addRowEdge, addColumnEdge);
    return this.registerMeasured(wrap, view);
  }

  ignoreEvent(): boolean { return true; }
}

function stopEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function tableToolButton(label: string, title: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  return button;
}

function tableSizePickerButton(apply: (rows: number, columns: number) => void): HTMLElement {
  const host = document.createElement("span");
  host.className = "cm-table-size-picker-host";
  const button = tableToolButton("Size", "Resize table with grid", () => {
    let picker = host.querySelector<HTMLElement>(".cm-table-size-picker");
    if (picker) {
      picker.remove();
      return;
    }
    picker = document.createElement("span");
    picker.className = "cm-table-size-picker";
    picker.setAttribute("role", "grid");
    for (let row = 2; row <= 8; row++) {
      for (let col = 1; col <= 8; col++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "cm-table-size-cell";
        cell.title = `${row} rows × ${col} columns`;
        cell.setAttribute("aria-label", cell.title);
        cell.style.setProperty("--table-picker-row", String(row - 1));
        cell.style.setProperty("--table-picker-col", String(col));
        cell.addEventListener("mouseenter", () => {
          picker!.dataset.rows = String(row);
          picker!.dataset.columns = String(col);
        });
        cell.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          picker?.remove();
          apply(row, col);
        });
        picker.append(cell);
      }
    }
    host.append(picker);
  });
  host.append(button);
  return host;
}

function installTableDragHandles(
  table: HTMLTableElement,
  callbacks: { moveRow: (from: number, to: number) => void; moveColumn: (from: number, to: number) => void },
): void {
  const maxInteractiveRows = 500;
  const maxInteractiveColumns = 64;
  const stop = (event: Event): void => event.stopPropagation();
  let activeDrag = "";
  const dragPayload = (event: DragEvent): string => activeDrag || event.dataTransfer?.getData("text/plain") || "";
  const interactiveRows = Array.from(table.rows).slice(0, maxInteractiveRows + 1);
  const highlightColumn = (column: number, enabled: boolean): void => {
    interactiveRows.forEach((row) => row.cells[column]?.classList.toggle("is-column-hover", enabled));
  };

  interactiveRows.forEach((row, rowIndex) => {
    if (rowIndex < 1) return;
    const firstCell = row.cells[0] as HTMLTableCellElement | undefined;
    if (!firstCell) return;
    const handle = document.createElement("span");
    handle.className = "cm-table-drag-handle cm-table-row-drag-handle";
    handle.textContent = "⋮";
    handle.title = `Drag row ${rowIndex}`;
    handle.draggable = true;
    handle.addEventListener("mousedown", stop);
    handle.addEventListener("click", stop);
    handle.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      activeDrag = `row:${rowIndex}`;
      event.dataTransfer?.setData("text/plain", activeDrag);
      row.classList.add("is-row-dragging");
    });
    handle.addEventListener("dragend", () => {
      activeDrag = "";
      row.classList.remove("is-row-dragging");
    });
    row.addEventListener("dragover", (event) => {
      if (!dragPayload(event).startsWith("row:")) return;
      event.preventDefault();
      event.stopPropagation();
      row.classList.add("is-row-hover");
    });
    row.addEventListener("dragleave", () => row.classList.remove("is-row-hover"));
    row.addEventListener("drop", (event) => {
      const payload = dragPayload(event);
      row.classList.remove("is-row-hover");
      if (!payload.startsWith("row:")) return;
      event.preventDefault();
      event.stopPropagation();
      callbacks.moveRow(Number(payload.slice(4)), rowIndex);
    });
    firstCell.prepend(handle);
  });

  const header = table.querySelector<HTMLTableRowElement>("thead tr");
  if (!header) return;
  Array.from(header.cells).slice(0, maxInteractiveColumns).forEach((cell, columnIndex) => {
    const handle = document.createElement("span");
    handle.className = "cm-table-drag-handle cm-table-column-drag-handle";
    handle.textContent = "⋮";
    handle.title = `Drag column ${columnIndex + 1}`;
    handle.draggable = true;
    handle.addEventListener("mousedown", stop);
    handle.addEventListener("click", stop);
    handle.addEventListener("mouseenter", () => highlightColumn(columnIndex, true));
    handle.addEventListener("mouseleave", () => highlightColumn(columnIndex, false));
    handle.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      activeDrag = `column:${columnIndex}`;
      event.dataTransfer?.setData("text/plain", activeDrag);
      highlightColumn(columnIndex, true);
    });
    handle.addEventListener("dragend", () => {
      activeDrag = "";
      highlightColumn(columnIndex, false);
    });
    cell.addEventListener("dragover", (event) => {
      if (!dragPayload(event).startsWith("column:")) return;
      event.preventDefault();
      event.stopPropagation();
      highlightColumn(columnIndex, true);
    });
    cell.addEventListener("dragleave", () => highlightColumn(columnIndex, false));
    cell.addEventListener("drop", (event) => {
      const payload = dragPayload(event);
      highlightColumn(columnIndex, false);
      if (!payload.startsWith("column:")) return;
      event.preventDefault();
      event.stopPropagation();
      callbacks.moveColumn(Number(payload.slice(7)), columnIndex);
    });
    cell.prepend(handle);
  });
}

function focusTableCellInTable(table: HTMLTableElement, target?: TableFocusTarget | null): boolean {
  if (!target || table.rows.length === 0) return false;
  const row = table.rows[Math.max(0, Math.min(target.row, table.rows.length - 1))];
  if (!row || row.cells.length === 0) return false;
  const cell = row.cells[Math.max(0, Math.min(target.col, row.cells.length - 1))] as HTMLTableCellElement | undefined;
  if (!cell) return false;
  cell.focus();
  if (target.edit) {
    cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const input = cell.querySelector<HTMLInputElement>(".cm-table-cell-input");
    if (input) {
      input.focus();
      if (target.select) input.select();
    }
  }
  return true;
}

function focusTableCellAfterRender(
  view: EditorView,
  tableFrom: number,
  target?: TableFocusTarget | null,
): void {
  if (!target) return;
  window.requestAnimationFrame(() => {
    const table = view.dom.querySelector<HTMLTableElement>(
      `.cm-table-block[data-cm-source-from="${tableFrom}"] table`,
    );
    if (table && focusTableCellInTable(table, target)) return;
    view.focus();
  });
}

function renderEditableTable(
  data: MarkdownTableData,
  setActiveCell: (row: number, col: number) => void,
  commit: (focusTarget?: TableFocusTarget | null) => void,
  scheduleCommit: (focusTarget?: TableFocusTarget | null) => void,
  requestMeasure: () => void,
): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "cm-markdown-table-preview cm-markdown-table-editable";
  const colCount = data.rows[0]?.length ?? 1;
  let pendingFocusTarget: TableFocusTarget | null = null;
  const cellInput = (cell: HTMLTableCellElement): HTMLInputElement | null =>
    cell.querySelector<HTMLInputElement>(".cm-table-cell-input");
  const restorePreview = (cell: HTMLTableCellElement): void => {
    const source = cell.dataset.source ?? "";
    cell.innerHTML = inlineMarkdownHTML(source);
    cell.dataset.editing = "false";
    cell.dataset.dirty = "false";
    cell.dataset.editSource = source;
    requestMeasure();
  };
  const enterEditing = (cell: HTMLTableCellElement): HTMLInputElement => {
    const existing = cellInput(cell);
    if (existing) return existing;
    const source = cell.dataset.source ?? cell.textContent ?? "";
    cell.dataset.editSource = source;
    cell.dataset.editing = "true";
    cell.dataset.dirty = "false";
    cell.textContent = "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cm-table-cell-input";
    input.value = source;
    input.spellcheck = true;
    cell.append(input);
    requestMeasure();
    return input;
  };
  const addCellEvents = (cell: HTMLTableCellElement, row: number, col: number): void => {
    cell.tabIndex = 0;
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    cell.dataset.editing = "false";
    cell.dataset.dirty = "false";
    cell.dataset.editSource = cell.dataset.source ?? "";
    const bindInput = (input: HTMLInputElement): void => {
      if (input.dataset.bound === "true") return;
      input.dataset.bound = "true";
      input.addEventListener("input", () => {
        cell.dataset.dirty = "true";
      });
      input.addEventListener("mousedown", (event) => event.stopPropagation());
      input.addEventListener("mouseup", (event) => event.stopPropagation());
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("blur", (event) => {
        const focusTarget = pendingFocusTarget;
        pendingFocusTarget = null;
        let appendedRow = false;
        if (focusTarget && focusTarget.row >= table.rows.length) {
          appendEmptyTableRow(table, colCount);
          appendedRow = true;
        }
        const nextSource = input.value;
        const changed = nextSource !== (cell.dataset.editSource ?? "");
        if (changed || appendedRow) {
          if (changed) cell.dataset.source = nextSource;
          cell.dataset.dirty = "true";
          const nextTarget = event.relatedTarget;
          const movingInsideTable = nextTarget instanceof Node && table.contains(nextTarget);
          if (movingInsideTable) scheduleCommit(focusTarget);
          else commit(focusTarget);
        } else {
          cell.dataset.dirty = "false";
        }
        restorePreview(cell);
        if (!changed && focusTarget) {
          window.setTimeout(() => focusTableCellInTable(table, focusTarget), 0);
        }
      });
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          pendingFocusTarget = { row: row + 1, col, edit: true, select: true };
          input.blur();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          pendingFocusTarget = null;
          cell.dataset.dirty = "false";
          restorePreview(cell);
          cell.focus();
        }
        if (event.key === "Tab") {
          event.preventDefault();
          const nextCol = event.shiftKey ? col - 1 : col + 1;
          const nextRow = nextCol < 0 ? row - 1 : nextCol >= colCount ? row + 1 : row;
          const normalizedCol = nextCol < 0 ? colCount - 1 : nextCol >= colCount ? 0 : nextCol;
          pendingFocusTarget = { row: nextRow, col: normalizedCol, edit: true, select: true };
          input.blur();
        }
      });
    };
    const openEditor = (targetCell: HTMLTableCellElement): HTMLInputElement => {
      const input = enterEditing(targetCell);
      bindInput(input);
      return input;
    };
    cell.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      setActiveCell(row, col);
      if (event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      const input = openEditor(cell);
      window.setTimeout(() => {
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }, 0);
    });
    cell.addEventListener("focus", () => {
      setActiveCell(row, col);
    });
    cell.addEventListener("click", (event) => {
      event.stopPropagation();
      setActiveCell(row, col);
    });
    cell.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const input = openEditor(cell);
        input.focus();
        input.select();
      }
    });
  };

  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  for (let col = 0; col < colCount; col++) {
    const th = document.createElement("th");
    const source = data.rows[0]?.[col] ?? "";
    th.dataset.source = source;
    th.innerHTML = inlineMarkdownHTML(source);
    const align = data.aligns[col] ?? "";
    if (align) th.style.textAlign = align;
    addCellEvents(th, 0, col);
    headerRow.append(th);
  }

  const tbody = table.createTBody();
  data.rows.slice(1).forEach((row, bodyIndex) => {
    const tr = tbody.insertRow();
    for (let col = 0; col < colCount; col++) {
      const td = tr.insertCell();
      const source = row[col] ?? "";
      td.dataset.source = source;
      td.innerHTML = inlineMarkdownHTML(source);
      const align = data.aligns[col] ?? "";
      if (align) td.style.textAlign = align;
      addCellEvents(td, bodyIndex + 1, col);
    }
  });

  return table;
}

function tableRowsFromDOM(table: HTMLTableElement): string[][] {
  return Array.from(table.rows).map((row) =>
    Array.from(row.cells).map((cell) => (
      cell.dataset.dirty === "true"
        ? cell.querySelector<HTMLInputElement>(".cm-table-cell-input")?.value
          ?? cell.textContent
          ?? ""
        : cell.dataset.source ?? cell.textContent ?? ""
    )));
}

function appendEmptyTableRow(table: HTMLTableElement, colCount: number): void {
  const tbody = table.tBodies[0] ?? table.createTBody();
  const tr = tbody.insertRow();
  for (let col = 0; col < colCount; col++) {
    const td = tr.insertCell();
    td.dataset.source = "";
  }
}

const markdownTablesField = StateField.define<readonly MarkdownTable[]>({
  create: collectMarkdownTables,
  update(tables, tr) {
    if (tr.docChanged) {
      return canMapMarkdownTables(tr.startState.doc, tables, tr.changes)
        ? mapMarkdownTables(tables, tr.changes)
        : updateMarkdownTablesNearChanges(tr.state, tables, tr.changes) ?? collectMarkdownTables(tr.state);
    }
    return tables;
  },
});

function buildTableDecoRanges(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): Range<Decoration>[] {
  const decos: Range<Decoration>[] = [];
  const tables = markdownTablesFromState(state);
  const sel = state.selection.main;

  for (const table of tables) {
    if (table.to < from || table.from > to) continue;
    if (table.sourceTo < table.to && sel.from <= table.to && sel.to >= table.sourceTo) continue;
    decos.push(
      Decoration.replace({
        widget: new TableWidget(table.source, table.from, table.sourceTo, table.to, table.layout),
        block: true,
      }).range(table.from, table.to),
    );
  }

  return decos;
}

function buildTableDecos(state: EditorState): DecorationSet {
  return Decoration.set(buildTableDecoRanges(state), true);
}

function activeTableAttrsKey(state: EditorState): string {
  const sel = state.selection.main;
  // Range selection preserves the rendered table. Only a collapsed caret in
  // its source attributes needs to swap that table back to editable source.
  if (!sel.empty) return "";
  const tables = markdownTablesFromState(state);
  const keys: string[] = [];
  for (const table of tables) {
    if (table.sourceTo < table.to && sel.from <= table.to && sel.to >= table.sourceTo) {
      keys.push(`${table.from}:${table.to}`);
    }
  }
  return keys.join("|");
}

function tableRangesFromKey(key: string): Array<{ from: number; to: number }> {
  if (!key) return [];
  return key.split("|")
    .map((part) => {
      const [from, to] = part.split(":").map((value) => Number(value));
      return Number.isFinite(from) && Number.isFinite(to) && from <= to ? { from, to } : null;
    })
    .filter((range): range is { from: number; to: number } => Boolean(range));
}

function mergeTablePatchRanges(ranges: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const sorted = ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function patchTableDecosForSelectionChange(
  state: EditorState,
  current: DecorationSet,
  oldKey: string,
  newKey: string,
): DecorationSet {
  const ranges = mergeTablePatchRanges([
    ...tableRangesFromKey(oldKey),
    ...tableRangesFromKey(newKey),
  ]);
  if (ranges.length === 0) return current;

  let next = current;
  const add: Range<Decoration>[] = [];
  for (const range of ranges) {
    next = next.update({ filterFrom: range.from, filterTo: range.to, filter: () => false });
    add.push(...buildTableDecoRanges(state, range.from, range.to));
  }
  return next.update({ add, sort: true });
}

const tableDecoField = StateField.define<DecorationSet>({
  create: (state) => buildTableDecos(state),
  update(value, tr) {
    if (tr.effects.some((e) => e.is(refreshViewportDecorations))) return value;
    if (tr.docChanged) {
      const tables = markdownTablesFromState(tr.startState);
      return canMapMarkdownTables(tr.startState.doc, tables, tr.changes)
        ? value.map(tr.changes)
        : patchTableDecosNearChanges(tr.state, value.map(tr.changes), tr.changes);
    }
    if (tr.selection != null) {
      const oldKey = activeTableAttrsKey(tr.startState);
      const newKey = activeTableAttrsKey(tr.state);
      if (oldKey !== newKey) return patchTableDecosForSelectionChange(tr.state, value, oldKey, newKey);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function patchTableDecosNearChanges(
  state: EditorState,
  mapped: DecorationSet,
  changes: ChangeSet,
): DecorationSet {
  let fromB = Number.POSITIVE_INFINITY;
  let toB = 0;
  changes.iterChanges((_fromA, _toA, nextFrom, nextTo) => {
    fromB = Math.min(fromB, nextFrom);
    toB = Math.max(toB, nextTo);
  });
  if (!Number.isFinite(fromB)) return mapped;
  const { startLine, endLine } = expandedTableLineWindow(state.doc, fromB, toB);
  const affectedFrom = state.doc.line(startLine).from;
  const affectedTo = state.doc.line(endLine).to;
  return mapped
    .update({ filterFrom: affectedFrom, filterTo: affectedTo, filter: () => false })
    .update({ add: buildTableDecoRanges(state, affectedFrom, affectedTo), sort: true });
}

function buildLineDecoRanges(
  state: EditorState,
  startLine = 1,
  endLine = state.doc.lines,
): Range<Decoration>[] {
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  const blockMathRanges = getBlockMathRanges(state);
  const lineExcludedRanges = blockMathRanges;
  const firstLine = Math.max(1, startLine);
  const lastWindowLine = Math.min(doc.lines, endLine);
  if (firstLine > lastWindowLine) return decos;
  const windowFrom = doc.line(firstLine).from;
  const windowTo = doc.line(lastWindowLine).to;
  const activeBlankRun = blankLineRunAtSelection(state);

  for (let lineNumber = firstLine; lineNumber <= lastWindowLine; lineNumber++) {
    const line = doc.line(lineNumber);
    if (line.text.trim().length > 0) continue;

    const isActiveBlank = activeBlankRun?.activeLine === lineNumber;
    const firstInRun = lineNumber === 1 || doc.line(lineNumber - 1).text.trim().length > 0;
    const absorbed = firstInRun && blankRunTouchesSemanticBlock(doc, lineNumber, blockMathRanges);
    const classNames = ["cm-prose-blank-line"];
    if (isActiveBlank) classNames.push("cm-prose-blank-active");
    else if (absorbed) classNames.push("cm-prose-blank-absorbed");
    else classNames.push("cm-prose-paragraph-gap");
    decos.push(Decoration.line({ attributes: { class: classNames.join(" ") } }).range(line.from));
  }

  for (const heading of tocIndexFromState(state).headings) {
    if (heading.source === "semantic") continue;
    const line = doc.lineAt(Math.max(0, Math.min(heading.pos, doc.length)));
    if (line.to < windowFrom || line.from > windowTo) continue;
    if (rangeInsideAny(line.from, line.to, lineExcludedRanges)) continue;
    decos.push(Decoration.line({ attributes: { class: `cm-md-h${heading.renderLevel ?? heading.level}` } }).range(line.from));
  }

  const pushLineRange = (from: number, to: number, cls: string): void => {
    let lineNum = Math.max(firstLine, doc.lineAt(from).number);
    const lastLine = Math.min(lastWindowLine, doc.lineAt(to).number);
    while (lineNum <= lastLine) {
      const line = doc.line(lineNum);
      decos.push(Decoration.line({ attributes: { class: cls } }).range(line.from));
      lineNum++;
    }
  };

  syntaxTree(state).iterate({
    from: windowFrom,
    to: windowTo,
    enter(node) {
      if (rangeInsideAny(node.from, node.to, lineExcludedRanges)) return false;

      if (node.name === "Blockquote") {
        const firstLine = doc.lineAt(node.from);
        const calloutM = /^>\s*\[!(\w+)\]/.exec(firstLine.text);
        if (calloutM) {
          const type = calloutM[1]!.toLowerCase();
          pushLineRange(node.from, node.to, `cm-md-blockquote cm-md-callout cm-md-callout-${type}`);
          decos.push(Decoration.line({ attributes: { class: "cm-md-callout-title" } }).range(firstLine.from));
        } else {
          pushLineRange(node.from, node.to, "cm-md-blockquote");
        }
        return false;
      }
      if (node.name === "FencedCode" || node.name === "CodeBlock") {
        pushLineRange(node.from, node.to, "cm-md-code-block");
        return false;
      }
    },
  });

  for (const table of markdownTablesFromState(state)) {
    if (table.to < windowFrom || table.from > windowTo) continue;
    let lineNum = Math.max(firstLine, doc.lineAt(table.from).number);
    const lastLine = Math.min(lastWindowLine, doc.lineAt(table.to).number);
    while (lineNum <= lastLine) {
      const line = doc.line(lineNum);
      const cls = isTableSeparatorLine(line.text)
        ? "cm-md-table cm-md-table-separator"
        : "cm-md-table";
      decos.push(Decoration.line({ attributes: { class: cls } }).range(line.from));
      lineNum++;
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return decos;
}

function buildLineDecos(state: EditorState): DecorationSet {
  return Decoration.set(buildLineDecoRanges(state), true);
}

const lineDecoField = StateField.define<DecorationSet>({
  create: (state) => buildLineDecos(state),
  update(value, tr) {
    const refreshRanges = viewportDecorationRefreshRanges(tr);
    if (refreshRanges) {
      let next = value;
      for (const range of refreshRanges) {
        const startLine = tr.state.doc.lineAt(range.from).number;
        const endLine = tr.state.doc.lineAt(range.to).number;
        const from = tr.state.doc.line(startLine).from;
        const to = tr.state.doc.line(endLine).to;
        next = next.update({ filterFrom: from, filterTo: to, filter: () => false });
        next = next.update({ add: buildLineDecoRanges(tr.state, startLine, endLine), sort: true });
      }
      return next;
    }
    if (isCoalescedVisualTypingTransaction(tr)) return value.map(tr.changes);
    if (tr.docChanged) {
      if (canMapLineDecos(tr.startState.doc, tr.changes)) return value.map(tr.changes);
      if (canPatchLineDecosNearChanges(tr.startState.doc, tr.changes)) {
        return patchLineDecosNearChanges(tr.startState.doc, tr.state, value.map(tr.changes), tr.changes);
      }
      return buildLineDecos(tr.state);
    }
    if (tr.selection != null) {
      const oldRun = blankLineRunAtSelection(tr.startState);
      const newRun = blankLineRunAtSelection(tr.state);
      if (blankLineRunKey(oldRun) !== blankLineRunKey(newRun)) {
        return patchLineDecosForBlankSelection(tr.state, value, oldRun, newRun);
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

type BlankLineRun = { startLine: number; endLine: number; activeLine: number };

const SEMANTIC_VERTICAL_LINE_RE = /^\s*(?:#{1,6}(?:\s|$)|#\+\s*(?:begin|end)\b|\\\[|\\\]|`{3,}|~{3,}|@@(?:todo|cell)\b|\|.*\|\s*$|<(?:table|figure|section|div)\b)/i;

function blankLineRunAtSelection(state: EditorState): BlankLineRun | null {
  const line = state.doc.lineAt(state.selection.main.head);
  if (line.text.trim().length > 0) return null;
  let startLine = line.number;
  let endLine = line.number;
  while (startLine > 1 && state.doc.line(startLine - 1).text.trim().length === 0) startLine--;
  while (endLine < state.doc.lines && state.doc.line(endLine + 1).text.trim().length === 0) endLine++;
  return { startLine, endLine, activeLine: line.number };
}

function blankLineRunKey(run: BlankLineRun | null): string {
  return run == null ? "" : `${run.startLine}:${run.endLine}:${run.activeLine}`;
}

function lineOwnsVerticalRhythm(
  doc: Text,
  lineNumber: number,
  blockMathRanges: readonly { from: number; to: number }[],
): boolean {
  if (lineNumber < 1 || lineNumber > doc.lines) return false;
  const line = doc.line(lineNumber);
  const rangeTo = Math.min(doc.length, Math.max(line.from + 1, line.to));
  if (rangeOverlapsAny(line.from, rangeTo, blockMathRanges)) return true;
  return SEMANTIC_VERTICAL_LINE_RE.test(line.text);
}

function blankRunTouchesSemanticBlock(
  doc: Text,
  firstBlankLine: number,
  blockMathRanges: readonly { from: number; to: number }[],
): boolean {
  let lastBlankLine = firstBlankLine;
  while (lastBlankLine < doc.lines && doc.line(lastBlankLine + 1).text.trim().length === 0) lastBlankLine++;
  return lineOwnsVerticalRhythm(doc, firstBlankLine - 1, blockMathRanges)
    || lineOwnsVerticalRhythm(doc, lastBlankLine + 1, blockMathRanges);
}

function patchLineDecosForBlankSelection(
  state: EditorState,
  current: DecorationSet,
  ...runs: Array<BlankLineRun | null>
): DecorationSet {
  const windows = runs
    .filter((run): run is BlankLineRun => run != null)
    .sort((a, b) => a.startLine - b.startLine);
  if (windows.length === 0) return current;

  const merged: BlankLineRun[] = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, window.endLine);
    } else {
      merged.push({ ...window });
    }
  }

  let next = current;
  for (const window of merged) {
    const from = state.doc.line(window.startLine).from;
    const to = state.doc.line(window.endLine).to;
    next = next.update({ filterFrom: from, filterTo: to, filter: () => false });
    next = next.update({
      add: buildLineDecoRanges(state, window.startLine, window.endLine),
      sort: true,
    });
  }
  return next;
}

function canMapLineDecos(doc: Text, changes: ChangeSet): boolean {
  let canMap = true;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!canMap) return;
    const removed = doc.sliceString(fromA, toA);
    const added = inserted.toString();
    if (/[\n#>|`~]/.test(removed) || /[\n#>|`~]/.test(added) || SEMANTIC_HEADING_TEXT_RE.test(removed) || SEMANTIC_HEADING_TEXT_RE.test(added)) {
      canMap = false;
    }
  });
  return canMap;
}

function canPatchLineDecosNearChanges(doc: Text, changes: ChangeSet): boolean {
  // Newline edits (every Enter press) are patched near the change, not full-doc
  // rebuilt: patchLineDecosNearChanges already expands its window over contiguous
  // table rows and enclosing code fences, so a newline's structural reach is
  // covered. This mirrors htmlBlockDecoField, which patches near changes
  // unconditionally. Without this, each Enter in a large document forced a
  // whole-document syntaxTree.iterate (full parse) via buildLineDecos.
  // Semantic part/section headings still need a full rebuild (they renumber
  // structurally beyond a local window), so they remain excluded.
  let canPatch = true;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!canPatch) return;
    const removed = doc.sliceString(fromA, toA);
    const added = inserted.toString();
    if (SEMANTIC_HEADING_TEXT_RE.test(removed) || SEMANTIC_HEADING_TEXT_RE.test(added)) {
      canPatch = false;
    }
  });
  return canPatch;
}

function patchLineDecosNearChanges(
  oldDoc: Text,
  state: EditorState,
  mapped: DecorationSet,
  changes: ChangeSet,
): DecorationSet {
  let fromB = Number.POSITIVE_INFINITY;
  let toB = 0;
  const includeNewLines = (startLine: number, endLine: number): void => {
    fromB = Math.min(fromB, state.doc.line(startLine).from);
    toB = Math.max(toB, state.doc.line(endLine).to);
  };
  changes.iterChanges((fromA, toA, nextFrom, nextTo, inserted) => {
    const tableWindow = expandedTableLineWindow(state.doc, nextFrom, nextTo);
    includeNewLines(tableWindow.startLine, tableWindow.endLine);
    const removed = oldDoc.sliceString(fromA, toA);
    const added = inserted.toString();
    if (!/[`~]/.test(removed) && !/[`~]/.test(added)) return;

    const oldWindow = expandedCodeFenceLineWindow(oldDoc, fromA, toA);
    fromB = Math.min(fromB, changes.mapPos(oldDoc.line(oldWindow.startLine).from, -1));
    toB = Math.max(toB, changes.mapPos(oldDoc.line(oldWindow.endLine).to, 1));

    const newWindow = expandedCodeFenceLineWindow(state.doc, nextFrom, nextTo);
    includeNewLines(newWindow.startLine, newWindow.endLine);
  });
  if (!Number.isFinite(fromB)) return mapped;
  const startLine = state.doc.lineAt(Math.max(0, Math.min(fromB, state.doc.length))).number;
  const endLine = state.doc.lineAt(Math.max(0, Math.min(toB, state.doc.length))).number;
  const affectedFrom = state.doc.line(startLine).from;
  const affectedTo = state.doc.line(endLine).to;
  return mapped
    .update({ filterFrom: affectedFrom, filterTo: affectedTo, filter: () => false })
    .update({ add: buildLineDecoRanges(state, startLine, endLine), sort: true });
}

// ---------------------------------------------------------------------------
// Block HTML widget + StateField
// ---------------------------------------------------------------------------

class HtmlBlockWidget extends MeasuredWidget {
  source: string;
  from: number;
  to: number;
  constructor(source: string, from: number, to: number) {
    super();
    this.source = source;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string { return `html-block:${shortHash(this.source)}`; }

  protected measureGroupKey(): string {
    const lines = Math.min(8, Math.ceil(this.source.split(/\n/).length / 4));
    return `html-block:lines:${lines}`;
  }

  protected estimatedHeightFallback(): number {
    return Math.max(48, this.source.split(/\n/).length * 20);
  }

  eq(other: HtmlBlockWidget): boolean {
    return this.source === other.source && this.from === other.from && this.to === other.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-html-block-widget";
    div.dataset.cmFrom = String(this.from);
    div.dataset.cmTo = String(this.to);
    div.innerHTML = sanitizeEmbeddedHtml(this.source);
    resolveHtmlImgSrcs(div);
    return this.registerMeasured(div, view);
  }

  ignoreEvent(): boolean { return true; }
}

function collectHtmlBlockDecoRanges(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): Range<Decoration>[] {
  const decos: Range<Decoration>[] = [];
  const sel = state.selection.main;
  const fencedRanges = getFencedCodeRanges(state);
  const mathRanges = getBlockMathRanges(state);

  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name !== "HTMLBlock") return;
      if (rangeOverlapsAny(node.from, node.to, fencedRanges)) return false;
      if (rangeOverlapsAny(node.from, node.to, mathRanges)) return false;
      // Skip nodes inside org-env blocks (e.g. #+begin html body lines)
      if (orgEnvContextForRange(state, node.from, node.to)) return false;
      // Reveal source when cursor is inside the block
      if (sel.from <= node.to && sel.to >= node.from) return false;
      const source = state.doc.sliceString(node.from, node.to);
      decos.push(
        Decoration.replace({
          widget: new HtmlBlockWidget(source, node.from, node.to),
          block: true,
        }).range(node.from, node.to),
      );
      return false;
    },
  });

  return decos;
}

function buildHtmlBlockDecos(state: EditorState): DecorationSet {
  return Decoration.set(collectHtmlBlockDecoRanges(state), true);
}

function patchHtmlBlockDecosNearChanges(
  state: EditorState,
  mapped: DecorationSet,
  changes: ChangeSet,
): DecorationSet {
  let fromB = Number.POSITIVE_INFINITY;
  let toB = 0;
  changes.iterChanges((_fromA, _toA, nextFrom, nextTo) => {
    fromB = Math.min(fromB, nextFrom);
    toB = Math.max(toB, nextTo);
  });
  if (!Number.isFinite(fromB)) return mapped;
  const startLine = state.doc.lineAt(Math.max(0, Math.min(fromB, state.doc.length))).number;
  const endLine = state.doc.lineAt(Math.max(0, Math.min(toB, state.doc.length))).number;
  const affectedFrom = state.doc.line(Math.max(1, startLine)).from;
  const affectedTo = state.doc.line(Math.min(state.doc.lines, endLine)).to;
  return mapped
    .update({ filterFrom: affectedFrom, filterTo: affectedTo, filter: () => false })
    .update({ add: collectHtmlBlockDecoRanges(state, affectedFrom, affectedTo), sort: true });
}

function activeHtmlBlockKey(state: EditorState): string {
  const sel = state.selection.main;
  // Iterating the syntax tree from range start to range end made a drag or
  // Cmd-A proportional to the selected document. Rich block widgets stay
  // rendered during range selection; a collapsed caret still reveals source.
  if (!sel.empty) return "";
  const fencedRanges = getFencedCodeRanges(state);
  const mathRanges = getBlockMathRanges(state);
  const keys: string[] = [];
  syntaxTree(state).iterate({
    from: sel.from,
    to: sel.to,
    enter(node) {
      if (node.name !== "HTMLBlock") return;
      if (rangeOverlapsAny(node.from, node.to, fencedRanges)) return false;
      if (rangeOverlapsAny(node.from, node.to, mathRanges)) return false;
      if (orgEnvContextForRange(state, node.from, node.to)) return false;
      keys.push(`${node.from}:${node.to}`);
      return false;
    },
  });
  return keys.join("|");
}

const htmlBlockDecoField = StateField.define<DecorationSet>({
  create: (state) => buildHtmlBlockDecos(state),
  update(value, tr) {
    const refreshRanges = viewportDecorationRefreshRanges(tr);
    if (refreshRanges) {
      let next = value;
      for (const range of refreshRanges) {
        next = next
          .update({ filterFrom: range.from, filterTo: range.to, filter: () => false })
          .update({ add: collectHtmlBlockDecoRanges(tr.state, range.from, range.to), sort: true });
      }
      return next;
    }
    if (isCoalescedVisualTypingTransaction(tr)) return value.map(tr.changes);
    if (tr.docChanged) {
      return patchHtmlBlockDecosNearChanges(tr.state, value.map(tr.changes), tr.changes);
    }
    if (tr.selection != null) {
      const oldKey = activeHtmlBlockKey(tr.startState);
      const newKey = activeHtmlBlockKey(tr.state);
      if (oldKey !== newKey) return buildHtmlBlockDecos(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// Public export — inline mark plugin + line decoration field
// ---------------------------------------------------------------------------

export const livePreviewExtension = [livePreviewPlugin, markdownTablesField, lineDecoField, tableDecoField, htmlBlockDecoField];
