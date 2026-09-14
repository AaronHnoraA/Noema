export function sanitizeCaptureHTML(source: string): string;
export function captureMarkdownFromHTML(source: string): { sanitizedHtml: string; markdown: string };
export function parseOfficialConversationExport(options: { format: string; data: string | Buffer | unknown }): Record<string, any>[];
export function createResearchCaptureService(options: {
  getProvider: () => any;
  root: string;
}): {
  create(body?: Record<string, any>): Promise<Record<string, any>>;
  list(body?: Record<string, any>): Promise<Record<string, any>>;
  importOfficial(body?: Record<string, any>): Promise<Record<string, any>>;
};
