export const MAX_PRINT_HTML_BYTES: number;

export type PrintPdfRequest = {
  html: string;
  title: string;
  defaultPath: string;
  bytes: number;
};

export type PrintPdfResult = {
  canceled: false;
  path: string;
  bytes: number;
};

export function safePdfTitle(value?: unknown): string;
export function normalizePdfOutputPath(value?: unknown): string;
export function normalizePrintPdfRequest(input?: {
  html?: unknown;
  title?: unknown;
  defaultPath?: unknown;
}): PrintPdfRequest;
export function nativePdfOptions(): {
  printBackground: true;
  preferCSSPageSize: true;
  displayHeaderFooter: false;
  pageSize: "A4";
  margins: { top: number; bottom: number; left: number; right: number };
};
export function printHtmlToPdf(options: {
  BrowserWindow: new (options: Record<string, unknown>) => any;
  html: string;
  outputPath: string;
  parent?: { isDestroyed?(): boolean } | null;
  tempRoot: string;
  resourceTimeoutMs?: number;
}): Promise<PrintPdfResult>;
