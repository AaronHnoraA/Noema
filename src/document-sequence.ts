import type MarkdownIt from "markdown-it";
import Token from "markdown-it/lib/token.mjs";
import type { AttrMap } from "../shared/layout-attrs.mjs";

export type DocumentSequenceKind = "timeline" | "steps";

function inlineHTML(html: string): Token {
  const token = new Token("html_inline", "", 0);
  token.content = html;
  return token;
}

function inlineText(text: string): Token {
  const token = new Token("text", "", 0);
  token.content = text;
  return token;
}

const eventStatusPrefix = /^\[(success|warning|danger|info)\][ \t]+/i;
const stepStatePrefix = /^\[([ xX])\][ \t]+/;

function takePrefix(inline: Token, expression: RegExp): string | null {
  const marker = expression.exec(inline.content);
  const first = inline.children?.[0];
  if (!marker || first?.type !== "text" || !first.content.startsWith(marker[0])) return null;
  first.content = first.content.slice(marker[0].length);
  return marker[1]!.toLowerCase();
}

function timelineHeading(inline: Token, status: string | null): void {
  const children = inline.children;
  if (!children) return;
  const badge = status ? inlineHTML(`<span class="noema-timeline-status">${status}</span>`) : null;

  // Split only a top-level delimiter. A separator in an inline link or
  // emphasized phrase is part of that phrase and keeps its usual rendering.
  let nesting = 0;
  for (const [index, token] of children.entries()) {
    nesting += token.nesting;
    if (nesting || token.type !== "text") continue;
    const separator = /[ \t][·—][ \t]/u.exec(token.content);
    if (!separator) continue;
    const start = token.content.slice(0, separator.index).trimEnd();
    const end = token.content.slice(separator.index + separator[0].length).trimStart();
    if ((!start && !index) || (!end && index === children.length - 1)) break;
    inline.children = [
      inlineHTML('<span class="noema-timeline-heading"><span class="noema-timeline-meta"><span class="noema-timeline-date">'),
      ...children.slice(0, index), inlineText(start), inlineHTML("</span>"),
      ...(badge ? [inlineText(" "), badge] : []),
      inlineHTML('</span> <span class="noema-timeline-title">'), inlineText(end),
      ...children.slice(index + 1), inlineHTML("</span></span>"),
    ];
    return;
  }
  if (badge) children.push(inlineText(" "), badge);
}

/** Decorate an ordinary Markdown list while preserving its nested content. */
export function renderDocumentSequence(
  md: MarkdownIt, body: string, kind: DocumentSequenceKind, attrs: AttrMap,
): string | null {
  const environment = {};
  const tokens = md.parse(body, environment);
  const list = tokens[0];
  if (!list) return null;
  const ordered = list.type === "ordered_list_open";
  if (!ordered && (kind === "steps" || list.type !== "bullet_list_open")) return null;
  if (tokens.slice(1, -1).some((token) => token.level === 0)) return null;

  const orientation = attrs.orientation?.toLowerCase() || "vertical";
  const card = attrs.card?.toLowerCase() || String(orientation === "horizontal");
  const marker = attrs["list-style"]?.toLowerCase() || (ordered ? "decimal" : "bullet");
  if (!["vertical", "horizontal"].includes(orientation) || !["true", "false"].includes(card)
      || !["decimal", "bullet", "none"].includes(marker)) return null;
  list.attrJoin("class", `noema-${kind}-list`);
  list.attrSet("role", "list");
  list.attrSet("data-marker", marker);
  if (kind === "timeline") {
    list.attrSet("data-orientation", orientation);
    list.attrSet("data-card", card);
  }

  let item: Token | null = null;
  let hasCurrentStep = false;
  for (const token of tokens) {
    if (token.type === "list_item_open" && token.level === 1) item = token;
    else if (token.type === "list_item_close" && token.level === 1) item = null;
    if (!item || token.type !== "inline" || token.level !== 3) continue;
    if (kind === "timeline") {
      const status = takePrefix(token, eventStatusPrefix);
      if (status) item.attrSet("data-event-status", status);
      timelineHeading(token, status);
    } else {
      const mark = takePrefix(token, stepStatePrefix);
      if (mark !== null) {
        const status = mark === "x" ? "done" : hasCurrentStep ? "pending" : "current";
        item.attrSet("data-step-state", status);
        if (status === "current") {
          item.attrSet("aria-current", "step");
          hasCurrentStep = true;
        }
        const label = status === "done" ? "Done" : status === "current" ? "Current" : "Pending";
        token.children!.push(inlineText(" "), inlineHTML(`<span class="noema-step-status">${label}</span>`));
      }
    }
    item = null; // Later paragraphs remain ordinary Markdown.
  }
  return `<div class="noema-document-sequence">${md.renderer.render(tokens, md.options, environment)}</div>`;
}
