import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

export const MAX_STANDALONE_HTML_BYTES = 64 * 1024 * 1024;

export function safeHtmlTitle(value = "") {
  const title = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\\/:]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return title || "Noema";
}

export function normalizeHtmlOutputPath(value = "") {
  const requested = String(value || "").trim();
  if (!requested) throw new Error("Missing HTML output path");
  const output = resolve(requested);
  return /\.html?$/iu.test(extname(output)) ? output : `${output}.html`;
}

export function normalizeExportHtmlRequest(input = {}) {
  const html = typeof input?.html === "string" ? input.html : "";
  const bytes = Buffer.byteLength(html, "utf8");
  if (!html.trim()) throw new Error("Export HTML is empty");
  if (html.includes("\u0000")) throw new Error("Export HTML contains a NUL byte");
  if (bytes > MAX_STANDALONE_HTML_BYTES) {
    throw new Error(`Export HTML exceeds ${MAX_STANDALONE_HTML_BYTES} bytes`);
  }
  const title = safeHtmlTitle(input?.title);
  const defaultPath = String(input?.defaultPath || "").trim();
  return {
    html,
    title,
    defaultPath: defaultPath ? normalizeHtmlOutputPath(defaultPath) : "",
    bytes,
  };
}

export function writeStandaloneHtml(outputPath, html) {
  const output = normalizeHtmlOutputPath(outputPath);
  const request = normalizeExportHtmlRequest({ html });
  mkdirSync(dirname(output), { recursive: true });
  const temporary = join(dirname(output), `.${basename(output)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, request.html, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { canceled: false, path: output, bytes: request.bytes };
}
