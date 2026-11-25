import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { TableCellAlign } from "./cm6/table-model.ts";

export const documentDataAccents = new Set(["neutral", "primary", "info", "success", "warning", "danger", "important"]);

export function gfmTableCellStarts(line: string): number[] {
  // Markdown-it's GFM rule makes a pipe literal if a backslash precedes it.
  const first = line.length - line.trimStart().length;
  const last = line.trimEnd().length;
  const pipes = Array.from(line.matchAll(/(?<!\\)\|/g), (pipe) => pipe.index);
  const start = pipes[0] === first ? pipes.shift()! + 1 : first;
  const end = pipes.at(-1) === last - 1 ? pipes.pop()! : last;
  if (start >= end) return [];
  return [start, ...pipes.map((pipe) => pipe + 1)].map((from) => {
    while (from < end && /\s/u.test(line[from]!)) from++;
    return from;
  });
}

export function literalDocumentDataSource(md: MarkdownIt, body: string): string {
  // GFM crops extra cells and fills absent ones. Keep malformed source visible.
  return `<pre class="noema-document-data-source"><code>${md.utils.escapeHtml(body)}</code></pre>`;
}

/** One GFM table, with the normal parser's inline formatting and escaped pipes. */
export function parseDocumentDataTable(md: MarkdownIt, body: string) {
  const environment: { references?: Record<string, { href: string; title: string }> } = {};
  const tokens = md.parse(body, environment);
  if (tokens[0]?.type !== "table_open" || tokens.at(-1)?.type !== "table_close"
      || tokens.filter((token) => token.type === "table_open").length !== 1) return null;
  const headStart = tokens.findIndex((token) => token.type === "thead_open");
  const headEnd = tokens.findIndex((token) => token.type === "thead_close");
  const bodyStart = tokens.findIndex((token) => token.type === "tbody_open");
  if (headStart < 0 || headEnd < 0 || bodyStart < 0) return null;
  const headTokens = tokens.slice(headStart + 1, headEnd);
  const headings = headTokens.filter((token) => token.type === "inline");
  const aligns = headTokens.filter((token) => token.type === "th_open").map((token): TableCellAlign => {
    const alignment = token.attrGet("style")?.split(":")[1]?.trim();
    return alignment === "left" || alignment === "right" || alignment === "center" ? alignment : "";
  });
  const rows: Token[][] = [];
  const rowWidths: number[] = [];
  const rowLines: number[] = [];
  const lines = body.split(/\r\n?|\n/);
  for (const token of tokens.slice(bodyStart + 1)) {
    if (token.type === "tr_open" && token.map) {
      rows.push([]);
      rowLines.push(token.map[0]);
      rowWidths.push(gfmTableCellStarts(lines[token.map[0]] ?? "").length);
    }
    if (token.type === "inline") rows.at(-1)?.push(token);
  }
  const content = (token: Token | undefined): string =>
    token?.children ? md.renderer.renderInline(token.children, md.options, environment) : "";
  return rows.length ? { headings, rows, aligns, rowWidths, rowLines, headLine: tokens[0].map?.[0] ?? 0,
    references: environment.references, content } : null;
}
