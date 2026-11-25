import type MarkdownIt from "markdown-it";
import Token from "markdown-it/lib/token.mjs";
import { layoutFromAttrs, type AttrMap } from "../shared/layout-attrs.mjs";
import { splitDocumentWidgetTitle } from "../shared/document-widget-title.mjs";
import { documentDataAccents } from "./document-data-table.ts";
import { readImageTrailingAttrs } from "./image-attrs.ts";
import { safeHref } from "./url-safety.ts";

const cardFrameKinds = new Set(["card", "home-box", "link-card", "image-card"]);
const alignmentKinds = new Set(["center", "left", "right", "justify"]);
export const documentFrameKinds = new Set(["box", "panel", ...cardFrameKinds, ...alignmentKinds]);
const textAlignments = new Set(["start", "end", ...alignmentKinds]);
const surfaces = new Set(["none", "paper", "quiet", "raised"]);
const cardIcons = new Map([["link", "↗"], ["file", "▤"], ["check", "✓"], ["info", "ⓘ"]]);

export function documentFrameHasDetails(kind: string, rawTitle: string): boolean {
  if (!cardFrameKinds.has(kind) && kind !== "panel") return false;
  const { attrs } = splitDocumentWidgetTitle(kind, rawTitle);
  if (kind === "panel") return Boolean(attrs.status);
  return Boolean(attrs.description || (attrs.href && safeHref(attrs.href)) || cardIcons.has(attrs.icon?.toLowerCase() || "")
    || (kind === "image-card" && ((attrs.src && safeHref(attrs.src)) || attrs.alt)));
}

function renderCardAction(md: MarkdownIt, href: string | undefined, label: string): string {
  if (!href || !safeHref(href)) return "";
  const open = new Token("link_open", "a", 1);
  open.attrSet("class", "noema-document-card-action");
  open.attrSet("href", md.normalizeLink(href));
  const text = new Token("text", "", 0);
  text.content = label;
  return md.renderer.renderInline([open, text, new Token("link_close", "a", -1)], md.options, {});
}

function renderCoverSource(md: MarkdownIt, src: string, alt: string): string {
  const image = new Token("image", "img", 0);
  image.attrSet("src", md.normalizeLink(src));
  image.attrSet("alt", alt);
  const text = new Token("text", "", 0);
  text.content = alt;
  image.children = [text];
  image.content = alt;
  return md.renderer.renderInline([image], md.options, {});
}

function renderCardContent(md: MarkdownIt, kind: string, body: string, attrs: AttrMap) {
  let action = renderCardAction(md, attrs.href, attrs.action || "Open link");
  let cover = kind === "image-card" && attrs.src && safeHref(attrs.src) ? renderCoverSource(md, attrs.src, attrs.alt || "") : "";
  if ((kind !== "image-card" || cover) && (kind !== "link-card" || attrs.href)) {
    return { html: body.trim() ? md.render(body) : "", cover, action };
  }
  const environment = {};
  const tokens = md.parse(body, environment);
  const first = tokens[0]?.type === "paragraph_open" && tokens[2]?.type === "paragraph_close" ? tokens[1]?.children : null;
  let bodyStart = 0;
  if (first?.length) {
    const [lead, tail] = first;
    const src = lead?.attrGet("src");
    const href = lead?.attrGet("href");
    const hasCover = kind === "image-card" && lead?.type === "image" && src && safeHref(src)
      && (first.length === 1 || (first.length === 2 && tail?.type === "text"
        && readImageTrailingAttrs(tail.content, 0)?.to === tail.content.trimEnd().length));
    const hasLink = kind === "link-card" && lead?.type === "link_open" && href && safeHref(href)
      && first.at(-1)?.type === "link_close"
      && first.slice(1, -1).every((token) => token.type !== "link_open" && token.type !== "link_close");
    if (hasCover) cover = md.renderer.renderInline(first, md.options, environment);
    if (hasLink) {
      lead.attrJoin("class", "noema-document-card-action");
      action = md.renderer.renderInline(first, md.options, environment);
    }
    if (hasCover || hasLink) bodyStart = 3;
  }
  if (!cover && kind === "image-card" && attrs.alt) cover = md.utils.escapeHtml(attrs.alt);
  return { html: md.renderer.render(tokens.slice(bodyStart), md.options, environment), cover, action };
}

export function renderDocumentFrame(md: MarkdownIt, kind: string, body: string, attrs: AttrMap): string {
  if (alignmentKinds.has(kind)) {
    return `<div class="noema-document-alignment" data-text-align="${kind}">${body.trim() ? md.render(body) : ""}</div>`;
  }

  const layout = layoutFromAttrs({ ...attrs, align: attrs.align || "left" });
  const padding = kind === "box" ? layoutFromAttrs({ width: attrs.padding || "" }).width : "";
  const style = [layout.width && `--document-frame-width:${layout.width}`, padding && `--document-frame-padding:${padding}`]
    .filter(Boolean).join(";");
  const accent = attrs.accent?.toLowerCase() || (kind === "home-box" ? "primary" : "neutral");
  const surface = attrs.surface?.toLowerCase() || (kind === "box" ? "none" : "raised");
  const align = attrs["text-align"]?.toLowerCase() || "start";
  const variant = attrs.variant?.toLowerCase() === "flat" ? "flat" : "default";
  const focus = ["focus", "true"].includes(attrs.focus?.toLowerCase() || "");
  const variantAttributes = ` data-surface="${surfaces.has(surface) ? surface : "none"}" data-accent="${documentDataAccents.has(accent) ? accent : "neutral"}"`
    + ` data-frame-align="${layout.align}" data-text-align="${textAlignments.has(align) ? align : "start"}"`
    + ` data-variant="${variant}" data-focus="${focus}"`;

  let leading = "";
  let trailing = "";
  let cardLink = false;
  let html = "";
  if (cardFrameKinds.has(kind)) {
    const content = renderCardContent(md, kind, body, attrs);
    html = content.html;
    const icon = cardIcons.get(attrs.icon?.toLowerCase() || "");
    const description = attrs.description ? md.renderInline(attrs.description) : "";
    if (content.cover) leading = `<div class="noema-document-card-cover">${content.cover}</div>`;
    if (icon || description) {
      leading += `<div class="noema-document-card-description">${icon ? `<span class="noema-document-card-icon" aria-hidden="true">${icon}</span>` : ""}${description}</div>`;
    }
    trailing = content.action;
    cardLink = Boolean(trailing) && (kind === "link-card" || kind === "image-card");
  } else {
    html = body.trim() ? md.render(body) : "";
    if (kind === "panel" && attrs.status) trailing = `<div class="noema-document-panel-status">${md.renderInline(attrs.status)}</div>`;
  }
  if (!leading && !html && !trailing) return "";
  return `<div class="noema-document-frame" data-frame="${kind}"${variantAttributes}${cardLink ? ' data-card-link="true"' : ""}${style ? ` style="${style}"` : ""}>`
    + leading + (html ? `<div class="noema-document-frame-body">${html}</div>` : "") + trailing + "</div>";
}
