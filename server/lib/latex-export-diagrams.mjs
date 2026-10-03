/**
 * Diagrams in a LaTeX export.
 *
 * A Mermaid fence and a `.drawio` reference are pictures in the editor, so they
 * have to be pictures in the PDF too. Before Pandoc sees the Markdown, each one
 * is turned into a vector figure that rides along as a support file, and the
 * source is rewritten to an ordinary image link — from there the existing image
 * path handles captions, sizing and placement.
 *
 * Where the pictures come from:
 *
 * - `.drawio` is exported by the local draw.io application straight to PDF, so
 *   nothing is converted twice and the figure stays vector.
 * - Mermaid has no server-side renderer — it needs a browser to lay text out —
 *   so the page that is already showing the diagram renders it and sends the
 *   SVG with the export request. `rsvg-convert` turns that into PDF.
 *
 * A diagram that cannot be made into a figure is left exactly as it was, so an
 * export never fails over one picture; the caller reports it as a warning.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

import { drawioExportSVG } from "./drawio-export.mjs";

const execFileAsync = promisify(execFile);

const DIAGRAM_LANGS = new Set(["mermaid", "mindmap", "marmind", "markmind"]);
const DRAWIO_RE = /\.(?:drawio|dio)(?:\.xml)?$/i;
const CONVERT_TIMEOUT_MS = 30_000;

/** A fence's identity, so a client-rendered SVG can be matched to it. */
export function diagramKey(lang, source) {
  return createHash("sha256")
    .update(`${String(lang || "").trim().toLowerCase()}\u0000${String(source || "").trim()}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Scan Markdown for the diagram fences an export has to turn into figures.
 * Returns `{ lang, source, key }` per fence, in document order.
 */
export function scanDiagramFences(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const found = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        if (fence.lang) {
          found.push({ lang: fence.lang, source: fence.body.join("\n"), key: diagramKey(fence.lang, fence.body.join("\n")) });
        }
        fence = null;
        continue;
      }
      fence.body.push(line);
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/);
    if (!open) continue;
    const lang = String(open[2] || "").toLowerCase();
    fence = {
      char: open[1][0],
      length: open[1].length,
      lang: DIAGRAM_LANGS.has(lang) ? lang : "",
      body: [],
    };
  }
  return found;
}

function svgToPdfBin(convertBin) {
  const explicit = String(convertBin || process.env.NOEMA_RSVG_BIN || "").trim();
  return explicit || "rsvg-convert";
}

/** Convert one SVG to PDF. Throws when the converter is missing or fails. */
async function svgToPdf(svg, { convertBin, tmpDir, timeoutMs = CONVERT_TIMEOUT_MS } = {}) {
  const stem = `noema-diagram-${createHash("sha256").update(svg).digest("hex").slice(0, 16)}`;
  const svgFile = resolvePath(tmpDir, `${stem}.svg`);
  const pdfFile = resolvePath(tmpDir, `${stem}.pdf`);
  try {
    await writeFile(svgFile, svg, "utf8");
    await execFileAsync(svgToPdfBin(convertBin), ["-f", "pdf", "-o", pdfFile, svgFile], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const data = await readFile(pdfFile);
    if (data.subarray(0, 4).toString("latin1") !== "%PDF") throw new Error("converter produced no PDF");
    return data;
  } finally {
    await rm(svgFile, { force: true }).catch(() => {});
    await rm(pdfFile, { force: true }).catch(() => {});
  }
}

function replaceFenceWithImage(lines, fenceStart, fenceEnd, name, alt) {
  const replacement = `![${alt}](${name})`;
  return [...lines.slice(0, fenceStart), replacement, ...lines.slice(fenceEnd + 1)];
}

function splitDrawioDestination(destination) {
  const raw = String(destination || "").trim();
  const match = raw.match(/[?#]page=(\d+)\s*$/i);
  if (!match) return { path: raw, page: 0 };
  return { path: raw.slice(0, match.index).trim(), page: Math.max(0, Number(match[1]) - 1) };
}

function drawioLinksIn(line) {
  const links = [];
  for (const match of String(line || "").matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const { path } = splitDrawioDestination(match[2]);
    if (DRAWIO_RE.test(path.split(/[?#]/, 1)[0] || "")) {
      links.push({ from: match.index, to: match.index + match[0].length, alt: match[1], destination: match[2] });
    }
  }
  return links;
}

/**
 * Turn every diagram in MARKDOWN into a figure.
 *
 * `diagrams` is what the page rendered: `[{ key, svg }]`, keyed by
 * `diagramKey(lang, source)`. A fence with no matching render is left as a
 * fenced block and reported, rather than silently dropped.
 *
 * Returns `{ markdown, files, warnings }`, where `files` is the
 * `{ name, content }` shape the LaTeX compile stages beside the document.
 */
export async function prepareLatexDiagrams(markdown, {
  sourceDir = "",
  diagrams = [],
  cacheDir = "",
  tmpDir = "",
  convertBin = "",
  signal,
} = {}) {
  const warnings = [];
  const files = [];
  const rendered = new Map();
  for (const entry of Array.isArray(diagrams) ? diagrams : []) {
    const key = String(entry?.key || "");
    const svg = String(entry?.svg || "");
    if (key && svg) rendered.set(key, svg);
  }

  let lines = String(markdown || "").split(/\r?\n/);
  let figure = 0;
  const stage = tmpDir || cacheDir;

  // 1. Mermaid and mind-map fences, from the back so earlier indexes stay valid.
  const fences = [];
  {
    let fence = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (fence) {
        const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
        if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
          if (fence.lang) fences.push({ ...fence, end: index, source: fence.body.join("\n") });
          fence = null;
          continue;
        }
        fence.body.push(line);
        continue;
      }
      const open = line.match(/^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/);
      if (!open) continue;
      const lang = String(open[2] || "").toLowerCase();
      fence = { char: open[1][0], length: open[1].length, lang: DIAGRAM_LANGS.has(lang) ? lang : "", body: [], start: index };
    }
  }

  for (const fence of fences.reverse()) {
    if (signal?.aborted) break;
    const svg = rendered.get(diagramKey(fence.lang, fence.source));
    if (!svg) {
      warnings.push(`A ${fence.lang} diagram was exported as source: the editor did not supply a rendered picture.`);
      continue;
    }
    if (!stage) {
      warnings.push(`A ${fence.lang} diagram was exported as source: no staging directory for the figure.`);
      continue;
    }
    try {
      const pdf = await svgToPdf(svg, { convertBin, tmpDir: stage });
      figure += 1;
      const name = `noema-diagram-${figure}.pdf`;
      files.push({ name, content: pdf });
      lines = replaceFenceWithImage(lines, fence.start, fence.end, name, "");
    } catch (err) {
      warnings.push(`A ${fence.lang} diagram was exported as source: ${String(err?.message || err)}`);
    }
  }

  // 2. `.drawio` references, exported straight to PDF by draw.io itself.
  for (let index = 0; index < lines.length; index += 1) {
    if (signal?.aborted) break;
    const links = drawioLinksIn(lines[index]);
    if (links.length === 0) continue;
    let line = lines[index];
    for (const link of links.reverse()) {
      const { path, page } = splitDrawioDestination(link.destination);
      const file = isAbsolute(path) ? path : resolvePath(sourceDir || ".", path);
      const result = await drawioExportSVG(file, { page, format: "pdf", cacheDir });
      if (result.error || !result.data) {
        warnings.push(`draw.io diagram "${path}" was not exported: ${result.error || "no output"}`);
        continue;
      }
      figure += 1;
      const name = `noema-diagram-${figure}.pdf`;
      files.push({ name, content: result.data });
      line = `${line.slice(0, link.from)}![${link.alt}](${name})${line.slice(link.to)}`;
    }
    lines[index] = line;
  }

  return { markdown: lines.join("\n"), files, warnings };
}
