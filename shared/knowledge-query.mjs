const FIELD_ALIASES = new Map([
  ["intitle", "title"],
  ["category", "tag"],
  ["repository", "repo"],
  ["since", "after"],
  ["until", "before"],
]);

const KNOWN_FIELDS = new Set(["title", "tag", "repo", "namespace", "path", "kind", "is", "linksto", "after", "before", "created"]);
const DATE_FIELDS = new Set(["after", "before", "created"]);

// `after:` and `before:` compare a page's modification time against a calendar
// date (`2026`, `2026-10`, `2026-10-09`) or an age (`7d`, `2w`, `3m`, `1y`).
// The bound is the local start of that day, so `after:2026-10-09` includes the
// 9th and `before:2026-10-09` ends with the 8th.  Returns epoch milliseconds,
// or null when VALUE is neither form.
export function knowledgeDateBound(value, now = Date.now()) {
  const text = String(value || "").trim().toLowerCase();
  const age = text.match(/^(\d{1,4})([dwmy])$/);
  if (age) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const count = Number(age[1]);
    // Calendar arithmetic, not milliseconds: a day is 23 or 25 hours across a
    // daylight-saving change.
    if (age[2] === "d") start.setDate(start.getDate() - count);
    else if (age[2] === "w") start.setDate(start.getDate() - count * 7);
    else if (age[2] === "m") start.setMonth(start.getMonth() - count);
    else start.setFullYear(start.getFullYear() - count);
    return start.getTime();
  }
  const date = text.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/);
  if (!date) return null;
  const month = Number(date[2] || 1);
  const day = Number(date[3] || 1);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const bound = new Date(Number(date[1]), month - 1, day);
  return bound.getMonth() === month - 1 ? bound.getTime() : null;
}

// `created:` names the period a page was created in, from the `date` its
// metadata carries: `created:2026` is that year, `created:2026-10` that month,
// `created:2026-10-09` that day, and an age (`created:7d`) is "since then".
// Returns `{ from, to }` in epoch milliseconds, `to` exclusive and Infinity
// for an age, or null when VALUE is neither form.
export function knowledgeDatePeriod(value, now = Date.now()) {
  const text = String(value || "").trim().toLowerCase();
  const from = knowledgeDateBound(text, now);
  if (from === null) return null;
  const date = text.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/);
  if (!date) return { from, to: Infinity };
  const end = new Date(from);
  if (date[3]) end.setDate(end.getDate() + 1);
  else if (date[2]) end.setMonth(end.getMonth() + 1);
  else end.setFullYear(end.getFullYear() + 1);
  return { from, to: end.getTime() };
}

/** The local start of the day a page's `date` metadata names, or 0. */
export function knowledgeCreatedTime(value) {
  const day = String(value || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/);
  if (!day) return 0;
  return knowledgeDateBound(`${day[1]}-${day[2]}-${day[3]}`) ?? 0;
}

function dateMatch(entity, clause) {
  if (clause.field === "created") {
    const period = knowledgeDatePeriod(clause.value);
    const created = Number(entity?.createdMs);
    return Boolean(period) && Number.isFinite(created) && created > 0
      && created >= period.from && created < period.to;
  }
  const bound = knowledgeDateBound(clause.value);
  const modified = Number(entity?.mtimeMs);
  if (bound === null || !Number.isFinite(modified) || modified <= 0) return false;
  return clause.field === "after" ? modified >= bound : modified < bound;
}

function queryTokens(value) {
  const input = String(value || "").normalize("NFKC").trim().slice(0, 512);
  const tokens = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (/\s/u.test(char) && !quoted) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens.slice(0, 16);
}

export function parseKnowledgeQuery(value) {
  const source = String(value || "").normalize("NFKC").trim().slice(0, 512);
  const clauses = queryTokens(source).map((rawValue) => {
    const negative = rawValue.startsWith("-") && rawValue.length > 1;
    const raw = negative ? rawValue.slice(1) : rawValue;
    const separator = raw.indexOf(":");
    const candidate = separator > 0 ? raw.slice(0, separator).toLocaleLowerCase() : "";
    const canonical = FIELD_ALIASES.get(candidate) || candidate;
    const recognized = KNOWN_FIELDS.has(canonical);
    return {
      raw: rawValue,
      negative,
      field: recognized ? canonical : "",
      value: recognized ? raw.slice(separator + 1).toLocaleLowerCase() : raw.toLocaleLowerCase(),
    };
  }).filter((clause) => clause.value || clause.field === "is");
  return { source, clauses };
}

function strings(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "")) : [String(value || "")];
}

function entityKind(entity) {
  return String(entity?.kind || entity?.type || "note").toLocaleLowerCase();
}

function fieldValues(entity, field) {
  const title = entity?.title || entity?.name || entity?.id || entity?.key || "";
  const kind = entityKind(entity);
  if (field === "title") return strings([title, ...(entity?.aliases || [])]);
  if (field === "tag") return kind === "tag"
    ? strings([title, entity?.id, entity?.key])
    : strings(entity?.tags || []);
  if (field === "repo") return strings([entity?.repositoryId, entity?.repository, entity?.groupKey]);
  if (field === "namespace") return strings([entity?.namespace, entity?.qualifiedNamespace]);
  if (field === "path") return strings([entity?.path, entity?.repositoryPath, entity?.file, entity?.link]);
  if (field === "kind") return [kind];
  if (field === "linksto") return strings([...(entity?.refs || []), ...(entity?.backlinks || [])]);
  return strings([
    title,
    entity?.id,
    entity?.key,
    entity?.path,
    entity?.repositoryPath,
    entity?.file,
    entity?.repositoryId,
    entity?.namespace,
    entity?.qualifiedNamespace,
    entity?.summary,
    entity?.searchText,
    ...(entity?.aliases || []),
    ...(entity?.tags || []),
  ]);
}

function specialMatch(entity, value, degree) {
  const kind = entityKind(entity);
  if (value === "orphan") return Number(degree || 0) === 0;
  if (value === "missing") return kind === "missing" || entity?.exists === false || (entity?.unresolvedLinks || []).length > 0;
  if (value === "attachment") return kind === "attachment" || kind === "dependency";
  return false;
}

export function knowledgeEntityMatches(entity, query, options = {}) {
  const parsed = typeof query === "string" ? parseKnowledgeQuery(query) : query;
  if (!parsed?.clauses?.length) return true;
  return parsed.clauses.every((clause) => {
    const matched = clause.field === "is"
      ? specialMatch(entity, clause.value, options.degree)
      : DATE_FIELDS.has(clause.field) ? dateMatch(entity, clause)
      : fieldValues(entity, clause.field).some((value) => value.toLocaleLowerCase().includes(clause.value));
    return clause.negative ? !matched : matched;
  });
}

export function knowledgeQueryTextTerms(query) {
  const parsed = typeof query === "string" ? parseKnowledgeQuery(query) : query;
  return (parsed?.clauses || [])
    .filter((clause) => !clause.negative && !clause.field)
    .map((clause) => clause.value)
    .filter(Boolean);
}
