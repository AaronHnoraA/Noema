/*
 * Canonical TikZ source handling shared by the browser widget, the Node render
 * service, the HTML exporter and the LaTeX exporter.
 *
 * Every consumer must agree on three things or the compiled-asset cache breaks:
 *   1. how a `#+begin tikz` body is normalized into a standalone document,
 *   2. the content hash that names the compiled asset, and
 *   3. how the compiled SVG's intrinsic TeX size maps back onto note typography.
 *
 * Keeping all three here is what lets the editor, `render-html` and a publish
 * run resolve the *same* `images/<note>/tikz-<id>-<hash>.svg` without talking to
 * each other.
 */

/** Base font size (in TeX pt) that `standalone` uses when none is requested. */
export const TIKZ_DEFAULT_BASE_PT = 10;

/**
 * Drop TeX line comments. A `%` is a comment only when an even number of
 * backslashes precedes it — `\%` is a literal percent sign.
 */
export function stripTexComments(source) {
  return String(source || "")
    .split(/\r?\n/)
    .map((line) => {
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] !== "%") continue;
        let slashes = 0;
        for (let back = index - 1; back >= 0 && line[back] === "\\"; back -= 1) slashes += 1;
        if (slashes % 2 === 0) return line.slice(0, index).trimEnd();
      }
      return line;
    })
    .join("\n");
}

/**
 * Classify a TikZ body: a full document, a bare `tikzpicture`, or loose picture
 * commands that still need the environment wrapped around them.
 */
export function classifyTikzSource(source) {
  const body = stripTexComments(source).trim();
  if (!body) return { kind: "empty", body: "" };
  if (/\\documentclass\b|\\begin\s*\{\s*document\s*\}/.test(body)) return { kind: "document", body };
  if (/\\begin\s*\{\s*tikzpicture\s*\}/.test(body)) return { kind: "picture", body };
  return { kind: "commands", body };
}

/**
 * The body as a `tikzpicture` environment — no preamble. This is what a LaTeX
 * export splices into the surrounding document, which already loads `tikz`.
 */
export function tikzPictureSource(source) {
  const { kind, body } = classifyTikzSource(source);
  if (kind === "empty") return "";
  if (kind === "picture") return body;
  if (kind === "document") {
    // A self-contained document still has to contribute a picture when it is
    // inlined into an export. Prefer its own tikzpicture over its preamble.
    const picture = body.match(/\\begin\s*\{\s*tikzpicture\s*\}[\s\S]*\\end\s*\{\s*tikzpicture\s*\}/);
    return picture ? picture[0] : "";
  }
  return `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`;
}

/**
 * Base font size the source compiles at. A user-supplied `\documentclass` may
 * ask for 11pt/12pt, and the rendered SVG's pt dimensions are relative to it.
 */
export function tikzBasePt(source) {
  const { kind, body } = classifyTikzSource(source);
  if (kind !== "document") return TIKZ_DEFAULT_BASE_PT;
  const options = body.match(/\\documentclass\s*\[([^\]]*)\]/);
  const requested = options?.[1]?.match(/(?:^|,)\s*(\d{1,2})pt\s*(?:,|$)/);
  const value = Number(requested?.[1]);
  return Number.isFinite(value) && value > 0 ? value : TIKZ_DEFAULT_BASE_PT;
}

/**
 * The complete `.tex` handed to pdflatex. `standalone` with `border=2pt` crops
 * the page to the picture, which is what makes the result behave like an
 * inline figure rather than a page.
 */
export function tikzStandaloneDocument(source) {
  const { kind, body } = classifyTikzSource(source);
  if (kind === "empty") return "";
  if (kind === "document") return body;
  const picture = kind === "picture" ? body : `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`;
  return [
    "\\documentclass[tikz,border=2pt]{standalone}",
    "\\begin{document}",
    picture,
    "\\end{document}",
  ].join("\n");
}

/**
 * Stable 64-bit FNV-1a over the normalized document, as 16 lowercase hex chars.
 *
 * Cache identity only — never a security boundary — so a non-cryptographic hash
 * that both a browser and Node can compute synchronously beats SubtleCrypto's
 * async API here.
 */
export function tikzSourceHash(source) {
  const text = tikzStandaloneDocument(source);
  let hash = 0xcbf29ce484222325n;
  // Hash bytes, not UTF-16 code units. This makes non-ASCII node labels stable
  // across browser and Node implementations and is the specified FNV-1a input
  // model rather than a lookalike 32-bit multiply folded into two halves.
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Filesystem-safe portion of a `#+begin tikz <id>` identifier. */
export function tikzAssetId(id, fallback = "tikz") {
  const clean = String(id || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || fallback;
}

/**
 * Compiled-asset file name. The hash in the name is what makes a recompile
 * produce a *new* URL, so neither the browser nor a published page can serve a
 * stale diagram from cache.
 */
export function tikzAssetFileName(id, source) {
  return `tikz-${tikzAssetId(id)}-${tikzSourceHash(source)}.svg`;
}

/** Matches any compiled asset for one id, whatever its content hash. */
export function tikzAssetFilePattern(id) {
  const escaped = tikzAssetId(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^tikz-${escaped}-[0-9a-f]{16}\\.svg$`);
}

// SVG/CSS lengths → TeX pt. A CSS `pt` is 1/72in, i.e. a TeX *big* point, so it
// converts exactly like `bp` and not 1:1 — dvisvgm writes CSS units on the root.
const LENGTH_TO_PT = {
  pt: 72.27 / 72,
  bp: 72.27 / 72,
  px: 72.27 / 96,
  in: 72.27,
  cm: 72.27 / 2.54,
  mm: 72.27 / 25.4,
  pc: 12,
};

function lengthToPt(value) {
  const match = String(value || "").trim().match(/^(-?[\d.]+)\s*([a-z]*)$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const unit = (match[2] || "px").toLowerCase();
  return amount * (LENGTH_TO_PT[unit] ?? LENGTH_TO_PT.px);
}

/**
 * Intrinsic size of a dvisvgm-produced SVG, in TeX pt.
 *
 * dvisvgm writes CSS `pt` (1/72in) on the root element, so the raw attribute is
 * converted rather than trusted as a TeX length.
 */
export function tikzSvgIntrinsicSize(svg) {
  const text = String(svg || "").slice(0, 4096);
  const root = text.match(/<svg\b[^>]*>/i)?.[0] || "";
  const width = lengthToPt(root.match(/\bwidth\s*=\s*['"]([^'"]+)['"]/i)?.[1] || "");
  const height = lengthToPt(root.match(/\bheight\s*=\s*['"]([^'"]+)['"]/i)?.[1] || "");
  if (width > 0 && height > 0) return { widthPt: width, heightPt: height };
  const box = root.match(/\bviewBox\s*=\s*['"]\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*['"]/i);
  if (!box) return { widthPt: 0, heightPt: 0 };
  return { widthPt: lengthToPt(`${box[1]}pt`), heightPt: lengthToPt(`${box[2]}pt`) };
}

/**
 * Intrinsic size expressed in `em` of the surrounding prose.
 *
 * This is the whole point of measuring: a picture that is 8 base-font-widths
 * across in the PDF stays 8 em across in the note, so a TikZ figure keeps the
 * same relationship to body text that it has in a compiled LaTeX document
 * instead of being pinned to an arbitrary pixel box.
 */
export function tikzIntrinsicEm(size, basePt = TIKZ_DEFAULT_BASE_PT) {
  const base = Number(basePt) > 0 ? Number(basePt) : TIKZ_DEFAULT_BASE_PT;
  const round = (value) => Math.round((Number(value) || 0) / base * 1000) / 1000;
  return { widthEm: round(size?.widthPt), heightEm: round(size?.heightPt) };
}

/**
 * The `images/<folder>/` name a note's generated assets live under.
 *
 * The server owns asset placement, but an export running in the browser has to
 * resolve the *same* directory without a round trip, so the rule lives here and
 * `server/lib/runtime.mjs` defers to it rather than keeping a second copy.
 */
export function noteAssetFolderName(noteFile, fallback = "scratch") {
  const base = String(noteFile || "").replace(/\\/g, "/").split("/").pop() || "";
  const stem = base.replace(/\.[^.]+$/, "");
  const safe = stem
    .normalize("NFKC")
    .replace(new RegExp("[\\u0000-\\u001f<>:\"/\\\\|?*]+", "g"), "-")
    .replace(/\s+/g, "-")
    .trim()
    .replace(/^\.+$/, "");
  return safe || fallback;
}

/** Note-relative markdown path of a compiled TikZ asset. */
export function tikzAssetMarkdownPath(noteFile, id, source) {
  return `./images/${noteAssetFolderName(noteFile)}/${tikzAssetFileName(id, source)}`;
}
