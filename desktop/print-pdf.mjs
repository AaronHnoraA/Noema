import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_PRINT_HTML_BYTES = 32 * 1024 * 1024;

export function safePdfTitle(value = "") {
  const title = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\\/:]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return title || "Noema";
}

export function normalizePdfOutputPath(value = "") {
  const requested = String(value || "").trim();
  if (!requested) throw new Error("Missing PDF output path");
  const output = resolve(requested);
  return extname(output).toLowerCase() === ".pdf" ? output : `${output}.pdf`;
}

export function normalizePrintPdfRequest(input = {}) {
  const html = typeof input?.html === "string" ? input.html : "";
  const bytes = Buffer.byteLength(html, "utf8");
  if (!html.trim()) throw new Error("Printable HTML is empty");
  if (html.includes("\u0000")) throw new Error("Printable HTML contains a NUL byte");
  if (bytes > MAX_PRINT_HTML_BYTES) {
    throw new Error(`Printable HTML exceeds ${MAX_PRINT_HTML_BYTES} bytes`);
  }
  const title = safePdfTitle(input?.title);
  const defaultPath = String(input?.defaultPath || "").trim();
  return {
    html,
    title,
    defaultPath: defaultPath ? normalizePdfOutputPath(defaultPath) : "",
    bytes,
  };
}

export function nativePdfOptions() {
  return {
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    pageSize: "A4",
    margins: { top: 0.5, bottom: 0.5, left: 0.55, right: 0.55 },
  };
}

function printableResourcesReadyScript(timeoutMs) {
  const timeout = Math.max(1, Math.min(30_000, Number(timeoutMs) || 10_000));
  return `(() => {
    const waitForImage = (image) => image.complete
      ? Promise.resolve()
      : new Promise((resolve) => {
          const done = () => resolve();
          image.addEventListener("load", done, { once: true });
          image.addEventListener("error", done, { once: true });
        });
    const fonts = document.fonts && document.fonts.ready
      ? Promise.resolve(document.fonts.ready).catch(() => undefined)
      : Promise.resolve();
    const resources = Promise.all([fonts, ...Array.from(document.images, waitForImage)]);
    return Promise.race([
      resources,
      new Promise((resolve) => setTimeout(resolve, ${timeout})),
    ]).then(() => true);
  })()`;
}

function atomicWritePdf(outputPath, data) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
    renameSync(temporary, outputPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function printHtmlToPdf({
  BrowserWindow,
  html,
  outputPath,
  parent = null,
  tempRoot,
  resourceTimeoutMs = 10_000,
} = {}) {
  if (typeof BrowserWindow !== "function") throw new TypeError("BrowserWindow constructor is required");
  const request = normalizePrintPdfRequest({ html, title: "Noema" });
  const output = normalizePdfOutputPath(outputPath);
  const root = resolve(String(tempRoot || "").trim());
  if (!String(tempRoot || "").trim()) throw new Error("Missing PDF temporary root");
  mkdirSync(root, { recursive: true });
  const work = mkdtempSync(join(root, "noema-print-"));
  const htmlFile = join(work, "document.html");
  let printWindow = null;
  try {
    writeFileSync(htmlFile, request.html, { encoding: "utf8", mode: 0o600 });
    printWindow = new BrowserWindow({
      show: false,
      ...(parent && !parent.isDestroyed?.() ? { parent } : {}),
      backgroundColor: "#ffffff",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    printWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    printWindow.webContents.on("will-navigate", (event, target) => {
      let allowed = false;
      try {
        allowed = new URL(target).protocol === "file:"
          && resolve(fileURLToPath(target)) === resolve(htmlFile);
      } catch {}
      if (!allowed) event.preventDefault();
    });
    await printWindow.loadFile(htmlFile);
    await printWindow.webContents.executeJavaScript(
      printableResourcesReadyScript(resourceTimeoutMs),
      true,
    );
    const pdf = await printWindow.webContents.printToPDF(nativePdfOptions());
    const bytes = Buffer.from(pdf);
    if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("Electron returned an invalid PDF document");
    }
    atomicWritePdf(output, bytes);
    return { canceled: false, path: output, bytes: bytes.length };
  } finally {
    if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
    rmSync(work, { recursive: true, force: true });
  }
}
