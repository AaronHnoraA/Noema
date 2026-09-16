import { canonicalTodoArgs, normalizeDateValue, parseDuration } from "./planning-values.mjs";
import { scanPlanningNodes, serializeBlockAttrs, serializeInlineAttrs } from "./planning-dsl.mjs";

// Agenda is authored with the same visible @@todo / @@clock grammar used by
// Markdown.  Leading planning commands are control text (and therefore
// excluded from Agent prompts), while outputs and later lookalikes are data.
export const WORK_AGENDA_KEYS = Object.freeze(["sche", "ddl", "end", "prio", "effort", "tags", "context", "project", "status", "done", "progress", "clocks"]);
export const WORK_AGENDA_STATUSES = Object.freeze(["todo", "doing", "blocked", "done", "cancelled"]);
const AGENDA_SCALAR_KEYS = WORK_AGENDA_KEYS.filter((key) => key !== "clocks");

const clockDate = (value) => typeof value === "string" && / \d{2}:\d{2}$/.test(value) && normalizeDateValue(value) === value;

export function validateWorkClocks(clocks) {
  if (!Array.isArray(clocks)) return ["agenda.clocks must be an array"];
  const errors = [];
  const ids = new Set();
  let running = 0;
  for (const clock of clocks) {
    if (!clock || typeof clock !== "object" || Array.isArray(clock)) { errors.push("agenda clock must be an object"); continue; }
    if (Object.keys(clock).some((key) => !["id", "from", "to"].includes(key))) errors.push("unsupported agenda clock field");
    if (typeof clock.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(clock.id) || ids.has(clock.id)) errors.push("invalid or duplicate agenda clock ID");
    ids.add(clock.id);
    if (!clockDate(clock.from)) errors.push("agenda clock.from requires a canonical date and time");
    if (Object.hasOwn(clock, "to")) {
      if (!clockDate(clock.to) || clock.to < clock.from) errors.push("agenda clock.to must be a date and time at or after from");
    } else running++;
  }
  if (running > 1) errors.push("a WorkNode may have only one running clock");
  return errors;
}

export function validateWorkAgenda(agenda, kind) {
  if (!agenda || typeof agenda !== "object" || Array.isArray(agenda)) return ["agenda must be an object"];
  const errors = [];
  for (const [key, value] of Object.entries(agenda)) {
    if (!WORK_AGENDA_KEYS.includes(key)) { errors.push(`unsupported agenda field: ${key}`); continue; }
    if (key === "clocks") { errors.push(...validateWorkClocks(value)); continue; }
    if (typeof value !== "string") { errors.push(`agenda.${key} must be a string`); continue; }
    if (["sche", "ddl", "end", "done"].includes(key) && value && normalizeDateValue(value) !== value) errors.push(`invalid agenda.${key} canonical date`);
    if (key === "prio" && value && !/^[A-Z]$/.test(value)) errors.push("agenda.prio must be A–Z");
    if (key === "effort" && value && parseDuration(value) === null) errors.push("invalid agenda.effort duration");
    if (key === "progress" && value && (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) > 100)) errors.push("agenda.progress must be between 0 and 100");
    if (key === "status" && (kind === "work" || !WORK_AGENDA_STATUSES.includes(value))) errors.push("agenda.status is only a task status for question/checkpoint nodes; work nodes use state");
  }
  return errors;
}

function agendaSyntaxError(message, sourceName = "cell") {
  return Object.assign(new Error(`${sourceName}: ${message}`), { statusCode: 422, code: "ERR_RESEARCH_AGENDA" });
}

/** Parse one leading Markdown planning command from LINES at START. */
export function parseWorkAgendaCommand(lines, start, { kind = "work", sourceName = "cell" } = {}) {
  const tail = lines.slice(start).join("\n");
  const node = scanPlanningNodes(tail)[0];
  if (!node || node.span.from !== 0 || !["todo", "clock"].includes(node.kind)) {
    throw agendaSyntaxError(`malformed WorkNode planning command: ${(lines[start] || "").trim()}`, sourceName);
  }
  if (node.diagnostics?.some((item) => ["malformed", "invalid-date", "invalid-duration"].includes(item.kind))) {
    throw agendaSyntaxError(node.diagnostics.map((item) => item.message).join("; "), sourceName);
  }
  const end = start + tail.slice(0, node.span.to).split("\n").length;
  if (node.kind === "clock") {
    const clock = { id: String(node.attrs.id || ""), from: String(node.attrs.from || "") };
    if (node.attrs.to) clock.to = String(node.attrs.to);
    const errors = validateWorkClocks([clock]);
    if (errors.length) throw agendaSyntaxError(errors.join("; "), sourceName);
    return { type: "clock", clock, title: node.title, end };
  }
  const agenda = canonicalTodoArgs(node.attrs);
  if (node.status) agenda.status = node.status;
  if (kind === "work") delete agenda.status;
  const errors = validateWorkAgenda(agenda, kind);
  if (errors.length) throw agendaSyntaxError(errors.join("; "), sourceName);
  return { type: "todo", agenda, title: node.title, end };
}

function locateWorkAgendaDirective(source, options = {}) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  let agenda = null;
  let start = -1;
  let end = -1;
  const clocks = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (/^@@(?:todo|clock)\b/.test(line)) {
      const parsed = parseWorkAgendaCommand(lines, index, options);
      if (start < 0) start = index;
      end = parsed.end;
      if (parsed.type === "todo") {
        if (agenda !== null) throw agendaSyntaxError("only one leading @@todo is allowed", options.sourceName);
        agenda = parsed.agenda;
      } else clocks.push(parsed.clock);
      index = parsed.end;
      continue;
    }
    if (/^@@[A-Za-z][A-Za-z0-9_-]*\(.*\)\s*$/.test(line)) { index += 1; continue; }
    break;
  }
  if (clocks.length && agenda === null) throw agendaSyntaxError("@@clock requires a leading @@todo in the same Cell", options.sourceName);
  if (agenda !== null && clocks.length) agenda.clocks = clocks;
  if (agenda !== null) {
    const errors = validateWorkAgenda(agenda, options.kind || "work");
    if (errors.length) throw agendaSyntaxError(errors.join("; "), options.sourceName);
  }
  return { lines, found: agenda === null ? null : { agenda, start, end } };
}

/** Return the visible Agenda object, or null when the Cell did not opt in. */
export function extractWorkAgendaDirective(source, options = {}) {
  return locateWorkAgendaDirective(source, options).found?.agenda ?? null;
}

export function formatWorkAgendaDirective(agenda, { kind = "work", title = "WorkNode", sourceName = "cell" } = {}) {
  const errors = validateWorkAgenda(agenda, kind);
  if (errors.length) throw agendaSyntaxError(errors.join("; "), sourceName);
  const attrs = {};
  for (const key of AGENDA_SCALAR_KEYS) if (key !== "status" && Object.hasOwn(agenda, key) && agenda[key] !== "") attrs[key] = agenda[key];
  const safeTitle = String(title || "WorkNode").replace(/([\\\]])/g, "\\$1");
  const status = kind === "work" ? "" : String(agenda.status || "");
  const lines = [`@@todo${status && status !== "todo" ? `(${status})` : ""} [${safeTitle}] ${serializeBlockAttrs(attrs)}`];
  for (const clock of agenda.clocks || []) {
    lines.push(`@@clock [${safeTitle}] ${serializeInlineAttrs({ id: clock.id, from: clock.from, ...(clock.to ? { to: clock.to } : {}) })}`);
  }
  return lines.join("\n");
}

/** Insert, replace, or remove the leading visible Agenda block. */
export function replaceWorkAgendaDirective(source, agenda, options = {}) {
  const normalized = String(source || "").replace(/\r\n?/g, "\n");
  const { lines, found } = locateWorkAgendaDirective(normalized, options);
  if (found) {
    const replacement = agenda === null ? [] : formatWorkAgendaDirective(agenda, options).split("\n");
    lines.splice(found.start, found.end - found.start, ...replacement);
    if (agenda === null && lines[found.start] === "" && (found.start === 0 || lines[found.start - 1] === "")) lines.splice(found.start, 1);
    return lines.join("\n");
  }
  if (agenda === null) return normalized;
  const block = formatWorkAgendaDirective(agenda, options);
  return normalized ? `${block}\n\n${normalized}` : block;
}

export function workAgendaPlanning(notebook, { file, root, mtimeMs }) {
  const meta = notebook.metadata.noema_research;
  const nodes = meta.work_nodes || [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const stateMap = { open: "todo", active: "doing", waiting: "blocked", done: "done", dropped: "cancelled" };
  const primaryCells = new Map();
  for (const node of nodes) {
    const cell = (notebook.cells || []).find((candidate) => candidate?.metadata?.noema_research?.work_node_id === node.id
      && (node.kind === "work" ? candidate.cell_type === "code" : candidate.cell_type === "markdown"));
    if (cell) primaryCells.set(node.id, cell);
  }
  const agendas = new Map(nodes.map((node) => {
    const cell = primaryCells.get(node.id);
    return [node.id, cell ? extractWorkAgendaDirective(Array.isArray(cell.source) ? cell.source.join("") : cell.source,
      { kind: node.kind, sourceName: `WorkNode ${node.id}` }) : null];
  }));
  const baseState = (node) => node.kind === "work" ? stateMap[node.state || "open"] : agendas.get(node.id)?.status || "todo";
  const dependencies = new Map();
  for (const edge of meta.dependencies || []) if (edge.type === "depends") {
    if (!dependencies.has(edge.to)) dependencies.set(edge.to, []);
    dependencies.get(edge.to).push(edge.from);
  }
  const cells = new Map();
  for (const cell of notebook.cells || []) {
    const id = cell.metadata?.noema_research?.work_node_id;
    if (!cells.has(id)) cells.set(id, []);
    cells.get(id).push(cell.id);
  }
  const todos = [];
  const clocks = [];
  const dagNodes = nodes.map((node, index) => {
    const depends = dependencies.get(node.id) || [];
    const declaredStatus = baseState(node);
    const blockedBy = depends.filter((id) => !byId.has(id) || baseState(byId.get(id)) !== "done");
    return {
      id: `${file}#${node.id}`,
      workNodeId: node.id,
      notebookId: meta.notebook_id,
      sourceKind: "work-node",
      nodeKind: node.kind,
      title: node.title || node.id,
      text: node.title || node.id,
      file,
      path: file,
      index,
      line: 1,
      cellIds: cells.get(node.id) || [],
      status: !["done", "cancelled"].includes(declaredStatus) && blockedBy.length ? "blocked" : declaredStatus,
      declaredStatus,
      state: node.state || null,
      outcome: node.outcome || null,
      hasAgenda: Boolean(agendas.get(node.id)),
    };
  });
  const dagEdges = (meta.dependencies || [])
    .filter((edge) => edge && ["depends", "lineage"].includes(edge.type) && byId.has(edge.from) && byId.has(edge.to))
    .map((edge, index) => ({
      id: edge.id || `${file}#edge-${index}`,
      from: `${file}#${edge.from}`,
      to: `${file}#${edge.to}`,
      type: edge.type,
    }));
  nodes.forEach((node, index) => {
    const agenda = agendas.get(node.id);
    if (!agenda) return;
    const depends = dependencies.get(node.id) || [];
    // A dropped experiment does not satisfy a dependency merely because it
    // has no more work. Lineage is never a scheduling prerequisite.
    const blockedBy = depends.filter((id) => !byId.has(id) || baseState(byId.get(id)) !== "done");
    const declaredStatus = baseState(node);
    const status = !["done", "cancelled"].includes(declaredStatus) && blockedBy.length ? "blocked" : declaredStatus;
    const todo = {
      id: `${file}#${node.id}`, workNodeId: node.id, notebookId: meta.notebook_id,
      sourceKind: "work-node", state: node.state || null, outcome: node.outcome || null,
      status, declaredStatus, nativeBlockedBy: blockedBy, nativeDepends: depends,
      text: node.title || node.id, noteTitle: meta.title || file, file, path: file,
      index, line: 1, source: "", updatedAt: mtimeMs,
      canon: canonicalTodoArgs(agenda), tags: [],
      cellIds: cells.get(node.id) || [],
      availableActions: ["visit", "schedule", "deadline", "priority", "effort", "state", "complete", "progress", "clock"],
    };
    todos.push(todo);
    for (const clock of agenda.clocks || []) clocks.push({
      id: `${todo.id}/clock/${clock.id}`, nativeTodoId: todo.id,
      workNodeId: node.id, clockId: clock.id, notebookId: meta.notebook_id,
      sourceKind: "work-node", file, path: file, index, line: 1,
      text: todo.text, title: todo.text, noteTitle: todo.noteTitle,
      source: JSON.stringify(clock), updatedAt: mtimeMs, canon: {},
      args: { from: clock.from, ...(clock.to ? { to: clock.to } : {}) },
    });
  });
  return { todos, projects: [], milestones: [], clocks, dag: { nodes: dagNodes, edges: dagEdges } };
}
