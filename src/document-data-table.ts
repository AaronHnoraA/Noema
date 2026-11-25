import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

export const documentDataAccents = new Set(["neutral", "primary", "info", "success", "warning", "danger", "important"]);

export function parseDocumentNumber(source: string): number | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(source)) return null;
  const number = Number(source);
  return Number.isFinite(number) ? number : null;
}

/** One GFM table, with the normal parser's inline formatting and escaped pipes. */
export function parseDocumentDataTable(md: MarkdownIt, body: string) {
  const environment = {};
  const tokens = md.parse(body, environment);
  if (tokens[0]?.type !== "table_open" || tokens.at(-1)?.type !== "table_close"
      || tokens.filter((token) => token.type === "table_open").length !== 1) return null;
  const headStart = tokens.findIndex((token) => token.type === "thead_open");
  const headEnd = tokens.findIndex((token) => token.type === "thead_close");
  const bodyStart = tokens.findIndex((token) => token.type === "tbody_open");
  if (headStart < 0 || headEnd < 0 || bodyStart < 0) return null;
  const headings = tokens.slice(headStart + 1, headEnd).filter((token) => token.type === "inline");
  const rows: Token[][] = [];
  const rowStarts: number[] = [];
  for (const token of tokens.slice(bodyStart + 1)) {
    if (token.type === "tr_open" && token.map) {
      rows.push([]);
      rowStarts.push(token.map[0]);
    }
    if (token.type === "inline") rows.at(-1)?.push(token);
  }
  const content = (token: Token | undefined): string =>
    token?.children ? md.renderer.renderInline(token.children, md.options, environment) : "";
  return rows.length ? { headings, rows, rowStarts, content } : null;
}
