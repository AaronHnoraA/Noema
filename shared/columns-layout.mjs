/*
 * Canonical parser, serializer, splitter, and CSS/LaTeX emitters for Noema's
 * multi-column block environment:
 *
 *   #+begin columns {widths=60-40 valign=top gap=md rule=on}
 *   Left column: arbitrary Markdown blocks (headings, lists, math, tables, images...)
 *
 *   #+col
 *
 *   Right column: arbitrary Markdown blocks...
 *   #+end columns
 *
 * Also supports newspaper-style flowing columns:
 *
 *   #+begin columns {mode=flow cols=2}
 *   Flowing prose across columns...
 *   #+end columns
 *
 * Shared across the CM6 editor, HTML/published renderer, and Node LaTeX
 * exporter; mirrored in Go at `kernel/noema/latex/preprocess.go`.
 */

import { parseAttrArgs } from "./layout-attrs.mjs";

export const COLUMNS_ENV_KIND = "columns";
export const COLUMNS_MIN_WIDTH_PCT = 15;
export const COLUMNS_MAX_COUNT = 6;

const COLUMNS_OWNED_KEYS = new Set([
  "mode",
  "cols",
  "columns",
  "widths",
  "align",
  "valign",
  "gap",
  "rule",
]);

const VALID_ALIGNS = new Set(["left", "center", "right", "justify"]);
const VALID_VALIGNS = new Set(["top", "center", "bottom", "stretch"]);
const VALID_GAPS = new Set(["sm", "md", "lg"]);

const COL_MARKER_RE = /^[ \t]*#\+col(?=[ \t]*(?:\{|$))(?:\s+(\{[^{}\r\n]*\}))?[ \t]*$/i;
const ORG_OPEN_RE = /^[ \t]*#\+begin[ \t]+([A-Za-z][\w-]*)\b/i;
const ORG_CLOSE_RE = /^[ \t]*#\+end[ \t]+([A-Za-z][\w-]*)[ \t]*$/i;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

function normalizeBoolRule(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (["off", "false", "0", "no", "none"].includes(raw)) return "off";
  if (["on", "true", "1", "yes", "rule"].includes(raw)) return "on";
  return null;
}

/**
 * Normalize column width weights to clean integers summing strictly to 100,
 * respecting `COLUMNS_MIN_WIDTH_PCT` per column.
 */
export function normalizeColumnWidths(rawWidths, count) {
  const safeCount = Math.max(1, Math.min(COLUMNS_MAX_COUNT, Math.floor(count) || 1));
  if (safeCount === 1) return [100];
  const minPct = Math.min(COLUMNS_MIN_WIDTH_PCT, Math.floor(100 / safeCount));
  let values;
  if (Array.isArray(rawWidths) && rawWidths.length === safeCount
      && rawWidths.every((v) => Number.isFinite(Number(v)) && Number(v) > 0)) {
    values = rawWidths.map((v) => Number(v));
  } else {
    values = Array(safeCount).fill(100 / safeCount);
  }
  const sum = values.reduce((acc, v) => acc + v, 0) || safeCount;
  const pcts = values.map((v) => (v / sum) * 100);
  // Water-filling floor clamp: pin any column below minPct to minPct and
  // redistribute the remaining budget across unfixed columns so no column ever
  // drops below minPct after normalization.
  const fixed = Array(safeCount).fill(false);
  let fixedCount = 0;
  while (true) {
    let changed = false;
    for (let i = 0; i < safeCount; i++) {
      if (!fixed[i] && pcts[i] < minPct) {
        fixed[i] = true;
        pcts[i] = minPct;
        fixedCount++;
        changed = true;
      }
    }
    if (!changed || fixedCount >= safeCount) break;
    const remainingBudget = 100 - fixedCount * minPct;
    let freeSum = 0;
    for (let i = 0; i < safeCount; i++) {
      if (!fixed[i]) freeSum += pcts[i];
    }
    for (let i = 0; i < safeCount; i++) {
      if (!fixed[i]) pcts[i] = freeSum > 0 ? (pcts[i] / freeSum) * remainingBudget : remainingBudget / (safeCount - fixedCount);
    }
  }
  // Largest-remainder rounding so integers always sum strictly to 100.
  const floors = pcts.map((v) => Math.floor(v));
  let remainder = 100 - floors.reduce((acc, v) => acc + v, 0);
  const order = pcts
    .map((v, index) => ({ index, frac: v - floors[index] }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; i < remainder; i++) {
    floors[order[i % order.length].index] += 1;
  }
  return floors;
}

/** Whether WIDTHS matches the canonical equal-width split for COUNT columns. */
export function areEqualColumnWidths(widths, count) {
  if (!Array.isArray(widths) || widths.length !== count) return true;
  const equal = normalizeColumnWidths(null, count);
  return widths.every((w, idx) => Math.round(w) === equal[idx]);
}

/** Parse `{...}` attribute block from a `#+begin columns` title (ignoring trailing `{#id}`). */
export function parseColumnsHeader(title = "") {
  const rawTitle = String(title || "").replace(/\s+\{#[0-9a-fA-F-]+\}\s*$/, "").trim();
  const attrMatch = /\{([^{}]*)\}\s*$/.exec(rawTitle);
  const rawAttrs = attrMatch ? parseAttrArgs(attrMatch[0]) : {};
  const extraAttrs = {};
  for (const [k, v] of Object.entries(rawAttrs)) {
    if (!COLUMNS_OWNED_KEYS.has(k)) extraAttrs[k] = v;
  }
  const mode = String(rawAttrs.mode || "").toLowerCase() === "flow" ? "flow" : "columns";
  const reqCols = Number(rawAttrs.cols ?? rawAttrs.columns);
  const cols = Number.isInteger(reqCols) && reqCols >= 1 && reqCols <= COLUMNS_MAX_COUNT
    ? reqCols
    : (mode === "flow" ? 2 : 0);
  const rawAlign = String(rawAttrs.align || "").toLowerCase();
  const align = VALID_ALIGNS.has(rawAlign) ? rawAlign : "inherit";
  const rawValign = String(rawAttrs.valign || "").toLowerCase();
  const valign = VALID_VALIGNS.has(rawValign) ? rawValign : "top";
  const rawGap = String(rawAttrs.gap || "").toLowerCase();
  const gap = VALID_GAPS.has(rawGap) ? rawGap : "md";
  const rule = normalizeBoolRule(rawAttrs.rule) ?? "on";

  const widthParts = String(rawAttrs.widths || "").split(/[-,:]/).map((s) => s.trim()).filter(Boolean);
  const parsedWidths = widthParts.map(Number);
  const widths = parsedWidths.length >= 2 && parsedWidths.length <= COLUMNS_MAX_COUNT
    && parsedWidths.every((n) => Number.isFinite(n) && n > 0)
    ? normalizeColumnWidths(parsedWidths, parsedWidths.length)
    : null;

  return {
    mode,
    cols,
    widths,
    align,
    valign,
    gap,
    rule,
    extraAttrs,
  };
}

/**
 * Serialize a columns spec back into compact canonical `{...}` attributes,
 * omitting defaults so standard 2-column blocks stay noise-free.
 */
export function serializeColumnsAttrs(spec, paneCount = 2) {
  const out = { ...(spec.extraAttrs || {}) };
  if (spec.mode === "flow") {
    out.mode = "flow";
    out.cols = String(Math.max(2, Math.min(4, spec.cols || 2)));
  } else {
    if (spec.widths && spec.widths.length === paneCount && !areEqualColumnWidths(spec.widths, paneCount)) {
      out.widths = normalizeColumnWidths(spec.widths, paneCount).join("-");
    }
    if (spec.valign && spec.valign !== "top") out.valign = spec.valign;
  }
  if (spec.align && spec.align !== "inherit") out.align = spec.align;
  if (spec.gap && spec.gap !== "md") out.gap = spec.gap;
  if (spec.rule === "off") out.rule = "off";
  const entries = Object.entries(out);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}=${/\s/.test(v) ? JSON.stringify(v) : v}`).join(" ")}}`;
}

/**
 * Split the Markdown body of a `#+begin columns` block on top-level `#+col`
 * lines while ignoring fenced code blocks, display math, HTML comments, and
 * nested `#+begin ... #+end` environments.
 *
 * All offsets are relative to BODY start.
 */
export function splitColumnPanes(body = "", { allowIndentedMarkers = true } = {}) {
  const text = String(body ?? "");
  const lines = [];
  let offset = 0;
  while (offset <= text.length) {
    const nl = text.indexOf("\n", offset);
    const end = nl < 0 ? text.length : nl;
    lines.push({ from: offset, to: end, nextFrom: nl < 0 ? text.length : nl + 1, text: text.slice(offset, end) });
    if (nl < 0) break;
    offset = nl + 1;
  }

  const markers = [];
  let fenceChar = "";
  let fenceLen = 0;
  let inDisplayMath = false;
  let inHtmlComment = false;
  let envDepth = 0;

  for (const line of lines) {
    const raw = line.text;
    const trimmed = raw.trim();

    if (inHtmlComment) {
      if (raw.includes("-->")) inHtmlComment = false;
      continue;
    }
    if (fenceChar) {
      const closeRe = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);
      if (closeRe.test(raw)) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }
    if (inDisplayMath) {
      if (trimmed === "$$" || trimmed === "\\]") inDisplayMath = false;
      continue;
    }
    const fenceOpen = FENCE_OPEN_RE.exec(raw);
    if (fenceOpen) {
      fenceChar = fenceOpen[1][0];
      fenceLen = fenceOpen[1].length;
      continue;
    }
    if (trimmed === "$$" || trimmed === "\\[") {
      inDisplayMath = true;
      continue;
    }
    if (raw.includes("<!--") && !raw.includes("-->")) {
      inHtmlComment = true;
      continue;
    }
    if (ORG_OPEN_RE.test(raw)) {
      envDepth++;
      continue;
    }
    if (ORG_CLOSE_RE.test(raw)) {
      if (envDepth > 0) envDepth--;
      continue;
    }
    if (envDepth === 0 && (allowIndentedMarkers || !/^(?: {4}| {0,3}\t)/.test(raw))) {
      const colMatch = COL_MARKER_RE.exec(raw);
      if (colMatch) {
        const attrs = colMatch[1] ? parseAttrArgs(colMatch[1]) : {};
        const rawAlign = String(attrs.align || "").toLowerCase();
        markers.push({
          from: line.from,
          to: line.to,
          nextFrom: line.nextFrom,
          align: VALID_ALIGNS.has(rawAlign) ? rawAlign : "inherit",
        });
      }
    }
  }

  const panes = [];
  let start = 0;
  let paneAlign = "inherit";
  let markerFrom = -1;
  let markerTo = -1;
  for (const marker of markers) {
    const rawEnd = marker.from > start && text[marker.from - 1] === "\n" ? marker.from - 1 : marker.from;
    panes.push({
      body: text.slice(start, rawEnd),
      from: start,
      to: rawEnd,
      markerFrom,
      markerTo,
      align: paneAlign,
    });
    start = marker.nextFrom;
    paneAlign = marker.align;
    markerFrom = marker.from;
    markerTo = marker.to;
  }
  panes.push({
    body: text.slice(start),
    from: start,
    to: text.length,
    markerFrom,
    markerTo,
    align: paneAlign,
  });
  return panes;
}

/** Resolve effective widths for rendering a columns block with PANE_COUNT panes. */
export function resolvedColumnWidths(spec, paneCount) {
  const count = spec.mode === "flow"
    ? Math.max(2, Math.min(4, spec.cols || 2))
    : Math.max(1, Math.min(COLUMNS_MAX_COUNT, paneCount || 1));
  if (spec.mode === "flow") return normalizeColumnWidths(null, count);
  return normalizeColumnWidths(spec.widths && spec.widths.length === count ? spec.widths : null, count);
}

/** CSS grid-template-columns string with `minmax(0, Nfr)` so wide children never blow out columns. */
export function columnsGridTracks(widths) {
  return widths.map((w) => `minmax(0, ${Math.round(w)}fr)`).join(" ");
}

/** Exact CSS `left` expression placing divider INDEX dead-center inside the grid gap. */
export function columnDividerLeftCss(widths, index) {
  const total = widths.reduce((sum, w) => sum + w, 0) || 100;
  const precedingRatio = widths.slice(0, index + 1).reduce((sum, w) => sum + w, 0) / total;
  const gapCount = Math.max(0, widths.length - 1);
  return `calc((100% - ${gapCount} * var(--noema-columns-gap)) * ${precedingRatio.toFixed(6)} + ${index + 0.5} * var(--noema-columns-gap))`;
}

/** Exact CSS `left` offset of column pane INDEX matching CSS Grid track geometry. */
export function columnLeftCss(widths, index) {
  if (index <= 0) return "0px";
  const total = widths.reduce((sum, w) => sum + w, 0) || 100;
  const precedingRatio = widths.slice(0, index).reduce((sum, w) => sum + w, 0) / total;
  const gapCount = Math.max(0, widths.length - 1);
  return `calc((100% - ${gapCount} * var(--noema-columns-gap)) * ${precedingRatio.toFixed(6)} + ${index} * var(--noema-columns-gap))`;
}

/** Exact CSS `width` of column pane INDEX matching CSS Grid track geometry. */
export function columnWidthCss(widths, index) {
  const gapCount = Math.max(0, widths.length - 1);
  if (gapCount === 0) return "100%";
  const total = widths.reduce((sum, w) => sum + w, 0) || 100;
  const ratio = (widths[index] ?? 0) / total;
  return `calc((100% - ${gapCount} * var(--noema-columns-gap)) * ${ratio.toFixed(6)})`;
}

/** Exact CSS `right` inset from container right edge to column pane INDEX right edge. */
export function columnRightCss(widths, index) {
  const trailingGaps = Math.max(0, widths.length - 1 - index);
  if (trailingGaps === 0) return "0px";
  const total = widths.reduce((sum, w) => sum + w, 0) || 100;
  const followingRatio = widths.slice(index + 1).reduce((sum, w) => sum + w, 0) / total;
  const gapCount = Math.max(0, widths.length - 1);
  return `calc((100% - ${gapCount} * var(--noema-columns-gap)) * ${followingRatio.toFixed(6)} + ${trailingGaps} * var(--noema-columns-gap))`;
}

export function columnsClasses(spec, paneCount = 2) {
  const count = spec.mode === "flow"
    ? Math.max(2, Math.min(4, spec.cols || 2))
    : Math.max(1, Math.min(COLUMNS_MAX_COUNT, paneCount || 1));
  return [
    "noema-columns",
    `noema-columns-${spec.mode}`,
    `noema-columns-gap-${spec.gap || "md"}`,
    `noema-columns-valign-${spec.valign || "top"}`,
    `noema-columns-rule-${count <= 1 ? "off" : (spec.rule || "on")}`,
    spec.align && spec.align !== "inherit" ? `noema-columns-align-${spec.align}` : "",
  ].filter(Boolean).join(" ");
}

export function columnsStyle(spec, paneCount = 2) {
  const widths = resolvedColumnWidths(spec, paneCount);
  const count = widths.length;
  return `--noema-columns-count:${count};--noema-columns-tracks:${columnsGridTracks(widths)}`;
}

/**
 * Convert a parsed columns spec + rendered pane markdown fragments into LaTeX
 * blocks (`minipage` for explicit columns, `multicols` for flowing columns).
 *
 * Each pane entry may be a Markdown string or `{ body, align }`. Adjacent
 * minipage boundaries are emitted inside a single raw-LaTeX fence without a
 * blank line so TeX keeps columns strictly side by side in one horizontal box.
 */
export function columnsLatexBlocks(spec, transformedPanes) {
  const paneEntries = (transformedPanes || []).map((entry) => (
    typeof entry === "string"
      ? { body: entry, align: "inherit" }
      : { body: String(entry?.body ?? ""), align: entry?.align || "inherit" }
  ));
  if (spec.mode === "flow") {
    const cols = Math.max(2, Math.min(4, spec.cols || 2));
    const body = paneEntries.map((p) => p.body.trim()).filter(Boolean).join("\n\n");
    return [
      "",
      "```{=latex}",
      `\\begin{multicols}{${cols}}`,
      "```",
      "",
      body,
      "",
      "```{=latex}",
      "\\end{multicols}",
      "```",
      "",
    ];
  }
  const panes = paneEntries.length > 0 ? paneEntries : [{ body: "", align: "inherit" }];
  if (panes.length === 1) {
    const effAlign = panes[0].align !== "inherit" ? panes[0].align : spec.align;
    const body = panes[0].body.trim();
    if (effAlign === "center" || effAlign === "left" || effAlign === "right") {
      const env = effAlign === "left" ? "flushleft" : effAlign === "right" ? "flushright" : "center";
      return [
        "",
        "```{=latex}",
        `\\begin{${env}}`,
        "```",
        "",
        body,
        "",
        "```{=latex}",
        `\\end{${env}}`,
        "```",
        "",
      ];
    }
    return body ? ["", body, ""] : [""];
  }
  const widths = resolvedColumnWidths(spec, panes.length);
  const gapFraction = spec.gap === "sm" ? 0.02 : spec.gap === "lg" ? 0.045 : 0.03;
  const usable = Math.max(0.5, 1 - gapFraction * (panes.length - 1));
  const vpos = spec.valign === "center" ? "c" : spec.valign === "bottom" ? "b" : "t";
  const alignDirective = (paneAlign) => {
    const eff = paneAlign !== "inherit" ? paneAlign : spec.align;
    if (eff === "center") return "\\centering";
    if (eff === "left") return "\\raggedright";
    if (eff === "right") return "\\raggedleft";
    return "";
  };
  const openMinipage = (i, prefix) => {
    const frac = Math.round(((widths[i] / 100) * usable) * 1000) / 1000;
    const alignCmd = alignDirective(panes[i].align);
    return `${prefix}\\begin{minipage}[${vpos}]{${frac}\\textwidth}${alignCmd ? `\n${alignCmd}` : ""}`;
  };
  const out = [
    "",
    "```{=latex}",
    openMinipage(0, "\\noindent"),
    "```",
  ];
  for (let i = 0; i < panes.length; i++) {
    const body = panes[i].body.trim();
    if (body) out.push("", body, "");
    else out.push("");
    if (i < panes.length - 1) {
      out.push(
        "```{=latex}",
        "\\end{minipage}%",
        openMinipage(i + 1, "\\hfill"),
        "```",
      );
    } else {
      out.push(
        "```{=latex}",
        "\\end{minipage}",
        "```",
        "",
      );
    }
  }
  return out;
}
