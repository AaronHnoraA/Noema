import type { EditorView } from "@codemirror/view";
import { MeasuredWidget } from "./measured-widget.ts";
import { shortHash } from "./measured-observer.ts";

export type AttributeViewColumn = { key: string; label: string };
export type AttributeViewCell = { key: string; value: string };
export type AttributeViewRow = { id: string; kind: string; file: string; index: number; line: number; cells: AttributeViewCell[]; group?: string };
export type AttributeViewModel = {
  title?: string;
  source?: string;
  columns?: AttributeViewColumn[];
  rows?: AttributeViewRow[];
  total?: number;
  truncated?: boolean;
  diagnostics?: Array<{ line?: number; kind?: string; message?: string }>;
  evaluationSource?: string;
  view?: "table" | "gallery" | "kanban";
  groupBy?: string;
};

export type AttributeViewRequestDetail = {
  title: string;
  source: string;
  respond: (model: AttributeViewModel | null, error?: string) => void;
};

export type AttributeViewCellPatchDetail = {
  row: AttributeViewRow;
  key: string;
  value: string;
  respond: (ok: boolean, error?: string) => void;
};

export type AttributeViewOpenRowDetail = { row: AttributeViewRow };

const EDITABLE_TODO_COLUMNS = new Set([
  "status", "ddl", "sche", "end", "date", "prio", "repeat", "warn",
  "after", "blocks", "project", "area", "phase", "goal", "effort",
  "progress", "owner", "tags", "context",
]);
const READ_ONLY_BLOCK_COLUMNS = new Set([
  "id", "text", "title", "kind", "type", "env", "file", "line", "note", "notetitle", "note-title",
]);

function cellEditable(row: AttributeViewRow, key: string): boolean {
  if (row.kind === "todo") return EDITABLE_TODO_COLUMNS.has(key);
  return (row.kind === "prose" || row.kind === "org-env")
    && /^[a-z][a-z0-9_-]*$/i.test(key)
    && !READ_ONLY_BLOCK_COLUMNS.has(key);
}

function stopEditorEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function beginCellEdit(cell: HTMLElement, row: AttributeViewRow, key: string, refresh: () => void): void {
  if (cell.dataset.editing === "true") return;
  cell.dataset.editing = "true";
  const original = cell.textContent || "";
  const editor = row.kind === "todo" && key === "status" ? document.createElement("select") : document.createElement("input");
  editor.className = "cm-attribute-view-cell-editor";
  if (editor instanceof HTMLSelectElement) {
    for (const status of ["todo", "doing", "blocked", "done", "cancelled"]) {
      const option = document.createElement("option");
      option.value = status;
      option.textContent = status;
      editor.append(option);
    }
    editor.value = original || "todo";
  } else {
    editor.type = "text";
    editor.value = original;
  }
  cell.replaceChildren(editor);
  let finished = false;
  const restore = (message = "") => {
    cell.replaceChildren(document.createTextNode(original));
    delete cell.dataset.editing;
    if (message) cell.title = message;
  };
  const commit = () => {
    if (finished) return;
    finished = true;
    const value = editor.value.trim();
    if (value === original) {
      restore();
      return;
    }
    cell.dataset.pending = "true";
    const detail: AttributeViewCellPatchDetail = {
      row,
      key,
      value,
      respond: (ok, error = "") => {
        delete cell.dataset.pending;
        if (ok) refresh();
        else restore(error || "Cell edit failed");
      },
    };
    const event = new CustomEvent<AttributeViewCellPatchDetail>("aaronnote:attribute-view-cell-patch", {
      bubbles: true,
      cancelable: true,
      composed: true,
      detail,
    });
    cell.dispatchEvent(event);
    if (!event.defaultPrevented) detail.respond(false, "Attribute view editor is unavailable");
  };
  editor.addEventListener("mousedown", (event) => event.stopPropagation());
  editor.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    event.stopPropagation();
    if (keyboardEvent.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (keyboardEvent.key === "Escape") {
      event.preventDefault();
      finished = true;
      restore();
    }
  });
  if (editor instanceof HTMLSelectElement) editor.addEventListener("change", commit);
  else editor.addEventListener("blur", commit);
  queueMicrotask(() => {
    editor.focus();
    if (editor instanceof HTMLInputElement) editor.select();
  });
}

function rowCellValue(row: AttributeViewRow, key: string): string {
  return String(row.cells?.find((candidate) => candidate.key === key)?.value || "");
}

function setRowDataset(element: HTMLElement, row: AttributeViewRow): void {
  element.dataset.attributeViewRowId = String(row.id || "");
  element.dataset.file = String(row.file || "");
  element.dataset.index = String(Number(row.index || 0));
  element.dataset.line = String(Number(row.line || 0));
}

function dispatchOpenRow(element: HTMLElement, row: AttributeViewRow): void {
  element.dispatchEvent(new CustomEvent<AttributeViewOpenRowDetail>("aaronnote:attribute-view-open-row", {
    bubbles: true,
    cancelable: true,
    composed: true,
    detail: { row },
  }));
}

function configureValueCell(
  cell: HTMLElement,
  row: AttributeViewRow,
  column: AttributeViewColumn,
  refresh: () => void,
): void {
  const value = rowCellValue(row, column.key);
  cell.textContent = value;
  cell.dataset.empty = value ? "false" : "true";
  cell.dataset.column = String(column.key || "");
  cell.classList.add("cm-attribute-view-cell");
  if (cellEditable(row, column.key)) {
    cell.classList.add("cm-attribute-view-cell-editable");
    cell.tabIndex = 0;
    cell.title = `Edit ${column.label || column.key}`;
    cell.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      beginCellEdit(cell, row, column.key, refresh);
    });
    cell.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      beginCellEdit(cell, row, column.key, refresh);
    });
  } else {
    cell.classList.add("cm-attribute-view-cell-link");
    cell.tabIndex = 0;
    cell.title = `Open ${row.file || "source"}${row.line ? `:${row.line}` : ""}`;
    cell.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      dispatchOpenRow(cell, row);
    });
    cell.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      dispatchOpenRow(cell, row);
    });
  }
}

function renderTable(columns: AttributeViewColumn[], rows: AttributeViewRow[], refresh: () => void): HTMLElement {
  const scroller = document.createElement("div");
  scroller.className = "cm-attribute-view-scroller";
  const table = document.createElement("table");
  table.className = "cm-attribute-view-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = String(column.label || column.key || "");
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tableRow = document.createElement("tr");
    setRowDataset(tableRow, row);
    for (const column of columns) {
      const cell = document.createElement("td");
      configureValueCell(cell, row, column, refresh);
      tableRow.append(cell);
    }
    body.append(tableRow);
  }
  table.append(body);
  scroller.append(table);
  return scroller;
}

function renderCard(
  row: AttributeViewRow,
  columns: AttributeViewColumn[],
  refresh: () => void,
  hiddenKeys: Set<string> = new Set(),
): HTMLElement {
  const card = document.createElement("article");
  card.className = "cm-attribute-view-card";
  setRowDataset(card, row);
  const visible = columns.filter((column) => !hiddenKeys.has(column.key));
  const primary = visible.find((column) => column.key === "text" || column.key === "title") || visible[0];
  if (primary) {
    const heading = document.createElement("div");
    heading.className = "cm-attribute-view-card-title";
    configureValueCell(heading, row, primary, refresh);
    card.append(heading);
  }
  const fields = document.createElement("dl");
  fields.className = "cm-attribute-view-card-fields";
  for (const column of visible) {
    if (column === primary) continue;
    const field = document.createElement("div");
    field.className = "cm-attribute-view-card-field";
    const label = document.createElement("dt");
    label.textContent = String(column.label || column.key || "");
    const value = document.createElement("dd");
    configureValueCell(value, row, column, refresh);
    field.append(label, value);
    fields.append(field);
  }
  if (fields.childElementCount > 0) card.append(fields);
  return card;
}

function renderGallery(columns: AttributeViewColumn[], rows: AttributeViewRow[], refresh: () => void): HTMLElement {
  const gallery = document.createElement("div");
  gallery.className = "cm-attribute-view-gallery";
  for (const row of rows) gallery.append(renderCard(row, columns, refresh));
  return gallery;
}

function renderKanban(
  columns: AttributeViewColumn[],
  rows: AttributeViewRow[],
  groupBy: string,
  refresh: () => void,
): HTMLElement {
  const board = document.createElement("div");
  board.className = "cm-attribute-view-kanban";
  board.dataset.groupBy = groupBy;
  const groups = new Map<string, AttributeViewRow[]>();
  for (const row of rows) {
    const group = String(row.group || "");
    const lane = groups.get(group) || [];
    lane.push(row);
    groups.set(group, lane);
  }
  const groupLabel = columns.find((column) => column.key === groupBy)?.label
    || groupBy.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  for (const [group, laneRows] of groups) {
    const lane = document.createElement("section");
    lane.className = "cm-attribute-view-kanban-lane";
    lane.dataset.group = group;
    const header = document.createElement("header");
    header.className = "cm-attribute-view-kanban-header";
    const title = document.createElement("strong");
    title.textContent = group || `No ${groupLabel}`;
    const count = document.createElement("span");
    count.textContent = String(laneRows.length);
    header.append(title, count);
    const cards = document.createElement("div");
    cards.className = "cm-attribute-view-kanban-cards";
    for (const row of laneRows) cards.append(renderCard(row, columns, refresh));
    lane.append(header, cards);
    board.append(lane);
  }
  return board;
}

function renderModel(root: HTMLElement, model: AttributeViewModel, refresh: () => void): void {
  const content = root.querySelector<HTMLElement>(".cm-attribute-view-content");
  const count = root.querySelector<HTMLElement>(".cm-attribute-view-count");
  if (!content || !count) return;
  content.replaceChildren();
  const columns = Array.isArray(model.columns) ? model.columns : [];
  const rows = Array.isArray(model.rows) ? model.rows : [];
  const total = Number(model.total || 0);
  const view = model.view === "gallery" || model.view === "kanban" ? model.view : "table";
  count.textContent = model.truncated ? `${rows.length} of ${total}` : `${total}`;
  root.dataset.evaluationSource = String(model.evaluationSource || "");
  root.dataset.view = view;

  if (columns.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cm-attribute-view-empty";
    empty.textContent = "No columns configured";
    content.append(empty);
  } else {
    if (view === "gallery") content.append(renderGallery(columns, rows, refresh));
    else if (view === "kanban") content.append(renderKanban(columns, rows, String(model.groupBy || "status"), refresh));
    else content.append(renderTable(columns, rows, refresh));
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cm-attribute-view-empty";
      empty.textContent = "No matching rows";
      content.append(empty);
    }
  }
  const diagnostics = Array.isArray(model.diagnostics) ? model.diagnostics : [];
  if (diagnostics.length > 0) {
    const message = document.createElement("div");
    message.className = "cm-attribute-view-diagnostics";
    message.textContent = diagnostics.map((item) => `Line ${item.line || "?"}: ${item.message || item.kind || "Invalid view directive"}`).join(" · ");
    content.append(message);
  }
}

export class AttributeViewWidget extends MeasuredWidget {
  readonly title: string;
  readonly source: string;
  readonly from: number;
  readonly to: number;

  constructor(
    title: string,
    source: string,
    from: number,
    to: number,
  ) {
    super();
    this.title = title;
    this.source = source;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string { return `attribute-view:${shortHash(`${this.title}\n${this.source}`)}`; }

  protected measureGroupKey(): string { return "attribute-view"; }

  protected estimatedHeightFallback(): number { return 240; }

  eq(other: AttributeViewWidget): boolean {
    return this.title === other.title && this.source === other.source && this.from === other.from && this.to === other.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("section");
    root.className = "cm-attribute-view";
    root.dataset.kind = "av";
    root.dataset.sourceFrom = String(this.from);
    root.dataset.sourceTo = String(this.to);

    const header = document.createElement("header");
    header.className = "cm-attribute-view-header";
    const title = document.createElement("strong");
    title.className = "cm-attribute-view-title";
    title.textContent = this.title || "Attribute view";
    const count = document.createElement("span");
    count.className = "cm-attribute-view-count";
    count.textContent = "…";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "cm-attribute-view-action";
    refresh.textContent = "Refresh";
    const source = document.createElement("button");
    source.type = "button";
    source.className = "cm-attribute-view-action";
    source.textContent = "Source";
    header.append(title, count, refresh, source);
    const content = document.createElement("div");
    content.className = "cm-attribute-view-content";
    content.textContent = "Loading attribute view…";
    root.append(header, content);

    let requestOrdinal = 0;
    const request = () => {
      const ordinal = ++requestOrdinal;
      content.textContent = "Loading attribute view…";
      const detail: AttributeViewRequestDetail = {
        title: this.title,
        source: this.source,
        respond: (model, error = "") => {
          if (ordinal !== requestOrdinal || !root.isConnected) return;
          if (!model) {
            content.textContent = error || "Attribute view is unavailable";
            root.dataset.error = "true";
            count.textContent = "!";
            return;
          }
          delete root.dataset.error;
          renderModel(root, model, request);
        },
      };
      const event = new CustomEvent<AttributeViewRequestDetail>("aaronnote:attribute-view-request", {
        bubbles: true,
        cancelable: true,
        composed: true,
        detail,
      });
      root.dispatchEvent(event);
      if (!event.defaultPrevented) detail.respond(null, "Attribute view provider is unavailable");
    };
    refresh.addEventListener("mousedown", stopEditorEvent);
    refresh.addEventListener("click", (event) => {
      stopEditorEvent(event);
      request();
    });
    source.addEventListener("mousedown", stopEditorEvent);
    source.addEventListener("click", (event) => {
      stopEditorEvent(event);
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });
    root.addEventListener("mousedown", (event) => event.stopPropagation());
    queueMicrotask(request);
    return this.registerMeasured(root, view);
  }

  ignoreEvent(): boolean { return false; }
}
