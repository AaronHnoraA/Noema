// Shared variables-table renderer for Jupyter kernel introspection results —
// used by both the per-cell "Vars" popup
// (src/cm6/extensions/visual/widgets/block-extras.ts)
// and the app-shell Jupyter panel (aaronnote/main.ts), so both surfaces
// present a kernel's variables the same way.

export type JupyterVariableRow = {
  name?: string;
  type?: string;
  summary?: string;
  shape?: unknown;
};

function variablesCell(text: string, className: string): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.className = className;
  cell.textContent = text;
  return cell;
}

/** Render `rows` as a Name/Type/Shape/Value table into `host`, or an empty-state message. */
export function renderJupyterVariablesTable(host: HTMLElement, rows: JupyterVariableRow[], emptyMessage = "No variables in this kernel's namespace."): void {
  host.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cm-ceil-variables-empty";
    empty.textContent = emptyMessage;
    host.append(empty);
    return;
  }
  const table = document.createElement("table");
  table.className = "cm-ceil-variables-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Name", "Type", "Shape", "Value"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const variable of rows) {
    const row = document.createElement("tr");
    const shape = Array.isArray(variable.shape) ? variable.shape.join(" × ") : "";
    row.append(
      variablesCell(String(variable.name ?? ""), "cm-ceil-variables-name"),
      variablesCell(String(variable.type ?? ""), "cm-ceil-variables-type"),
      variablesCell(shape, "cm-ceil-variables-shape"),
      variablesCell(String(variable.summary ?? ""), "cm-ceil-variables-summary"),
    );
    tbody.append(row);
  }
  table.append(thead, tbody);
  host.append(table);
}
