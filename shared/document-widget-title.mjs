import { readTrailingAttrs } from "./layout-attrs.mjs";

const attributesByKind = new Map([
  ["chart", ["type", "accent"]],
  ["timeline", ["orientation", "card", "list-style"]],
  ["steps", ["list-style"]],
  ["table", ["sortable", "copy", "highlight-rows", "highlight-columns", "highlight-cells", "highlight", "align", "text-align", "width"]],
  ["box", ["surface", "padding", "text-align", "align", "width"]],
  ["card", ["description", "href", "action", "icon", "accent", "text-align", "align", "width"]],
  ["home-box", ["description", "href", "action", "accent", "surface", "text-align", "align", "width"]],
  ["link-card", ["description", "href", "action", "accent", "surface", "text-align", "align", "width"]],
  ["image-card", ["description", "href", "action", "src", "alt", "accent", "surface", "align", "width"]],
  ["panel", ["status", "variant", "focus", "accent", "align", "width"]],
  ["statusbar", ["mode", "keys", "note"]],
  ["keymap", ["columns"]],
  ["breadcrumb", ["separator"]],
  ["pros-cons", ["pros", "cons"]],
  ["qrcode", ["text"]],
]);

export function hasDocumentWidgetOptions(kind) { return attributesByKind.has(kind); }

/** Separate a widget's options after the block anchor has been removed. */
export function splitDocumentWidgetTitle(kind, source) {
  const knownKeys = attributesByKind.get(kind);
  if (!knownKeys) return { title: source, attrs: {} };
  const suffix = /(?:^|\s)(\{[^{}]*\})$/u.exec(source);
  const attributes = suffix && readTrailingAttrs(source, source.length - suffix[1].length, { knownKeys });
  return attributes ? { title: source.slice(0, attributes.from).trimEnd(), attrs: attributes.attrs } : { title: source, attrs: {} };
}
