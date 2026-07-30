import {
  applyLayoutAttrs,
  layoutClasses,
  layoutFromAttrs,
  layoutStyle,
  type LayoutAlign,
  type LayoutAttrs,
  readLayoutTrailingAttrs,
} from "./layout-attrs.ts";
import { type AttrMap, type TrailingAttrs } from "./attrs-syntax.ts";

export type ImageAlign = LayoutAlign;

export type ImageLayoutAttrs = LayoutAttrs;

export function readImageTrailingAttrs(text: string, from: number): TrailingAttrs | null {
  return readLayoutTrailingAttrs(text, from);
}

export function imageLayoutFromAttrs(attrs: AttrMap): ImageLayoutAttrs {
  return layoutFromAttrs(attrs);
}

/**
 * Serialize an image layout back into a canonical AttrMap that round-trips through
 * `imageLayoutFromAttrs`. The default layout (centered block, no explicit size)
 * serializes to an empty map so clean markdown carries no trailing attributes.
 */
export function imageLayoutToAttrMap(layout: ImageLayoutAttrs): AttrMap {
  const attrs: AttrMap = {};
  if (layout.wrap && layout.align !== "center") {
    // `wrap: left|right` reconstructs both the float side and the wrap flag.
    attrs.wrap = layout.align;
  } else if (layout.align !== "center") {
    attrs.align = layout.align;
  }
  if (layout.width) attrs.width = layout.width;
  if (layout.height) attrs.height = layout.height;
  return attrs;
}

/**
 * Serialize an image layout into the trailing `{key: value, ...}` attribute text
 * (no leading space). Returns "" when the layout is the default and needs no attrs.
 */
export function imageLayoutToTrailingAttrs(layout: ImageLayoutAttrs): string {
  const attrs = imageLayoutToAttrMap(layout);
  const keys = Object.keys(attrs);
  if (keys.length === 0) return "";
  return "{" + keys.map((key) => `${key}: ${attrs[key]}`).join(", ") + "}";
}

export function imageLayoutClasses(layout: ImageLayoutAttrs): string {
  return layoutClasses("image", layout);
}

export function imageLayoutStyle(layout: ImageLayoutAttrs): string {
  return layoutStyle("image", layout);
}

export function applyImageLayout(el: HTMLElement, layout: ImageLayoutAttrs): void {
  applyLayoutAttrs(el, "image", layout);
  el.dataset.aaronnoteImageAlign = layout.align;
  el.dataset.aaronnoteImageWrap = layout.wrap ? "true" : "false";
}
