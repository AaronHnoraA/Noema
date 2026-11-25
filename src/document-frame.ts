import type MarkdownIt from "markdown-it";
import Token from "markdown-it/lib/token.mjs";
import { layoutFromAttrs, type AttrMap } from "../shared/layout-attrs.mjs";
import { splitDocumentWidgetTitle } from "../shared/document-widget-title.mjs";
import { documentDataAccents } from "./document-data-table.ts";
import { safeHref } from "./url-safety.ts";

export const documentFrameKinds = new Set(["box", "card", "panel", "center", "left", "right", "justify"]);

const alignmentKinds = new Set(["center", "left", "right", "justify"]);
const textAlignments = new Set(["start", "end", ...alignmentKinds]);
const surfaces = new Set(["none", "paper", "quiet", "raised"]);
const cardIcons = new Map([["link", "↗"], ["file", "▤"], ["check", "✓"], ["info", "ⓘ"]]);

export function documentFrameHasDetails(kind: string, rawTitle: string): boolean {
  if (kind !== "card" && kind !== "panel") return false;
  const { attrs } = splitDocumentWidgetTitle(kind, rawTitle);
  return Boolean(kind === "card" ? attrs.description || (attrs.href && safeHref(attrs.href)) || cardIcons.has(attrs.icon?.toLowerCase() || "") : attrs.status);
}

export function renderDocumentFrame(md: MarkdownIt, kind: string, body: string, attrs: AttrMap): string {
  const html = body.trim() ? md.render(body) : "";
  if (alignmentKinds.has(kind)) {
    return `<div class="noema-document-alignment" data-text-align="${kind}">${html}</div>`;
  }

  const layout = layoutFromAttrs({ ...attrs, align: attrs.align || "left" });
  const padding = kind === "box" ? layoutFromAttrs({ width: attrs.padding || "" }).width : "";
  const style = [layout.width && `--document-frame-width:${layout.width}`, padding && `--document-frame-padding:${padding}`]
    .filter(Boolean).join(";");
  const accent = attrs.accent?.toLowerCase() || "neutral";
  const surface = attrs.surface?.toLowerCase() || (kind === "box" ? "none" : "raised");
  const align = attrs["text-align"]?.toLowerCase() || "start";
  const variant = attrs.variant?.toLowerCase() === "flat" ? "flat" : "default";
  const focus = ["focus", "true"].includes(attrs.focus?.toLowerCase() || "");
  const variantAttributes = ` data-surface="${surfaces.has(surface) ? surface : "none"}" data-accent="${documentDataAccents.has(accent) ? accent : "neutral"}"`
    + ` data-frame-align="${layout.align}" data-text-align="${textAlignments.has(align) ? align : "start"}"`
    + ` data-variant="${variant}" data-focus="${focus}"`;

  let leading = "";
  let trailing = "";
  if (kind === "card") {
    const icon = cardIcons.get(attrs.icon?.toLowerCase() || "");
    const description = attrs.description ? md.renderInline(attrs.description) : "";
    if (icon || description) {
      leading = `<div class="noema-document-card-description">${icon ? `<span class="noema-document-card-icon" aria-hidden="true">${icon}</span>` : ""}${description}</div>`;
    }
    const href = attrs.href && md.normalizeLink(attrs.href);
    if (href && safeHref(href)) {
      const open = new Token("link_open", "a", 1);
      open.attrSet("class", "noema-document-card-action");
      open.attrSet("href", href);
      const label = new Token("text", "", 0);
      label.content = attrs.action || "Open link";
      trailing = md.renderer.renderInline([open, label, new Token("link_close", "a", -1)], md.options, {});
    }
  } else if (kind === "panel" && attrs.status) {
    trailing = `<div class="noema-document-panel-status">${md.renderInline(attrs.status)}</div>`;
  }
  if (!leading && !html && !trailing) return "";
  return `<div class="noema-document-frame" data-frame="${kind}"${variantAttributes}${style ? ` style="${style}"` : ""}>`
    + leading + (html ? `<div class="noema-document-frame-body">${html}</div>` : "") + trailing + "</div>";
}
