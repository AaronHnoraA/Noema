import type MarkdownIt from "markdown-it";
import { documentDataAccents, parseDocumentDataTable, parseDocumentNumber } from "./document-data-table.ts";

function renderSparkline(source: string): string {
  const points = source.split(",").map((point) => point.trim());
  const values = points.map(parseDocumentNumber);
  if (!values.every((point) => point !== null)) return "";
  const low = values.reduce((a, b) => Math.min(a, b), Infinity);
  const high = values.reduce((a, b) => Math.max(a, b), -Infinity);
  const spread = high - low;
  const bars = values.map((value) => {
    const percent = !Number.isFinite(spread) || spread === 0 ? 50 : 12 + 88 * (value - low) / spread;
    return `<span class="noema-stat-spark-bar" style="height:${Math.round(percent)}%"></span>`;
  }).join("");
  return `<span class="noema-stat-spark" title="${points.join(",")}">${bars}</span>`;
}

export function renderStatsBody(md: MarkdownIt, body: string): string | null {
  const table = parseDocumentDataTable(md, body);
  if (!table || table.headings.length < 2 || table.headings.length > 6) return null;
  const { rows, content } = table;
  if (!rows.every((row) => row[0]?.content.trim() && row[1]?.content.trim())) return null;

  const cards: string[] = [];
  for (const [name, value, trend, note, series, accent] of rows) {
    const role = accent?.content.trim().toLowerCase() || "neutral";
    if (!documentDataAccents.has(role)) return null;
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
