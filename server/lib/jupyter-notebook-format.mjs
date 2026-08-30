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

const transientCellIds = new WeakMap();
const missingCellId = Symbol("missing-cell-id");

function rememberTransientCellId(cell, raw) {
  if (Object.prototype.hasOwnProperty.call(raw, "id")) {
    transientCellIds.set(cell, { original: raw.id });
  } else {
    transientCellIds.set(cell, missingCellId);
  }
  return cell;
}

function inheritTransientCellId(from, to) {
  if (from && transientCellIds.has(from)) {
    transientCellIds.set(to, transientCellIds.get(from));
  }
  return to;
}

function validCellId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
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
  return inheritTransientCellId(cell, result);
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
  const parsedNoema = object(object(parsed.metadata).noema);
  const standalone = typeof parsedNoema.source_file === "string"
    && parsedNoema.source_file.endsWith(".ipynb");
  if (Object.keys(parsedNoema).length > 0) {
    metadata.noema = { ...base.metadata.noema, ...parsedNoema };
  } else {
    delete metadata.noema;
  }
  const seen = new Set();
  const cells = [];
  for (const [index, raw] of (Array.isArray(parsed.cells) ? parsed.cells : []).entries()) {
    const rawCell = object(raw);
    const originalId = rawCell.id;
    const keepId = validCellId(originalId) && !seen.has(originalId);
    const id = uniqueCellId(originalId, seen, index);
    if (rawCell.cell_type !== "code") {
      const cell = { ...rawCell };
      cell.id = id;
      cell.metadata = object(cell.metadata);
      cell.source = notebookSource(cell.source);
      if (!keepId) rememberTransientCellId(cell, rawCell);
      cells.push(cell);
      continue;
    }
    const cell = codeCell(rawCell, id);
    cell.id = id;
    if (!keepId) rememberTransientCellId(cell, rawCell);
    cells.push(cell);
  }
  return {
    ...parsed,
    cells,
    metadata,
    nbformat: 4,
    nbformat_minor: Object.keys(parsedNoema).length > 0 && !standalone
      ? Math.max(5, Number(parsed.nbformat_minor) || 0)
      : Number(parsed.nbformat_minor) || 0,
  };
}

export function serializeNotebook(notebook) {
  return `${JSON.stringify(notebook, function preserveOrdinaryCellIds(key, value) {
    if (key !== "id" || !transientCellIds.has(this)) return value;
    const original = transientCellIds.get(this);
    return original === missingCellId ? undefined : original.original;
  }, 2)}\n`;
}

// ---- Lean source storage ---------------------------------------------------
//
// A Lean cell never runs through a Jupyter kernel: execution is refused and no
// output is ever persisted, so its notebook only ever carried source. Storing
// that source as an ordinary `.lean` file instead of notebook JSON lets Emacs,
// `lean-mode`, and the Lean LSP open the exact same file the editor writes.
//
// Cells are delimited by a `-- %% <id>` line, which is a plain Lean comment, so
// the file stays valid Lean and readable outside Noema.

const LEAN_CELL_MARKER = /^--[ \t]*%%[ \t]*(.*?)[ \t]*$/;

export function notebookStorageForFile(file) {
  return /\.lean$/i.test(String(file || "")) ? "lean" : "ipynb";
}

export function parseLeanNotebook(text, defaults = {}) {
  const notebook = createNotebook({ ...defaults, storage: "lean" });
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const seen = new Set();
  let pending = null;
  const flush = () => {
    if (!pending) return;
    // Trailing blank lines are separator, not content. Dropping them is what
    // makes serialize(parse(x)) stable.
    while (pending.lines.length > 0 && !pending.lines.at(-1).trim()) pending.lines.pop();
    if (pending.lines.length === 0 && !pending.explicit) { pending = null; return; }
    notebook.cells.push(codeCell({
      id: uniqueCellId(pending.id, seen, notebook.cells.length),
      source: pending.lines.join("\n"),
    }, "cell"));
    pending = null;
  };
  for (const line of lines) {
    const marker = line.match(LEAN_CELL_MARKER);
    if (marker) {
      flush();
      pending = { id: marker[1], lines: [], explicit: true };
      continue;
    }
    if (!pending) {
      // Content ahead of the first marker still belongs to the file.
      if (!line.trim()) continue;
      pending = { id: "", lines: [], explicit: false };
    }
    pending.lines.push(line);
  }
  flush();
  return notebook;
}

export function serializeLeanNotebook(notebook) {
  const blocks = notebookCodeCells(notebook).map((cell) => {
    const source = notebookSource(cell.source).replace(/\s+$/, "");
    return source ? `-- %% ${cell.id}\n${source}\n` : `-- %% ${cell.id}\n`;
  });
  return blocks.join("\n");
}

/** Read notebook text using the storage format implied by its file name. */
export function parseNotebookText(text, defaults = {}, file = "") {
  return notebookStorageForFile(file) === "lean"
    ? parseLeanNotebook(text, defaults)
    : parseNotebook(text, defaults);
}

/** Write notebook text using the storage format implied by its file name. */
export function serializeNotebookText(notebook, file = "") {
  return notebookStorageForFile(file) === "lean"
    ? serializeLeanNotebook(notebook)
    : serializeNotebook(notebook);
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
    const cell = codeCell({ ...old, id, source }, id);
    inheritTransientCellId(old, cell);
    incoming.push(cell);
  }
  // A partial editor projection must not discard cells already in the file.
  for (const old of notebook.cells || []) {
    if (seen.has(old.id) || dropped.has(old.id)) continue;
    seen.add(old.id);
    incoming.push(old);
  }
  notebook.cells = incoming;
  for (const cell of notebook.cells) {
    if (cell?.cell_type !== "code") continue;
    cell.metadata = object(cell.metadata);
    const noema = object(cell.metadata.noema);
    // Do not add private metadata to an ordinary untouched cell, but when a
    // Noema result record exists keep its runtime labels aligned with the
    // notebook's canonical language/session and selected kernelspec.
    if (Object.keys(noema).length > 0) {
      cell.metadata.noema = {
        ...noema,
        kernel: String(kernel),
        session: String(session),
        language: String(language),
      };
    }
  }
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
    storage: String(storage || "ipynb"),
  };

  let line = 1;
  for (const cell of notebook.cells) {
    if (cell.id === targetCellId) {
      line += 1; // the projected `# %% id` marker occupies the previous line
      break;
    }
    line += notebookSource(cell.source).split("\n").length + 2;
  }
  return {
    notebook,
    text: storage === "lean" ? serializeLeanNotebook(notebook) : serializeNotebook(notebook),
    line,
  };
}

export function notebookOutput(cell, { passive = false, includeRuntimeStamp = false } = {}) {
  if (!cell || cell.cell_type !== "code") return null;
  const noema = object(object(cell.metadata).noema);
  const hasPortableOutput = cell.execution_count != null || (Array.isArray(cell.outputs) && cell.outputs.length > 0);
  if (!hasPortableOutput && Object.keys(noema).length === 0) return null;
  const { widgetRuntime: _widgetRuntime, kernelRuntime, ...persisted } = noema;
  return {
    ...persisted,
    // kernelRuntime is a private identity stamp, not a serializable widget
    // manager.  Active service paths may retain it just long enough to prove
    // that the saved comm state belongs to the currently running generation.
    ...(includeRuntimeStamp && kernelRuntime ? { kernelRuntime } : {}),
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
