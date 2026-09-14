/*
 * Trailing `{key: value}` attribute parsing and the figure-layout model built on
 * it, shared by the browser and the Node/LaTeX exporters.
 *
 * The editor, the HTML renderer and the LaTeX exporter all have to agree on what
 * `{wrap: right, width: 40%}` means, or the same note lays out three different
 * ways. `src/attrs-syntax.ts` and `src/layout-attrs.ts` are the typed facades
 * over this module; `kernel/noema/latex/preprocess.go` is the Go port, pinned to
 * this behaviour by `shared/latex-transform-fixtures.json`.
 */

function cleanAttrValue(value) {
  return String(value ?? "").trim().replace(/^["']|["']$/g, "");
}

export function parseAttrArgs(raw = "") {
  const body = String(raw || "").trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  if (!body) return {};
  const out = {};
  for (const chunk of body.split(/[;,]/)) {
    const item = chunk.trim();
    if (!item) continue;
    const attrPattern = /([A-Za-z][\w-]*)(?:\s*[:=]\s*("[^"]*"|'[^']*'|.*?))?(?=\s+[A-Za-z][\w-]*(?:\s*[:=]|\s*$)|$)/g;
    let matched = false;
    for (const match of item.matchAll(attrPattern)) {
      matched = true;
      const key = match[1].toLowerCase();
      const value = cleanAttrValue(match[2] ?? key);
      if (key && value) out[key] = value;
    }
    if (matched) continue;
    const match = item.match(/^([A-Za-z][\w-]*)\s*[:=]\s*(.+)$/);
    if (match) {
      const key = match[1].toLowerCase();
      const value = cleanAttrValue(match[2]);
      if (key && value) out[key] = value;
      continue;
    }
    const bare = item.match(/^([A-Za-z][\w-]*)$/);
    if (bare) {
      const key = bare[1].toLowerCase();
      out[key] = key;
    }
  }
  return out;
}

export function findSingleLineClose(text, open, closeChar) {
  let bracketDepth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    // Skip over a whole inline/display math span so its `]` content does not
    // close the attribute block. Checked before the generic backslash escape.
    if (closeChar === "]" && ch === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) {
      const close = text[i + 1] === "[" ? "\\]" : "\\)";
      const start = i + 2;
      const found = text.indexOf(close, start);
      if (found >= 0 && !/[\n\r]/.test(text.slice(start, found))) {
        i = found + close.length - 1;
        continue;
      }
    }
    if (ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") return -1;
    if (closeChar === "]" && ch === "[") {
      bracketDepth++;
      continue;
    }
    if (ch === closeChar) {
      if (closeChar === "]" && bracketDepth > 0) {
        bracketDepth--;
        continue;
      }
      return i;
    }
  }
  return -1;
}

export function readTrailingAttrs(text, from, options = {}) {
  let openBrace = from;
  if (options.allowWhitespace) {
    while (openBrace < text.length && (text[openBrace] === " " || text[openBrace] === "\t")) openBrace++;
  }
  if (text[openBrace] !== "{") return null;
  const closeBrace = findSingleLineClose(text, openBrace, "}");
  if (closeBrace < 0) return null;

  const raw = text.slice(openBrace, closeBrace + 1);
  const attrs = parseAttrArgs(raw);
  if (options.knownKeys?.length) {
    const allowed = new Set(options.knownKeys.map((key) => String(key).toLowerCase()));
    if (!Object.keys(attrs).some((key) => allowed.has(key))) return null;
  }

  return { raw, attrs, from: openBrace, to: closeBrace + 1 };
}

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
];

function normalizeDimension(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (/^\d+(?:\.\d+)?$/.test(raw)) return `${raw}px`;
  if (/^\d+(?:\.\d+)?(?:%|px|em|rem|vw|vh|ch)$/.test(raw)) return raw;
  if (/^calc\([0-9.\s+\-*/%a-z]+\)$/.test(raw)) return raw;
  return "";
}

function normalizeAlign(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["left", "l"].includes(raw)) return "left";
  if (["right", "r"].includes(raw)) return "right";
  if (["center", "centre", "middle", "c"].includes(raw)) return "center";
  return "";
}

function truthyWrap(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "y", "on", "wrap"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off", "none", "nowrap"].includes(raw)) return false;
  return null;
}

export function readLayoutTrailingAttrs(text, from) {
  return readTrailingAttrs(text, from, { allowWhitespace: true, knownKeys: LAYOUT_ATTR_KEYS });
}

export function readLayoutAttrsLine(text) {
  const from = text.match(/^\s*/)?.[0].length ?? 0;
  const trailing = readLayoutTrailingAttrs(text, from);
  if (!trailing || text.slice(trailing.to).trim()) return null;
  return trailing;
}

export function layoutFromAttrs(attrs) {
  const source = attrs || {};
  const wrapSide = normalizeAlign(source.wrap);
  const floatSide = normalizeAlign(source.float);
  const requestedAlign = normalizeAlign(source.align || source.position || source.pos);
  const wrapValue = truthyWrap(source.wrap);
  const floatValue = truthyWrap(source.float);
  const wrapRequested = Boolean(wrapSide || floatSide || wrapValue || floatValue);
  const align = wrapSide || floatSide || requestedAlign || (wrapRequested ? "right" : "center");
  const wrap = wrapRequested && align !== "center";

  return {
    align,
    wrap,
    width: normalizeDimension(source.size || source.width || source.w),
    height: normalizeDimension(source.height || source.h),
  };
}

export function layoutClasses(kind, layout) {
  return [
    `aaronnote-${kind}`,
    `aaronnote-${kind}-align-${layout.align}`,
    layout.wrap ? `aaronnote-${kind}-wrap` : "",
  ].filter(Boolean).join(" ");
}

export function layoutStyle(kind, layout) {
  const parts = [];
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

/** Whether a layout carries anything a renderer has to act on. */
export function layoutIsDefault(layout) {
  return layout.align === "center" && !layout.wrap && !layout.width && !layout.height;
}

// ── LaTeX ────────────────────────────────────────────────────────────────
// One CSS length → one TeX length. Relative widths become a fraction of the
// text block, which is what `{width: 60%}` means in every other Noema surface;
// absolute lengths convert at the CSS reference of 96px per inch.
const CSS_PX_PER_PT = 96 / 72.27;

export function layoutLatexLength(value, relativeTo = "\\textwidth") {
  const raw = String(value || "").trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(%|px|em|rem|vw|vh|ch)?$/);
  if (!match) return "";
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const unit = match[2] || "px";
  const round = (number) => String(Math.round(number * 1000) / 1000);
  if (unit === "%" || unit === "vw") return `${round(Math.min(amount, 100) / 100)}${relativeTo}`;
  if (unit === "em" || unit === "rem" || unit === "ch") return `${round(amount)}em`;
  if (unit === "vh") return `${round(Math.min(amount, 100) / 100)}\\textheight`;
  return `${round(amount / CSS_PX_PER_PT)}pt`;
}

/**
 * Wrap already-typeset LaTeX in the environment a layout asks for.
 *
 * Alignment and text wrapping are document-level decisions in LaTeX, so they
 * belong to the enclosing environment rather than to the graphic: `wrap` maps to
 * `wrapfigure`, and a plain alignment to the matching centring environment.
 * Returns the wrapped lines plus the packages the result needs.
 */
export function layoutLatexEnvironment(layout, lines) {
  const body = Array.isArray(lines) ? lines : [String(lines)];
  if (layout.wrap && layout.align !== "center") {
    const side = layout.align === "left" ? "l" : "r";
    const width = layoutLatexLength(layout.width) || "0.45\\textwidth";
    return {
      lines: [`\\begin{wrapfigure}{${side}}{${width}}`, "\\centering", ...body, "\\end{wrapfigure}"],
      packages: ["wrapfig"],
    };
  }
  const env = layout.align === "left" ? "flushleft" : layout.align === "right" ? "flushright" : "center";
  return { lines: [`\\begin{${env}}`, ...body, `\\end{${env}}`], packages: [] };
}

/**
 * Size and place already-typeset figure material using the same layout model as
 * the editor. A wrapped figure fills its wrapfigure measure; a normal figure is
 * left at its TeX-native size unless the source asks for width and/or height.
 */
export function layoutLatexFigure(layout, lines) {
  const body = Array.isArray(lines) ? lines : [String(lines)];
  const requestedWidth = layoutLatexLength(layout.width);
  const requestedHeight = layoutLatexLength(layout.height, "\\textheight");
  // Inside wrapfigure, \linewidth is the width chosen by the outer environment.
  // Using it avoids resolving the same percentage against \textwidth twice.
  const width = layout.wrap && (requestedWidth || !requestedHeight) ? "\\linewidth" : requestedWidth;
  const sized = width || requestedHeight
    ? [`\\resizebox{${width || "!"}}{${requestedHeight || "!"}}{%`, ...body, "}"]
    : body;
  const placed = layoutLatexEnvironment(layout, sized);
  return {
    lines: placed.lines,
    packages: [...new Set([...(width || requestedHeight ? ["graphicx"] : []), ...placed.packages])],
  };
}
