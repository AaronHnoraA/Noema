import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  MAX_PRINT_HTML_BYTES,
  nativePdfOptions,
  normalizePdfOutputPath,
  normalizePrintPdfRequest,
  printHtmlToPdf,
  safePdfTitle,
} from "../desktop/print-pdf.mjs";

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = [];
  options: Record<string, unknown>;
  destroyed = false;
  loadedFile = "";
  navigationHandler: ((event: { preventDefault(): void }, target: string) => void) | null = null;
  printedOptions: Record<string, unknown> | null = null;
  pdf = Buffer.from("%PDF-1.7\nprobe\n", "utf8");
  webContents = {
    setWindowOpenHandler: (handler: () => { action: string }) => {
      expect(handler()).toEqual({ action: "deny" });
    },
    on: (name: string, handler: (event: { preventDefault(): void }, target: string) => void) => {
      if (name === "will-navigate") this.navigationHandler = handler;
    },
    executeJavaScript: async (source: string, userGesture: boolean) => {
      expect(source).toContain("document.fonts");
      expect(source).toContain("document.images");
      expect(userGesture).toBe(true);
      return true;
    },
    printToPDF: async (options: Record<string, unknown>) => {
      this.printedOptions = options;
      return this.pdf;
    },
  };

  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeBrowserWindow.instances.push(this);
  }

  async loadFile(file: string) {
    this.loadedFile = file;
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
  }
}

describe("Electron native PDF adapter", () => {
  test("normalizes titles, output paths and bounded printable HTML", () => {
    expect(safePdfTitle("  Paper / Draft:\u0007  ")).toBe("Paper - Draft-");
    expect(normalizePdfOutputPath("/tmp/paper")).toBe("/tmp/paper.pdf");
    expect(normalizePdfOutputPath("/tmp/PAPER.PDF")).toBe("/tmp/PAPER.PDF");
    expect(normalizePrintPdfRequest({ html: "<html>ok</html>", title: "Paper" })).toMatchObject({
      html: "<html>ok</html>",
      title: "Paper",
      bytes: 15,
    });
    expect(() => normalizePrintPdfRequest({ html: "" })).toThrow("empty");
    expect(() => normalizePrintPdfRequest({ html: `x\u0000y` })).toThrow("NUL");
    expect(() => normalizePrintPdfRequest({ html: "x".repeat(MAX_PRINT_HTML_BYTES + 1) })).toThrow("exceeds");
    expect(nativePdfOptions()).toMatchObject({
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      pageSize: "A4",
    });
  });

  test("prints in an isolated hidden window, atomically writes PDF, and removes staging", async () => {
    const suite = await mkdtemp(join(tmpdir(), "noema-print-pdf-test-"));
    const output = join(suite, "result.pdf");
    const tempRoot = join(suite, "print-tmp");
    FakeBrowserWindow.instances = [];
    try {
      await writeFile(output, "old PDF bytes", "utf8");
      const result = await printHtmlToPdf({
        BrowserWindow: FakeBrowserWindow,
        html: "<!doctype html><html><body><h1>Paper</h1></body></html>",
        outputPath: output,
        tempRoot,
      });
      expect(result).toEqual({ canceled: false, path: output, bytes: 15 });
      expect(await readFile(output, "utf8")).toBe("%PDF-1.7\nprobe\n");
      expect(await readdir(tempRoot)).toEqual([]);
      const win = FakeBrowserWindow.instances[0]!;
      expect(win.options).toMatchObject({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      expect(win.printedOptions).toEqual(nativePdfOptions());
      expect(win.destroyed).toBe(true);
      expect(existsSync(win.loadedFile)).toBe(false);
      let prevented = 0;
      win.navigationHandler?.({ preventDefault: () => { prevented++; } }, pathToFileURL(win.loadedFile).href);
      win.navigationHandler?.({ preventDefault: () => { prevented++; } }, "https://example.com/escape");
      expect(prevented).toBe(1);
    } finally {
      await rm(suite, { recursive: true, force: true });
    }
  });

  test("rejects invalid Electron output without leaving a destination or staging directory", async () => {
    const suite = await mkdtemp(join(tmpdir(), "noema-print-pdf-invalid-"));
    const output = join(suite, "invalid.pdf");
    const tempRoot = join(suite, "print-tmp");
    class InvalidPdfWindow extends FakeBrowserWindow {
      pdf = Buffer.from("not a pdf", "utf8");
    }
    try {
      await writeFile(output, "previous valid export", "utf8");
      await expect(printHtmlToPdf({
        BrowserWindow: InvalidPdfWindow,
        html: "<html><body>Invalid</body></html>",
        outputPath: output,
        tempRoot,
      })).rejects.toThrow("invalid PDF");
      expect(await readFile(output, "utf8")).toBe("previous valid export");
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(suite, { recursive: true, force: true });
    }
  });
});
