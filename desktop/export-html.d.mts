export const MAX_STANDALONE_HTML_BYTES: number;

export type ExportHtmlRequest = {
  html: string;
  title: string;
  defaultPath: string;
  bytes: number;
};

export function safeHtmlTitle(value?: string): string;
export function normalizeHtmlOutputPath(value?: string): string;
export function normalizeExportHtmlRequest(input?: {
  html?: unknown;
  title?: unknown;
  defaultPath?: unknown;
}): ExportHtmlRequest;
export function writeStandaloneHtml(outputPath: string, html: string): {
  canceled: false;
  path: string;
  bytes: number;
};
