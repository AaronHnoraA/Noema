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
import { markdownLinkNodeDestination } from "./extensions/visual/document-references.ts";
import { definitionLinesFromText } from "./extensions/visual/definition-lines.ts";
import { redo, undo } from "@codemirror/commands";
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
import { Prec, StateField, type ChangeSet, type EditorState, type Text } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { getBlockMathRanges, mergeOverlappingRanges, rangeInsideAny, rangeOverlapsAny } from "./math-ranges.ts";
import { sanitizeEmbeddedHtml } from "../sanitize-html.ts";
import { renderInlineMarkdownHTML } from "../render-html.ts";
import { tableCellMathRanges } from "./table-cell-assist.ts";
import { openRenderedFormulaSource, renderedFormulaClickRatio } from "./rendered-formula-click.ts";
import { figureLayoutToolbar, figureMoveGrip, figureResizeHandle } from "./figure-layout-menu.ts";
import { scanEmojiShortcodes } from "../emoji-shortcodes.ts";
import { writeSystemClipboard } from "../system-clipboard.ts";
import {
  buildMarkdownTableSource,
  computeTableColumnPercentages,
  parseMarkdownTable,
  sortTableBodyRows,
  tableRowsToCSV,
  type MarkdownTableData,
} from "./table-model.ts";
import {
  isTableBodyLine,
  isTableSeparatorLine,
  isTableStart,
  mapRenderedOffsetToSource,
  tableCellColumnAtOffset,
  tableCellTarget,
  tableSourceRowParts,
} from "./table-source-cells.ts";
import { isMarkdownLinkOpenEvent, markdownLinkOpensNewWindow } from "./markdown-link-events.ts";
import { renderedTextOffsetAtPoint } from "./pointer-position.ts";
import {
  clearRectCells,
  rectCellSources,
  rectContains,
  rectCoversTable,
  rectIsSingleCell,
  removeRectStructure,
  tableCellRect,
  type TableCellPosition,
  type TableCellRect,
} from "./table-rect-selection.ts";
import {
  applyLayoutAttrs,
  layoutClasses,
  layoutFromAttrs,
  layoutStyle,
  readLayoutAttrsLine,
  type LayoutAttrs,
} from "../layout-attrs.ts";
import { tocIndexFromState } from "./toc-index.ts";
import { hasViewportDecorationRefresh, viewportDecorationRefreshRanges } from "./viewport-refresh.ts";
import { changesMightAffectFencedCodeRanges, getFencedCodeRanges } from "./code-ranges.ts";
import { isDocumentDataBody, orgEnvContextForRange } from "./extensions/visual/widgets/block-extras.ts";
import { preserveEditorViewport } from "./viewport-stability.ts";
import {
  firstChangedLine,
  viewportDeltaRanges,
} from "./utils/tree-operations/change-ranges.ts";
import {
  isPointerSelecting,
  pointerSelectionEffect,
  updateHasPointerSelectionEffect,
  visualSelection,
} from "./extensions/visual/selection.ts";
import {
  dispatchConstructEdit,  constructSources,
  drawnConstructSource,
  mathRangesIn,
  rangeRevealsSource,
  rebuildDecorations,
  rebuildForRevealChange,
  selectionOpensSource,
  type ConstructSource,
} from "./extensions/visual/constructs/index.ts";
import { isStableWikiHref, scanWikiLinks } from "../../shared/wiki-link.mjs";
import { scanCommentAnchors } from "../../shared/comment-anchors.mjs";
import {
  isCoalescedVisualTyping,
  isCoalescedVisualTypingTransaction,
} from "./extensions/visual/typing-burst.ts";
import {
  persistentVisualStateField,
  rememberPersistentVisualPluginState,
  restorePersistentVisualPluginState,
} from "./extensions/visual/visual-mode.ts";

// ---------------------------------------------------------------------------
// Asset URL helpers for raw HTML embedded in the live preview.
// Markdown images go through renderMarkdownHTML → md.renderer.rules.image →
// NoemaResolveAssetUrl automatically.  Raw <img> tags inside HTML
// inline/block widgets bypass that path, so we patch their src attributes
// explicitly after DOMPurify runs.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    NoemaResolveAssetUrl?: (src: string) => string;
  }
}

/** Apply NoemaResolveAssetUrl to every <img src> inside ROOT that looks like a local path. */
function resolveHtmlImgSrcs(root: HTMLElement): void {
  const resolver = window.NoemaResolveAssetUrl;
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
  "LinkLabel", // [reference]
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
  | { kind: "link-delimiter"; from: number; to: number; spanFrom: number; spanTo: number; labelFrom: number; labelTo: number; linkClass: string }
  | { kind: "block-mark"; from: number; to: number; line: number }
  | { kind: "autolink"; from: number; to: number }
  | { kind: "static"; from: number; to: number; cls: string }
  | { kind: "html-inline"; from: number; to: number; source: string }
  | { kind: "emoji"; from: number; to: number; emoji: string; name: string }
  | { kind: "comment-text"; from: number; to: number; id: string }
  | { kind: "comment-delimiter"; from: number; to: number };

function mapLivePreviewTokens(tokens: readonly LivePreviewToken[], changes: ChangeSet): LivePreviewToken[] {
  return tokens.map((token) => {
    const mapped = {
      ...token,
      from: changes.mapPos(token.from, -1),
      to: changes.mapPos(token.to, 1),
    };
    if (token.kind === "span" || token.kind === "delimiter" || token.kind === "link-delimiter") {
      const span = {
        ...mapped,
        spanFrom: changes.mapPos(token.spanFrom, -1),
        spanTo: changes.mapPos(token.spanTo, 1),
      };
      return token.kind === "link-delimiter"
        ? { ...span, labelFrom: changes.mapPos(token.labelFrom, -1), labelTo: changes.mapPos(token.labelTo, 1) }
        : span as LivePreviewToken;
    }
    return mapped as LivePreviewToken;
  });
}

/**
 * Whether the selection reveals the source markers of span [from, to]: the
 * shared `interior` policy (see `constructs/reveal.ts`), as MarkText's
 * `checkNeedRender` decides from the anchor and focus.
 */
function selectionIntersectsSpan(sel: { from: number; to: number; empty: boolean }, from: number, to: number): boolean {
  return rangeRevealsSource(sel, from, to, "interior");
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

/**
 * Comment anchors `{==text==}{>>#id<<}` (C70): the commented text is marked
 * with its thread id, which the page's comment rail answers; the markers stay
 * hidden like Google Docs shows none, and open only while the caret is inside
 * a marker itself, so editing the commented text never reveals them.
 */
function addCommentTokens(
  tokens: LivePreviewToken[],
  doc: Text,
  ranges: readonly { from: number; to: number }[],
  excludedRanges: readonly { from: number; to: number }[],
): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  const visited = new Set<number>();
  for (const { from: visibleFrom, to: visibleTo } of ranges) {
    const firstLine = doc.lineAt(visibleFrom).number;
    const lastLine = doc.lineAt(Math.min(toVisibleDocPos(doc, visibleTo))).number;
    for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
      if (visited.has(lineNum)) continue;
      visited.add(lineNum);
      const line = doc.line(lineNum);
      if (!line.text.includes("{==")) continue;
      for (const anchor of scanCommentAnchors(line.text)) {
        const from = line.from + anchor.from, to = line.from + anchor.to;
        // Only the markers must lie outside code and math: the commented text
        // may hold math, which keeps rendering inside the highlight.
        if (rangeOverlapsAny(from, line.from + anchor.textFrom, excludedRanges)
          || rangeOverlapsAny(line.from + anchor.textTo, to, excludedRanges)) continue;
        found.push({ from, to });
        tokens.push({ kind: "comment-delimiter", from, to: line.from + anchor.textFrom });
        if (anchor.textFrom < anchor.textTo) {
          tokens.push({ kind: "comment-text", from: line.from + anchor.textFrom, to: line.from + anchor.textTo, id: anchor.id });
        }
        tokens.push({ kind: "comment-delimiter", from: line.from + anchor.textTo, to });
      }
    }
  }
  return found;
}

/** `:name:` shortcodes outside code and math, rendered as the emoji. */
function addEmojiTokens(
  tokens: LivePreviewToken[],
  doc: Text,
  ranges: readonly { from: number; to: number }[],
  excludedRanges: readonly { from: number; to: number }[],
  codeRanges: readonly { from: number; to: number }[],
): void {
  for (const { from, to } of ranges) {
    for (const match of scanEmojiShortcodes(doc.sliceString(from, to), from)) {
      if (rangeOverlapsAny(match.from, match.to, codeRanges) || rangeOverlapsAny(match.from, match.to, excludedRanges)) continue;
      tokens.push({ kind: "emoji", from: match.from, to: match.to, emoji: match.emoji, name: match.name });
    }
  }
}

class EmojiWidget extends WidgetType {
  readonly emoji: string;
  readonly name: string;
  constructor(emoji: string, name: string) {
    super();
    this.emoji = emoji;
    this.name = name;
  }
  eq(other: EmojiWidget): boolean { return other.emoji === this.emoji && other.name === this.name; }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-emoji";
    span.textContent = this.emoji;
    span.title = `:${this.name}:`;
    return span;
  }
  ignoreEvent(): boolean { return false; }
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
  const definitions = definitionLinesFromText(doc);
  // Math is literal for every construct family (constructs/literal-ranges.ts);
  // code ranges are collected by the walk below, which already visits them.
  const excludedRanges = mathRangesIn(view.state, ranges);
  const codeRanges: Array<{ from: number; to: number }> = [];

  // Headings come from the syntax tree (never inside code), so they can run
  // before the main walk. CJK/Jupyter-link scanners are regex-based and must skip
  // code spans, so they run AFTER the walk below has populated `codeRanges` —
  // this reuses the same walk rather than adding a second pass (perf-neutral).
  addHeadingMarkTokens(tokens, view.state, ranges, excludedRanges);

  for (const { from, to } of ranges) {
    if (definitions) {
      for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number++) {
        const definition = definitions.get(number);
        if (!definition || definition === "term") continue;
        const line = doc.line(number);
        const marker = definition === "body"
          ? /^[ \t]*(?:>[ \t]*)*([:~])(?:[ \t]+|$)/.exec(line.text)
          : /^([ \t]{2,})/.exec(line.text);
        if (!marker) continue;
        const at = line.from + marker[0].lastIndexOf(marker[1]!);
        tokens.push({ kind: "block-mark", from: at, to: line.from + marker[0].length, line: number });
      }
    }
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
          const href = markdownLinkNodeDestination(view.state, p);
          if (node.name === "LinkLabel" && !href) return false;
          const roamLink = isRoamCoreHref(href);
          let labelFrom = spanFrom;
          let labelTo = spanTo;
          if (roamLink) {
            // Only the visible label belongs to the node's visual identity.
            // A mark over the whole Markdown source also styles the hidden
            // brackets and URL, producing empty capsules beside the title.
            labelFrom = spanFrom + 1;
            for (let child = p.firstChild; child; child = child.nextSibling) {
              if (child.name === "LinkMark" && doc.sliceString(child.from, child.to) === "]") {
                labelTo = child.from;
                break;
              }
            }
          }

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
            labelFrom,
            labelTo,
            linkClass: isJupyterHref(href)
              ? "cm-link-text cm-jupyter-link-text"
              : roamLink
                ? `cm-link-text cm-roam-link-text${isStableWikiHref(href) ? " cm-roam-link-stable" : ""}`
                : "cm-link-text",
          });
          if (roamLink && node.from === spanFrom && labelFrom < labelTo) {
            tokens.push({
              kind: "span", from: labelFrom, to: labelFrom + 1, spanFrom, spanTo,
              cls: `cm-roam-link-glyph${isStableWikiHref(href) ? " cm-roam-link-stable" : ""}`,
            });
          }
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
  // Comment anchors (C70) come first: their `{==` / `==}` are not highlights.
  const commentRanges = addCommentTokens(tokens, doc, ranges, allExcluded);
  addHighlightTokens(tokens, doc, ranges, combineRanges(allExcluded, commentRanges), codeRanges);
  addEmojiTokens(tokens, doc, ranges, allExcluded, codeRanges);
  addPairedHtmlTokens(tokens, doc);

  return tokens;
}

/**
 * Lezer emits `<kbd>` and `</kbd>` as two unrelated HTMLTag nodes, so the text
 * between them never sits inside a real element.  Pair same-line open/close
 * tags of the inline formatting set and mark their content, so `<kbd>`,
 * `<sub>`, `<sup>`, `<mark>`, `<u>`/`<ins>` and `<small>` render in place.
 */
const PAIRED_INLINE_HTML = new Set(["kbd", "sub", "sup", "mark", "u", "ins", "small"]);
const HTML_OPEN_TAG_RE = /^<([a-z]+)(?:\s[^>]*)?>$/i;
const HTML_CLOSE_TAG_RE = /^<\/([a-z]+)\s*>$/i;

function addPairedHtmlTokens(tokens: LivePreviewToken[], doc: Text): void {
  const tags = tokens
    .filter((token): token is Extract<LivePreviewToken, { kind: "html-inline" }> => token.kind === "html-inline")
    .sort((a, b) => a.from - b.from);
  const open: { name: string; to: number; line: number }[] = [];
  for (const tag of tags) {
    const line = doc.lineAt(tag.from).number;
    const opening = HTML_OPEN_TAG_RE.exec(tag.source);
    if (opening) {
      const name = opening[1]!.toLowerCase();
      if (PAIRED_INLINE_HTML.has(name)) open.push({ name, to: tag.to, line });
      continue;
    }
    const closing = HTML_CLOSE_TAG_RE.exec(tag.source);
    if (!closing) continue;
    const name = closing[1]!.toLowerCase();
    for (let index = open.length - 1; index >= 0; index--) {
      const candidate = open[index]!;
      if (candidate.name !== name) continue;
      open.splice(index);
      if (candidate.line === line && candidate.to < tag.from) {
        tokens.push({ kind: "static", from: candidate.to, to: tag.from, cls: `cm-html-${name}` });
      }
      break;
    }
  }
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
        const linkClass = `cm-link-text cm-internal-link-text cm-roam-link-text${isStableWikiHref(link.target) ? " cm-roam-link-stable" : ""}`;
        tokens.push({ kind: "span", from: link.labelFrom, to: link.labelTo, spanFrom: link.from, spanTo: link.to, cls: linkClass });
        tokens.push({
          kind: "span", from: link.labelFrom, to: link.labelFrom + 1, spanFrom: link.from, spanTo: link.to,
          cls: `cm-roam-link-glyph${isStableWikiHref(link.target) ? " cm-roam-link-stable" : ""}`,
        });
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
  const sel = visualSelection(view.state).main;
  const doc = view.state.doc;
  const cursorLine = doc.lineAt(sel.from).number;
  // Every delimiter of a link (`[`, `]`, `(`, the URL, `)`) carries the same
  // link class, so styling the link per delimiter wrapped each link in
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
            pushMark(decos, token.labelFrom, token.labelTo, token.linkClass);
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
        // A tag broken across lines (`<a⏎href>`) stays source: a plugin may
        // not replace a line break, and trying aborts the view update.
        if (!inSpan && !token.source.includes("\n")) {
          decos.push(
            Decoration.replace({ widget: new HtmlInlineWidget(token.source) }).range(token.from, token.to),
          );
        }
        break;
      }
      case "emoji":
        if (!selectionIntersectsSpan(sel, token.from, token.to)) {
          decos.push(Decoration.replace({ widget: new EmojiWidget(token.emoji, token.name) }).range(token.from, token.to));
        }
        break;
      case "comment-text":
        decos.push(Decoration.mark({
          class: "noema-comment-anchor",
          attributes: { "data-comment-id": token.id },
        }).range(token.from, token.to));
        break;
      case "comment-delimiter":
        pushMark(decos, token.from, token.to,
          selectionIntersectsSpan(sel, token.from, token.to) ? "syntax-hint" : "syntax-hidden");
        break;
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decos, true);
}

function selectionAffectingTokenKey(state: EditorState, tokens: readonly LivePreviewToken[]): string {
  const sel = visualSelection(state).main;
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
      case "emoji":
      case "comment-delimiter":
        if (selectionIntersectsSpan(sel, token.from, token.to)) {
          keys.push(`${token.kind}:${token.from}:${token.to}`);
        }
        break;
      case "block-mark":
        if (cursorLine === token.line) keys.push(`block-mark:${token.line}`);
        break;
      case "static":
      case "comment-text":
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
      tokens.push({ kind: "link-delimiter", from, to: from + 1, spanFrom: from, spanTo: to, labelFrom: from, labelTo: to, linkClass });
      tokens.push({ kind: "link-delimiter", from: labelTo, to: hrefFrom, spanFrom: from, spanTo: to, labelFrom: from, labelTo: to, linkClass });
      tokens.push({ kind: "link-delimiter", from: hrefFrom, to, spanFrom: from, spanTo: to, labelFrom: from, labelTo: to, linkClass });
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

type LivePreviewPluginSnapshot = {
  decorations: DecorationSet;
  tokens: LivePreviewToken[];
  cjkLineCache: CjkLineCache;
  lastVpFrom: number;
  lastVpTo: number;
  selectionKey: string;
};

const livePreviewPluginCacheKey = {};

class LivePreviewPlugin {
  decorations: DecorationSet;
  tokens: LivePreviewToken[];
  private readonly view: EditorView;
  private readonly cjkLineCache: CjkLineCache;
  private lastVpFrom: number;
  private lastVpTo: number;
  private selectionKey: string;

  constructor(view: EditorView) {
    this.view = view;
    const cached = restorePersistentVisualPluginState<LivePreviewPluginSnapshot>(
      view.state,
      livePreviewPluginCacheKey,
    );
    if (cached) {
      this.decorations = cached.decorations;
      this.tokens = cached.tokens;
      this.cjkLineCache = cached.cjkLineCache;
      this.lastVpFrom = cached.lastVpFrom;
      this.lastVpTo = cached.lastVpTo;
      this.selectionKey = cached.selectionKey;
      return;
    }
    this.cjkLineCache = new Map();
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
    if (isPointerSelecting(update.state) && !update.docChanged
        && !update.viewportChanged && !forceRefresh) return;
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

  destroy(): void {
    rememberPersistentVisualPluginState(this.view, livePreviewPluginCacheKey, {
      decorations: this.decorations,
      tokens: this.tokens,
      cjkLineCache: this.cjkLineCache,
      lastVpFrom: this.lastVpFrom,
      lastVpTo: this.lastVpTo,
      selectionKey: this.selectionKey,
    } satisfies LivePreviewPluginSnapshot);
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (v) => v.decorations,
  // Emoji and inline HTML drawn over their source; an emoji is one glyph, an object.
  provide: (plugin) => constructSources.of(drawnConstructSource(
    "inline-markup",
    (widget) => (widget instanceof EmojiWidget ? "object" : "structure"),
    (_state, view) => view?.plugin(plugin)?.decorations,
  )),
});

// ---------------------------------------------------------------------------
// Line-level decorations (StateField — Decoration.line cannot come from ViewPlugin)
//
// Adds a CSS class to the <div class="cm-line"> for each heading and
// blockquote line so themes can apply font-size / indentation / border.
// ---------------------------------------------------------------------------

const SEMANTIC_HEADING_TEXT_RE = /@@(?:part|section)(?:\(|[ \t]+\[)/;

interface MarkdownTable {
  from: number;
  to: number;
  sourceTo: number;
  source: string;
  layout: LayoutAttrs;
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
  const fencedRanges = getFencedCodeRanges(state);
  let lineNum = Math.max(1, startLine);
  const lastLine = Math.min(doc.lines, endLine);

  while (lineNum <= lastLine) {
    const header = doc.line(lineNum);
    const separator = lineNum < lastLine ? doc.line(lineNum + 1) : null;
    if (
      !separator
      || rangeOverlapsAny(header.from, separator.to, blockMathRanges)
      || rangeOverlapsAny(header.from, separator.to, fencedRanges)
      || !isTableStart(header.text, separator.text)
    ) {
      lineNum++;
      continue;
    }

    let endLine = lineNum + 1;
    while (endLine + 1 <= lastLine) {
      const next = doc.line(endLine + 1);
      if (rangeOverlapsAny(next.from, next.to, blockMathRanges)
          || rangeOverlapsAny(next.from, next.to, fencedRanges)
          || !isTableBodyLine(next.text)) break;
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

function firstTableEndingAtOrAfter(tables: readonly MarkdownTable[], from: number): number {
  let first = 0;
  let past = tables.length;
  while (first < past) {
    const middle = (first + past) >> 1;
    if (tables[middle]!.to < from) first = middle + 1;
    else past = middle;
  }
  return first;
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
  if (changesMightAffectFencedCodeRanges(doc, changes)) return false;
  let canMap = true;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!canMap) return;
    const removed = doc.sliceString(fromA, toA);
    const added = inserted.toString();
    if (removed.includes("|") || added.includes("|")) {
      canMap = false;
      return;
    }
    const table = tables[firstTableEndingAtOrAfter(tables, fromA)];
    if (table && toA >= table.from) {
      canMap = false;
      return;
    }
    // Text on the line right after a table joins its body (rows need no pipe).
    const lineStart = doc.lineAt(Math.min(fromA, doc.length)).from;
    if (lineStart > 0) {
      const above = tables[firstTableEndingAtOrAfter(tables, lineStart - 1)];
      if (above && above.from <= lineStart - 1 && above.sourceTo >= lineStart - 1) {
        canMap = false;
        return;
      }
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
  // A table runs until a blank line, and its body rows need no pipes, so an
  // edit inside it rescans the whole run of non-blank lines around it.
  while (startLine > 1 && doc.line(startLine - 1).text.trim()) startLine--;
  while (endLine < doc.lines && doc.line(endLine + 1).text.trim()) endLine++;
  return { startLine, endLine };
}

function affectedFenceWindow(
  oldState: EditorState,
  nextState: EditorState,
  changes: ChangeSet,
): { from: number; to: number } | null {
  if (!changesMightAffectFencedCodeRanges(oldState.doc, changes)) return null;
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  const oldRanges = getFencedCodeRanges(oldState);
  const nextRanges = getFencedCodeRanges(nextState);
  changes.iterChanges((fromA, toA, fromB, toB) => {
    from = Math.min(from, fromB);
    to = Math.max(to, toB);
    for (const range of oldRanges) {
      if (range.from > toA || range.to < fromA) continue;
      from = Math.min(from, changes.mapPos(range.from, -1));
      to = Math.max(to, changes.mapPos(range.to, 1));
    }
    for (const range of nextRanges) {
      if (range.from > toB || range.to < fromB) continue;
      from = Math.min(from, range.from);
      to = Math.max(to, range.to);
    }
  });
  return Number.isFinite(from) ? { from, to } : null;
}

function affectedTableLineWindow(
  oldState: EditorState,
  nextState: EditorState,
  changes: ChangeSet,
): { startLine: number; endLine: number } {
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  changes.iterChanges((_fromA, _toA, fromB, toB) => {
    from = Math.min(from, fromB);
    to = Math.max(to, toB);
  });
  const fence = affectedFenceWindow(oldState, nextState, changes);
  if (fence) {
    from = Math.min(from, fence.from);
    to = Math.max(to, fence.to);
  }
  return expandedTableLineWindow(nextState.doc, from, to);
}

function updateMarkdownTablesNearChanges(
  oldState: EditorState,
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
  const { startLine, endLine } = affectedTableLineWindow(oldState, state, changes);
  const affectedFrom = state.doc.line(startLine).from;
  const affectedTo = state.doc.line(endLine).to;
  const rescanned = collectMarkdownTablesInLineRange(state, startLine, endLine);
  const mapped = mapMarkdownTables(tables, changes)
    .filter((table) => table.to < affectedFrom || table.from > affectedTo);
  let first = 0;
  let past = mapped.length;
  while (first < past) {
    const middle = (first + past) >> 1;
    if (mapped[middle]!.from < affectedFrom) first = middle + 1;
    else past = middle;
  }
  return mapped.slice(0, first).concat(rescanned, mapped.slice(first));
}

type TableFocusTarget = {
  row: number;
  col: number;
  /** Enter the cell in the document editor rather than focus its preview. */
  edit?: boolean;
  select?: boolean;
  /** Where the caret lands in an edited cell when nothing is selected. */
  caret?: "start" | "end";
  /** Clicked rendered text offset from pointer-position.ts, mapped to cell source. */
  caretHit?: { offset: number; total: number } | null;
};

/** Whole-table writes a rectangular cell selection needs from its widget. */
type TableStructureActions = {
  aligns: () => MarkdownTableData["aligns"];
  replace: (rows: string[][], aligns: MarkdownTableData["aligns"], focus: TableFocusTarget | null) => void;
  remove: () => void;
};

type TableFocusResolver = TableFocusTarget | ((data: MarkdownTableData) => TableFocusTarget | null);

/** Apply colgroup widths matching computeTableColumnPercentages to a preview table. */
function syncPreviewTableColgroup(table: HTMLTableElement, colWidths: readonly number[]): void {
  let colgroup = table.querySelector("colgroup");
  if (!colgroup) {
    colgroup = document.createElement("colgroup");
    table.prepend(colgroup);
  }
  const existing = Array.from(colgroup.children) as HTMLTableColElement[];
  if (existing.length === colWidths.length) {
    colWidths.forEach((width, index) => {
      existing[index]!.style.width = `${width}%`;
    });
    return;
  }
  colgroup.replaceChildren(...colWidths.map((width) => {
    const col = document.createElement("col");
    col.style.width = `${width}%`;
    return col;
  }));
}

/** The same table controls in the preview and in the live document grid. */
function createTableToolbar(
  apply: (mutate: (next: MarkdownTableData) => void, focus?: TableFocusResolver) => void,
  active: () => { row: number; col: number },
  readData: () => MarkdownTableData,
  onDeleteTable?: () => void,
  layoutHost?: { view: EditorView; widget: HTMLElement; readLayout: () => LayoutAttrs },
): { element: HTMLElement; syncState: () => void } {
  const toolbar = document.createElement("div");
  toolbar.className = "cm-table-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Table controls");
  toolbar.addEventListener("mousedown", stopEvent);

  const sep = (): HTMLSpanElement => {
    const el = document.createElement("span");
    el.className = "cm-table-toolbar-sep";
    el.setAttribute("aria-hidden", "true");
    return el;
  };

  const deleteRowBtn = tableToolButton("-R", "Delete current body row", () => apply((next) => {
    const row = active().row;
    if (next.rows.length <= 2 || row < 1 || row >= next.rows.length) return;
    next.rows.splice(row, 1);
  }, (next) => ({ row: Math.max(1, Math.min(active().row, next.rows.length - 1)), col: active().col })));

  const deleteColBtn = tableToolButton("-C", "Delete current column", () => apply((next) => {
    if ((next.rows[0]?.length ?? 0) <= 1) return;
    const col = Math.max(0, Math.min(active().col, (next.rows[0]?.length ?? 1) - 1));
    next.rows.forEach((row) => row.splice(col, 1));
    next.aligns.splice(col, 1);
  }, (next) => ({ row: active().row, col: Math.max(0, Math.min(active().col, (next.rows[0]?.length ?? 1) - 1)) })));

  const toggleAlign = (align: "left" | "center" | "right") => () => apply((next) => {
    const col = active().col;
    next.aligns[col] = next.aligns[col] === align ? "" : align;
  }, { row: active().row, col: active().col });

  const alignLeftBtn = tableToolButton("L", "Align column left", toggleAlign("left"));
  const alignCenterBtn = tableToolButton("C", "Align column center", toggleAlign("center"));
  const alignRightBtn = tableToolButton("R", "Align column right", toggleAlign("right"));

  const syncState = (): void => {
    const data = readData();
    const pos = active();
    const align = data.aligns[pos.col] ?? "";
    alignLeftBtn.classList.toggle("is-active", align === "left");
    alignCenterBtn.classList.toggle("is-active", align === "center");
    alignRightBtn.classList.toggle("is-active", align === "right");
    deleteRowBtn.disabled = data.rows.length <= 2 || pos.row < 1;
    deleteColBtn.disabled = (data.rows[0]?.length ?? 0) <= 1;
  };

  toolbar.append(
    tableToolButton("+↑", "Insert row above", () => {
      let insertAt = Math.max(1, active().row);
      apply((next) => {
        const width = next.rows[0]?.length ?? 1;
        insertAt = Math.max(1, Math.min(insertAt, next.rows.length));
        next.rows.splice(insertAt, 0, Array(width).fill(""));
      }, () => ({ row: insertAt, col: active().col, edit: true, select: true }));
    }),
    tableToolButton("+↓", "Insert row below", () => {
      let insertAt = Math.max(1, active().row + 1);
      apply((next) => {
        const width = next.rows[0]?.length ?? 1;
        insertAt = Math.min(insertAt, next.rows.length);
        next.rows.splice(insertAt, 0, Array(width).fill(""));
      }, () => ({ row: insertAt, col: active().col, edit: true, select: true }));
    }),
    deleteRowBtn,
    sep(),
    tableToolButton("+←", "Insert column left", () => {
      let col = Math.max(0, active().col);
      apply((next) => {
        col = Math.max(0, Math.min(col, next.rows[0]?.length ?? 1));
        next.rows.forEach((row) => row.splice(col, 0, ""));
        next.aligns.splice(col, 0, "");
      }, () => ({ row: active().row, col, edit: true, select: true }));
    }),
    tableToolButton("+→", "Insert column right", () => {
      let col = Math.max(0, active().col + 1);
      apply((next) => {
        col = Math.min(col, next.rows[0]?.length ?? 1);
        next.rows.forEach((row) => row.splice(col, 0, ""));
        next.aligns.splice(col, 0, "");
      }, () => ({ row: active().row, col, edit: true, select: true }));
    }),
    deleteColBtn,
    sep(),
    alignLeftBtn,
    alignCenterBtn,
    alignRightBtn,
    sep(),
    tableToolButton("↑", "Sort body rows ascending by active column", () => apply((next) => {
      if (next.rows.length > 100) return;
      next.rows = sortTableBodyRows(next.rows, active().col, 1, (row) => row);
    }, { row: Math.max(1, active().row), col: active().col })),
    tableToolButton("↓", "Sort body rows descending by active column", () => apply((next) => {
      if (next.rows.length > 100) return;
      next.rows = sortTableBodyRows(next.rows, active().col, -1, (row) => row);
    }, { row: Math.max(1, active().row), col: active().col })),
    tableToolButton("CSV", "Copy table as CSV", () => {
      const rows = readData().rows;
      if (rows.length <= 100) void writeSystemClipboard(tableRowsToCSV(rows));
    }),
    tableSizePickerButton(
      () => {
        const data = readData();
        return { rows: data.rows.length, cols: data.rows[0]?.length ?? 1 };
      },
      (rows, columns) => apply((next) => {
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
      }, { row: 1, col: 0, edit: true, select: true }),
    ),
  );
  if (layoutHost) {
    toolbar.append(
      tableLayoutPopoverButton(layoutHost.view, layoutHost.widget, layoutHost.readLayout),
      figureMoveGrip(layoutHost.view, layoutHost.widget),
    );
  }
  if (onDeleteTable) {
    const deleteBtn = tableToolButton("×", "Delete table", onDeleteTable);
    deleteBtn.className = "cm-table-toolbar-danger";
    toolbar.append(sep(), deleteBtn);
  }
  syncState();
  return { element: toolbar, syncState };
}

/** Compact `◫` button inside the table toolbar opening the unified figure layout controls. */
function tableLayoutPopoverButton(
  view: EditorView,
  widget: HTMLElement,
  readLayout: () => LayoutAttrs,
): HTMLElement {
  const host = document.createElement("span");
  host.className = "cm-table-layout-popover-host";
  let closePopover: (() => void) | null = null;
  const button = tableToolButton("◫", "Table layout (align, wrap, width)", () => {
    if (closePopover) {
      closePopover();
      return;
    }
    const cleanup = (): void => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
      popover.remove();
      button.classList.remove("is-active");
      closePopover = null;
    };
    const onOutside = (event: Event): void => {
      if (!(event.target instanceof Node) || !host.contains(event.target)) cleanup();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cleanup();
      }
    };
    const popover = figureLayoutToolbar(view, widget, readLayout(), {
      extraClass: "cm-table-layout-popover",
      preservesAspect: false,
      includeMoveGrip: false,
      onApplied: cleanup,
    });
    closePopover = cleanup;
    button.classList.add("is-active");
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    host.append(popover);
  });
  button.setAttribute("aria-label", "Table layout");
  host.append(button);
  return host;
}

class TableWidget extends MeasuredWidget {
  source: string;
  from: number;
  sourceTo: number;
  to: number;
  layout: LayoutAttrs;
  private disposeCellEditor: () => void = () => {};
  private domContext: { widget: TableWidget; data: MarkdownTableData } | null = null;

  protected get floatedBlock(): boolean { return this.layout.wrap; }

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
    return Math.max(96, 36 + rows * 34);
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

  updateDOM(dom: HTMLElement, view: EditorView, previous: TableWidget): boolean {
    const context = previous.domContext;
    if (!context || this.layout.align !== previous.layout.align || this.layout.wrap !== previous.layout.wrap
        || this.layout.width !== previous.layout.width || this.layout.height !== previous.layout.height) return false;
    const wrap = this.layout.wrap ? dom.firstElementChild as HTMLElement | null : dom;
    const table = wrap?.querySelector<HTMLTableElement>("table");
    if (!wrap || !table) return false;
    if (table.classList.contains("cm-markdown-table-editable") === view.state.readOnly) return false;
    const data = parseMarkdownTable(this.source);
    if (context.data.rows.length !== data.rows.length
        || context.data.rows.some((row, index) => row.length !== data.rows[index]!.length)) return false;
    const rows = Array.from(table.rows);
    if (rows.length !== data.rows.length || rows.some((row, index) => row.cells.length !== data.rows[index]!.length)) return false;

    context.widget = this;
    context.data.rows = data.rows;
    context.data.aligns = data.aligns;
    this.domContext = context;
    this.disposeCellEditor = previous.disposeCellEditor;
    syncPreviewTableColgroup(table, computeTableColumnPercentages(data.rows));
    rows.forEach((row, rowIndex) => {
      Array.from(row.cells).forEach((cell, col) => {
        const source = data.rows[rowIndex]![col]!;
        if (cell.dataset.source !== source) {
          const handles = Array.from(cell.children).filter((child) => child.classList.contains("cm-table-drag-handle"));
          cell.dataset.source = source;
          cell.innerHTML = renderInlineMarkdownHTML(source);
          cell.prepend(...handles);
        }
        cell.style.textAlign = data.aligns[col] ?? "";
      });
    });
    wrap.dataset.cmSourceFrom = String(this.from);
    wrap.dataset.cmSourceTo = String(this.to);
    wrap.dataset.cmSourceBaseTo = String(this.sourceTo);
    if (!this.layout.wrap) wrap.dataset.cmMeasureKey = this.measureKey();
    view.requestMeasure();
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const data = parseMarkdownTable(this.source);
    const context = { widget: this, data };
    this.domContext = context;
    const editable = !view.state.readOnly;
    const wrap = document.createElement("div");
    wrap.className = "cm-table-block cm-table-editable-block";
    wrap.dataset.cmSourceFrom = String(this.from);
    wrap.dataset.cmSourceTo = String(this.to);
    wrap.dataset.cmSourceBaseTo = String(this.sourceTo);
    wrap.dataset.cmOpenSource = "false";
    applyLayoutAttrs(wrap, "table", this.layout);
    if (this.layout.height) wrap.classList.add("cm-table-explicit-height");
    const currentTable = (): MarkdownTable | null => {
      const pos = view.posAtDOM(wrap);
      const tables = markdownTablesFromState(view.state);
      const found = tables[firstTableEndingAtOrAfter(tables, pos)];
      return found && found.from <= pos && found.to >= pos ? found : null;
    };
    const stopWidgetMouseEvent = (event: Event): void => {
      event.stopPropagation();
    };
    wrap.addEventListener("mousedown", stopWidgetMouseEvent);
    wrap.addEventListener("mouseup", stopWidgetMouseEvent);
    wrap.addEventListener("click", stopWidgetMouseEvent);
    wrap.addEventListener("dblclick", stopWidgetMouseEvent);

    let activeRow = 0;
    let activeCol = 0;
    let syncToolbar: () => void = () => {};
    const removeTable = (): void => {
      const current = currentTable();
      if (!current) return;
      const doc = view.state.doc;
      const to = current.to < doc.length && doc.sliceString(current.to, current.to + 1) === "\n" ? current.to + 1 : current.to;
      dispatchConstructEdit(view, {
        changes: { from: current.from, to },
        selection: { anchor: current.from },
        scrollIntoView: true,
      }, "delete");
      view.focus();
    };
    /** Write the cells' sources back as the table's Markdown. */
    const commit = (focusTarget?: TableFocusTarget | null): void => {
      const rows = tableRowsFromDOM(table);
      if (rows.length === 0) return;
      const current = currentTable();
      if (!current) return;
      const nextSource = buildMarkdownTableSource({ rows, aligns: context.data.aligns.slice(0, rows[0]!.length) });
      if (nextSource !== current.source) {
        dispatchConstructEdit(view, {
          changes: { from: current.from, to: current.sourceTo, insert: nextSource },
        });
        focusTableCellAfterRender(view, current.from, focusTarget);
      } else {
        focusTableCellInTable(table, focusTarget);
      }
      view.requestMeasure();
    };
    const apply = (
      mutate: (next: MarkdownTableData) => void,
      focusTarget?: TableFocusResolver,
    ): void => {
      const current = currentTable();
      if (!current) return;
      const rows = tableRowsFromDOM(table);
      const next = { rows, aligns: context.data.aligns.slice(0, rows[0]?.length ?? 1) };
      mutate(next);
      const nextSource = buildMarkdownTableSource(next);
      const target = typeof focusTarget === "function" ? focusTarget(next) : focusTarget;
      if (nextSource !== current.source) dispatchConstructEdit(view, {
        changes: { from: current.from, to: current.sourceTo, insert: nextSource },
      });
      focusTableCellAfterRender(view, current.from, target);
      view.requestMeasure();
    };

    const rendered = renderEditableTable(data, (row, col) => {
      activeRow = row;
      activeCol = col;
      syncToolbar();
    }, commit, view, () => currentTable()?.from ?? context.widget.from,
    (row, col, cellEl, event) => {
      const current = currentTable();
      if (!current) return;
      openTableCellFromPointer(view, current, cellEl, row, col, event);
    }, editable, {
      aligns: () => [...context.data.aligns],
      replace: (rows, aligns, focus) => apply((next) => {
        next.rows = rows;
        next.aligns = aligns;
      }, focus ?? undefined),
      remove: removeTable,
    });
    const table = rendered.table;
    const toolbar = createTableToolbar(
      apply,
      () => ({ row: activeRow, col: activeCol }),
      () => ({ rows: tableRowsFromDOM(table), aligns: [...context.data.aligns] }),
      removeTable,
      { view, widget: wrap, readLayout: () => currentTable()?.layout ?? context.widget.layout },
    );
    syncToolbar = toolbar.syncState;
    syncPreviewTableColgroup(table, computeTableColumnPercentages(data.rows));
    table.style.setProperty("--noema-table-row-count", String(data.rows.length));
    if (this.layout.height) table.classList.add("cm-table-explicit-height");
    this.disposeCellEditor = rendered.dispose;
    if (editable) {
      table.addEventListener("keydown", (event) => {
        if (event.isComposing || !["Enter", " "].includes(event.key)) return;
        const cell = event.target instanceof Element ? event.target.closest<HTMLTableCellElement>("td, th") : null;
        const current = currentTable();
        if (!cell || !current || event.target !== cell) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        focusDocumentTableCell(view, current, {
          row: Number(cell.dataset.row), col: Number(cell.dataset.col), edit: true, select: true,
        });
      }, true);
    }
    if (editable) installTableDragHandles(table, view, {
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
    if (editable) wrap.append(toolbar.element, table, addRowEdge, addColumnEdge, figureResizeHandle(view, wrap, "table"));
    else wrap.append(table);
    return this.registerMeasured(wrap, view);
  }

  ignoreEvent(): boolean { return true; }

  destroy(dom: HTMLElement): void {
    this.disposeCellEditor();
    super.destroy(dom);
  }
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

function tableSizePickerButton(
  readDimensions: () => { rows: number; cols: number },
  apply: (rows: number, columns: number) => void,
): HTMLElement {
  const host = document.createElement("span");
  host.className = "cm-table-size-picker-host";
  let closePicker: (() => void) | null = null;
  const button = tableToolButton("⊞", "Resize table with grid", () => {
    if (closePicker) {
      closePicker();
      return;
    }
    const current = readDimensions();
    const picker = document.createElement("span");
    picker.className = "cm-table-size-picker";
    picker.setAttribute("role", "grid");
    const grid = document.createElement("span");
    grid.className = "cm-table-size-grid";
    const label = document.createElement("span");
    label.className = "cm-table-size-label";
    label.textContent = `${current.rows} × ${current.cols}`;
    const cells: Array<{ el: HTMLButtonElement; row: number; col: number }> = [];

    const highlight = (targetRow: number, targetCol: number): void => {
      picker.dataset.rows = String(targetRow);
      picker.dataset.columns = String(targetCol);
      const shrinks = targetRow < current.rows || targetCol < current.cols;
      label.textContent = shrinks ? `${targetRow} × ${targetCol} (trim)` : `${targetRow} × ${targetCol}`;
      label.classList.toggle("is-shrink", shrinks);
      for (const item of cells) {
        const inRange = item.row <= targetRow && item.col <= targetCol;
        const isCurrent = item.row <= current.rows && item.col <= current.cols;
        item.el.classList.toggle("is-in-range", inRange);
        item.el.classList.toggle("is-current", isCurrent && !inRange);
        item.el.classList.toggle("is-shrink", shrinks && isCurrent && !inRange);
      }
    };

    const cleanup = (): void => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
      picker.remove();
      closePicker = null;
    };
    const onOutside = (event: Event): void => {
      if (!(event.target instanceof Node) || !host.contains(event.target)) cleanup();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cleanup();
      }
    };
    closePicker = cleanup;
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);

    for (let row = 2; row <= 8; row++) {
      for (let col = 1; col <= 8; col++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "cm-table-size-cell";
        cell.title = `${row} rows × ${col} columns`;
        cell.setAttribute("aria-label", cell.title);
        cell.style.setProperty("--table-picker-row", String(row - 1));
        cell.style.setProperty("--table-picker-col", String(col));
        cell.addEventListener("mouseenter", () => highlight(row, col));
        cell.addEventListener("focus", () => highlight(row, col));
        cell.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          cleanup();
          apply(row, col);
        });
        cells.push({ el: cell, row, col });
        grid.append(cell);
      }
    }
    highlight(Math.min(8, Math.max(2, current.rows)), Math.min(8, Math.max(1, current.cols)));
    picker.append(grid, label);
    host.append(picker);
  });
  host.append(button);
  return host;
}

function installTableDragHandles(
  table: HTMLTableElement,
  view: EditorView,
  callbacks: { moveRow: (from: number, to: number) => void; moveColumn: (from: number, to: number) => void },
): void {
  const maxInteractiveRows = 500;
  const maxInteractiveColumns = 64;
  const stop = (event: Event): void => event.stopPropagation();
  let activeDrag = "";
  const dragPayload = (event: DragEvent): string => activeDrag || event.dataTransfer?.getData("text/plain") || "";
  const interactiveRows = Array.from(table.rows).slice(0, maxInteractiveRows + 1);
  const clearDropClasses = (): void => {
    for (const row of interactiveRows) {
      row.classList.remove("is-row-hover", "is-row-drop-before", "is-row-drop-after");
      for (const cell of Array.from(row.cells)) {
        cell.classList.remove("is-column-hover", "is-col-drop-before", "is-col-drop-after");
      }
    }
  };
  const highlightColumn = (column: number, enabled: boolean, dropClass?: "is-col-drop-before" | "is-col-drop-after"): void => {
    interactiveRows.forEach((row) => {
      const cell = row.cells[column];
      if (!cell) return;
      cell.classList.toggle("is-column-hover", enabled);
      cell.classList.toggle("is-col-drop-before", enabled && dropClass === "is-col-drop-before");
      cell.classList.toggle("is-col-drop-after", enabled && dropClass === "is-col-drop-after");
    });
  };
  const openHandleMenu = (event: MouseEvent, cell: HTMLTableCellElement): void => {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    view.dom.dispatchEvent(new CustomEvent("noema:table-context-menu", {
      bubbles: true,
      cancelable: true,
      detail: {
        cell,
        x: rect.left || event.clientX,
        y: rect.bottom ? rect.bottom + 4 : event.clientY,
      },
    }));
  };

  interactiveRows.forEach((row, rowIndex) => {
    if (rowIndex < 1) return;
    const firstCell = row.cells[0] as HTMLTableCellElement | undefined;
    if (!firstCell) return;
    const handle = document.createElement("span");
    handle.className = "cm-table-drag-handle cm-table-row-drag-handle";
    handle.textContent = "⋮";
    handle.title = `Drag to move row ${rowIndex}; click for row menu`;
    handle.draggable = true;
    handle.addEventListener("mousedown", stop);
    handle.addEventListener("click", (event) => openHandleMenu(event, firstCell));
    handle.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      activeDrag = `row:${rowIndex}`;
      event.dataTransfer?.setData("text/plain", activeDrag);
      row.classList.add("is-row-dragging");
    });
    handle.addEventListener("dragend", () => {
      activeDrag = "";
      row.classList.remove("is-row-dragging");
      clearDropClasses();
    });
    row.addEventListener("dragover", (event) => {
      const payload = dragPayload(event);
      if (!payload.startsWith("row:")) return;
      event.preventDefault();
      event.stopPropagation();
      const from = Number(payload.slice(4));
      row.classList.add("is-row-hover");
      row.classList.toggle("is-row-drop-before", from > rowIndex);
      row.classList.toggle("is-row-drop-after", from < rowIndex);
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("is-row-hover", "is-row-drop-before", "is-row-drop-after");
    });
    row.addEventListener("drop", (event) => {
      const payload = dragPayload(event);
      clearDropClasses();
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
    handle.textContent = "⋯";
    handle.title = `Drag to move column ${columnIndex + 1}; click for column menu`;
    handle.draggable = true;
    handle.addEventListener("mousedown", stop);
    handle.addEventListener("click", (event) => openHandleMenu(event, cell));
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
      clearDropClasses();
    });
    cell.addEventListener("dragover", (event) => {
      const payload = dragPayload(event);
      if (!payload.startsWith("column:")) return;
      event.preventDefault();
      event.stopPropagation();
      const from = Number(payload.slice(7));
      highlightColumn(columnIndex, true, from > columnIndex ? "is-col-drop-before" : from < columnIndex ? "is-col-drop-after" : undefined);
    });
    cell.addEventListener("dragleave", () => highlightColumn(columnIndex, false));
    cell.addEventListener("drop", (event) => {
      const payload = dragPayload(event);
      clearDropClasses();
      if (!payload.startsWith("column:")) return;
      event.preventDefault();
      event.stopPropagation();
      callbacks.moveColumn(Number(payload.slice(7)), columnIndex);
    });
    cell.prepend(handle);
  });
}

/** Shared pointer click entry for both TableWidget preview cells and TableSourceCellWidget. */
function openTableCellFromPointer(
  view: EditorView,
  current: MarkdownTable,
  cellEl: Element,
  row: number,
  col: number,
  event: MouseEvent,
): boolean {
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (link && cellEl.contains(link) && isMarkdownLinkOpenEvent(event)) {
    const href = link.getAttribute("href") ?? "";
    if (href) {
      event.preventDefault();
      event.stopPropagation();
      view.dom.dispatchEvent(new CustomEvent("noema:open-url", {
        bubbles: true,
        cancelable: true,
        detail: { href, newWindow: markdownLinkOpensNewWindow(href, event), sourcePos: current.from },
      }));
      return true;
    }
  }
  const formula = event.target instanceof Element
    ? event.target.closest<HTMLElement>(".noema-math-inline") : null;
  const formulaIndex = formula && cellEl.contains(formula)
    ? Array.from(cellEl.querySelectorAll(".noema-math-inline")).indexOf(formula) : -1;
  if (formulaIndex >= 0 && focusDocumentTableFormula(view, current, row, col, formulaIndex, renderedFormulaClickRatio(formula!, event))) {
    return true;
  }
  const caretHit = renderedTextOffsetAtPoint(cellEl, event.clientX, event.clientY, ".cm-table-drag-handle");
  return focusDocumentTableCell(view, current, { row, col, edit: true, caretHit });
}

/** Focus a selected preview cell; text editing uses focusDocumentTableCell. */
function focusTableCellInTable(table: HTMLTableElement, target?: TableFocusTarget | null): boolean {
  if (!target || table.rows.length === 0) return false;
  const row = table.rows[Math.max(0, Math.min(target.row, table.rows.length - 1))];
  if (!row || row.cells.length === 0) return false;
  const cell = row.cells[Math.max(0, Math.min(target.col, row.cells.length - 1))] as HTMLTableCellElement | undefined;
  if (!cell) return false;
  cell.focus({ preventScroll: true });
  return true;
}

function focusDocumentTableCell(view: EditorView, table: MarkdownTable, target: TableFocusTarget): boolean {
  const firstLine = view.state.doc.lineAt(table.from).number;
  const lineNumber = firstLine + (target.row === 0 ? 0 : target.row + 1);
  if (lineNumber > view.state.doc.lines) return false;
  const line = view.state.doc.line(lineNumber);
  if (line.from >= table.sourceTo) return false;
  const range = tableCellTarget(line.text, target.col);
  const from = line.from + range.anchor;
  const to = line.from + range.head;
  let anchor: number;
  if (target.caretHit) {
    const cellSource = line.text.slice(range.anchor, range.head);
    anchor = from + mapRenderedOffsetToSource(cellSource, target.caretHit.offset, target.caretHit.total);
  } else {
    anchor = target.caret === "start" ? from : to;
  }
  preserveEditorViewport(view, () => {
    view.dispatch({ selection: target.select ? { anchor: from, head: to } : { anchor } });
    view.focus();
  }, table.from);
  return true;
}

/** Map a rendered formula to its source and enter the ordinary CM6 formula flow. */
function focusDocumentTableFormula(
  view: EditorView,
  table: MarkdownTable,
  row: number,
  col: number,
  formulaIndex: number,
  clickRatio = 0,
): boolean {
  const firstLine = view.state.doc.lineAt(table.from).number;
  const lineNumber = firstLine + (row === 0 ? 0 : row + 1);
  if (lineNumber > view.state.doc.lines) return false;
  const line = view.state.doc.line(lineNumber);
  if (line.from >= table.sourceTo) return false;
  const cell = tableCellTarget(line.text, col);
  const formula = tableCellMathRanges(line.text.slice(cell.anchor, cell.head))[formulaIndex];
  if (!formula) return false;
  const from = line.from + cell.anchor + formula.from;
  return openRenderedFormulaSource(view, {
    display: false,
    from,
    to: line.from + cell.anchor + formula.to,
    contentFrom: from + 2,
    contentTo: line.from + cell.anchor + formula.to - 2,
  }, clickRatio, table.from);
}

function focusTableCellAfterRender(
  view: EditorView,
  tableFrom: number,
  target?: TableFocusTarget | null,
): void {
  if (!target) return;
  window.requestAnimationFrame(() => {
    const current = markdownTablesFromState(view.state).find((candidate) => candidate.from === tableFrom);
    if (target.edit && current && focusDocumentTableCell(view, current, target)) return;
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
  view: EditorView,
  tableFrom: () => number,
  openFromPointer: (row: number, col: number, cellEl: HTMLTableCellElement, event: MouseEvent) => void,
  editable = true,
  structure: TableStructureActions | null = null,
): { table: HTMLTableElement; dispose: () => void } {
  const table = document.createElement("table");
  table.className = editable ? "cm-markdown-table-preview cm-markdown-table-editable" : "cm-markdown-table-preview";
  // The preview is a selection surface; cell text and formulas use the main editor.
  const colCount = data.rows[0]?.length ?? 1;
  const restorePreview = (cell: HTMLTableCellElement): void => {
    const handles = Array.from(cell.children).filter((child) => child.classList.contains("cm-table-drag-handle"));
    cell.innerHTML = renderInlineMarkdownHTML(cell.dataset.source ?? "");
    cell.prepend(...handles);
  };
  // ── Rectangular cell selection (MarkText TableRectSelection) ───────────
  let rectAnchor: TableCellPosition | null = null;
  let rectFocus: TableCellPosition | null = null;
  let lastCell: TableCellPosition | null = null;
  let drag: { origin: TableCellPosition; selecting: boolean } | null = null;
  const RECT_CLASSES = ["cm-table-cell-selected", "cm-table-rect-top", "cm-table-rect-bottom", "cm-table-rect-left", "cm-table-rect-right"];
  const cellElement = (pos: TableCellPosition): HTMLTableCellElement | undefined =>
    table.rows[pos.row]?.cells[pos.col] as HTMLTableCellElement | undefined;
  const paintRect = (): void => {
    for (const cell of Array.from(table.querySelectorAll(".cm-table-cell-selected"))) cell.classList.remove(...RECT_CLASSES);
    table.classList.toggle("cm-table-rect-active", Boolean(rectAnchor && rectFocus));
    if (!rectAnchor || !rectFocus) return;
    const rect = tableCellRect(rectAnchor, rectFocus);
    for (let row = rect.top; row <= rect.bottom; row++) {
      for (let col = rect.left; col <= rect.right; col++) {
        const classes = cellElement({ row, col })?.classList;
        if (!classes) continue;
        classes.add("cm-table-cell-selected");
        if (row === rect.top) classes.add("cm-table-rect-top");
        if (row === rect.bottom) classes.add("cm-table-rect-bottom");
        if (col === rect.left) classes.add("cm-table-rect-left");
        if (col === rect.right) classes.add("cm-table-rect-right");
      }
    }
  };
  const clearRect = (): void => {
    if (!rectAnchor && !rectFocus) return;
    rectAnchor = null;
    rectFocus = null;
    paintRect();
  };
  const selectRect = (anchor: TableCellPosition, focus: TableCellPosition, focusCell = true): void => {
    rectAnchor = anchor;
    rectFocus = focus;
    paintRect();
    window.getSelection?.()?.removeAllRanges();
    if (focusCell) cellElement(focus)?.focus({ preventScroll: true });
  };
  const tableRows = (): string[][] => tableRowsFromDOM(table);
  const setCellSources = (rect: TableCellRect, value: string): void => {
    for (let row = rect.top; row <= rect.bottom; row++) {
      for (let col = rect.left; col <= rect.right; col++) {
        const cell = cellElement({ row, col });
        if (!cell || (cell.dataset.source ?? "") === value) continue;
        cell.dataset.source = value;
        restorePreview(cell);
      }
    }
  };
  /** First press empties the cells; on empty cells it removes the structure they span. */
  const deleteRect = (allowStructure: boolean): void => {
    if (!rectAnchor || !rectFocus) return;
    const rect = tableCellRect(rectAnchor, rectFocus);
    const rows = tableRows();
    if (clearRectCells(rows, rect)) {
      setCellSources(rect, "");
      commit(null);
      paintRect();
      cellElement(rectFocus)?.focus({ preventScroll: true });
      return;
    }
    const removal = allowStructure && structure ? removeRectStructure(rows, structure.aligns(), rect) : null;
    clearRect();
    if (!removal || !structure) return;
    if (removal.kind === "table") structure.remove();
    else {
      const rowCount = removal.rows.length;
      const colCount = removal.rows[0]?.length ?? 1;
      structure.replace(removal.rows, removal.kind === "columns" ? removal.aligns as MarkdownTableData["aligns"] : structure.aligns(), {
        row: Math.max(0, Math.min(rect.top, rowCount - 1)),
        col: Math.max(0, Math.min(rect.left, colCount - 1)),
      });
    }
  };
  const copyRect = (): void => {
    if (!rectAnchor || !rectFocus) return;
    const rect = tableCellRect(rectAnchor, rectFocus);
    const cells = rectCellSources(tableRows(), rect);
    const aligns = (structure?.aligns() ?? []).slice(rect.left, rect.right + 1);
    // One cell copies as its text; a rectangle as a GFM table whose first
    // selected row becomes the header, as MarkText's copy does.
    const text = rectIsSingleCell(rect) ? cells[0]?.[0] ?? "" : buildMarkdownTableSource({ rows: cells, aligns });
    void writeSystemClipboard(text);
  };
  /** Keys over a selected rectangle; returns false to let the cell handle the key. */
  const handleRectKey = (event: KeyboardEvent): boolean => {
    if (!rectAnchor || !rectFocus) return false;
    const mod = (event.metaKey || event.ctrlKey) && !event.altKey;
    const key = event.key.toLowerCase();
    if (event.key === "Escape") {
      clearRect();
    } else if ((event.key === "Backspace" || event.key === "Delete") && !mod) {
      deleteRect(true);
    } else if (mod && key === "a" && !event.shiftKey) {
      const rowCount = table.rows.length;
      if (rectCoversTable(tableCellRect(rectAnchor, rectFocus), rowCount, colCount)) {
        // Cell → table → document, as MarkText's selectAll escalates.
        clearRect();
        view.focus();
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length }, userEvent: "select" });
      } else {
        selectRect({ row: 0, col: 0 }, { row: rowCount - 1, col: colCount - 1 });
      }
    } else if (mod && key === "c" && !event.shiftKey) {
      copyRect();
    } else if (mod && key === "x" && !event.shiftKey) {
      copyRect();
      const rect = tableCellRect(rectAnchor, rectFocus);
      if (rectCoversTable(rect, table.rows.length, colCount) && structure) {
        clearRect();
        structure.remove();
      } else deleteRect(false);
    } else if (event.shiftKey && !mod && event.key.startsWith("Arrow")) {
      const [dr, dc] = event.key === "ArrowUp" ? [-1, 0] : event.key === "ArrowDown" ? [1, 0]
        : event.key === "ArrowLeft" ? [0, -1] : [0, 1];
      selectRect(rectAnchor, {
        row: Math.max(0, Math.min(table.rows.length - 1, rectFocus.row + dr)),
        col: Math.max(0, Math.min(colCount - 1, rectFocus.col + dc)),
      });
    } else {
      clearRect();
      return false;
    }
    event.preventDefault();
    return true;
  };
  const cellPositionAt = (target: EventTarget | null): TableCellPosition | null => {
    const cell = target instanceof Element ? target.closest<HTMLTableCellElement>("td, th") : null;
    if (!cell || !table.contains(cell)) return null;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    return Number.isFinite(row) && Number.isFinite(col) ? { row, col } : null;
  };
  const onDragMove = (event: MouseEvent): void => {
    if (!drag) return;
    if (!(event.buttons & 1)) { endDrag(); return; }
    const pos = cellPositionAt(event.target);
    if (!pos) return;
    if (!drag.selecting) {
      // Within one cell the pointer is placing a caret; leaving it selects cells.
      if (pos.row === drag.origin.row && pos.col === drag.origin.col) return;
      drag.selecting = true;
      selectRect(drag.origin, pos, false);
      return;
    }
    if (rectFocus && pos.row === rectFocus.row && pos.col === rectFocus.col) return;
    rectFocus = pos;
    paintRect();
    window.getSelection?.()?.removeAllRanges();
  };
  const endDrag = (): void => {
    const finished = drag;
    drag = null;
    document.removeEventListener("mousemove", onDragMove, true);
    document.removeEventListener("mouseup", endDrag, true);
    if (finished?.selecting && rectFocus) cellElement(rectFocus)?.focus({ preventScroll: true });
  };
  const startDrag = (pos: TableCellPosition): void => {
    endDrag();
    drag = { origin: pos, selecting: false };
    // Capture: the widget stops mouseup from bubbling past its wrapper.
    document.addEventListener("mousemove", onDragMove, true);
    document.addEventListener("mouseup", endDrag, true);
  };
  if (editable) {
    table.addEventListener("focusout", (event) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !table.contains(next)) clearRect();
    });
  }

  const addCellEvents = (cell: HTMLTableCellElement, row: number, col: number): void => {
    if (!editable) return;
    cell.tabIndex = 0;
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    cell.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      if (event.button === 0 && event.shiftKey) {
        event.preventDefault();
        selectRect(rectAnchor ?? lastCell ?? { row, col }, { row, col });
        return;
      }
      clearRect();
      lastCell = { row, col };
      if (event.button === 0) startDrag({ row, col });
      setActiveCell(row, col);
      event.preventDefault();
    });
    cell.addEventListener("focus", () => {
      if (rectAnchor && rectFocus && !rectContains(tableCellRect(rectAnchor, rectFocus), row, col)) clearRect();
      lastCell = { row, col };
      setActiveCell(row, col);
    });
    cell.addEventListener("click", (event) => {
      event.stopPropagation();
      setActiveCell(row, col);
      if (rectAnchor || (event.target instanceof Element && event.target.closest("button, .cm-table-drag-handle"))) return;
      openFromPointer(row, col, cell, event);
    });
    cell.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.target === cell && handleRectKey(event)) return;
      if (event.target === cell && event.shiftKey && event.key.startsWith("Arrow")
          && !event.metaKey && !event.ctrlKey && !event.altKey) {
        // Shift+Arrow from a selected cell starts a rectangle.
        event.preventDefault();
        const step = event.key === "ArrowUp" ? [-1, 0] : event.key === "ArrowDown" ? [1, 0]
          : event.key === "ArrowLeft" ? [0, -1] : [0, 1];
        selectRect({ row, col }, {
          row: Math.max(0, Math.min(table.rows.length - 1, row + step[0]!)),
          col: Math.max(0, Math.min(colCount - 1, col + step[1]!)),
        });
        return;
      }
      const historyKey = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && !event.altKey
          && (historyKey === "z" || (historyKey === "y" && event.ctrlKey))) {
        event.preventDefault();
        const from = tableFrom();
        const command = historyKey === "y" || event.shiftKey ? redo : undo;
        if (command(view)) focusTableCellAfterRender(view, from, { row, col });
        return;
      }
      const step = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ? null
        : event.key === "ArrowUp" ? [-1, 0] : event.key === "ArrowDown" ? [1, 0]
          : event.key === "ArrowLeft" ? [0, -1] : event.key === "ArrowRight" ? [0, 1] : null;
      if (step && event.target === cell) {
        // A selected (not edited) cell moves like a spreadsheet cursor.
        event.preventDefault();
        focusTableCellInTable(table, {
          row: Math.max(0, Math.min(table.rows.length - 1, row + step[0]!)),
          col: Math.max(0, Math.min(colCount - 1, col + step[1]!)),
        });
        return;
      }
    });
  };

  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  for (let col = 0; col < colCount; col++) {
    const th = document.createElement("th");
    const source = data.rows[0]?.[col] ?? "";
    th.dataset.source = source;
    th.innerHTML = renderInlineMarkdownHTML(source);
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
      td.innerHTML = renderInlineMarkdownHTML(source);
      const align = data.aligns[col] ?? "";
      if (align) td.style.textAlign = align;
      addCellEvents(td, bodyIndex + 1, col);
    }
  });

  return { table, dispose: () => {
    endDrag();
  } };
}

function tableRowsFromDOM(table: HTMLTableElement): string[][] {
  return Array.from(table.rows).map((row) =>
    Array.from(row.cells).map((cell) => cell.dataset.source ?? cell.textContent ?? ""));
}

const markdownTablesField = StateField.define<readonly MarkdownTable[]>({
  create: collectMarkdownTables,
  update(tables, tr) {
    if (tr.docChanged) {
      return canMapMarkdownTables(tr.startState.doc, tables, tr.changes)
        ? mapMarkdownTables(tables, tr.changes)
        : updateMarkdownTablesNearChanges(tr.startState, tr.state, tables, tr.changes) ?? collectMarkdownTables(tr.state);
    }
    return tables;
  },
});

/** Sync the active table row's minimum height to its tallest positioned inactive cell's natural content. */
function syncActiveTableRowMinHeight(cell: HTMLElement, view: EditorView): void {
  const rowEl = cell.closest<HTMLElement>(".cm-table-source-has-active");
  if (!rowEl || !rowEl.isConnected) return;
  let tallest = 0;
  for (const sibling of rowEl.querySelectorAll<HTMLElement>(".cm-table-source-positioned-cell")) {
    const inner = sibling.querySelector<HTMLElement>(".cm-table-source-cell-content");
    const h = inner ? inner.offsetHeight : sibling.offsetHeight;
    if (h > tallest) tallest = h;
  }
  const style = rowEl.ownerDocument.defaultView?.getComputedStyle(rowEl);
  const borderY = (Number.parseFloat(style?.borderTopWidth || "0") || 0)
    + (Number.parseFloat(style?.borderBottomWidth || "0") || 0);
  const next = tallest > 0 ? `${Math.ceil(tallest + borderY)}px` : "";
  if (rowEl.style.getPropertyValue("--noema-table-active-row-min-h") !== next) {
    const beforeHeight = rowEl.offsetHeight;
    if (next) rowEl.style.setProperty("--noema-table-active-row-min-h", next);
    else rowEl.style.removeProperty("--noema-table-active-row-min-h");
    if (rowEl.offsetHeight !== beforeHeight) view.requestMeasure();
  }
}

/** Render an inactive cell while its neighbour remains editable in the main CM6 view. */
class TableSourceCellWidget extends WidgetType {
  readonly source: string;
  readonly row: number;
  readonly col: number;
  readonly align: string;
  readonly last: boolean;
  readonly onActiveRow: boolean;
  readonly colLeft: number;
  readonly colWidth: number;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    source: string,
    row: number,
    col: number,
    align: string,
    last: boolean,
    onActiveRow = false,
    colLeft = 0,
    colWidth = 0,
  ) {
    super();
    this.source = source;
    this.row = row;
    this.col = col;
    this.align = align;
    this.last = last;
    this.onActiveRow = onActiveRow;
    this.colLeft = colLeft;
    this.colWidth = colWidth;
  }

  eq(other: TableSourceCellWidget): boolean {
    return this.source === other.source && this.row === other.row
      && this.col === other.col && this.align === other.align && this.last === other.last
      && this.onActiveRow === other.onActiveRow
      && this.colLeft === other.colLeft && this.colWidth === other.colWidth;
  }

  toDOM(view: EditorView): HTMLElement {
    const cell = document.createElement("span");
    cell.className = "cm-table-source-cell cm-table-source-rendered-cell";
    if (this.last) cell.classList.add("cm-table-source-last-cell");
    let measureTarget: HTMLElement = cell;
    if (this.onActiveRow) {
      cell.classList.add("cm-table-source-positioned-cell");
      cell.style.left = `${this.colLeft}%`;
      cell.style.width = `${this.colWidth}%`;
      const content = document.createElement("span");
      content.className = "cm-table-source-cell-content";
      content.innerHTML = renderInlineMarkdownHTML(this.source) || "&nbsp;";
      cell.append(content);
      measureTarget = content;
    } else {
      // Pin inactive cells explicitly to their grid track so CM6's inline
      // `<img class="cm-widgetBuffer">` nodes can never displace columns.
      cell.style.gridColumn = String(this.col + 1);
      cell.style.gridRow = "1";
      cell.innerHTML = renderInlineMarkdownHTML(this.source) || "&nbsp;";
    }
    cell.setAttribute("role", "cell");
    cell.dataset.row = String(this.row);
    cell.dataset.col = String(this.col);
    if (this.align) cell.style.textAlign = this.align;
    cell.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      // Allow Cmd/Ctrl-click to open links directly without switching cell edit focus.
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (link && cell.contains(link) && isMarkdownLinkOpenEvent(event)) {
        const href = link.getAttribute("href") ?? "";
        if (href) {
          event.preventDefault();
          event.stopPropagation();
          let sourcePos = 0;
          try { sourcePos = view.posAtDOM(cell); } catch { /* ignore */ }
          view.dom.dispatchEvent(new CustomEvent("noema:open-url", {
            bubbles: true,
            cancelable: true,
            detail: { href, newWindow: markdownLinkOpensNewWindow(href, event), sourcePos },
          }));
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      const hit = renderedTextOffsetAtPoint(cell, event.clientX, event.clientY, ".cm-table-drag-handle");
      const formula = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".noema-math-inline") : null;
      const formulaIndex = formula && cell.contains(formula)
        ? Array.from(cell.querySelectorAll(".noema-math-inline")).indexOf(formula) : -1;
      const formulaClickRatio = formula ? renderedFormulaClickRatio(formula, event) : 0;
      // Run on microtask (same frame, after any synchronous CM6 DOM reconcile).
      queueMicrotask(() => {
        if (!cell.isConnected || !view.dom.isConnected) return;
        const table = tableAt(view.state, view.posAtDOM(cell));
        if (!table) return;
        if (formulaIndex >= 0 && focusDocumentTableFormula(view, table, this.row, this.col, formulaIndex, formulaClickRatio)) return;
        focusDocumentTableCell(view, table, { row: this.row, col: this.col, edit: true, caretHit: hit });
      });
    });
    if (this.onActiveRow && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => syncActiveTableRowMinHeight(cell, view));
      ro.observe(measureTarget);
      this.resizeObserver = ro;
    }
    return cell;
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  ignoreEvent(): boolean { return true; }
}

/** Keep the table's structural controls present while a cell uses CM6 text. */
class TableSourceToolbarWidget extends MeasuredWidget {
  readonly from: number;
  readonly layout: LayoutAttrs;
  readonly activeRow: number;
  readonly activeCol: number;
  readonly alignKey: string;

  protected get floatedBlock(): boolean { return false; }

  constructor(from: number, layout: LayoutAttrs, activeRow: number, activeCol: number, alignKey: string) {
    super();
    this.from = from;
    this.layout = layout;
    this.activeRow = activeRow;
    this.activeCol = activeCol;
    this.alignKey = alignKey;
  }

  protected measureKey(): string { return "tbl-bar:" + this.from; }

  protected estimatedHeightFallback(): number { return 6; }

  eq(other: TableSourceToolbarWidget): boolean {
    return this.from === other.from
      && this.activeRow === other.activeRow
      && this.activeCol === other.activeCol
      && this.alignKey === other.alignKey
      && this.layout.align === other.layout.align
      && this.layout.wrap === other.layout.wrap
      && this.layout.width === other.layout.width
      && this.layout.height === other.layout.height;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-source-toolbar cm-table-editable-block";
    applyLayoutAttrs(wrap, "table", this.layout);
    const currentTable = (): MarkdownTable | null => {
      if (!wrap.isConnected) return null;
      return tableAt(view.state, view.posAtDOM(wrap));
    };
    const refreshSourceRange = (): void => {
      const table = currentTable() ?? tableAt(view.state, this.from);
      if (!table) return;
      wrap.dataset.cmSourceFrom = String(table.from);
      wrap.dataset.cmSourceTo = String(table.to);
      wrap.dataset.cmSourceBaseTo = String(table.sourceTo);
    };
    refreshSourceRange();
    wrap.addEventListener("click", refreshSourceRange, true);
    wrap.addEventListener("pointerdown", refreshSourceRange, true);
    const active = (): { row: number; col: number } => {
      const table = currentTable();
      if (!table) return { row: Math.max(0, this.activeRow), col: Math.max(0, this.activeCol) };
      const firstLine = view.state.doc.lineAt(table.from).number;
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      return {
        row: Math.max(0, line.number === firstLine ? 0 : line.number - firstLine - 1),
        col: Math.max(0, tableSourceActiveColumn(view.state, line)),
      };
    };
    const apply = (
      mutate: (next: MarkdownTableData) => void,
      focus?: TableFocusResolver,
    ): void => {
      const table = currentTable();
      if (!table) return;
      const next = parseMarkdownTable(table.source);
      mutate(next);
      const source = buildMarkdownTableSource(next);
      const requested = typeof focus === "function" ? focus(next) : focus;
      const target = { ...(requested ?? active()), edit: true };
      if (source !== table.source) dispatchConstructEdit(view, {
        changes: { from: table.from, to: table.sourceTo, insert: source },
      });
      focusTableCellAfterRender(view, table.from, target);
      view.requestMeasure();
    };
    const removeTable = (): void => {
      const table = currentTable();
      if (!table) return;
      const doc = view.state.doc;
      const to = table.to < doc.length && doc.sliceString(table.to, table.to + 1) === "\n" ? table.to + 1 : table.to;
      dispatchConstructEdit(view, {
        changes: { from: table.from, to },
        selection: { anchor: table.from },
        scrollIntoView: true,
      }, "delete");
      view.focus();
    };
    const toolbar = createTableToolbar(
      apply,
      active,
      () => {
        const table = currentTable() ?? tableAt(view.state, this.from);
        return table ? parseMarkdownTable(table.source) : { rows: [[]], aligns: [] };
      },
      removeTable,
      { view, widget: wrap, readLayout: () => currentTable()?.layout ?? this.layout },
    );
    wrap.append(toolbar.element);
    return this.registerMeasured(wrap, view);
  }

  ignoreEvent(): boolean { return true; }
}

/** Bottom edge `+` strip and live width resize handle kept present while editing a table in CM6. */
class TableSourceEdgeWidget extends MeasuredWidget {
  readonly from: number;
  readonly layout: LayoutAttrs;

  protected get floatedBlock(): boolean { return false; }

  constructor(from: number, layout: LayoutAttrs) {
    super();
    this.from = from;
    this.layout = layout;
  }

  protected measureKey(): string { return "tbl-edge:" + this.from; }

  protected estimatedHeightFallback(): number { return 14; }

  eq(other: TableSourceEdgeWidget): boolean {
    return this.from === other.from
      && this.layout.align === other.layout.align
      && this.layout.wrap === other.layout.wrap
      && this.layout.width === other.layout.width
      && this.layout.height === other.layout.height;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-source-edge cm-table-editable-block";
    applyLayoutAttrs(wrap, "table", this.layout);
    const currentTable = (): MarkdownTable | null => {
      if (!wrap.isConnected) return null;
      const pos = Math.max(0, view.posAtDOM(wrap) - 1);
      return tableAt(view.state, pos) ?? tableAt(view.state, this.from);
    };
    const refreshSourceRange = (): void => {
      const table = currentTable() ?? tableAt(view.state, this.from);
      if (!table) return;
      wrap.dataset.cmSourceFrom = String(table.from);
      wrap.dataset.cmSourceTo = String(table.to);
      wrap.dataset.cmSourceBaseTo = String(table.sourceTo);
    };
    refreshSourceRange();
    wrap.addEventListener("pointerdown", refreshSourceRange, true);
    wrap.addEventListener("keydown", refreshSourceRange, true);

    /** Mirror live `%` drag width across every sibling row and top toolbar of this editing table. */
    const savedWidths = new Map<HTMLElement, string>();
    const previewTableWidth = (widthCss: string | null): void => {
      if (widthCss === null) {
        for (const [el, prev] of savedWidths) {
          if (prev) el.style.setProperty("--noema-table-width", prev);
          else el.style.removeProperty("--noema-table-width");
        }
        savedWidths.clear();
        return;
      }
      let cursor = wrap.previousElementSibling as HTMLElement | null;
      while (cursor) {
        if (cursor.classList.contains("cm-table-source-row")
          || cursor.classList.contains("cm-table-source-rule")
          || cursor.classList.contains("cm-table-source-toolbar")) {
          if (!savedWidths.has(cursor)) savedWidths.set(cursor, cursor.style.getPropertyValue("--noema-table-width"));
          cursor.style.setProperty("--noema-table-width", widthCss);
          if (cursor.classList.contains("cm-table-source-toolbar")) break;
          cursor = cursor.previousElementSibling as HTMLElement | null;
        } else {
          break;
        }
      }
    };

    const addRow = tableToolButton("+", "Add row at table edge", () => {
      const table = currentTable();
      if (!table) return;
      const next = parseMarkdownTable(table.source);
      const width = next.rows[0]?.length ?? 1;
      next.rows.push(Array(width).fill(""));
      const source = buildMarkdownTableSource(next);
      dispatchConstructEdit(view, {
        changes: { from: table.from, to: table.sourceTo, insert: source },
      });
      focusTableCellAfterRender(view, table.from, { row: next.rows.length - 1, col: 0, edit: true, select: true });
      view.requestMeasure();
    });
    addRow.className = "cm-table-edge-add cm-table-edge-add-row";
    const addCol = tableToolButton("+", "Add column at table edge", () => {
      const table = currentTable();
      if (!table) return;
      const next = parseMarkdownTable(table.source);
      next.rows.forEach((row) => row.push(""));
      next.aligns.push("");
      const source = buildMarkdownTableSource(next);
      dispatchConstructEdit(view, {
        changes: { from: table.from, to: table.sourceTo, insert: source },
      });
      focusTableCellAfterRender(view, table.from, { row: 0, col: (next.rows[0]?.length ?? 1) - 1, edit: true, select: true });
      view.requestMeasure();
    });
    addCol.className = "cm-table-edge-add cm-table-edge-add-column cm-table-source-edge-add-column";
    wrap.append(addRow, addCol, figureResizeHandle(view, wrap, "table", wrap, { onPreviewWidth: previewTableWidth }));
    return this.registerMeasured(wrap, view);
  }

  ignoreEvent(): boolean { return true; }
}

function buildTableDecoRanges(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): Range<Decoration>[] {
  const decos: Range<Decoration>[] = [];
  const tables = markdownTablesFromState(state);

  for (let index = firstTableEndingAtOrAfter(tables, from);
       index < tables.length && tables[index]!.from <= to; index++) {
    const table = tables[index]!;
    const opened = tableOpened(state, table);
    if (!opened && isDocumentDataBody(state, table.from, table.to)) continue;
    if (opened) {
      const data = parseMarkdownTable(table.source);
      const doc = state.doc;
      const first = doc.lineAt(table.from).number;
      const headLine = doc.lineAt(visualSelection(state).main.head);
      const onTable = headLine.from >= table.from && headLine.to <= table.sourceTo;
      const activeRow = onTable ? (headLine.number === first ? 0 : Math.max(0, headLine.number - first - 1)) : 0;
      const activeCol = onTable ? Math.max(0, tableSourceActiveColumn(state, headLine)) : 0;
      if (!state.readOnly) decos.push(Decoration.widget({
        widget: new TableSourceToolbarWidget(table.from, table.layout, activeRow, activeCol, data.aligns.join(",")),
        block: true,
        side: -1,
      }).range(table.from));
      decos.push(...tableSourceGridDecos(state, table, data));
      if (!state.readOnly) decos.push(Decoration.widget({
        widget: new TableSourceEdgeWidget(table.from, table.layout),
        block: true,
        side: 1,
      }).range(table.sourceTo));
      continue;
    }
    decos.push(
      Decoration.replace({
        widget: new TableWidget(table.source, table.from, table.sourceTo, table.to, table.layout),
        block: true,
      }).range(table.from, table.to),
    );
  }

  return decos;
}

function tableSourceActiveColumn(state: EditorState, line: ReturnType<Text["line"]>): number {
  const selection = visualSelection(state).main;
  if (state.doc.lineAt(selection.head).number !== line.number) return -1;
  return tableCellColumnAtOffset(line.text, selection.head - line.from);
}

/** Keep the active cell as native CM6 block flow and render every other cell in place. */
function tableSourceGridDecos(
  state: EditorState,
  table: MarkdownTable,
  parsed?: MarkdownTableData,
): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  const first = doc.lineAt(table.from).number;
  const last = doc.lineAt(table.sourceTo).number;
  const data = parsed ?? parseMarkdownTable(table.source);
  const aligns = data.aligns;
  const columns = aligns.length;
  const colWidths = computeTableColumnPercentages(data.rows);
  const colLefts: number[] = [];
  let accum = 0;
  for (let c = 0; c < colWidths.length; c++) {
    colLefts.push(Number(accum.toFixed(2)));
    accum += colWidths[c]!;
  }
  const colTemplate = colWidths.map((w) => `${w}%`).join(" ");
  const layoutClass = layoutClasses("table", table.layout);
  const layoutCss = layoutStyle("table", table.layout);
  const caretLine = doc.lineAt(visualSelection(state).main.head).number;
  for (let number = first; number <= last; number++) {
    const line = doc.line(number);
    const separator = number === first + 1;
    if (separator) {
      ranges.push(Decoration.line({
        attributes: {
          class: `cm-table-source-rule${caretLine === number ? " cm-table-source-rule-active" : ""}`,
          style: layoutCss,
        },
      }).range(line.from));
      continue;
    }

    const { pipes, cells, hasLeadingPipe, hasTrailingPipe } = tableSourceRowParts(line.text);
    const activeCol = number === caretLine ? Math.min(cells.length - 1, Math.max(0, tableSourceActiveColumn(state, line))) : -1;
    const isActiveRow = activeCol >= 0;
    const totalCols = Math.max(cells.length, columns);
    const activeIsLast = isActiveRow && activeCol === totalCols - 1;
    const row = number === first ? 0 : number - first - 1;
    const activeLeft = isActiveRow ? (colLefts[activeCol] ?? 0) : 0;
    const activeWidth = isActiveRow ? (colWidths[activeCol] ?? (100 / Math.max(1, columns))) : 100;
    const activeRight = isActiveRow ? Math.max(0, Number((100 - activeLeft - activeWidth).toFixed(2))) : 0;
    const activeLeftRatio = isActiveRow ? Number((activeLeft / 100).toFixed(4)) : 0;
    const activeRightRatio = isActiveRow ? Number((activeRight / 100).toFixed(4)) : 0;
    const activeAlign = isActiveRow ? (aligns[activeCol] || (row === 0 ? "center" : "left")) : "left";

    ranges.push(Decoration.line({
      attributes: {
        class: `cm-table-source-row ${layoutClass}${isActiveRow ? " cm-table-source-has-active" : ""}${activeIsLast ? " cm-table-source-active-is-last" : ""}${table.layout.height ? " cm-table-source-explicit-height" : ""}${number === first ? " cm-table-source-header" : ""}${number === last ? " cm-table-source-last-row" : ""}${number > first + 1 && (number - first - 1) % 2 === 0 ? " cm-table-source-alt-row" : ""}`,
        style: `--noema-table-cols:${columns};--noema-table-row-count:${data.rows.length};--noema-table-col-template:${colTemplate};${isActiveRow ? `--noema-table-active-left:${activeLeft}%;--noema-table-active-width:${activeWidth}%;--noema-table-active-right:${activeRight}%;--noema-table-active-left-ratio:${activeLeftRatio};--noema-table-active-right-ratio:${activeRightRatio};--noema-table-active-align:${activeAlign};` : ""}${layoutCss}`,
      },
    }).range(line.from));

    // Keep leading/trailing spaces outside outer pipes out of CSS Grid / text flow.
    const firstUsed = hasLeadingPipe ? pipes[0]! : (cells[0]?.from ?? 0);
    if (firstUsed > 0) {
      ranges.push(Decoration.mark({ class: "cm-table-source-pipe" }).range(line.from, line.from + firstUsed));
    }
    const lastUsed = hasTrailingPipe ? pipes[pipes.length - 1]! + 1 : (cells[cells.length - 1]?.to ?? line.text.length);
    if (lastUsed < line.text.length) {
      ranges.push(Decoration.mark({ class: "cm-table-source-pipe" }).range(line.from + lastUsed, line.to));
    }

    for (const offset of pipes) {
      ranges.push(Decoration.mark({ class: "cm-table-source-pipe" }).range(line.from + offset, line.from + offset + 1));
    }
    for (let col = 0; col < cells.length; col++) {
      const { from, to } = cells[col]!;
      const sourceFrom = line.from + from;
      const sourceTo = line.from + to;
      const closingPipeTo = pipes.includes(to) ? sourceTo + 1 : sourceTo;
      const isLastCol = col === totalCols - 1;
      if (col !== activeCol) {
        const widget = new TableSourceCellWidget(
          data.rows[row]?.[col] ?? "",
          row,
          col,
          aligns[col] ?? "",
          isLastCol,
          isActiveRow,
          colLefts[col] ?? 0,
          colWidths[col] ?? (100 / Math.max(1, columns)),
        );
        ranges.push(to > from
          ? Decoration.replace({ widget }).range(sourceFrom, sourceTo)
          : Decoration.widget({ widget }).range(sourceFrom));
      } else if (closingPipeTo > sourceFrom) {
        ranges.push(Decoration.mark({
          // During the shared typing burst the grid is mapped instead of
          // rebuilt. Include edits at either cell edge in the active mark so
          // WebKit/CM6 keep one editable DOM span around the closing pipe.
          inclusive: true,
          attributes: {
            class: `cm-table-source-cell cm-table-source-active-cell${isLastCol ? " cm-table-source-last-cell" : ""}`,
            style: aligns[col] ? `text-align:${aligns[col]}` : "",
          },
        }).range(sourceFrom, closingPipeTo));
      }
    }
    // Pad short ragged body rows with clickable rendered placeholders so the grid stays aligned.
    for (let col = cells.length; col < columns; col++) {
      const widget = new TableSourceCellWidget(
        "",
        row,
        col,
        aligns[col] ?? "",
        col === columns - 1,
        isActiveRow,
        colLefts[col] ?? 0,
        colWidths[col] ?? (100 / Math.max(1, columns)),
      );
      ranges.push(Decoration.widget({ widget, side: 1 }).range(line.to));
    }
  }
  if (table.to > table.sourceTo) {
    const attrs = doc.lineAt(table.to);
    const active = caretLine === attrs.number;
    ranges.push(Decoration.line({ attributes: {
      class: active ? "cm-table-source-attrs-active" : "cm-table-source-attrs-hidden",
    } }).range(attrs.from));
    if (!active && attrs.to > attrs.from) ranges.push(Decoration.replace({}).range(attrs.from, attrs.to));
  }
  return ranges;
}

function buildTableDecos(state: EditorState): DecorationSet {
  return Decoration.set(buildTableDecoRanges(state), true);
}

/**
 * A table is structure, like an org-env block: a caret in it — moved there by
 * the arrow keys or Vim, or placed by a click on a cell — opens its source,
 * which is then edited with the main editor (Tab and Enter move between
 * cells; see `commands/index.ts`). A range inside a cell opens the editable
 * grid; a range crossing the whole table leaves it rendered.
 */
function tableOpened(state: EditorState, table: MarkdownTable): boolean {
  const from = table.from === 0 ? 1 : table.from;
  return selectionOpensSource(state, from, table.to, "edge", "structure");
}

function tableAt(state: EditorState, pos: number): MarkdownTable | null {
  const tables = markdownTablesFromState(state);
  const table = tables[firstTableEndingAtOrAfter(tables, pos)];
  return table && table.from <= pos && pos <= table.to ? table : null;
}

function activeTableAttrsKey(state: EditorState): string {
  const selection = visualSelection(state).main;
  const candidates = [tableAt(state, selection.from), tableAt(state, selection.to)];
  const seen = new Set<number>();
  const parts: string[] = [];
  const headLine = state.doc.lineAt(selection.head);
  for (const table of candidates) {
    if (!table || seen.has(table.from) || !tableOpened(state, table)) continue;
    seen.add(table.from);
    const onTable = headLine.from >= table.from && headLine.to <= table.to;
    const col = onTable ? tableSourceActiveColumn(state, headLine) : -1;
    parts.push(`${onTable ? headLine.number : 0}.${col}:${table.from}:${table.to}`);
  }
  return parts.join("|");
}

/** Tables as rendered constructs: one block of structure while rendered. */
const tableConstructSource: ConstructSource = {
  kind: "table",
  at(state, pos) {
    const table = tableAt(state, pos);
    if (!table || pos >= table.to) return [];
    if (!tableOpened(state, table) && isDocumentDataBody(state, table.from, table.to)) return [];
    return [{
      from: table.from,
      to: table.to,
      block: true,
      kind: "table",
      reveal: "edge",
      role: "structure",
      revealRegion: { from: table.from === 0 ? 1 : table.from, to: table.to },
    }];
  },
};


const tableDecoField = StateField.define<DecorationSet>({
  create: (state) => buildTableDecos(state),
  update(value, tr) {
    const refreshRanges = viewportDecorationRefreshRanges(tr);
    if (refreshRanges) {
      const tables = markdownTablesFromState(tr.state);
      const affected = tables.filter((table) =>
        refreshRanges.some(({ from, to }) => table.from <= to && table.to >= from));
      let stale = false;
      for (const { from, to } of refreshRanges) {
        value.between(from, to, (oldFrom, oldTo) => {
          if (!affected.some((table) => table.from <= oldFrom && oldTo <= table.to)) stale = true;
        });
      }
      // The candidate may have removed the table delimiter or changed its
      // extent. Remove decorations left outside the current table spans.
      if (stale) return buildTableDecos(tr.state);
      return rebuildDecorations(value, affected.map(({ from, to }) => ({ from, to })),
        (from, to) => buildTableDecoRanges(tr.state, from, to));
    }
    // Cell text belongs to the same CM6 contenteditable as prose. Mapping its
    // decorations during a typing burst keeps the IME's DOM target intact even
    // when an uncommitted candidate briefly looks like table syntax. The
    // shared typing-burst refresh redraws the grid after input settles.
    if (isCoalescedVisualTypingTransaction(tr)) return value.map(tr.changes);
    if (tr.docChanged) {
      const tables = markdownTablesFromState(tr.startState);
      return canMapMarkdownTables(tr.startState.doc, tables, tr.changes)
        ? value.map(tr.changes)
        : patchTableDecosNearChanges(tr.startState, tr.state, value.map(tr.changes), tr.changes);
    }
    if (tr.selection != null
        || tr.effects.some((effect) => effect.is(pointerSelectionEffect) && !effect.value)) {
      const oldKey = activeTableAttrsKey(tr.startState);
      const newKey = activeTableAttrsKey(tr.state);
      return rebuildForRevealChange(value, oldKey, newKey, (from, to) => buildTableDecoRanges(tr.state, from, to));
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function patchTableDecosNearChanges(
  oldState: EditorState,
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
  const { startLine, endLine } = affectedTableLineWindow(oldState, state, changes);
  const affectedFrom = state.doc.line(startLine).from;
  const affectedTo = state.doc.line(endLine).to;
  return rebuildDecorations(mapped, [{ from: affectedFrom, to: affectedTo }], (from, to) => buildTableDecoRanges(state, from, to));
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
  const definitions = definitionLinesFromText(doc);
  for (let lineNumber = firstLine; lineNumber <= lastWindowLine; lineNumber++) {
    const line = doc.line(lineNumber);
    const definition = definitions?.get(lineNumber);
    if (definition) decos.push(lineClassDecoration(`cm-md-definition-${definition}`).range(line.from));
    if (/^[ \t]{0,3}\*\[[^\]\n]+\]:[ \t]*\S/.test(line.text)) {
      decos.push(lineClassDecoration("cm-md-abbreviation-definition").range(line.from));
    }
    if (line.text.trim().length > 0) continue;

    const continued = lineNumber > 1 && doc.line(lineNumber - 1).text.trim().length === 0;
    const className = continued
      ? "cm-prose-blank-line cm-prose-blank-line-continued"
      : "cm-prose-blank-line";
    decos.push(lineClassDecoration(className).range(line.from));
  }

  const headings = tocIndexFromState(state).headings;
  let firstHeading = 0;
  let pastHeading = headings.length;
  while (firstHeading < pastHeading) {
    const middle = (firstHeading + pastHeading) >> 1;
    if (headings[middle]!.pos < windowFrom) firstHeading = middle + 1;
    else pastHeading = middle;
  }
  for (let index = firstHeading; index < headings.length && headings[index]!.pos <= windowTo; index++) {
    const heading = headings[index]!;
    if (heading.source === "semantic") continue;
    const line = doc.lineAt(Math.max(0, Math.min(heading.pos, doc.length)));
    if (rangeInsideAny(line.from, line.to, lineExcludedRanges)) continue;
    decos.push(lineClassDecoration(`cm-md-h${heading.renderLevel ?? heading.level}`).range(line.from));
    // CM6 samples a short, plain-text line for its default line height. A
    // heading kept around the caret can lose its viewport-only marks when
    // scrolled off screen, making it look like that sample. The larger heading
    // font then resets the height map for the entire note. Keep a structural
    // mark alongside the persistent line style so it is never sampled as prose.
    if (line.to > line.from) {
      decos.push(Decoration.mark({ class: "cm-heading-text" }).range(line.from, line.to));
    }
  }

  const pushLineRange = (from: number, to: number, cls: string): void => {
    let lineNum = Math.max(firstLine, doc.lineAt(from).number);
    const lastLine = Math.min(lastWindowLine, doc.lineAt(to).number);
    while (lineNum <= lastLine) {
      const line = doc.line(lineNum);
      decos.push(lineClassDecoration(cls).range(line.from));
      // Code and other styled blocks are not representative prose samples
      // either, even before their viewport syntax highlighting is available.
      if (line.to > line.from) {
        decos.push(Decoration.mark({ class: "cm-block-text" }).range(line.from, line.to));
      }
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
          decos.push(lineClassDecoration("cm-md-callout-title").range(firstLine.from));
        } else {
          pushLineRange(node.from, node.to, "cm-md-blockquote");
        }
        return false;
      }
      if (node.name === "FootnoteDefinition") {
        pushLineRange(node.from, node.to, "cm-md-footnote");
        return false;
      }
      if (node.name === "FencedCode" || node.name === "CodeBlock") {
        pushLineRange(node.from, node.to, "cm-md-code-block");
        // The first and last lines close the block into one card; a fence's
        // first line is also its header, where the language and tools sit.
        const first = doc.lineAt(node.from);
        const last = doc.lineAt(Math.max(node.from, node.to - (node.to > node.from && doc.sliceString(node.to - 1, node.to) === "\n" ? 1 : 0)));
        if (first.number >= firstLine && first.number <= lastWindowLine) {
          decos.push(lineClassDecoration(node.name === "FencedCode" ? "cm-md-code-first cm-md-code-header" : "cm-md-code-first").range(first.from));
        }
        if (last.number >= firstLine && last.number <= lastWindowLine) {
          // A closing fence carries no content; it is drawn as the card's
          // thin bottom edge instead of a blank full-height line.
          const closing = node.name === "FencedCode" && last.number > first.number && /^\s*(?:`{3,}|~{3,})\s*$/.test(last.text);
          decos.push(lineClassDecoration(closing ? "cm-md-code-last cm-md-code-close" : "cm-md-code-last").range(last.from));
        }
        return false;
      }
    },
  });

  const tables = markdownTablesFromState(state);
  const firstTable = firstTableEndingAtOrAfter(tables, windowFrom);
  for (let index = firstTable; index < tables.length && tables[index]!.from <= windowTo; index++) {
    const table = tables[index]!;
    let lineNum = Math.max(firstLine, doc.lineAt(table.from).number);
    const lastLine = Math.min(lastWindowLine, doc.lineAt(table.to).number);
    while (lineNum <= lastLine) {
      const line = doc.line(lineNum);
      const cls = isTableSeparatorLine(line.text)
        ? "cm-md-table cm-md-table-separator"
        : "cm-md-table";
      decos.push(lineClassDecoration(cls).range(line.from));
      lineNum++;
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return decos;
}

/**
 * One shared decoration per line class. A 5 MB note carried ~70k identical
 * line decorations (one object and attribute map per blank line); decorations
 * are immutable values, so every line with the same class can share one.
 */
const lineClassDecorations = new Map<string, Decoration>();
function lineClassDecoration(className: string): Decoration {
  let decoration = lineClassDecorations.get(className);
  if (!decoration) lineClassDecorations.set(className, decoration = Decoration.line({ attributes: { class: className } }));
  return decoration;
}

function buildLineDecos(state: EditorState): DecorationSet {
  return Decoration.set(buildLineDecoRanges(state), true);
}

const lineDecoField = StateField.define<DecorationSet>({
  create: (state) => buildLineDecos(state),
  update(value, tr) {
    const refreshRanges = viewportDecorationRefreshRanges(tr);
    if (refreshRanges) {
      const doc = tr.state.doc;
      const lines = refreshRanges.map((range) => ({ from: doc.lineAt(range.from).from, to: doc.lineAt(range.to).to }));
      return rebuildDecorations(value, lines, (from, to) =>
        buildLineDecoRanges(tr.state, doc.lineAt(from).number, doc.lineAt(to).number));
    }
    // A one-character edit can turn an empty source line into prose (or the
    // reverse). Mapping its old line decoration would leave the new text with
    // blank-line height until the typing-burst refresh, moving every line
    // below it. Repair this small structural boundary in the same transaction.
    if (tr.docChanged && blankLineClassChanged(tr.startState.doc, tr.state.doc, tr.changes)) {
      return canPatchLineDecosNearChanges(tr.startState.doc, tr.changes)
        ? patchLineDecosNearChanges(tr.startState, tr.state, value.map(tr.changes), tr.changes)
        : buildLineDecos(tr.state);
    }
    if (isCoalescedVisualTypingTransaction(tr)) return value.map(tr.changes);
    if (tr.docChanged) {
      if (canMapLineDecos(tr.startState.doc, tr.changes)) return value.map(tr.changes);
      if (canPatchLineDecosNearChanges(tr.startState.doc, tr.changes)) {
        return patchLineDecosNearChanges(tr.startState, tr.state, value.map(tr.changes), tr.changes);
      }
      return buildLineDecos(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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

function blankLineClassChanged(oldDoc: Text, newDoc: Text, changes: ChangeSet): boolean {
  let changed = false;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (changed) return;
    const oldStart = oldDoc.lineAt(fromA).number;
    const oldEnd = oldDoc.lineAt(toA).number;
    const newStart = newDoc.lineAt(fromB).number;
    const newEnd = newDoc.lineAt(toB).number;
    if (oldEnd - oldStart !== newEnd - newStart) {
      changed = true;
      return;
    }
    for (let offset = 0; offset <= oldEnd - oldStart; offset++) {
      const wasBlank = oldDoc.line(oldStart + offset).text.trim().length === 0;
      const isBlank = newDoc.line(newStart + offset).text.trim().length === 0;
      if (wasBlank !== isBlank) {
        changed = true;
        break;
      }
    }
  });
  return changed;
}

function canPatchLineDecosNearChanges(doc: Text, changes: ChangeSet): boolean {
  // Newline edits (every Enter press) are patched near the change, not full-doc
  // rebuilt: patchLineDecosNearChanges expands over contiguous table rows and
  // indexed code fences affected by the change. This mirrors htmlBlockDecoField,
  // which patches near changes
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
  oldState: EditorState,
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
  changes.iterChanges((_fromA, _toA, nextFrom, nextTo) => {
    const tableWindow = expandedTableLineWindow(state.doc, nextFrom, nextTo);
    includeNewLines(tableWindow.startLine, tableWindow.endLine);
  });
  const fence = affectedFenceWindow(oldState, state, changes);
  if (fence) {
    fromB = Math.min(fromB, fence.from);
    toB = Math.max(toB, fence.to);
  }
  if (!Number.isFinite(fromB)) return mapped;
  const startLine = state.doc.lineAt(Math.max(0, Math.min(fromB, state.doc.length))).number;
  const endLine = state.doc.lineAt(Math.max(0, Math.min(toB, state.doc.length))).number;
  const affected = { from: state.doc.line(startLine).from, to: state.doc.line(endLine).to };
  return rebuildDecorations(mapped, [affected], (from, to) =>
    buildLineDecoRanges(state, state.doc.lineAt(from).number, state.doc.lineAt(to).number));
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

/** An HTML block is structure: a caret at or inside it opens its source, in every mode. */
function htmlBlockOpened(state: EditorState, block: { from: number; to: number }): boolean {
  return selectionOpensSource(state, block.from, block.to, "caret-edge", "structure");
}

function collectHtmlBlockDecoRanges(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): Range<Decoration>[] {
  const decos: Range<Decoration>[] = [];
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
      // Only a caret reveals the source; a range keeps the block rendered, as
      // `activeHtmlBlockKey` assumes when it ignores range selections.
      if (htmlBlockOpened(state, node)) return false;
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
  const affected = {
    from: state.doc.line(Math.max(1, startLine)).from,
    to: state.doc.line(Math.min(state.doc.lines, endLine)).to,
  };
  return rebuildDecorations(mapped, [affected], (from, to) => collectHtmlBlockDecoRanges(state, from, to));
}

function activeHtmlBlockKey(state: EditorState): string {
  const sel = visualSelection(state).main;
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
      if (htmlBlockOpened(state, node)) keys.push(`${node.from}:${node.to}`);
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
      return rebuildDecorations(value, refreshRanges, (from, to) => collectHtmlBlockDecoRanges(tr.state, from, to));
    }
    if (isCoalescedVisualTypingTransaction(tr)) return value.map(tr.changes);
    if (tr.docChanged) {
      return patchHtmlBlockDecosNearChanges(tr.state, value.map(tr.changes), tr.changes);
    }
    if (tr.selection != null
        || tr.effects.some((effect) => effect.is(pointerSelectionEffect) && !effect.value)) {
      const oldKey = activeHtmlBlockKey(tr.startState);
      const newKey = activeHtmlBlockKey(tr.state);
      return rebuildForRevealChange(value, oldKey, newKey, (from, to) => collectHtmlBlockDecoRanges(tr.state, from, to));
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// Public export — inline mark plugin + line decoration field
// ---------------------------------------------------------------------------

export const livePreviewExtension = [
  livePreviewPlugin,
  persistentVisualStateField(markdownTablesField, collectMarkdownTables),
  persistentVisualStateField(lineDecoField, buildLineDecos),
  // Keep the editable cell's mark outside syntax marks, so nested emphasis
  // and formula styling cannot split one visual cell into several flex items.
  Prec.lowest(persistentVisualStateField(tableDecoField, buildTableDecos)),
  constructSources.of(tableConstructSource),
  persistentVisualStateField(htmlBlockDecoField, buildHtmlBlockDecos),
  constructSources.of(drawnConstructSource("html-block", "structure", (state) => state.field(htmlBlockDecoField, false))),
];
