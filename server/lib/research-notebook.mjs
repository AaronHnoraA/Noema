/**
 * Noema research notebooks (Noema design §5).
 *
 * A Noema work document is a standard nbformat 4.5 JSON container stored as
 * `*.noema`; its research semantics live below the `noema_research` metadata
 * namespace. The legacy `*.noema.ipynb` suffix is read during migration. The
 * `metadata.noema` namespace belongs to Markdown sidecar notebooks and is
 * never written here.  The file is the only authority for declared research
 * structure; the kernel index is rebuilt from it after every write.
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { notebookSource, parseNotebook, serializeNotebook } from "./jupyter-notebook-format.mjs";
import { parseResearchDirectives } from "./research-directives.mjs";

export const RESEARCH_SCHEMA = "noema.work-document/2";
export const LEGACY_RESEARCH_SCHEMA = "noema.research-notebook/1";
export const RESEARCH_NAMESPACE = "noema_research";
export const GRAPH_KINDS = Object.freeze(["question", "work", "checkpoint"]);
export const RESEARCH_KINDS = Object.freeze([]);
export const WORK_STATES = Object.freeze(["open", "active", "waiting", "done", "dropped"]);
export const WORK_OUTCOMES = Object.freeze(["supported", "refuted", "inconclusive", "dead_end", "superseded"]);
export const RELATION_TYPES = Object.freeze(["lineage", "depends"]);
export const RESEARCH_SUFFIX = ".noema";
export const LEGACY_RESEARCH_SUFFIX = ".noema.ipynb";

const CELL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WORK_NODE_ID = /^wn_[A-Za-z0-9_-]{1,80}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    const text = typeof item === "string" ? item.trim() : "";
    if (text) seen.add(text);
  }
  return [...seen];
}

function firstLine(source) {
  return String(source || "").split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 80) || "";
}

export function researchError(message, statusCode = 400, code = "ERR_RESEARCH") {
  return Object.assign(new Error(message), { statusCode, code });
}

export function isResearchDocumentPath(file) {
  const lower = String(file || "").toLowerCase();
  return lower.endsWith(RESEARCH_SUFFIX) || lower.endsWith(LEGACY_RESEARCH_SUFFIX);
}

export function researchMeta(cell) {
  return object(object(cell?.metadata)[RESEARCH_NAMESPACE]);
}

export function researchDocumentMeta(notebook) {
  return object(object(notebook?.metadata)[RESEARCH_NAMESPACE]);
}

function setResearchMeta(cell, meta) {
  const metadata = { ...object(cell.metadata) };
  if (Object.keys(meta).length > 0) metadata[RESEARCH_NAMESPACE] = meta;
  else delete metadata[RESEARCH_NAMESPACE];
  cell.metadata = metadata;
}

export function researchWorkNodes(notebook) {
  return Array.isArray(researchDocumentMeta(notebook).work_nodes)
    ? researchDocumentMeta(notebook).work_nodes
    : [];
}

export function researchDependencies(notebook) {
  return Array.isArray(researchDocumentMeta(notebook).dependencies)
    ? researchDocumentMeta(notebook).dependencies
    : [];
}

function setDocumentMeta(notebook, meta) {
  notebook.metadata = { ...object(notebook.metadata), [RESEARCH_NAMESPACE]: meta };
}

function workNodeIndex(notebook, id) {
  return researchWorkNodes(notebook).findIndex((node) => node?.id === id);
}

function resolveWorkNodeId(notebook, value) {
  const id = String(value || "").trim();
  if (!id) return "";
  if (workNodeIndex(notebook, id) >= 0) return id;
  const cell = (notebook?.cells || []).find((candidate) => candidate?.id === id);
  return String(researchMeta(cell).work_node_id || "").trim();
}

export function researchWorkNodeId(notebook, value) {
  return resolveWorkNodeId(notebook, value) || null;
}

function requireWorkNodeIndex(notebook, value) {
  const id = resolveWorkNodeId(notebook, value);
  const index = workNodeIndex(notebook, id);
  if (index < 0) throw researchError(`Unknown WorkNode: ${value}`, 404, "ERR_RESEARCH_WORK_NODE");
  return { id, index };
}

function dependencyId(from, to, type) {
  return `dep_${createHash("sha256").update(`${from}\u0000${to}\u0000${type}`).digest("hex").slice(0, 24)}`;
}

function relationParents(notebook, nodeId, type) {
  return researchDependencies(notebook)
    .filter((edge) => edge?.to === nodeId && edge?.type === type)
    .map((edge) => String(edge.from || ""))
    .filter(Boolean);
}

export function researchWorkNodeForCell(notebook, cellOrId) {
  const cell = typeof cellOrId === "string"
    ? (notebook?.cells || []).find((candidate) => candidate?.id === cellOrId)
    : cellOrId;
  const id = String(researchMeta(cell).work_node_id || "");
  return researchWorkNodes(notebook).find((node) => node?.id === id) || null;
}

export function researchCellKind(cell, notebook = null) {
  const kind = researchMeta(cell).kind;
  // Result exists only as a migration compatibility role. Canonical D-023
  // cells derive their role from storage type plus the bound WorkNode.
  if (kind === "result") return "result";
  const node = notebook ? researchWorkNodeForCell(notebook, cell) : null;
  if (cell?.cell_type === "code") return node?.kind === "work" ? "work" : "code";
  if (node?.kind === "question" || node?.kind === "checkpoint") return node.kind;
  if (typeof kind === "string" && kind) return kind;
  return "note";
}

export function newResearchCellId(notebook, prefix = "c") {
  const taken = new Set((notebook?.cells || []).map((cell) => cell?.id));
  for (;;) {
    const id = `${prefix}-${randomBytes(6).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

export function newResearchWorkNodeId(notebook) {
  const taken = new Set(researchWorkNodes(notebook).map((node) => node?.id));
  for (;;) {
    const id = `wn_${uuidv7()}`;
    if (!taken.has(id)) return id;
  }
}

export function researchWorkNodeSummary(notebook, value) {
  const { id, index } = requireWorkNodeIndex(notebook, value);
  const node = researchWorkNodes(notebook)[index];
  const boundCells = (notebook?.cells || [])
    .filter((cell) => researchMeta(cell).work_node_id === id)
  const cellIds = boundCells.map((cell) => cell.id);
  const primaryCell = boundCells.find((cell) => (
    node.kind === "work" ? cell?.cell_type === "code" : cell?.cell_type === "markdown"
  )) || null;
  const ordinal = primaryCell ? cellIndex(notebook, primaryCell.id) : Number.MAX_SAFE_INTEGER;
  return {
    id,
    kind: String(node.kind || ""),
    title: String(node.title || ""),
    label: String(node.title || "") || id,
    state: typeof node.state === "string" ? node.state : null,
    outcome: typeof node.outcome === "string" ? node.outcome : null,
    droppedReason: typeof node.dropped_reason === "string" ? node.dropped_reason : null,
    disclosure: typeof node.disclosure === "string" ? node.disclosure : null,
    lineage: relationParents(notebook, id, "lineage"),
    depends: relationParents(notebook, id, "depends"),
    cellIds,
    primaryCellId: primaryCell?.id || null,
    ordinal,
  };
}

export function researchCellSummary(cell, ordinal = 0, notebook = null) {
  const meta = researchMeta(cell);
  const source = notebookSource(cell?.source);
  const node = notebook ? researchWorkNodeForCell(notebook, cell) : null;
  const nodeSummary = node ? researchWorkNodeSummary(notebook, node.id) : null;
  const title = nodeSummary?.title || (typeof meta.title === "string" ? meta.title : "");
  return {
    id: String(cell?.id || ""),
    workNodeId: nodeSummary?.id || (typeof meta.work_node_id === "string" ? meta.work_node_id : null),
    cellType: String(cell?.cell_type || ""),
    kind: researchCellKind(cell, notebook),
    title,
    label: title || firstLine(source) || String(cell?.id || ""),
    state: nodeSummary?.state || null,
    outcome: nodeSummary?.outcome || null,
    droppedReason: nodeSummary?.droppedReason || null,
    lineage: nodeSummary?.lineage || [],
    depends: nodeSummary?.depends || [],
    of: researchCellKind(cell, notebook) === "result" ? (meta.work_node_id || null) : null,
    ordinal,
  };
}

export function createResearchNotebook({ title = "", defaultAgent = "" } = {}) {
  const agent = String(defaultAgent || "").trim();
  if (agent && !AGENT_ID.test(agent)) {
    throw researchError(`Invalid default agent: ${agent}`, 422, "ERR_RESEARCH_AGENT");
  }
  const documentMeta = {
    schema: RESEARCH_SCHEMA,
    notebook_id: `nb_${uuidv7()}`,
    workstream_id: `ws_${uuidv7()}`,
    title: String(title || "").trim(),
    work_nodes: [],
    dependencies: [],
  };
  if (agent) documentMeta.default_agent = agent;
  return {
    cells: [],
    metadata: {
      [RESEARCH_NAMESPACE]: documentMeta,
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

export function isResearchNotebook(notebook) {
  return [RESEARCH_SCHEMA, LEGACY_RESEARCH_SCHEMA].includes(researchDocumentMeta(notebook).schema);
}

// `parseNotebook` remembers ids it had to synthesize so ordinary notebooks keep
// their original shape on disk.  Research notebooks must persist stable valid
// ids, so every cell is adopted as a fresh object without that memory.
function adoptCells(notebook) {
  notebook.cells = (Array.isArray(notebook.cells) ? notebook.cells : []).map((cell) => ({ ...cell }));
  return notebook;
}

function legacyWorkNodeId(notebookId, cellId) {
  return `wn_legacy_${createHash("sha256").update(`${notebookId}\u0000${cellId}`).digest("hex").slice(0, 24)}`;
}

// v1 stored graph identity, node state, and dependency edges in each cell.
// Upgrade that graph representation before applying the D-023 storage rules.
function upgradeLegacyResearchGraph(notebook) {
  const next = adoptCells(structuredClone(notebook));
  const oldMeta = researchDocumentMeta(next);
  if (oldMeta.schema !== LEGACY_RESEARCH_SCHEMA) return next;
  const notebookId = String(oldMeta.notebook_id || "").trim();
  const bindings = new Map();
  const workNodes = [];
  for (const cell of next.cells) {
    const meta = researchMeta(cell);
    if (!GRAPH_KINDS.includes(meta.kind)) continue;
    const id = legacyWorkNodeId(notebookId, cell.id);
    bindings.set(cell.id, id);
    const node = { id, kind: meta.kind, title: String(meta.title || "") };
    for (const key of ["state", "outcome", "dropped_reason", "disclosure"]) {
      if (typeof meta[key] === "string" && meta[key]) node[key] = meta[key];
    }
    workNodes.push(node);
  }
  const dependencies = [];
  for (const cell of next.cells) {
    const meta = { ...researchMeta(cell) };
    const workNodeId = bindings.get(cell.id);
    if (workNodeId) {
      for (const type of RELATION_TYPES) {
        for (const parentCellId of stringList(meta[type])) {
          const from = bindings.get(parentCellId);
          if (from) dependencies.push({ id: dependencyId(from, workNodeId, type), from, to: workNodeId, type });
        }
      }
      for (const key of ["kind", "title", "state", "outcome", "dropped_reason", "disclosure", "lineage", "depends"]) delete meta[key];
      meta.work_node_id = workNodeId;
    } else if (meta.kind === "result") {
      const target = bindings.get(meta.of);
      delete meta.of;
      if (target) meta.work_node_id = target;
    }
    setResearchMeta(cell, meta);
  }
  setDocumentMeta(next, {
    ...oldMeta,
    schema: RESEARCH_SCHEMA,
    migrated_from: LEGACY_RESEARCH_SCHEMA,
    work_nodes: workNodes,
    dependencies,
  });
  return next;
}

// Upgrade deterministically in memory so compatibility reads get the same
// WorkNode ids until the user explicitly persists the canonical form.
export function migrateLegacyResearchNotebook(notebook) {
  const legacy = researchDocumentMeta(notebook).schema === LEGACY_RESEARCH_SCHEMA;
  const next = upgradeLegacyResearchGraph(notebook);
  return legacy
    ? migrateResearchNotebookD023(next, { legacyInput: true }).notebook
    : next;
}

function readableMigrationName(value, fallback) {
  const slug = String(value || "").normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56);
  return slug || fallback;
}

function legacyResultContent(cell) {
  const source = notebookSource(cell?.source).trim();
  return source.replace(/^##\s+Run\s+run_[^\n]*\n+/i, "").trim() || source;
}

/**
 * Deterministically upgrade an in-memory pre-D-023 document. Programming
 * cells are returned as extraction records and replaced by bound notes; the
 * caller owns writing those ordinary files before committing the notebook.
 */
export function migrateResearchNotebookD023(notebook, {
  extractionPath = null,
  legacyInput = false,
} = {}) {
  const inputWasLegacy = legacyInput
    || researchDocumentMeta(notebook).schema === LEGACY_RESEARCH_SCHEMA;
  const next = adoptCells(structuredClone(notebook));
  const metadata = object(next.metadata);
  const documentMeta = researchDocumentMeta(next);
  const legacyExecution = Object.hasOwn(metadata, "kernelspec")
    || Object.hasOwn(metadata, "language_info")
    || inputWasLegacy;
  delete metadata.kernelspec;
  delete metadata.language_info;
  next.metadata = metadata;

  const nodeById = new Map(researchWorkNodes(next).map((node) => [node.id, node]));
  const latestResults = new Map();
  for (const cell of next.cells) {
    if (researchMeta(cell).kind === "result") {
      const workNodeId = String(researchMeta(cell).work_node_id || "");
      if (workNodeId) latestResults.set(workNodeId, cell);
    }
  }

  const programmingCellIds = new Set();
  const workStorage = new Set();
  for (const cell of next.cells) {
    const workNodeId = String(researchMeta(cell).work_node_id || "");
    if (cell.cell_type !== "code") continue;
    const runtimeMeta = object(object(cell.metadata).noema);
    const pairedLegacyPrompt = next.cells.some((candidate) => (
      candidate !== cell && candidate.cell_type === "markdown"
      && researchMeta(candidate).work_node_id === workNodeId
      && nodeById.get(workNodeId)?.kind === "work"
    ));
    const programming = legacyExecution && (
      Object.keys(runtimeMeta).length > 0 || pairedLegacyPrompt
      || nodeById.get(workNodeId)?.kind !== "work"
    );
    if (programming) programmingCellIds.add(cell.id);
    else if (nodeById.get(workNodeId)?.kind === "work") workStorage.add(workNodeId);
  }
  const extractions = [];
  const cells = [];
  for (const cell of next.cells) {
    const meta = { ...researchMeta(cell) };
    const workNodeId = String(meta.work_node_id || "");
    const node = nodeById.get(workNodeId);
    if (meta.kind === "result") continue;
    if (cell.cell_type === "code" && programmingCellIds.has(cell.id)) {
      const ordinal = extractions.length + 1;
      const fallback = String(cell.id || `cell-${ordinal}`).replace(/^c-/, "");
      const demoName = /^c-demo-(.+)$/.exec(String(cell.id || ""))?.[1];
      const suggested = `experiments/${readableMigrationName(demoName || node?.title, fallback)}.py`;
      const path = typeof extractionPath === "function" ? extractionPath(cell, node, suggested, ordinal) : suggested;
      extractions.push({
        cellId: cell.id,
        workNodeId,
        path,
        source: notebookSource(cell.source),
        outputs: structuredClone(Array.isArray(cell.outputs) ? cell.outputs : []),
      });
      cell.cell_type = "markdown";
      delete cell.execution_count;
      delete cell.outputs;
      delete cell.attachments;
      // `metadata.noema` is the old Jupyter runtime stamp (kernel, session,
      // saved output UI).  It has no meaning on the replacement note and
      // must not leave a hidden kernel association in the migrated document.
      if (object(cell.metadata).noema) delete cell.metadata.noema;
      delete meta.kind;
      cell.source = `Programming code migrated to [${path}](${path}).`;
      setResearchMeta(cell, meta);
      cells.push(cell);
      continue;
    }
    if (node?.kind === "work" && cell.cell_type === "markdown" && !workStorage.has(workNodeId)) {
      cell.cell_type = "code";
      cell.execution_count = null;
      cell.outputs = [];
      delete cell.attachments;
      delete meta.kind;
      setResearchMeta(cell, meta);
      workStorage.add(workNodeId);
    }
    cells.push(cell);
  }

  for (const [workNodeId, result] of latestResults) {
    const target = cells.find((cell) => cell.cell_type === "code" && researchMeta(cell).work_node_id === workNodeId);
    if (!target) continue;
    const resultMeta = researchMeta(result);
    const runId = String(resultMeta.run_id || "").trim();
    if (!runId.startsWith("run_")) continue;
    target.outputs = [runOutput({
      runId,
      agent: resultMeta.agent,
      status: String(resultMeta.status || "completed"),
      content: legacyResultContent(result),
    })];
  }
  next.cells = cells;
  const report = validateResearchNotebook(next);
  return {
    notebook: next,
    extractions,
    validation: report,
    changed: legacyExecution || latestResults.size > 0 || cells.some((cell, index) => cell.cell_type !== notebook.cells?.[index]?.cell_type),
  };
}

export function parseResearchNotebook(text) {
  let notebook;
  try {
    notebook = parseNotebook(text);
    // The ordinary Jupyter reader supplies convenient kernel defaults for
    // editor-backed .ipynb files.  Those defaults are not on disk and are not
    // meaningful for a D-023 work document, so remove only the fields the
    // reader synthesized.  Real legacy kernel metadata remains visible to
    // validation and migration.
    const raw = JSON.parse(String(text || "{}"));
    const rawMetadata = object(raw?.metadata);
    if (!Object.hasOwn(rawMetadata, "kernelspec")) delete notebook.metadata.kernelspec;
    if (!Object.hasOwn(rawMetadata, "language_info")) delete notebook.metadata.language_info;
  } catch (error) {
    throw researchError(`Invalid notebook JSON: ${error?.message || error}`, 422, "ERR_RESEARCH_FORMAT");
  }
  if (!isResearchNotebook(notebook)) {
    throw researchError("Not a Noema research notebook", 422, "ERR_RESEARCH_FORMAT");
  }
  return researchDocumentMeta(notebook).schema === LEGACY_RESEARCH_SCHEMA
    ? migrateLegacyResearchNotebook(notebook)
    : adoptCells(notebook);
}

function cellIndex(notebook, cellId) {
  return (notebook.cells || []).findIndex((cell) => cell?.id === cellId);
}

function requireCellIndex(notebook, cellId) {
  const index = cellIndex(notebook, String(cellId || ""));
  if (index < 0) throw researchError(`Unknown research cell: ${cellId}`, 404, "ERR_RESEARCH_CELL");
  return index;
}

export function findDependencyCycle(notebook, types = RELATION_TYPES) {
  const included = new Set(types);
  const nodes = new Map(researchWorkNodes(notebook).map((node) => [node.id, node]));
  const parents = new Map();
  for (const edge of researchDependencies(notebook)) {
    if (!included.has(edge?.type)) continue;
    parents.set(edge.to, [...(parents.get(edge.to) || []), edge.from]);
  }
  const marks = new Map();
  const stack = [];
  const visit = (id) => {
    marks.set(id, 1);
    stack.push(id);
    for (const parent of parents.get(id) || []) {
      if (!nodes.has(parent)) continue;
      const mark = marks.get(parent);
      if (mark === 1) return [...stack.slice(stack.indexOf(parent)), parent];
      if (!mark) {
        const cycle = visit(parent);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    marks.set(id, 2);
    return null;
  };
  for (const id of nodes.keys()) {
    if (marks.get(id)) continue;
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

export function findDependsCycle(notebook) {
  return findDependencyCycle(notebook, ["depends"]);
}

export function validateResearchNotebook(notebook) {
  const errors = [];
  const warnings = [];
  const add = (list, code, cellId, message) => list.push({ code, cellId, message });
  const meta = researchDocumentMeta(notebook);
  if (notebook?.nbformat !== 4 || notebook?.nbformat_minor !== 5) {
    add(errors, "nbformat", null, "Noema work documents require nbformat 4.5");
  }
  if (meta.schema !== RESEARCH_SCHEMA) add(errors, "schema", null, `metadata.${RESEARCH_NAMESPACE}.schema must be ${RESEARCH_SCHEMA}`);
  if (!String(meta.notebook_id || "").trim()) add(errors, "notebook-id", null, `metadata.${RESEARCH_NAMESPACE}.notebook_id is required`);
  if (meta.default_agent !== undefined && !AGENT_ID.test(String(meta.default_agent || ""))) {
    add(errors, "default-agent", null, `metadata.${RESEARCH_NAMESPACE}.default_agent is invalid`);
  }
  if (Object.hasOwn(object(notebook?.metadata), "kernelspec") || Object.hasOwn(object(notebook?.metadata), "language_info")) {
    add(errors, "kernel-metadata", null, ".noema work documents cannot declare kernelspec or language_info");
  }
  const cells = Array.isArray(notebook?.cells) ? notebook.cells : [];
  const summaries = cells.map((cell, index) => researchCellSummary(cell, index, notebook));
  const byId = new Map();
  for (const cell of summaries) {
    if (!CELL_ID.test(cell.id)) add(errors, "cell-id", cell.id, `Invalid cell id: ${cell.id || "(missing)"}`);
    else if (byId.has(cell.id)) add(errors, "duplicate-cell-id", cell.id, `Duplicate cell id: ${cell.id}`);
    else byId.set(cell.id, cell);
  }
  const nodeById = new Map();
  for (const raw of researchWorkNodes(notebook)) {
    const id = String(raw?.id || "");
    if (!WORK_NODE_ID.test(id)) add(errors, "work-node-id", id || null, `Invalid WorkNode id: ${id || "(missing)"}`);
    else if (nodeById.has(id)) add(errors, "duplicate-work-node-id", id, `Duplicate WorkNode id: ${id}`);
    else nodeById.set(id, raw);
    if (!GRAPH_KINDS.includes(raw?.kind)) add(errors, "work-node-kind", id || null, `Unsupported WorkNode kind: ${String(raw?.kind)}`);
    if (raw?.state !== undefined && !WORK_STATES.includes(raw.state)) add(errors, "state", id || null, `Unsupported work state: ${raw.state}`);
    if (raw?.outcome !== undefined && !WORK_OUTCOMES.includes(raw.outcome)) add(errors, "outcome", id || null, `Unsupported work outcome: ${raw.outcome}`);
    if ((raw?.state !== undefined || raw?.outcome !== undefined) && raw?.kind !== "work") {
      add(warnings, "state-non-work", id || null, "State and outcome only apply to work WorkNodes");
    }
  }
  for (const cell of summaries) {
    const raw = researchMeta(cells[cell.ordinal]);
    const sourceCell = cells[cell.ordinal];
    const node = raw.work_node_id ? nodeById.get(raw.work_node_id) : null;
    if (raw.kind !== undefined) {
      add(errors, "cell-graph-metadata", cell.id, "Graph kind belongs to a WorkNode, not cell metadata");
    }
    if (raw.work_node_id && !nodeById.has(raw.work_node_id)) {
      add(errors, "cell-work-node", cell.id, `Cell references missing WorkNode ${raw.work_node_id}`);
    }
    if (raw.kind === "result" && nodeById.get(raw.work_node_id)?.kind !== "work") {
      add(errors, "result-cell", cell.id, "Independent Result cells are not allowed; migrate the result into work outputs");
    }
    if (!["markdown", "code"].includes(cell.cellType)) {
      add(errors, "cell-type", cell.id, `Unsupported .noema cell_type: ${cell.cellType}`);
    } else if (cell.cellType === "code") {
      if (!node || node.kind !== "work") {
        add(errors, "work-storage", cell.id, "A code storage cell must bind an existing work WorkNode");
      }
      if (sourceCell.execution_count !== null) {
        add(errors, "execution-count", cell.id, "A .noema work cell execution_count must be null");
      }
      if (!Array.isArray(sourceCell.outputs)) {
        add(errors, "outputs", cell.id, "A .noema work cell must have an outputs array");
      }
      if (notebookSource(sourceCell.source).trim()) {
        try {
          parseResearchDirectives(notebookSource(sourceCell.source), { sourceName: `work cell ${cell.id}` });
        } catch (error) {
          add(errors, "directive", cell.id, String(error?.message || error));
        }
      }
    } else {
      if (Object.hasOwn(sourceCell, "outputs") || Object.hasOwn(sourceCell, "execution_count")) {
        add(errors, "markdown-runtime", cell.id, "question, checkpoint, and note cells cannot carry outputs or execution_count");
      }
      if (node?.kind === "work" && !cells.some((candidate) => (
        candidate !== sourceCell
        && candidate?.cell_type === "code"
        && researchMeta(candidate).work_node_id === node.id
      ))) {
        add(warnings, "work-without-prompt", cell.id, `WorkNode ${node.id} has no executable work cell`);
      }
    }
  }
  const dependencyKeys = new Set();
  for (const edge of researchDependencies(notebook)) {
    const type = String(edge?.type || "");
    const from = String(edge?.from || "");
    const to = String(edge?.to || "");
    const key = `${from}\u0000${to}\u0000${type}`;
    if (!RELATION_TYPES.includes(type)) add(errors, "dependency-type", to || null, `Unsupported dependency type: ${type}`);
    if (from === to && from) add(errors, "self-relation", to, `${type} cannot reference its own WorkNode`);
    if (!nodeById.has(from)) add(warnings, "dangling-relation", to || null, `${type} references missing WorkNode ${from}`);
    if (!nodeById.has(to)) add(warnings, "dangling-relation", to || null, `${type} targets missing WorkNode ${to}`);
    if (dependencyKeys.has(key)) add(errors, "duplicate-dependency", to || null, `Duplicate dependency ${from} -> ${to} (${type})`);
    dependencyKeys.add(key);
  }
  const cycle = findDependencyCycle(notebook);
  if (cycle) add(errors, "dependency-cycle", cycle[0], `work dependencies form a cycle: ${cycle.join(" -> ")}`);
  return { ok: errors.length === 0, errors, warnings };
}

export function createResearchCell(notebook, spec = {}) {
  const next = structuredClone(notebook);
  const kind = String(spec.kind || "work");
  if (![...GRAPH_KINDS, "note"].includes(kind)) {
    throw researchError(`Unsupported cell kind: ${kind}`, 422, "ERR_RESEARCH_KIND");
  }
  const requestedId = String(spec.id || spec.cellId || spec.cell_id || "").trim();
  if (requestedId && (!CELL_ID.test(requestedId) || cellIndex(next, requestedId) >= 0)) {
    throw researchError(`Invalid or duplicate research cell id: ${requestedId}`, 409, "ERR_RESEARCH_CELL");
  }
  const id = requestedId || newResearchCellId(next);
  const source = notebookSource(spec.source ?? "");
  const meta = {};
  const title = String(spec.title ?? "").trim();
  const requestedWorkNode = String(spec.workNodeId || spec.work_node_id || "").trim();
  let workNodeId = requestedWorkNode ? requireWorkNodeIndex(next, requestedWorkNode).id : "";
  if (GRAPH_KINDS.includes(kind)) {
    if (workNodeId) {
      const node = researchWorkNodes(next)[workNodeIndex(next, workNodeId)];
      if (node.kind !== kind) throw researchError(`WorkNode ${workNodeId} is ${node.kind}, not ${kind}`, 422, "ERR_RESEARCH_KIND");
    } else {
      workNodeId = newResearchWorkNodeId(next);
      const node = { id: workNodeId, kind, title };
      if (kind === "work") node.state = "open";
      const documentMeta = { ...researchDocumentMeta(next), work_nodes: [...researchWorkNodes(next), node] };
      setDocumentMeta(next, documentMeta);
    }
    meta.work_node_id = workNodeId;
  } else if (workNodeId) {
    meta.work_node_id = workNodeId;
  } else if (title) {
    meta.title = title;
  }
  const cell = kind === "work"
    ? { cell_type: "code", execution_count: null, id, metadata: {}, outputs: [], source }
    : { cell_type: "markdown", id, metadata: {}, source };
  setResearchMeta(cell, meta);
  const lineageParent = spec.lineageParent ? resolveWorkNodeId(next, spec.lineageParent) : "";
  if (spec.lineageParent && !lineageParent) throw researchError(`Unknown upstream WorkNode: ${spec.lineageParent}`, 404, "ERR_RESEARCH_WORK_NODE");
  const requestedAnchor = spec.after ? String(spec.after) : String(spec.lineageParent || "");
  const anchorNode = resolveWorkNodeId(next, requestedAnchor);
  const anchor = cellIndex(next, requestedAnchor) >= 0
    ? requestedAnchor
    : (anchorNode || workNodeId ? researchWorkNodeSummary(next, anchorNode || workNodeId).primaryCellId : null);
  let index = next.cells.length;
  if (anchor) {
    index = requireCellIndex(next, anchor) + 1;
  }
  next.cells.splice(index, 0, cell);
  let result = { notebook: next, cell: researchCellSummary(cell, index, next), workNode: workNodeId ? researchWorkNodeSummary(next, workNodeId) : null };
  if (lineageParent && workNodeId) result = setResearchRelation(next, workNodeId, "lineage", [lineageParent]);
  if (Array.isArray(spec.depends) && spec.depends.length > 0) {
    result = setResearchRelation(result.notebook, workNodeId, "depends", spec.depends);
  }
  const finalCell = result.notebook.cells.find((candidate) => candidate.id === id);
  return { ...result, cell: researchCellSummary(finalCell, cellIndex(result.notebook, id), result.notebook), workNode: workNodeId ? researchWorkNodeSummary(result.notebook, workNodeId) : null };
}

export function updateResearchCell(notebook, cellId, patch = {}) {
  const next = structuredClone(notebook);
  const index = requireCellIndex(next, cellId);
  const cell = next.cells[index];
  const meta = { ...researchMeta(cell) };
  if (meta.kind === "result") throw researchError("Independent Result cells are not editable; migrate this document to D-023", 409, "ERR_RESEARCH_READONLY");
  let workNode = researchWorkNodeForCell(next, cell);
  if (patch.kind !== undefined) {
    const kind = String(patch.kind);
    if (![...GRAPH_KINDS, "note"].includes(kind)) {
      throw researchError(`Cannot change cell ${cellId} to kind ${kind}`, 422, "ERR_RESEARCH_KIND");
    }
    if (kind === "note") {
      delete meta.work_node_id;
      workNode = null;
    } else if (workNode) {
      workNode.kind = kind;
      if (kind === "work") workNode.state ??= "open";
      else {
        delete workNode.state;
        delete workNode.outcome;
        delete workNode.dropped_reason;
      }
    } else {
      const id = newResearchWorkNodeId(next);
      workNode = { id, kind, title: "" };
      if (kind === "work") workNode.state = "open";
      setDocumentMeta(next, { ...researchDocumentMeta(next), work_nodes: [...researchWorkNodes(next), workNode] });
      meta.work_node_id = id;
    }
    if (kind === "work") {
      cell.cell_type = "code";
      cell.execution_count = null;
      cell.outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
      delete cell.attachments;
    } else {
      cell.cell_type = "markdown";
      delete cell.execution_count;
      delete cell.outputs;
    }
  }
  if (patch.title !== undefined) {
    const title = String(patch.title ?? "").trim();
    if (workNode) workNode.title = title;
    else if (title) meta.title = title;
    else delete meta.title;
  }
  if (patch.source !== undefined) cell.source = notebookSource(patch.source);
  setResearchMeta(cell, meta);
  return { notebook: next, cell: researchCellSummary(cell, index, next), workNode: workNode ? researchWorkNodeSummary(next, workNode.id) : null };
}

export function deleteResearchCell(notebook, cellId) {
  const next = structuredClone(notebook);
  const index = requireCellIndex(next, cellId);
  const workNodeId = String(researchMeta(next.cells[index]).work_node_id || "");
  next.cells.splice(index, 1);
  const node = workNodeId ? researchWorkNodes(next).find((candidate) => candidate.id === workNodeId) : null;
  const stillBound = node && next.cells.some((cell) => (
    researchMeta(cell).work_node_id === workNodeId
    && (node.kind === "work" ? cell.cell_type === "code" : cell.cell_type === "markdown")
  ));
  return { notebook: next, removed: [String(cellId)], orphanedWorkNodeIds: workNodeId && !stillBound ? [workNodeId] : [] };
}

export function deleteResearchWorkNode(notebook, value, { deleteBoundCells = false } = {}) {
  const next = structuredClone(notebook);
  const { id } = requireWorkNodeIndex(next, value);
  setDocumentMeta(next, {
    ...researchDocumentMeta(next),
    work_nodes: researchWorkNodes(next).filter((node) => node.id !== id),
    dependencies: researchDependencies(next).filter((edge) => edge.from !== id && edge.to !== id),
  });
  const removedCells = [];
  next.cells = next.cells.filter((cell) => {
    const meta = { ...researchMeta(cell) };
    if (meta.work_node_id !== id) return true;
    if (deleteBoundCells) {
      removedCells.push(cell.id);
      return false;
    }
    delete meta.work_node_id;
    setResearchMeta(cell, meta);
    return true;
  });
  return { notebook: next, removedWorkNodeId: id, removedCells };
}

export function setResearchRelation(notebook, workNodeId, type, parents = []) {
  if (!RELATION_TYPES.includes(type)) throw researchError(`Unsupported relation type: ${type}`, 422, "ERR_RESEARCH_RELATION");
  const next = structuredClone(notebook);
  const target = requireWorkNodeIndex(next, workNodeId).id;
  const list = stringList(parents).map((parent) => requireWorkNodeIndex(next, parent).id);
  for (const parent of list) {
    if (parent === target) throw researchError(`${type} cannot reference its own WorkNode`, 422, "ERR_RESEARCH_RELATION");
  }
  const kept = researchDependencies(next).filter((edge) => !(edge.to === target && edge.type === type));
  const added = list.map((from) => ({ id: dependencyId(from, target, type), from, to: target, type }));
  setDocumentMeta(next, { ...researchDocumentMeta(next), dependencies: [...kept, ...added] });
  const cycle = findDependencyCycle(next);
  if (cycle) throw researchError(`work dependency would form a cycle: ${cycle.join(" -> ")}`, 422, "ERR_RESEARCH_CYCLE");
  const node = researchWorkNodeSummary(next, target);
  const cell = node.primaryCellId ? next.cells[cellIndex(next, node.primaryCellId)] : null;
  return { notebook: next, workNode: node, cell: cell ? researchCellSummary(cell, cellIndex(next, cell.id), next) : null };
}

export function setResearchState(notebook, workNodeId, { state, outcome, reason } = {}) {
  const next = structuredClone(notebook);
  const { id, index } = requireWorkNodeIndex(next, workNodeId);
  const node = researchWorkNodes(next)[index];
  if (node.kind !== "work") throw researchError("State only applies to work WorkNodes", 422, "ERR_RESEARCH_STATE");
  if (state !== undefined) {
    if (!WORK_STATES.includes(state)) throw researchError(`Unsupported work state: ${state}`, 422, "ERR_RESEARCH_STATE");
    node.state = state;
    const text = String(reason ?? "").trim();
    if (state === "dropped" && text) node.dropped_reason = text;
    else if (state !== "dropped") delete node.dropped_reason;
  }
  if (outcome !== undefined) {
    if (outcome === null || outcome === "") delete node.outcome;
    else if (WORK_OUTCOMES.includes(outcome)) node.outcome = outcome;
    else throw researchError(`Unsupported work outcome: ${outcome}`, 422, "ERR_RESEARCH_STATE");
  }
  const summary = researchWorkNodeSummary(next, id);
  const cell = summary.primaryCellId ? next.cells[cellIndex(next, summary.primaryCellId)] : null;
  return { notebook: next, workNode: summary, cell: cell ? researchCellSummary(cell, cellIndex(next, cell.id), next) : null };
}

function runOutput({ runId, agent = "", status, content = "" }) {
  const text = String(content || "").trim() || `Run ${runId} ${status}.`;
  return {
    output_type: "display_data",
    data: {
      "text/markdown": text,
      "text/plain": text,
      "application/vnd.noema.run+json": {
        run_id: runId,
        agent: String(agent || "").trim(),
        status,
      },
    },
    metadata: {},
  };
}

/** Persist the latest terminal agent reply on the Work's canonical code cell. */
export function upsertResearchRunOutput(notebook, {
  workId, cellId = "", runId, agent = "", status, content = "",
} = {}) {
  const next = structuredClone(notebook);
  const resolved = requireWorkNodeIndex(next, String(workId || ""));
  const work = researchWorkNodes(next)[resolved.index];
  if (work.kind !== "work") {
    throw researchError("Run outputs can only be attached to a work WorkNode", 422, "ERR_RESEARCH_RESULT");
  }
  const run = String(runId || "").trim();
  if (!run.startsWith("run_")) throw researchError("Run output requires a durable run id", 422, "ERR_RESEARCH_RESULT");
  const terminal = String(status || "").trim();
  if (!["completed", "cancelled", "failed", "interrupted"].includes(terminal)) {
    throw researchError("Run output requires a terminal status", 422, "ERR_RESEARCH_RESULT");
  }
  const requestedCell = String(cellId || "").trim();
  const index = requestedCell ? requireCellIndex(next, requestedCell)
    : cellIndex(next, researchWorkNodeSummary(next, work.id).primaryCellId);
  if (index < 0) throw researchError(`WorkNode ${work.id} has no executable work cell`, 409, "ERR_RESEARCH_RESULT");
  const cell = next.cells[index];
  if (cell.cell_type !== "code" || researchMeta(cell).work_node_id !== work.id) {
    throw researchError("Run output target is not the bound work cell", 409, "ERR_RESEARCH_RESULT");
  }
  cell.execution_count = null;
  cell.outputs = [runOutput({ runId: run, agent, status: terminal, content })];
  return { notebook: next, cell: researchCellSummary(cell, index, next), workNode: researchWorkNodeSummary(next, work.id) };
}

// Compatibility export for callers compiled against D-019. It now writes
// outputs and never creates a Result cell.
export const upsertResearchRunResult = upsertResearchRunOutput;

export function clearResearchOutputs(notebook, { cellId = "", workId = "", all = false } = {}) {
  const next = structuredClone(notebook);
  const targetWork = workId ? requireWorkNodeIndex(next, workId).id : "";
  const cleared = [];
  for (const cell of next.cells) {
    if (cell.cell_type !== "code") continue;
    if (!all && cellId && cell.id !== cellId) continue;
    if (!all && targetWork && researchMeta(cell).work_node_id !== targetWork) continue;
    if (!all && !cellId && !targetWork) continue;
    cell.execution_count = null;
    cell.outputs = [];
    cleared.push(cell.id);
  }
  if (!all && cleared.length === 0) throw researchError("No matching work cell outputs", 404, "ERR_RESEARCH_CELL");
  return { notebook: next, cleared };
}

export function setResearchDefaultAgent(notebook, agent = "") {
  const next = structuredClone(notebook);
  const value = String(agent || "").trim();
  if (value && !AGENT_ID.test(value)) {
    throw researchError(`Invalid default agent: ${value}`, 422, "ERR_RESEARCH_AGENT");
  }
  const meta = { ...researchDocumentMeta(next) };
  if (value) meta.default_agent = value;
  else delete meta.default_agent;
  setDocumentMeta(next, meta);
  return { notebook: next, defaultAgent: value };
}

/**
 * Lineage-first graph projection with semantic folding and a focus lens.
 * A fold contracts the descendants that are only reachable through the folded
 * node; the focus node and its ancestors are never hidden.
 */
export function researchGraphProjection(notebook, { focus = null, folds = [], depth = 2 } = {}) {
  const summaries = researchWorkNodes(notebook).map((node) => researchWorkNodeSummary(notebook, node.id));
  const nodes = new Map(summaries.map((node) => [node.id, node]));
  const relationEdges = (type) => {
    const edges = [];
    for (const edge of researchDependencies(notebook)) {
      if (edge.type === type && nodes.has(edge.from) && nodes.has(edge.to) && edge.from !== edge.to) {
        edges.push({ from: edge.from, to: edge.to, type });
      }
    }
    return edges;
  };
  const lineage = relationEdges("lineage");
  const depends = relationEdges("depends");
  const children = new Map();
  const parents = new Map();
  const push = (map, key, value) => map.set(key, [...(map.get(key) || []), value]);
  for (const edge of lineage) {
    push(children, edge.from, edge.to);
    push(parents, edge.to, edge.from);
  }
  const walk = (start, graph, limit = Infinity) => {
    const seen = new Map();
    const queue = [[start, 0]];
    while (queue.length > 0) {
      const [id, distance] = queue.shift();
      if (distance >= limit) continue;
      for (const next of graph.get(id) || []) {
        if (next === start || seen.has(next)) continue;
        seen.set(next, distance + 1);
        queue.push([next, distance + 1]);
      }
    }
    return seen;
  };
  const focusId = focus && nodes.has(focus) ? focus : null;
  const protectedIds = new Set(focusId ? [focusId, ...walk(focusId, parents).keys()] : []);
  let lens = null;
  if (focusId) {
    lens = new Set([...protectedIds, ...walk(focusId, children, depth).keys()]);
    for (const parent of parents.get(focusId) || []) {
      for (const sibling of children.get(parent) || []) lens.add(sibling);
    }
  }
  const roots = [...nodes.keys()].filter((id) => !(parents.get(id) || []).length);
  const hiddenBy = new Map();
  const effectiveFolds = [];
  for (const fold of stringList(folds)) {
    if (!nodes.has(fold)) continue;
    const reachable = new Set();
    const stack = roots.filter((id) => id !== fold);
    while (stack.length > 0) {
      const id = stack.pop();
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const child of children.get(id) || []) if (child !== fold) stack.push(child);
    }
    for (const id of walk(fold, children).keys()) {
      if (reachable.has(id) || protectedIds.has(id) || hiddenBy.has(id)) continue;
      hiddenBy.set(id, fold);
    }
    effectiveFolds.push(fold);
  }
  const representative = (id) => {
    let current = id;
    const seen = new Set();
    while (hiddenBy.has(current) && !seen.has(current)) {
      seen.add(current);
      current = hiddenBy.get(current);
    }
    return current;
  };
  const visible = (id) => !hiddenBy.has(id) && (!lens || lens.has(id));
  const foldSummaries = new Map();
  for (const id of hiddenBy.keys()) {
    const owner = representative(id);
    const summary = foldSummaries.get(owner) || { hidden: 0, kinds: {}, outcomes: {} };
    const cell = nodes.get(id);
    summary.hidden += 1;
    summary.kinds[cell.kind] = (summary.kinds[cell.kind] || 0) + 1;
    if (cell.outcome) summary.outcomes[cell.outcome] = (summary.outcomes[cell.outcome] || 0) + 1;
    foldSummaries.set(owner, summary);
  }
  const outNodes = [...nodes.values()].filter((cell) => visible(cell.id)).map((cell) => ({
    id: cell.id,
    kind: cell.kind,
    title: cell.label,
    state: cell.state,
    outcome: cell.outcome,
    ordinal: cell.ordinal,
    cellId: cell.primaryCellId,
    cellIds: cell.cellIds,
    orphaned: !cell.primaryCellId,
    focus: cell.id === focusId,
    folded: effectiveFolds.includes(cell.id) ? (foldSummaries.get(cell.id) || { hidden: 0, kinds: {}, outcomes: {} }) : null,
  }));
  const seenEdges = new Set();
  const outEdges = [];
  for (const edge of [...lineage, ...depends]) {
    const from = representative(edge.from);
    const to = representative(edge.to);
    if (from === to || !visible(from) || !visible(to)) continue;
    const key = `${from}\u0000${to}\u0000${edge.type}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    outEdges.push({ from, to, type: edge.type });
  }
  const meta = researchDocumentMeta(notebook);
  return {
    notebookId: String(meta.notebook_id || ""),
    documentId: String(meta.notebook_id || ""),
    title: String(meta.title || ""),
    focus: focusId,
    folds: effectiveFolds,
    nodes: outNodes,
    edges: outEdges,
    omitted: nodes.size - outNodes.length - hiddenBy.size,
  };
}

export function researchRevision(text) {
  return `sha256:${createHash("sha256").update(String(text)).digest("hex")}`;
}

export function assertResearchFile(file) {
  const value = String(file || "");
  if (!value || !isAbsolute(value)) throw researchError("Noema document path must be absolute", 400, "ERR_RESEARCH_PATH");
  if (!isResearchDocumentPath(value)) {
    throw researchError("Noema work documents use the .noema suffix", 400, "ERR_RESEARCH_PATH");
  }
  return resolve(value);
}

export async function readResearchNotebookFile(file) {
  const path = assertResearchFile(file);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw researchError(`Research notebook not found: ${path}`, 404, "ERR_RESEARCH_NOT_FOUND");
    throw error;
  }
  return { file: path, text, revision: researchRevision(text), notebook: parseResearchNotebook(text) };
}

async function currentRevision(path) {
  try {
    return researchRevision(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeResearchNotebookFile(file, notebook, { expectedRevision = null, create = false } = {}) {
  const path = assertResearchFile(file);
  const validation = validateResearchNotebook(notebook);
  if (!validation.ok) {
    throw Object.assign(
      researchError(validation.errors.map((entry) => entry.message).join("; "), 422, "ERR_RESEARCH_INVALID"),
      { validation },
    );
  }
  const current = await currentRevision(path);
  if (create && current !== null) throw researchError(`Research notebook already exists: ${path}`, 409, "ERR_RESEARCH_EXISTS");
  if (!create && current === null) throw researchError(`Research notebook not found: ${path}`, 404, "ERR_RESEARCH_NOT_FOUND");
  if (expectedRevision && current !== expectedRevision) {
    throw researchError("Research notebook changed on disk", 409, "ERR_RESEARCH_REVISION");
  }
  const text = serializeNotebook(adoptCells(structuredClone(notebook)));
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o644);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { file: path, text, revision: researchRevision(text), validation };
}

export async function migrateResearchNotebookFile(file, { backupSuffix = ".pre-d023.bak" } = {}) {
  const loaded = await readResearchNotebookFile(file);
  const root = (await findResearchRepositoryRoot(loaded.file)) || dirname(loaded.file);
  const raw = JSON.parse(loaded.text);
  const rawLegacy = researchDocumentMeta(raw).schema === LEGACY_RESEARCH_SCHEMA;
  const source = rawLegacy
    ? upgradeLegacyResearchGraph(parseNotebook(loaded.text))
    : loaded.notebook;
  const migrated = migrateResearchNotebookD023(source, { legacyInput: rawLegacy });
  if (!migrated.changed) {
    return { ...loaded, root, backup: null, extractions: [], migrated: false, validation: validateResearchNotebook(loaded.notebook) };
  }
  if (!migrated.validation.ok) {
    throw Object.assign(
      researchError(migrated.validation.errors.map((entry) => entry.message).join("; "), 422, "ERR_RESEARCH_MIGRATION"),
      { validation: migrated.validation },
    );
  }
  const backup = `${loaded.file}${backupSuffix}`;
  try {
    await stat(backup);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await copyFile(loaded.file, backup);
  }
  for (const extraction of migrated.extractions) {
    const target = resolve(root, extraction.path);
    const insideRoot = relative(root, target);
    if (insideRoot === ".." || insideRoot.startsWith(`..${sep}`) || isAbsolute(insideRoot)) {
      throw researchError(`Migration target escapes the project: ${extraction.path}`, 422, "ERR_RESEARCH_MIGRATION");
    }
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, extraction.source, { encoding: "utf8", flag: "wx", mode: 0o644 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await readFile(target, "utf8") !== extraction.source) {
        throw researchError(`Migration will not overwrite existing file: ${target}`, 409, "ERR_RESEARCH_MIGRATION");
      }
    }
    extraction.file = target;
  }
  const written = await writeResearchNotebookFile(loaded.file, migrated.notebook, { expectedRevision: loaded.revision });
  return {
    file: loaded.file,
    root,
    backup,
    notebook: migrated.notebook,
    revision: written.revision,
    extractions: migrated.extractions,
    migrated: true,
    validation: written.validation,
  };
}

export async function findResearchRepositoryRoot(file) {
  let dir = dirname(assertResearchFile(file));
  for (;;) {
    try {
      if ((await stat(join(dir, "noema.toml"))).isFile()) return dir;
    } catch {
      // keep walking upward
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Channel-facing service.  Mutations are serialized per file, written
 * atomically, and followed by a kernel reindex.  The kernel derives semantic
 * research events by diffing the new file against its previous index, so a
 * write from Emacs or an external checkout produces the same history as a
 * mutation made here.
 */
export function createResearchNotebookService({ getIndexer = () => null, allowWrite = true } = {}) {
  const queues = new Map();
  const serialized = (key, task) => {
    const previous = queues.get(key) || Promise.resolve();
    const run = previous.then(task, task);
    queues.set(key, run.catch(() => {}));
    return run;
  };
  const guardWrite = () => {
    if (!allowWrite) throw researchError("Research notebooks are read-only on this host", 403, "ERR_RESEARCH_READONLY");
  };
  const expected = (body) => body.expectedRevision ?? body.expected_revision ?? null;
  const actor = (body) => String(body.actor || "node");

  async function locate(file) {
    const path = assertResearchFile(file);
    const root = (await findResearchRepositoryRoot(path)) || dirname(path);
    return { path, root, relative: relative(root, path).split(sep).join("/") };
  }

  async function syncIndex(location, { actor: who = "node", reason = "" } = {}) {
    const indexer = getIndexer();
    if (!indexer) return { index: null, indexError: "kernel research index is unavailable" };
    try {
      return { index: await indexer.index({ root: location.root, path: location.relative, actor: who, reason }), indexError: null };
    } catch (error) {
      return { index: null, indexError: String(error?.message || error) };
    }
  }

  async function mutate(body, reason, apply) {
    guardWrite();
    const location = await locate(body.file);
    return serialized(location.path, async () => {
      const loaded = await readResearchNotebookFile(location.path);
      const wanted = expected(body);
      if (wanted && wanted !== loaded.revision) {
        throw researchError("Research notebook changed on disk", 409, "ERR_RESEARCH_REVISION");
      }
      const { notebook, ...outcome } = apply(loaded.notebook);
      const written = await writeResearchNotebookFile(location.path, notebook, { expectedRevision: loaded.revision });
      const index = await syncIndex(location, { actor: actor(body), reason });
      return {
        file: location.path,
        root: location.root,
        revision: written.revision,
        notebook,
        validation: written.validation,
        ...outcome,
        ...index,
      };
    });
  }

  return {
    async create(body = {}) {
      guardWrite();
      const location = await locate(body.file);
      return serialized(location.path, async () => {
        const notebook = createResearchNotebook({
          title: body.title,
          defaultAgent: body.agent || body.defaultAgent || body.default_agent,
        });
        const written = await writeResearchNotebookFile(location.path, notebook, { create: true });
        const index = await syncIndex(location, { actor: actor(body), reason: "notebook.create" });
        return { file: location.path, root: location.root, revision: written.revision, notebook, validation: written.validation, ...index };
      });
    },

    async snapshot(body = {}) {
      const location = await locate(body.file);
      const loaded = await readResearchNotebookFile(location.path);
      let index = null;
      let indexError = null;
      const indexer = getIndexer();
      if (!indexer) {
        indexError = "kernel research index is unavailable";
      } else {
        try {
          index = await indexer.status({ root: location.root, path: location.relative });
          if (index?.stale && allowWrite) {
            ({ index, indexError } = await syncIndex(location, { actor: actor(body), reason: "reconcile" }));
          }
        } catch (error) {
          indexError = String(error?.message || error);
        }
      }
      return {
        file: location.path,
        root: location.root,
        revision: loaded.revision,
        notebook: loaded.notebook,
        validation: validateResearchNotebook(loaded.notebook),
        cells: loaded.notebook.cells.map((cell, ordinal) => researchCellSummary(cell, ordinal, loaded.notebook)),
        workNodes: researchWorkNodes(loaded.notebook).map((node) => researchWorkNodeSummary(loaded.notebook, node.id)),
        dependencies: researchDependencies(loaded.notebook),
        projection: researchGraphProjection(loaded.notebook, { focus: body.focus, folds: body.folds }),
        index,
        indexError,
      };
    },

    async sync(body = {}) {
      guardWrite();
      const location = await locate(body.file);
      return serialized(location.path, async () => {
        const loaded = await readResearchNotebookFile(location.path);
        const index = await syncIndex(location, { actor: actor(body), reason: String(body.reason || "sync") });
        return { file: location.path, root: location.root, revision: loaded.revision, validation: validateResearchNotebook(loaded.notebook), ...index };
      });
    },

    save(body = {}) {
      return mutate(body, "notebook.save", () => ({ notebook: parseResearchNotebook(JSON.stringify(body.notebook ?? null)) }));
    },
    createCell(body = {}) {
      return mutate(body, "cell.create", (notebook) => createResearchCell(notebook, body));
    },
    updateCell(body = {}) {
      return mutate(body, "cell.update", (notebook) => updateResearchCell(notebook, body.cellId, object(body.patch)));
    },
    deleteCell(body = {}) {
      return mutate(body, "cell.delete", (notebook) => deleteResearchCell(notebook, body.cellId));
    },
    deleteWorkNode(body = {}) {
      return mutate(body, "work-node.delete", (notebook) => deleteResearchWorkNode(
        notebook, body.workNodeId || body.work_node_id, { deleteBoundCells: Boolean(body.deleteBoundCells || body.delete_bound_cells) },
      ));
    },
    setRelation(body = {}) {
      return mutate(body, "relation.set", (notebook) => setResearchRelation(
        notebook, body.workNodeId || body.work_node_id || body.cellId, body.type, body.parents,
      ));
    },
    setState(body = {}) {
      return mutate(body, "state.set", (notebook) => setResearchState(
        notebook, body.workNodeId || body.work_node_id || body.cellId, {
        state: body.state,
        outcome: body.outcome,
        reason: body.reason,
      }));
    },
    setDefaultAgent(body = {}) {
      return mutate(body, "notebook.default-agent", (notebook) => setResearchDefaultAgent(
        notebook, body.agent || body.defaultAgent || body.default_agent,
      ));
    },
    clearOutputs(body = {}) {
      return mutate(body, "run.outputs.clear", (notebook) => clearResearchOutputs(notebook, {
        cellId: body.cellId || body.cell_id,
        workId: body.workId || body.work_id,
        all: Boolean(body.all),
      }));
    },
    writeRunOutput(body = {}) {
      return mutate(body, "run.output", (notebook) => {
        const notebookId = String(body.notebookId || body.notebook_id || "").trim();
        if (notebookId && String(researchMeta({ metadata: notebook.metadata }).notebook_id || "") !== notebookId) {
          throw researchError("Run output notebook identity does not match the target file", 409, "ERR_RESEARCH_RESULT");
        }
        return upsertResearchRunOutput(notebook, {
          workId: body.workId || body.work_id,
          cellId: body.cellId || body.cell_id,
          runId: body.runId || body.run_id,
          agent: body.agent,
          status: body.status,
          content: body.content,
        });
      });
    },
    // Compatibility boundary for workers compiled before D-023.
    writeRunResult(body = {}) {
      return this.writeRunOutput(body);
    },

    async migrate(body = {}) {
      guardWrite();
      const location = await locate(body.file);
      return serialized(location.path, async () => {
        const migrated = await migrateResearchNotebookFile(location.path);
        const index = migrated.migrated
          ? await syncIndex(location, { actor: actor(body), reason: "notebook.migrate-d023" })
          : { index: null, indexError: null };
        return { ...migrated, ...index };
      });
    },

    async projection(body = {}) {
      const loaded = await readResearchNotebookFile(body.file);
      return {
        file: loaded.file,
        revision: loaded.revision,
        projection: researchGraphProjection(loaded.notebook, { focus: body.focus, folds: body.folds }),
      };
    },

    async events(body = {}) {
      const location = await locate(body.file);
      const indexer = getIndexer();
      if (!indexer) throw researchError("kernel research index is unavailable", 503, "ERR_RESEARCH_INDEX");
      const loaded = await readResearchNotebookFile(location.path);
      const notebookId = String(loaded.notebook.metadata[RESEARCH_NAMESPACE].notebook_id);
      const events = await indexer.events({
        root: location.root,
        notebookId,
        after: Math.max(0, Number(body.after) || 0),
        limit: Math.min(1000, Math.max(1, Number(body.limit) || 200)),
      });
      return { file: location.path, notebookId, events };
    },
  };
}
