const DEFAULT_COLUMNS = ["text", "status", "project", "file"];
const PLANNING_KINDS = new Set(["todo", "project", "milestone", "clock"]);
const BLOCK_KINDS = new Set(["prose", "org-env"]);
const SOURCE_KINDS = new Set(["planning", "todo", "project", "milestone", "clock", "block", "prose", "org-env"]);
const VIEW_KINDS = new Set(["table", "gallery", "kanban"]);
const KEY_PATTERN = /^[a-z][a-z0-9_-]*$/i;
export const ATTRIBUTE_VIEW_FIELD_TYPES = [
  "block", "text", "number", "date", "select", "mselect", "url", "email", "phone",
  "masset", "template", "created", "updated", "checkbox", "relation", "rollup", "linenumber",
];
export const ATTRIBUTE_VIEW_FILTER_OPERATORS = [
  "not-contains-any", "contains-any", "not-contains", "starts-with", "ends-with",
  "not-empty", "between", "contains", "empty", "false", "true",
  ">=", "<=", "!=", ">", "<", "=",
];
export const ATTRIBUTE_VIEW_CALC_OPERATORS = [
  "unique-values", "count-all", "count-values", "count-unique-values", "count-empty", "count-not-empty",
  "percent-empty", "percent-not-empty", "percent-unique-values", "sum", "average", "median", "min", "max",
  "range", "earliest", "latest", "checked", "unchecked", "percent-checked", "percent-unchecked", "template",
];
const FIELD_TYPES = new Set(ATTRIBUTE_VIEW_FIELD_TYPES);
const FILTER_OPERATORS = [...ATTRIBUTE_VIEW_FILTER_OPERATORS.slice(0, 11), "not-in", "in", ...ATTRIBUTE_VIEW_FILTER_OPERATORS.slice(11)];
const CALC_OPERATORS = new Set(ATTRIBUTE_VIEW_CALC_OPERATORS);

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

function normalizeFieldType(raw) {
  return String(raw || "").replace(/[-_\s]+/g, "").toLowerCase();
}

function parseFilterClause(raw) {
  const operators = FILTER_OPERATORS.map((operator) => operator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = String(raw || "").trim().match(new RegExp(`^([a-z][a-z0-9_-]*)\\s+(${operators})(?:\\s+(.*))?$`, "i"));
  if (!match) return null;
  const op = match[2].toLowerCase();
  const value = String(match[3] || "").trim();
  if (!["empty", "not-empty", "true", "false"].includes(op) && !value) return null;
  return { key: match[1].toLowerCase(), op, value };
}

export function parseAttributeViewSpec(raw = "", title = "") {
  const spec = {
    title: cleanTitle(title),
    source: "todo",
    columns: [...DEFAULT_COLUMNS],
    filters: [],
    sorts: [],
    types: {},
    calculations: [],
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
      const filter = parseFilterClause(value);
      if (!filter) {
        diagnostics.push(diagnostic(line, "invalid-filter", `Invalid filter "${value}"`));
      } else if (spec.filters.length < 20) {
        spec.filters.push(filter);
      }
      continue;
    }
    if (key === "filter-any" || key === "filter-all") {
      const children = value.split(";").map(parseFilterClause);
      if (!children.length || children.some((filter) => !filter)) {
        diagnostics.push(diagnostic(line, "invalid-filter-group", `Invalid ${key} group "${value}"`));
      } else if (spec.filters.length < 20) {
        spec.filters.push({ combination: key === "filter-any" ? "or" : "and", filters: children });
      }
      continue;
    }
    if (key === "type") {
      const match = value.match(/^([a-z][a-z0-9_-]*)\s+([a-z][a-z0-9_-]*)$/i);
      const type = normalizeFieldType(match?.[2]);
      if (!match || !FIELD_TYPES.has(type)) {
        diagnostics.push(diagnostic(line, "invalid-type", `Invalid field type "${value}"`));
      } else {
        spec.types[match[1].toLowerCase()] = type;
      }
      continue;
    }
    if (key === "calc") {
      const match = value.match(/^([a-z][a-z0-9_-]*)\s+([a-z][a-z0-9_-]*)(?:\s+(.*))?$/i);
      const operator = String(match?.[2] || "").toLowerCase();
      if (!match || !CALC_OPERATORS.has(operator)) {
        diagnostics.push(diagnostic(line, "invalid-calc", `Invalid calculation "${value}"`));
      } else if (spec.calculations.length < 20) {
        spec.calculations.push({ key: match[1].toLowerCase(), operator, template: String(match[3] || "").trim() });
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

function collectionValues(value) {
  return String(value || "").split(/[|,]/).map((part) => part.trim()).filter(Boolean);
}

function checkboxValue(value) {
  return /^(?:1|true|yes|on|checked|done)$/i.test(String(value || "").trim());
}

function dateValue(value, nowMs) {
  const raw = String(value || "").trim().toLowerCase();
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  if (raw === "today") return today.getTime();
  if (raw === "yesterday") return today.getTime() - 86_400_000;
  if (raw === "tomorrow") return today.getTime() + 86_400_000;
  const relative = raw.match(/^([+-]?\d+)\s*([dwmy])$/i);
  if (relative) {
    const count = Number(relative[1]);
    const date = new Date(today);
    if (relative[2] === "d") date.setDate(date.getDate() + count);
    else if (relative[2] === "w") date.setDate(date.getDate() + count * 7);
    else if (relative[2] === "m") date.setMonth(date.getMonth() + count);
    else date.setFullYear(date.getFullYear() + count);
    return date.getTime();
  }
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[ t])/);
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])).getTime();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function semanticValue(value, type, nowMs) {
  if (["mselect", "masset", "relation", "rollup"].includes(type)) {
    return collectionValues(value).map((part) => part.toLocaleLowerCase());
  }
  if (["number", "linenumber"].includes(type)) {
    const number = Number(String(value || "").replaceAll(",", ""));
    return Number.isFinite(number) ? number : Number.NaN;
  }
  if (["date", "created", "updated"].includes(type)) return dateValue(value, nowMs);
  if (type === "checkbox") return checkboxValue(value);
  return String(value || "").toLocaleLowerCase();
}

function semanticCompare(left, right) {
  if (typeof left === "number" && Number.isNaN(left)) return 1;
  if (typeof right === "number" && Number.isNaN(right)) return -1;
  if (left === right) return 0;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return String(left).localeCompare(String(right), "en", { numeric: true, sensitivity: "base" });
}

function matchesFilter(item, filter, types, nowMs) {
  if (filter?.filters) {
    const results = filter.filters.map((child) => matchesFilter(item, child, types, nowMs));
    return filter.combination === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  const actualRaw = itemValue(item, filter.key);
  const expectedRaw = String(filter.value || "");
  const type = types[filter.key] || "text";
  const empty = actualRaw === "" || (["mselect", "masset", "relation", "rollup"].includes(type) && collectionValues(actualRaw).length === 0);
  if (filter.op === "empty") return empty;
  if (filter.op === "not-empty") return !empty;
  if (filter.op === "true") return checkboxValue(actualRaw);
  if (filter.op === "false") return !checkboxValue(actualRaw);
  const actual = semanticValue(actualRaw, type, nowMs);
  const expected = semanticValue(expectedRaw, type, nowMs);
  if (filter.op === "=") {
    if (Array.isArray(actual) && Array.isArray(expected)) {
      const left = [...new Set(actual)].sort();
      const right = [...new Set(expected)].sort();
      return left.length === right.length && left.every((value, index) => value === right[index]);
    }
    return semanticCompare(actual, expected) === 0;
  }
  if (filter.op === "!=") return !matchesFilter(item, { ...filter, op: "=" }, types, nowMs);
  if ([">", ">=", "<", "<="].includes(filter.op)) {
    const compared = semanticCompare(actual, expected);
    return filter.op === ">" ? compared > 0 : filter.op === ">=" ? compared >= 0 : filter.op === "<" ? compared < 0 : compared <= 0;
  }
  const actualItems = Array.isArray(actual) ? actual : [String(actual)];
  const expectedItems = collectionValues(expectedRaw).map((value) => String(semanticValue(value, type === "mselect" ? "text" : type, nowMs)));
  if (filter.op === "contains") return Array.isArray(actual)
    ? expectedItems.every((value) => actual.includes(value))
    : String(actual).includes(String(expected));
  if (filter.op === "not-contains") return !matchesFilter(item, { ...filter, op: "contains" }, types, nowMs);
  if (filter.op === "contains-any" || filter.op === "in") return expectedItems.some((value) => actualItems.includes(value));
  if (filter.op === "not-contains-any" || filter.op === "not-in") return !expectedItems.some((value) => actualItems.includes(value));
  if (filter.op === "starts-with") return String(actual).startsWith(String(expected));
  if (filter.op === "ends-with") return String(actual).endsWith(String(expected));
  if (filter.op === "between") {
    const [lowerRaw, upperRaw] = expectedRaw.split("..", 2).map((value) => value.trim());
    if (!lowerRaw || !upperRaw) return false;
    const lower = semanticValue(lowerRaw, type, nowMs);
    const upper = semanticValue(upperRaw, type, nowMs);
    return semanticCompare(actual, lower) >= 0 && semanticCompare(actual, upper) <= 0;
  }
  return false;
}

function compareValues(a, b, type = "text", nowMs = Date.now()) {
  if (type !== "text") return semanticCompare(semanticValue(a, type, nowMs), semanticValue(b, type, nowMs));
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

function calculationResult(items, calculation, types, nowMs) {
  const raw = items.map((item) => itemValue(item, calculation.key));
  const values = raw.filter((value) => value !== "");
  const unique = [...new Map(values.map((value) => [value.toLocaleLowerCase(), value])).values()];
  const numbers = values.map((value) => Number(String(value).replaceAll(",", ""))).filter(Number.isFinite);
  const dates = values
    .map((value) => ({ value, time: dateValue(value, nowMs) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);
  const checked = raw.filter(checkboxValue).length;
  const percent = (count) => raw.length ? count / raw.length : 0;
  const median = () => {
    if (!numbers.length) return null;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  let value;
  switch (calculation.operator) {
    case "unique-values": value = unique; break;
    case "count-all": value = raw.length; break;
    case "count-values": value = values.length; break;
    case "count-unique-values": value = unique.length; break;
    case "count-empty": value = raw.length - values.length; break;
    case "count-not-empty": value = values.length; break;
    case "percent-empty": value = percent(raw.length - values.length); break;
    case "percent-not-empty": value = percent(values.length); break;
    case "percent-unique-values": value = percent(unique.length); break;
    case "sum": value = numbers.reduce((sum, number) => sum + number, 0); break;
    case "average": value = numbers.length ? numbers.reduce((sum, number) => sum + number, 0) / numbers.length : null; break;
    case "median": value = median(); break;
    case "min": value = numbers.length ? Math.min(...numbers) : null; break;
    case "max": value = numbers.length ? Math.max(...numbers) : null; break;
    case "range": value = numbers.length ? Math.max(...numbers) - Math.min(...numbers) : null; break;
    case "earliest": value = dates[0]?.value ?? null; break;
    case "latest": value = dates.at(-1)?.value ?? null; break;
    case "checked": value = checked; break;
    case "unchecked": value = raw.length - checked; break;
    case "percent-checked": value = percent(checked); break;
    case "percent-unchecked": value = percent(raw.length - checked); break;
    case "template": {
      const sum = numbers.reduce((total, number) => total + number, 0);
      const variables = {
        values: unique.join(", "),
        strings: values.join(", "),
        raw: raw.join(", "),
        count: raw.length,
        sum,
        avg: numbers.length ? sum / numbers.length : 0,
        min: numbers.length ? Math.min(...numbers) : 0,
        max: numbers.length ? Math.max(...numbers) : 0,
        median: median() ?? 0,
        nonEmptyCount: values.length,
      };
      value = String(calculation.template || "{{count}}")
        .replace(/\{\{\s*(values|strings|raw|count|sum|avg|min|max|median|nonEmptyCount)\s*\}\}/g, (_all, key) => String(variables[key]));
      break;
    }
    default: value = null;
  }
  return {
    key: calculation.key,
    operator: calculation.operator,
    type: types[calculation.key] || "text",
    value,
  };
}

export function evaluateAttributeView({ title = "", source = "", items = [], nowMs = Date.now() } = {}) {
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
    .filter(({ item }) => spec.filters.every((filter) => matchesFilter(item, filter, spec.types, nowMs)));
  matching.sort((left, right) => {
    for (const sort of spec.sorts) {
      const compared = compareValues(itemValue(left.item, sort.key), itemValue(right.item, sort.key), spec.types[sort.key] || "text", nowMs);
      if (compared) return sort.direction === "desc" ? -compared : compared;
    }
    return left.ordinal - right.ordinal;
  });
  const columns = spec.columns.map((key) => ({
    key,
    label: labelForKey(key),
    ...(spec.types[key] ? { type: spec.types[key] } : {}),
  }));
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
  if (spec.calculations.length) {
    result.calculations = spec.calculations.map((calculation) => calculationResult(
      matching.map(({ item }) => item),
      calculation,
      spec.types,
      nowMs,
    ));
  }
  return result;
}
