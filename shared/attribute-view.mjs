const DEFAULT_COLUMNS = ["text", "status", "project", "file"];
const PLANNING_KINDS = new Set(["todo", "project", "milestone", "clock"]);
const BLOCK_KINDS = new Set(["prose", "org-env"]);
const SOURCE_KINDS = new Set(["planning", "todo", "project", "milestone", "clock", "block", "prose", "org-env"]);
const VIEW_KINDS = new Set(["table", "gallery", "kanban"]);
const KEY_PATTERN = /^[a-z][a-z0-9_-]*$/i;

function diagnostic(line, kind, message) {
  return { line, kind, message };
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/\s*\{#[0-9a-f-]{36}(?:\s+[^{}\r\n]*)?\}\s*$/i, "")
    .trim() || "Attribute view";
}

function splitList(raw) {
  return String(raw || "").split(",").map((value) => value.trim()).filter(Boolean);
}

export function parseAttributeViewSpec(raw = "", title = "") {
  const spec = {
    title: cleanTitle(title),
    source: "todo",
    columns: [...DEFAULT_COLUMNS],
    filters: [],
    sorts: [],
    limit: 50,
    view: "table",
    group: "",
  };
  const diagnostics = [];
  for (const [index, sourceLine] of String(raw || "").split(/\r?\n/).entries()) {
    const line = index + 1;
    const text = sourceLine.trim();
    if (!text || text.startsWith("#")) continue;
    const separator = text.indexOf(":");
    if (separator < 1) {
      diagnostics.push(diagnostic(line, "invalid-directive", `Expected "key: value", got "${text}"`));
      continue;
    }
    const key = text.slice(0, separator).trim().toLowerCase();
    const value = text.slice(separator + 1).trim();
    if (key === "source") {
      const source = value.toLowerCase();
      if (SOURCE_KINDS.has(source)) spec.source = source;
      else diagnostics.push(diagnostic(line, "invalid-source", `Unknown attribute-view source "${value}"`));
      continue;
    }
    if (key === "columns") {
      const columns = splitList(value);
      const invalid = columns.find((column) => !KEY_PATTERN.test(column));
      if (columns.length === 0 || invalid) {
        diagnostics.push(diagnostic(line, "invalid-columns", "Columns must be comma-separated attribute names"));
      } else {
        spec.columns = [...new Set(columns.map((column) => column.toLowerCase()))].slice(0, 20);
      }
      continue;
    }
    if (key === "filter") {
      const match = value.match(/^([a-z][a-z0-9_-]*)\s+(not-empty|contains|empty|in|!=|=)(?:\s+(.*))?$/i);
      if (!match || (!/^(?:empty|not-empty)$/i.test(match?.[2] || "") && !String(match?.[3] || "").trim())) {
        diagnostics.push(diagnostic(line, "invalid-filter", `Invalid filter "${value}"`));
      } else if (spec.filters.length < 20) {
        spec.filters.push({ key: match[1].toLowerCase(), op: match[2].toLowerCase(), value: String(match[3] || "").trim() });
      }
      continue;
    }
    if (key === "sort") {
      const sorts = splitList(value);
      let valid = true;
      for (const sort of sorts) {
        const match = sort.match(/^([a-z][a-z0-9_-]*)(?:\s+(asc|desc))?$/i);
        if (!match) {
          valid = false;
          break;
        }
        if (spec.sorts.length < 10) spec.sorts.push({ key: match[1].toLowerCase(), direction: (match[2] || "asc").toLowerCase() });
      }
      if (!valid || sorts.length === 0) diagnostics.push(diagnostic(line, "invalid-sort", `Invalid sort "${value}"`));
      continue;
    }
    if (key === "limit") {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1) diagnostics.push(diagnostic(line, "invalid-limit", "Limit must be a positive integer"));
      else spec.limit = Math.min(200, limit);
      continue;
    }
    if (key === "view") {
      const view = value.toLowerCase();
      if (VIEW_KINDS.has(view)) spec.view = view;
      else diagnostics.push(diagnostic(line, "invalid-view", `Unknown attribute-view view "${value}"`));
      continue;
    }
    if (key === "group") {
      if (KEY_PATTERN.test(value)) spec.group = value.toLowerCase();
      else diagnostics.push(diagnostic(line, "invalid-group", "Group must be an attribute name"));
      continue;
    }
    diagnostics.push(diagnostic(line, "unknown-directive", `Unknown attribute-view directive "${key}"`));
  }
  return { spec, diagnostics };
}

function itemValue(item, key) {
  if (key === "kind" || key === "type") return String(item?.kind || "");
  if (key === "note" || key === "notetitle" || key === "note-title") return String(item?.noteTitle || "");
  if (key === "title") return String(item?.title || item?.text || "");
  if (["id", "status", "text", "file"].includes(key)) return String(item?.[key] || "");
  if (key === "line") return String(Number(item?.line || 0) || "");
  const canon = item?.canon && typeof item.canon === "object" ? item.canon : {};
  const args = item?.args && typeof item.args === "object" ? item.args : {};
  return String(canon[key] ?? args[key] ?? "");
}

function matchesFilter(item, filter) {
  const actual = itemValue(item, filter.key);
  const expected = String(filter.value || "");
  if (filter.op === "empty") return actual === "";
  if (filter.op === "not-empty") return actual !== "";
  if (filter.op === "=") return actual.toLowerCase() === expected.toLowerCase();
  if (filter.op === "!=") return actual.toLowerCase() !== expected.toLowerCase();
  if (filter.op === "contains") return actual.toLowerCase().includes(expected.toLowerCase());
  if (filter.op === "in") {
    const allowed = expected.split("|").map((value) => value.trim().toLowerCase()).filter(Boolean);
    return allowed.includes(actual.toLowerCase());
  }
  return true;
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const numberA = Number(a);
  const numberB = Number(b);
  if (Number.isFinite(numberA) && Number.isFinite(numberB)) return numberA - numberB;
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

function labelForKey(key) {
  const labels = { text: "Task", status: "Status", project: "Project", prio: "Priority", ddl: "Deadline", sche: "Scheduled", file: "File", kind: "Type", line: "Line", note: "Note", notetitle: "Note" };
  return labels[key] || key.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function evaluateAttributeView({ title = "", source = "", items = [] } = {}) {
  const { spec, diagnostics } = parseAttributeViewSpec(source, title);
  const groupBy = spec.view === "kanban" ? (spec.group || "status") : "";
  const matching = (Array.isArray(items) ? items : [])
    .map((item, ordinal) => ({ item, ordinal }))
    .filter(({ item }) => {
      const kind = String(item?.kind || "");
      if (spec.source === "planning") return PLANNING_KINDS.has(kind);
      if (spec.source === "block") return BLOCK_KINDS.has(kind);
      return kind === spec.source;
    })
    .filter(({ item }) => spec.filters.every((filter) => matchesFilter(item, filter)));
  matching.sort((left, right) => {
    for (const sort of spec.sorts) {
      const compared = compareValues(itemValue(left.item, sort.key), itemValue(right.item, sort.key));
      if (compared) return sort.direction === "desc" ? -compared : compared;
    }
    return left.ordinal - right.ordinal;
  });
  const columns = spec.columns.map((key) => ({ key, label: labelForKey(key) }));
  const rows = matching.slice(0, spec.limit).map(({ item }) => {
    const row = {
      id: String(item?.id || ""),
      kind: String(item?.kind || ""),
      file: String(item?.file || ""),
      index: Number(item?.index || 0),
      line: Number(item?.line || 0),
      cells: columns.map(({ key }) => ({ key, value: itemValue(item, key) })),
    };
    if (groupBy) row.group = itemValue(item, groupBy);
    return row;
  });
  const result = {
    title: spec.title,
    source: spec.source,
    columns,
    rows,
    total: matching.length,
    truncated: matching.length > rows.length,
    diagnostics,
  };
  if (spec.view !== "table") result.view = spec.view;
  if (groupBy) result.groupBy = groupBy;
  return result;
}
