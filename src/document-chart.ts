import type MarkdownIt from "markdown-it";
import type { AttrMap } from "../shared/layout-attrs.mjs";
import { documentDataAccents, literalDocumentDataSource, parseDocumentDataTable } from "./document-data-table.ts";
import { parseTableNumber } from "./cm6/table-model.ts";

const chartTypes = ["bar", "stacked", "heatmap", "line"] as const;
type ChartType = typeof chartTypes[number];

export function parseDocumentChartOptions(attrs: AttrMap): { type: ChartType | null; accent: string | null } {
  const type = attrs.type?.toLowerCase() || "bar";
  const accent = attrs.accent?.toLowerCase() || "primary";
  return {
    type: chartTypes.find((name) => name === type) ?? null,
    accent: documentDataAccents.has(accent) ? accent : null,
  };
}

interface ChartValue {
  source: string;
  number: number | null;
}

interface ChartRow {
  name: string;
  plainName: string;
  values: ChartValue[];
}

interface ChartSeriesRow {
  name: string;
  value: ChartValue & { number: number };
}

function percent(value: number): string {
  return `${Number((value * 100).toFixed(2))}%`;
}

function domain(rows: readonly number[]) {
  let min = 0;
  let max = 0;
  for (const value of rows) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const scale = Math.max(-min, max) || 1;
  const start = min / scale;
  const spread = max / scale - start || 1;
  return { min, max, position: (value: number) => (value / scale - start) / spread };
}

function barChart(label: string, rows: ChartSeriesRow[]): string {
  const { position } = domain(rows.map(({ value }) => value.number));
  const baseline = position(0);
  return `<div class="noema-chart-axis-label">${label}</div>`
    + `<ul class="noema-chart-bars" style="--chart-zero:${percent(baseline)};--chart-row-count:${rows.length}">`
    + rows.map(({ name, value }) => {
      const end = position(value.number);
      return `<li><span class="noema-chart-name">${name}</span>`
        + '<span class="noema-chart-bar-track" aria-hidden="true">'
        + `<span class="noema-chart-bar-mark" data-negative="${value.number < 0}" style="inline-size:${percent(Math.abs(end - baseline))};inset-inline-start:${percent(Math.min(end, baseline))}"></span>`
        + `</span><span class="noema-chart-value">${value.source}</span></li>`;
    }).join("") + "</ul>";
}

const compositionColors = ["primary", "success", "important", "warning", "info", "neutral", "danger"];

function stackedChart(label: string, rows: ChartSeriesRow[]): string | null {
  if (rows.some(({ value }) => value.number < 0)) return null;
  const total = rows.reduce((sum, { value }) => sum + value.number, 0);
  if (!total || !Number.isFinite(total)) return null;
  let segments = "";
  let legend = "";
  let edge = 0;
  for (const [index, { name, value }] of rows.entries()) {
    const accent = compositionColors[index % compositionColors.length]!;
    const share = value.number / total;
    if (share > 0) {
      // Round both ends so the rendered segments still add up to 100%.
      const start = Math.round(edge * 10000);
      edge += share;
      const width = (Math.round(edge * 10000) - start) / 100;
      segments += `<span class="noema-chart-segment" data-accent="${accent}" style="inline-size:${width}%"></span>`;
    }
    legend += `<li data-accent="${accent}"><span class="noema-chart-key" aria-hidden="true"></span>`
      + `<span class="noema-chart-name">${name}</span><span class="noema-chart-value">${value.source}</span>`
      + `<span class="noema-chart-share">${percent(share)}</span></li>`;
  }
  const readableTotal = Number.isSafeInteger(total) ? total : Number(total.toPrecision(15));
  return `<div class="noema-chart-total"><span>${label}</span><span>Total ${readableTotal}</span></div>`
    + `<div class="noema-chart-stack" aria-hidden="true">${segments}</div>`
    + `<ul class="noema-chart-legend">${legend}</ul>`;
}

function chartTable(headings: string[], rows: ChartRow[], heatmap: boolean): string {
  const { min, max } = domain(rows.flatMap((row) => row.values.map((value) => value.number ?? 0)));
  const range = Math.max(-min, max) || 1;
  const content = rows.map((row) => {
    const cells = row.values.map((value) => {
      if (value.number === null) return '<td data-sign="missing"><span aria-label="Missing">—</span></td>';
      if (!heatmap) return `<td>${value.source}</td>`;
      const sign = value.number === 0 ? "zero" : value.number < 0 ? "negative" : "positive";
      return `<td data-sign="${sign}" style="--chart-intensity:${percent(Math.abs(value.number) / range)}">${value.source}</td>`;
    }).join("");
    return `<tr><th scope="row">${row.name}</th>${cells}</tr>`;
  }).join("");
  const header = headings.map((heading) => `<th scope="col">${heading}</th>`).join("");
  const focus = heatmap ? ' tabindex="0" role="region" aria-label="Chart data"' : "";
  return `<div class="noema-chart-table"${focus}><table><thead><tr>${header}</tr></thead><tbody>${content}</tbody></table></div>`;
}

function lineChart(headings: string[], rows: ChartRow[]): string | null {
  const values = rows.flatMap((row) => row.values[0]?.number ?? []);
  if (values.length < 2) return null;
  const { position, min, max } = domain(values);
  const y = (value: number) => (56 - 48 * position(value)).toFixed(3);
  const runs: string[][] = [[]];
  const dots: string[] = [];
  const missing: string[] = [];
  rows.forEach((row, index) => {
    const value = row.values[0]?.number;
    const x = (8 + 240 * index / (rows.length - 1)).toFixed(3);
    if (value == null) {
      if (runs.at(-1)!.length) runs.push([]);
      missing.push(`<line class="noema-chart-line-missing" x1="${x}" x2="${x}" y1="8" y2="56"></line>`);
      return;
    }
    runs.at(-1)!.push(`${x},${y(value)}`);
    dots.push(`<circle cx="${x}" cy="${y(value)}" r="1.75"></circle>`);
  });
  const paths = runs.filter((run) => run.length > 1)
    .map((run) => `<polyline points="${run.join(" ")}"></polyline>`).join("");
  const scale = min === max ? `<span>${min}</span>` : `<span>${max}</span><span>${min}</span>`;
  return '<div class="noema-chart-line-frame" aria-hidden="true">'
    + `<div class="noema-chart-line-scale">${scale}</div>`
    + '<svg aria-hidden="true" viewBox="0 0 256 64" preserveAspectRatio="none" class="noema-chart-line-plot">'
    + `<line x1="8" x2="248" y1="${y(0)}" y2="${y(0)}"></line>`
    + missing.join("") + paths + dots.join("") + "</svg>"
    + `<div class="noema-chart-line-labels"><span>${rows[0]!.plainName}</span><span>${rows.at(-1)!.plainName}</span></div>`
    + "</div>" + chartTable(headings, rows, false);
}

export function renderChartBody(md: MarkdownIt, body: string, type: ChartType, accent: string): string | null {
  const table = parseDocumentDataTable(md, body);
  if (!table) return null;
  if (table.rowWidths.some((width) => width !== table.headings.length)) return literalDocumentDataSource(md, body);
  if (table.headings.length < 2 || (type !== "heatmap" && table.headings.length !== 2)) return null;
  if (table.headings.some((heading) => !heading.content.trim())) return null;
  const { content } = table;
  const headings = table.headings.map(content);
  const rows: ChartRow[] = [];
  const singleSeries: ChartSeriesRow[] = [];
  for (const [label, ...cells] of table.rows) {
    if (!label?.content.trim()) return null;
    const name = content(label);
    const values: ChartValue[] = [];
    for (const cell of cells) {
      const source = cell.content.trim();
      const number = parseTableNumber(source);
      if (number === null && (source || type === "bar" || type === "stacked")) return null;
      values.push({ source, number });
    }
    const plainName = md.utils.escapeHtml(label.children?.map((token) => token.content).join("") || label.content.trim());
    rows.push({ name, plainName, values });
    const value = values[0];
    if (value && value.number !== null) singleSeries.push({ name, value: { source: value.source, number: value.number } });
  }
  let rendered: string | null;
  switch (type) {
    case "bar": rendered = barChart(headings[1]!, singleSeries); break;
    case "stacked": rendered = stackedChart(headings[1]!, singleSeries); break;
    case "heatmap": rendered = chartTable(headings, rows, true); break;
    case "line": rendered = lineChart(headings, rows); break;
  }
  return rendered ? `<div class="noema-chart noema-chart-${type}" data-accent="${accent}">${rendered}</div>` : null;
}
