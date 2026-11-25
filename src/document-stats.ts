import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

const accents = new Set(["neutral", "primary", "info", "success", "warning", "danger", "important"]);
const numberSource = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function renderSparkline(source: string): string {
  const points = source.split(",").map((point) => point.trim());
  if (!points.every((point) => numberSource.test(point) && Number.isFinite(Number(point)))) return "";
  const values = points.map(Number);
  const low = values.reduce((a, b) => Math.min(a, b), Infinity);
  const high = values.reduce((a, b) => Math.max(a, b), -Infinity);
  const spread = high - low;
  const bars = values.map((value) => {
    const percent = !Number.isFinite(spread) || spread === 0 ? 50 : 12 + 88 * (value - low) / spread;
    return `<span class="noema-stat-spark-bar" style="height:${Math.round(percent)}%"></span>`;
  }).join("");
  return `<span class="noema-stat-spark" title="${points.join(",")}">${bars}</span>`;
}

/** Read a single GFM table so nested Markdown and escaped pipes use the normal parser. */
export function renderStatsBody(md: MarkdownIt, body: string): string | null {
  const environment = {};
  const tokens = md.parse(body, environment);
  if (tokens[0]?.type !== "table_open" || tokens.at(-1)?.type !== "table_close"
      || tokens.filter((token) => token.type === "table_open").length !== 1) return null;
  const columns = tokens.filter((token) => token.type === "th_open").length;
  if (columns < 2 || columns > 6) return null;
  const bodyStart = tokens.findIndex((token) => token.type === "tbody_open");
  if (bodyStart < 0) return null;

  const rows: Token[][] = [];
  for (const token of tokens.slice(bodyStart + 1)) {
    if (token.type === "tr_open") rows.push([]);
    if (token.type === "inline") rows.at(-1)?.push(token);
  }
  if (!rows.every((row) => row[0]?.content.trim() && row[1]?.content.trim())) return null;

  const content = (token: Token | undefined): string =>
    token?.children ? md.renderer.renderInline(token.children, md.options, environment) : "";
  const cards: string[] = [];
  for (const [name, value, trend, note, series, accent] of rows) {
    const role = accent?.content.trim().toLowerCase() || "neutral";
    if (!accents.has(role)) return null;
    const seriesText = series?.content.trim() || "";
    const spark = seriesText ? renderSparkline(seriesText) : "";
    if (seriesText && !spark) return null;
    cards.push(`<article class="noema-stat-card" data-accent="${role}">`
      + `<div class="noema-stat-name">${content(name)}</div>`
      + `<div class="noema-stat-value">${content(value)}</div>`
      + (trend?.content.trim() ? `<div class="noema-stat-trend">${content(trend)}</div>` : "")
      + (note?.content.trim() ? `<div class="noema-stat-note">${content(note)}</div>` : "")
      + spark + "</article>");
  }
  return cards.length ? `<div class="noema-stat-grid">${cards.join("")}</div>` : null;
}
