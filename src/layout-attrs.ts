import { type AttrMap, readTrailingAttrs, type TrailingAttrs } from "./attrs-syntax.ts";

export type LayoutAlign = "left" | "center" | "right";

export type LayoutAttrs = {
  align: LayoutAlign;
  wrap: boolean;
  width: string;
  height: string;
};

export const LAYOUT_ATTR_KEYS = [
  "align",
  "float",
  "h",
  "height",
  "pos",
  "position",
  "size",
  "w",
  "width",
  "wrap",
] as const;

function normalizeDimension(value: string | undefined): string {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (/^\d+(?:\.\d+)?$/.test(raw)) return `${raw}px`;
  if (/^\d+(?:\.\d+)?(?:%|px|em|rem|vw|vh|ch)$/.test(raw)) return raw;
  if (/^calc\([0-9.\s+\-*/%a-z]+\)$/.test(raw)) return raw;
  return "";
}

function normalizeAlign(value: string | undefined): LayoutAlign | "" {
  const raw = String(value || "").trim().toLowerCase();
  if (["left", "l"].includes(raw)) return "left";
  if (["right", "r"].includes(raw)) return "right";
  if (["center", "centre", "middle", "c"].includes(raw)) return "center";
  return "";
}

function truthyWrap(value: string | undefined): boolean | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "y", "on", "wrap"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off", "none", "nowrap"].includes(raw)) return false;
  return null;
}

export function readLayoutTrailingAttrs(text: string, from: number): TrailingAttrs | null {
  return readTrailingAttrs(text, from, {
    allowWhitespace: true,
    knownKeys: LAYOUT_ATTR_KEYS,
  });
}

export function readLayoutAttrsLine(text: string): TrailingAttrs | null {
  const from = text.match(/^\s*/)?.[0].length ?? 0;
  const trailing = readLayoutTrailingAttrs(text, from);
  if (!trailing || text.slice(trailing.to).trim()) return null;
  return trailing;
}

export function layoutFromAttrs(attrs: AttrMap): LayoutAttrs {
  const wrapSide = normalizeAlign(attrs.wrap);
  const floatSide = normalizeAlign(attrs.float);
  const requestedAlign = normalizeAlign(attrs.align || attrs.position || attrs.pos);
  const wrapValue = truthyWrap(attrs.wrap);
  const floatValue = truthyWrap(attrs.float);
  const wrapRequested = Boolean(wrapSide || floatSide || wrapValue || floatValue);
  const align = wrapSide || floatSide || requestedAlign || (wrapRequested ? "right" : "center");
  const wrap = wrapRequested && align !== "center";

  return {
    align,
    wrap,
    width: normalizeDimension(attrs.size || attrs.width || attrs.w),
    height: normalizeDimension(attrs.height || attrs.h),
  };
}

export function layoutClasses(kind: string, layout: LayoutAttrs): string {
  return [
    `aaronnote-${kind}`,
    `aaronnote-${kind}-align-${layout.align}`,
    layout.wrap ? `aaronnote-${kind}-wrap` : "",
  ].filter(Boolean).join(" ");
}

export function layoutStyle(kind: string, layout: LayoutAttrs): string {
  const parts: string[] = [];
  if (layout.width) {
    parts.push(`--aaronnote-${kind}-width: ${layout.width}`);
    parts.push(`--aaronnote-${kind}-max-width: none`);
    parts.push(`--aaronnote-${kind}-max-height: none`);
  }
  if (layout.height) {
    parts.push(`--aaronnote-${kind}-height: ${layout.height}`);
    parts.push(`--aaronnote-${kind}-max-height: none`);
  }
  return parts.length ? `${parts.join("; ")};` : "";
}

export function applyLayoutAttrs(el: HTMLElement, kind: string, layout: LayoutAttrs): void {
  el.classList.add(...layoutClasses(kind, layout).split(/\s+/).filter(Boolean));
  el.dataset.aaronnoteLayout = kind;
  el.dataset.aaronnoteLayoutAlign = layout.align;
  el.dataset.aaronnoteLayoutWrap = layout.wrap ? "true" : "false";
  if (layout.width) {
    el.style.setProperty(`--aaronnote-${kind}-width`, layout.width);
    el.style.setProperty(`--aaronnote-${kind}-max-width`, "none");
    el.style.setProperty(`--aaronnote-${kind}-max-height`, "none");
  }
  if (layout.height) {
    el.style.setProperty(`--aaronnote-${kind}-height`, layout.height);
    el.style.setProperty(`--aaronnote-${kind}-max-height`, "none");
  }
}
