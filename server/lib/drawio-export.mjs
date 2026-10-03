/**
 * draw.io export service.
 *
 * Noema renders a `.drawio` reference as a picture, not as an editor: the file
 * is exported to SVG once, cached, and served through the ordinary asset path.
 * This is the org-drawio model — the diagram lives in its own file, the real
 * draw.io application owns editing, and the note links the export — and it is
 * also how GitHub shows a committed `.drawio.svg`.
 *
 * Nothing here reaches the network. A missing exporter is reported in the
 * placeholder SVG instead of falling back to the hosted editor.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Bump whenever the export arguments change, so stale renders are not served. */
const EXPORT_VERSION = "2";
const EXPORT_TIMEOUT_MS = 90_000;
/**
 * Each export is a full draw.io (Electron) launch, around a second of CPU. A
 * note with a dozen diagrams would otherwise start a dozen of them at once and
 * stall the machine, so exports queue behind a small gate. Everything after the
 * first render is served from the on-disk cache and never reaches the gate.
 */
const EXPORT_CONCURRENCY = Math.max(1, Number(process.env.NOEMA_DRAWIO_CONCURRENCY || 2) || 2);
const PLACEHOLDER_WIDTH = 520;
const PLACEHOLDER_HEIGHT = 160;

/** Where draw.io desktop keeps its CLI on each platform we support. */
const EXPORTER_CANDIDATES = [
  "/Applications/draw.io.app/Contents/MacOS/draw.io",
  "/Applications/drawio.app/Contents/MacOS/drawio",
  "/opt/homebrew/bin/drawio",
  "/usr/local/bin/drawio",
  "/usr/bin/drawio",
  "/snap/bin/drawio",
];

let exporterPath;

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

/**
 * The draw.io binary, or "" when the application is not installed. Resolved
 * once per process; `NOEMA_DRAWIO_BIN` overrides the search.
 */
export function drawioExporter() {
  if (exporterPath !== undefined) return exporterPath;
  const override = String(process.env.NOEMA_DRAWIO_BIN || "").trim();
  if (override) {
    exporterPath = existsSync(override) ? override : "";
    return exporterPath;
  }
  exporterPath = EXPORTER_CANDIDATES.find((candidate) => existsSync(candidate)) || "";
  return exporterPath;
}

/** A standalone SVG that says why a diagram could not be drawn. */
export function drawioPlaceholderSVG(file, message) {
  const name = htmlEscape(basename(String(file || "diagram.drawio")));
  const lines = String(message || "Export failed").split(/\r?\n/).slice(0, 3);
  const detail = lines
    .map((line, index) => `<tspan x="24" dy="${index === 0 ? 0 : 18}">${htmlEscape(line.slice(0, 96))}</tspan>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PLACEHOLDER_WIDTH}" height="${PLACEHOLDER_HEIGHT}" viewBox="0 0 ${PLACEHOLDER_WIDTH} ${PLACEHOLDER_HEIGHT}" role="img" aria-label="draw.io diagram unavailable">
<rect x="0.5" y="0.5" width="${PLACEHOLDER_WIDTH - 1}" height="${PLACEHOLDER_HEIGHT - 1}" rx="6" fill="#fbfaf7" stroke="#d6d0c4"/>
<text x="24" y="46" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="14" font-weight="600" fill="#1f2937">${name}</text>
<text x="24" y="78" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="12" fill="#9f1239">${detail}</text>
<text x="24" y="${PLACEHOLDER_HEIGHT - 26}" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="11" fill="#6b7280">Open the file in draw.io to edit it; Noema renders the export.</text>
</svg>`;
}

function cacheKey(file, stats, page, format) {
  return createHash("sha256")
    .update(`${EXPORT_VERSION}\u0000${file}\u0000${stats.mtimeMs}\u0000${stats.size}\u0000${page}\u0000${format}`)
    .digest("hex")
    .slice(0, 40);
}

const inFlight = new Map();

let running = 0;
const waiting = [];

function releaseExportSlot() {
  running -= 1;
  const next = waiting.shift();
  if (next) {
    running += 1;
    next();
  }
}

function acquireExportSlot() {
  if (running < EXPORT_CONCURRENCY) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

/** The cache id for an export, so a caller can answer a conditional request. */
export async function drawioExportTag(file, { page = 0, format = "svg" } = {}) {
  try {
    return cacheKey(file, await stat(file), page, format);
  } catch {
    return "";
  }
}

/**
 * Export PAGE of FILE, caching the result under CACHEDIR keyed by the file's
 * path, size, mtime, page and format. FORMAT is "svg" for a page (the picture
 * Noema shows) or "pdf" for LaTeX, which has no SVG support of its own and
 * takes draw.io's own vector PDF rather than a converted one.
 *
 * Returns `{ svg, data, cached, error }`; `error` is set when the result is the
 * placeholder rather than a real export, and `data` is the raw bytes.
 */
export async function drawioExportSVG(file, { page = 0, format = "svg", cacheDir, timeoutMs = EXPORT_TIMEOUT_MS } = {}) {
  const outFormat = format === "pdf" ? "pdf" : "svg";
  const placeholder = (message) => (outFormat === "pdf"
    ? { svg: "", data: null, cached: false, error: message }
    : { svg: drawioPlaceholderSVG(file, message), data: null, cached: false, error: message });
  let stats;
  try {
    stats = await stat(file);
  } catch {
    return placeholder("File not found");
  }

  const key = cacheKey(file, stats, page, outFormat);
  const cacheFile = cacheDir ? join(cacheDir, `${key}.${outFormat}`) : "";
  if (cacheFile) {
    try {
      const data = await readFile(cacheFile);
      return { svg: outFormat === "svg" ? data.toString("utf8") : "", data, cached: true, error: "" };
    } catch {}
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const exporter = drawioExporter();
    if (!exporter) return placeholder("draw.io is not installed (set NOEMA_DRAWIO_BIN)");
    const outDir = cacheDir || tmpdir();
    mkdirSync(outDir, { recursive: true });
    const outFile = cacheFile || join(outDir, `${key}.${outFormat}`);
    const args = [
      "--no-sandbox",
      "-x",
      "-f", outFormat,
      // A PDF figure is cropped to the diagram; a page is not.
      ...(outFormat === "pdf" ? ["--crop"] : []),
      // Always the diagram's authored colours. draw.io's dark theme inverts the
      // fills an author chose, and a diagram's colours are its content; only the
      // sheet it sits on follows the editor theme.
      "--svg-theme", "light",
      // Embedded font subsets make a simple diagram 16x larger (422 KB vs 26 KB
      // for the same chart) for no gain: the SVG renders inside Noema's own
      // page, where the note's fonts already apply.
      "--embed-svg-fonts", "false",
      // Keep the source inside the export, the way a committed `.drawio.svg`
      // carries it, so the picture can still be opened and edited in draw.io.
      ...(outFormat === "svg" ? ["--embed-diagram"] : []),
      // draw.io counts pages from 1.
      "-p", String(page + 1),
      "-o", outFile,
      file,
    ];
    await acquireExportSlot();
    try {
      // Another request may have finished this exact export while we queued.
      if (cacheFile) {
        try {
          const data = await readFile(cacheFile);
          return { svg: outFormat === "svg" ? data.toString("utf8") : "", data, cached: true, error: "" };
        } catch {}
      }
      await execFileAsync(exporter, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
      const data = await readFile(outFile);
      if (outFormat === "svg" && !data.toString("utf8").trim().startsWith("<")) {
        throw new Error("Exporter produced no SVG");
      }
      if (outFormat === "pdf" && data.subarray(0, 4).toString("latin1") !== "%PDF") {
        throw new Error("Exporter produced no PDF");
      }
      return { svg: outFormat === "svg" ? data.toString("utf8") : "", data, cached: false, error: "" };
    } catch (err) {
      await rm(outFile, { force: true }).catch(() => {});
      const message = err?.killed ? "draw.io export timed out" : String(err?.message || err).split("\n")[0];
      return placeholder(message);
    } finally {
      releaseExportSlot();
    }
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}
