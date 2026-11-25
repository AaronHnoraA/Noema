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
  ["tabs", ["selected", "accent"]],
  ["code-tabs", ["selected", "accent"]],
  ["tab-panel", ["selected", "accent"]],
  ["swiper", ["selected", "accent"]],
  ["details", ["open"]],
  ["accordion", ["open", "multiple", "expand"]],
  ["diff", ["before", "after", "view"]],
  ["file-tree", ["lines", "collapsible", "clickable", "icon", "open-depth"]],
  ["code-tree", ["lines", "icon", "height", "open-depth"]],
  ["field", ["name", "type", "type-link", "default", "required", "deprecated", "experimental", "enum", "unit", "format", "constraint", "since", "label-width", "separator", "width"]],
  ["form", ["separator", "width"]],
  ["window", ["height", "gap", "no-padding"]],
  ["demo", ["open"]],
  ["npm-badge", ["name", "version", "downloads"]],
  ["npm-to", ["tabs", "selected"]],
]);
for (const kind of ["note", "tip", "important", "warning", "caution", "info", "danger"]) {
  attributesByKind.set(kind, ["collapsible", "open", "background", "border-left-width"]);
}

export function hasDocumentWidgetOptions(kind) { return attributesByKind.has(kind); }

/** Separate a widget's options after the block anchor has been removed. */
export function splitDocumentWidgetTitle(kind, source) {
  const knownKeys = attributesByKind.get(kind);
  if (!knownKeys) return { title: source, attrs: {} };
  return splitDocumentWidgetAttrs(source, knownKeys);
}

export function splitDocumentWidgetAttrs(source, knownKeys) {
  const suffix = /(?:^|\s)(\{[^{}]*\})$/u.exec(source);
  const attributes = suffix && readTrailingAttrs(source, source.length - suffix[1].length, { knownKeys });
  return attributes ? { title: source.slice(0, attributes.from).trimEnd(), attrs: attributes.attrs } : { title: source, attrs: {} };
}
