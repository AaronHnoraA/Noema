/**
 * Noema's on-disk Jupyter format.
 *
 * The notebook is the sole persisted document: source lives in `cell.source`,
 * portable results live in `execution_count`/`outputs`, and Noema-only state
 * lives below `cell.metadata.noema`.  Keeping the private state in metadata
 * makes the file valid nbformat 4.5 and leaves it usable in other Jupyter
 * clients.
 */

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function notebookCellId(value) {
  const clean = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return clean || "cell";
}

function uniqueCellId(value, seen, index) {
  let id = notebookCellId(value || `cell-${index + 1}`);
  let attempt = 0;
  while (seen.has(id)) {
    attempt += 1;
    const suffix = `-${index + 1}-${attempt}`;
    id = `${id.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
  }
  seen.add(id);
  return id;
}

export function notebookSource(value) {
  if (Array.isArray(value)) return value.map((part) => String(part)).join("");
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function codeCell(raw, fallbackId = "cell") {
  const cell = object(raw);
  const metadata = object(cell.metadata);
  const result = {
    ...cell,
    cell_type: "code",
    execution_count: Number.isInteger(cell.execution_count) ? cell.execution_count : null,
    id: notebookCellId(cell.id || fallbackId),
    metadata,
    outputs: Array.isArray(cell.outputs) ? cell.outputs : [],
    source: notebookSource(cell.source),
  };
  delete result.attachments;
  return result;
}

export function createNotebook({ sourceFile = "", kernel = "python3", session = "default", language = "python", storage = "ipynb" } = {}) {
  return {
    cells: [],
    metadata: {
      kernelspec: {
        display_name: String(kernel || "python3"),
        language: String(language || "python"),
        name: String(kernel || "python3"),
      },
      language_info: { name: String(language || "python") },
      noema: {
        source_file: String(sourceFile || ""),
        session: String(session || "default"),
        language: String(language || "python"),
        storage: String(storage || "ipynb"),
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

export function parseNotebook(text, defaults = {}) {
  const parsed = JSON.parse(String(text || "{}"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("Jupyter notebook root must be an object");
  }
  const base = createNotebook(defaults);
  const metadata = { ...base.metadata, ...object(parsed.metadata) };
  metadata.kernelspec = {
    ...base.metadata.kernelspec,
    ...object(object(parsed.metadata).kernelspec),
  };
  metadata.language_info = {
    ...base.metadata.language_info,
    ...object(object(parsed.metadata).language_info),
  };
  metadata.noema = { ...base.metadata.noema, ...object(object(parsed.metadata).noema) };
  const seen = new Set();
  const cells = [];
  for (const [index, raw] of (Array.isArray(parsed.cells) ? parsed.cells : []).entries()) {
    const id = uniqueCellId(object(raw).id, seen, index);
    if (object(raw).cell_type !== "code") {
      const cell = { ...object(raw) };
      cell.id = id;
      cell.metadata = object(cell.metadata);
      cell.source = notebookSource(cell.source);
      cells.push(cell);
      continue;
    }
    const cell = codeCell({ ...object(raw), id }, id);
    cells.push(cell);
  }
  return {
    ...parsed,
    cells,
    metadata,
    nbformat: 4,
    nbformat_minor: Math.max(5, Number(parsed.nbformat_minor) || 0),
  };
}

export function serializeNotebook(notebook) {
  return `${JSON.stringify(notebook, null, 2)}\n`;
}

export function notebookCodeCells(notebook) {
  return (Array.isArray(notebook?.cells) ? notebook.cells : [])
    .filter((cell) => cell?.cell_type === "code");
}

export function notebookCodeMap(notebook) {
  return new Map(notebookCodeCells(notebook).map((cell) => [cell.id, notebookSource(cell.source)]));
}

export function notebookCodeOrder(notebook) {
  return notebookCodeCells(notebook).map((cell) => cell.id);
}

export function buildNotebook({
  existing,
  noteFile,
  kernel,
  session,
  language,
  cells,
  targetCellId,
  storage = "ipynb",
  dropCellIds = [],
}) {
  const notebook = existing
    ? parseNotebook(serializeNotebook(existing), { sourceFile: noteFile, kernel, session, language, storage })
    : createNotebook({ sourceFile: noteFile, kernel, session, language, storage });
  const oldById = new Map((notebook.cells || []).map((cell) => [cell.id, cell]));
  const incoming = [];
  const seen = new Set();
  const dropped = new Set(dropCellIds.map(notebookCellId));
  for (const raw of Array.isArray(cells) ? cells : []) {
    const id = notebookCellId(raw?.cellId || raw?.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const old = oldById.get(id);
    const supplied = notebookSource(raw?.code);
    const source = supplied.trim() ? supplied : notebookSource(old?.source ?? supplied);
    incoming.push(codeCell({ ...old, id, source }, id));
  }
  // A partial editor projection must not discard cells already in the file.
  for (const old of notebook.cells || []) {
    if (seen.has(old.id) || dropped.has(old.id)) continue;
    seen.add(old.id);
    incoming.push(old);
  }
  notebook.cells = incoming;
  notebook.metadata = object(notebook.metadata);
  notebook.metadata.kernelspec = {
    ...object(notebook.metadata.kernelspec),
    display_name: String(object(notebook.metadata.kernelspec).display_name || kernel),
    language: String(language),
    name: String(kernel),
  };
  notebook.metadata.language_info = {
    ...object(notebook.metadata.language_info),
    name: String(language),
  };
  notebook.metadata.noema = {
    ...object(notebook.metadata.noema),
    source_file: String(noteFile),
    session: String(session),
    language: String(language),
    storage: "ipynb",
  };

  let line = 1;
  for (const cell of notebook.cells) {
    if (cell.id === targetCellId) {
      line += 1; // the projected `# %% id` marker occupies the previous line
      break;
    }
    line += notebookSource(cell.source).split("\n").length + 2;
  }
  return { notebook, text: serializeNotebook(notebook), line };
}

export function notebookOutput(cell, { passive = false } = {}) {
  if (!cell || cell.cell_type !== "code") return null;
  const noema = object(object(cell.metadata).noema);
  const hasPortableOutput = cell.execution_count != null || (Array.isArray(cell.outputs) && cell.outputs.length > 0);
  if (!hasPortableOutput && Object.keys(noema).length === 0) return null;
  const { widgetRuntime: _widgetRuntime, kernelRuntime: _kernelRuntime, ...persisted } = noema;
  return {
    ...persisted,
    executionCount: cell.execution_count ?? null,
    outputs: Array.isArray(cell.outputs) ? cell.outputs : [],
    ...(passive ? { live: false } : {}),
  };
}

export function notebookOutputMirror(notebook, { passive = false } = {}) {
  const cells = {};
  for (const cell of notebookCodeCells(notebook)) {
    const output = notebookOutput(cell, { passive });
    if (output) cells[cell.id] = output;
  }
  const noema = object(object(notebook?.metadata).noema);
  const kernelspec = object(object(notebook?.metadata).kernelspec);
  return {
    version: 2,
    source: String(noema.source_file || ""),
    kernel: String(kernelspec.name || "python3"),
    session: String(noema.session || "default"),
    language: String(noema.language || object(object(notebook?.metadata).language_info).name || "python"),
    cells,
  };
}

export function applyOutputMirror(notebook, mirror) {
  const saved = object(mirror?.cells);
  const known = new Set();
  notebook.cells = (notebook.cells || []).map((raw) => {
    if (raw?.cell_type !== "code") return raw;
    const cell = codeCell(raw, raw?.id);
    known.add(cell.id);
    const result = object(saved[cell.id]);
    const metadata = { ...object(cell.metadata) };
    if (Object.prototype.hasOwnProperty.call(saved, cell.id)) {
      const {
        executionCount,
        outputs,
        widgetRuntime: _widgetRuntime,
        ...noema
      } = result;
      cell.execution_count = Number.isInteger(executionCount) ? executionCount : null;
      cell.outputs = Array.isArray(outputs) ? outputs : [];
      metadata.noema = noema;
    } else {
      cell.execution_count = null;
      cell.outputs = [];
      delete metadata.noema;
    }
    cell.metadata = metadata;
    return cell;
  });
  // UI state can arrive before an editor projection has supplied the cell.
  for (const [id, result] of Object.entries(saved)) {
    if (known.has(id)) continue;
    const cell = codeCell({ id, source: "" }, id);
    const { executionCount, outputs, widgetRuntime: _widgetRuntime, ...noema } = object(result);
    cell.execution_count = Number.isInteger(executionCount) ? executionCount : null;
    cell.outputs = Array.isArray(outputs) ? outputs : [];
    cell.metadata.noema = noema;
    notebook.cells.push(cell);
  }
  return notebook;
}
