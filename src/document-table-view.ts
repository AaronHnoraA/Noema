import type MarkdownIt from "markdown-it";
import { layoutFromAttrs, type AttrMap } from "../shared/layout-attrs.mjs";
import { stripCommentAnchors } from "../shared/comment-anchors.mjs";
import { documentDataAccents, gfmTableCellStarts, literalDocumentDataSource, parseDocumentDataTable } from "./document-data-table.ts";
import { buildMarkdownTableSource, sortTableBodyRows, type MarkdownTableData } from "./cm6/table-model.ts";
import { writeSystemClipboard } from "./system-clipboard.ts";

function marks(source: string | undefined, pattern: RegExp): Set<string> {
  return new Set((source || "").split(/\s+/).filter((entry) => pattern.test(entry)));
}

export function renderDocumentTableView(md: MarkdownIt, body: string, attrs: AttrMap, interactive: boolean, original?: string): string | null {
  const data = parseDocumentDataTable(md, body);
  if (!data) return null;
  const { headings, rows, aligns, content } = data;
  if (data.rowWidths.some((width) => width < Math.min(2, headings.length) || width > headings.length)) {
    return literalDocumentDataSource(md, body);
  }

  const sortable = interactive && ["sortable", "true"].includes(attrs.sortable?.toLowerCase() || "");
  const copy = interactive && ["copy", "true"].includes(attrs.copy?.toLowerCase() || "");
  const rowMarks = marks(attrs["highlight-rows"], /^\d+$/);
  const columnMarks = marks(attrs["highlight-columns"], /^\d+$/);
  const cellMarks = marks(attrs["highlight-cells"], /^\d+:\d+$/);
  const highlight = attrs.highlight?.toLowerCase() || "warning";
  const accent = documentDataAccents.has(highlight) ? highlight : "warning";
  const layout = layoutFromAttrs(attrs);
  const width = layout.width ? ` style="--document-table-width:${layout.width}"` : "";
  const preferred = attrs["text-align"]?.toLowerCase() || "start";
  const fallback = ["end", "center", "left", "right"].includes(preferred) ? preferred : "start";
  const alignment = (index: number) => ` style="text-align:${aligns[index] || fallback}"`;
  const normalizedSource = original === undefined ? undefined : stripCommentAnchors(original).replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const sourceBody = interactive && original !== undefined && normalizedSource === body ? original : null;
  const sourceLines = sourceBody?.split(/\r\n?|\n/) ?? [];
  const lineStarts = sourceBody === null ? [] : [0, ...Array.from(sourceBody.matchAll(/\r\n?|\n/g), (line) => line.index + line[0].length)];
  const sourceOffsets = (line: number): string[] => {
    const text = sourceLines[line];
    if (text === undefined) return [];
    const cells = gfmTableCellStarts(text);
    const last = Math.max(0, text.trimEnd().length - 1);
    return headings.map((_, col) => ` data-cm-source-offset="${(lineStarts[line] ?? 0) + (cells[col] ?? last)}"`);
  };
  const headerOffsets = sourceOffsets(data.headLine);
  const header = headings.map((heading, col) => {
    const control = sortable ? `<button type="button" class="noema-document-table-sort" data-sort-column="${col}" aria-label="Sort column" title="Sort column">↕</button>` : "";
    const order = sortable ? ' aria-sort="none"' : "";
    return `<th scope="col"${order}${alignment(col)}${headerOffsets[col] || ""}><span class="noema-document-table-label">${content(heading)}</span>${control}</th>`;
  }).join("");
  const dataRows = rows.map((row, rowIndex) => {
    const rowNumber = String(rowIndex + 1);
    const offsets = sourceOffsets(data.rowLines[rowIndex]!);
    const cells = row.map((cell, colIndex) => {
      const colNumber = String(colIndex + 1);
      const marked = rowMarks.has(rowNumber) || columnMarks.has(colNumber) || cellMarks.has(`${rowNumber}:${colNumber}`);
      return `<td${marked ? ' data-highlight="true"' : ""}${alignment(colIndex)}${offsets[colIndex] || ""}>${content(cell)}</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  const controls = interactive ? '<div class="noema-document-table-tools">'
    + '<button type="button" data-pan-table aria-label="Show more columns">More →</button>'
    + (copy ? '<span role="status" class="noema-document-table-feedback"></span><button type="button" data-copy-table>Copy table</button>' : "")
    + '</div>' : "";
  const source = copy ? ` data-table-source="${md.utils.escapeHtml(JSON.stringify({
    rows: [headings, ...rows].map((row) => row.map((cell) => cell.content)), aligns,
    references: Object.entries(data.references ?? {}).map(([label, { href, title }]) =>
      `[${label}]: <${href}>${title ? ` "${title.replace(/[\\"]/g, "\\$&")}"` : ""}`).join("\n"),
  }))}"` : "";
  return `<div class="noema-document-table-view" data-accent="${accent}" data-table-align="${layout.align}"${source}${width}>${controls}`
    + '<div class="noema-document-table-scroll" role="region" tabindex="0" aria-label="Table data">'
    + `<table><thead><tr>${header}</tr></thead><tbody>${dataRows}</tbody></table></div></div>`;
}

type TableCopySource = MarkdownTableData & { references?: string };

const tableObservers = new WeakMap<HTMLElement, ResizeObserver>();

export function disconnectDocumentTableViews(root: ParentNode): void {
  for (const table of root.querySelectorAll<HTMLElement>(".noema-document-table-view[data-table-active]")) {
    tableObservers.get(table)?.disconnect();
    tableObservers.delete(table);
  }
}

function connectTableScroll(widget: HTMLElement, table: Element, viewport: HTMLElement, button: HTMLButtonElement): void {
  const max = () => viewport.scrollWidth - viewport.clientWidth;
  const atEnd = () => Math.abs(viewport.scrollLeft) >= max() - 1;
  const direction = () => viewport.ownerDocument.defaultView?.getComputedStyle(viewport).direction === "rtl" ? -1 : 1;
  const sync = () => {
    widget.toggleAttribute("data-table-overflow", max() > 1);
    const forward = direction() > 0;
    const end = atEnd();
    const label = end ? (forward ? "← Start" : "Start →") : (forward ? "More →" : "← More");
    if (button.textContent !== label) {
      button.textContent = label;
      button.setAttribute("aria-label", end ? "Return to first columns" : "Show more columns");
    }
  };
  button.addEventListener("click", () => {
    viewport.scrollLeft = atEnd() ? 0 : viewport.scrollLeft + direction() * Math.max(50, viewport.clientWidth * 0.7);
    sync();
  });
  viewport.addEventListener("scroll", sync, { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    observer.observe(table);
    tableObservers.set(widget, observer);
  } else {
    viewport.ownerDocument.defaultView?.requestAnimationFrame(() => { if (widget.isConnected) sync(); });
  }
}

function readTableCopySource(widget: HTMLElement): TableCopySource | null {
  const raw = widget.dataset.tableSource;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value?.rows) && value.rows.every((row: unknown) =>
      Array.isArray(row) && row.every((cell: unknown) => typeof cell === "string"))
      && Array.isArray(value.aligns) && value.aligns.every((alignment: unknown) =>
        alignment === "" || alignment === "left" || alignment === "center" || alignment === "right")
      && (value.references === undefined || typeof value.references === "string")) return value;
  } catch {
    // Imported HTML can supply its own data attributes.
  }
  return null;
}

export function connectDocumentTableViews(root: ParentNode): void {
  for (const widget of root.querySelectorAll<HTMLElement>(".noema-document-table-view:not([data-table-active])")) {
    const table = widget.querySelector(".noema-document-table-scroll > table");
    const body = table?.querySelector(":scope > tbody");
    const viewport = table?.parentElement;
    const pan = widget.querySelector<HTMLButtonElement>("[data-pan-table]");
    if (!table || !body || !viewport || !pan) continue;
    const header = [...table.querySelectorAll(":scope > thead > tr > th")];
    const originalRows = [...body.querySelectorAll(":scope > tr")];
    const entries = originalRows.map((row) => ({ row, cells: Array.from(row.children, (cell) => cell.textContent?.trim() || "") }));
    let sort: { column: number; direction: 1 | -1 } | undefined;
    const setDirection = (column: number): void => {
      const direction = sort?.column === column && sort.direction === 1 ? -1 : 1;
      sort = { column, direction };
      const rows = sortTableBodyRows(entries, column, direction, (entry) => entry.cells, 0);
      const ordered = widget.ownerDocument.createDocumentFragment();
      for (const entry of rows) ordered.append(entry.row);
      body.append(ordered);
      header.forEach((cell, index) => {
        const button = cell.querySelector<HTMLButtonElement>("[data-sort-column]");
        if (!button) return;
        cell.setAttribute("aria-sort", column !== index ? "none" : direction === 1 ? "ascending" : "descending");
        button.textContent = column !== index ? "↕" : direction === 1 ? "↑" : "↓";
      });
    };
    header.forEach((cell, index) => {
      const button = cell.querySelector<HTMLButtonElement>("[data-sort-column]");
      if (!button) return;
      const label = cell.querySelector(".noema-document-table-label")?.textContent?.trim();
      if (label) button.setAttribute("aria-label", `Sort by ${label}`);
      button.addEventListener("click", () => setDirection(index));
    });
    const clipboard = widget.querySelector<HTMLButtonElement>("[data-copy-table]");
    const data = clipboard ? readTableCopySource(widget) : null;
    if (clipboard && data) {
      const originalSources = new Map(originalRows.map((row, index) => [row, data.rows[index + 1] || []]));
      const feedback = widget.querySelector(".noema-document-table-feedback");
      clipboard.addEventListener("click", async () => {
        const rows = [data.rows[0] || [], ...Array.from(body.children, (row) => originalSources.get(row) || [])];
        const table = buildMarkdownTableSource({ rows, aligns: data.aligns });
        const copied = await writeSystemClipboard(data.references ? `${table}\n\n${data.references}` : table);
        if (feedback) feedback.textContent = copied ? "Copied" : "Copy failed";
      });
    } else {
      clipboard?.remove();
    }
    connectTableScroll(widget, table, viewport, pan);
    widget.dataset.tableActive = "true";
  }
}
