const FIELD_ALIASES = new Map([
  ["intitle", "title"],
  ["category", "tag"],
  ["repository", "repo"],
]);

const KNOWN_FIELDS = new Set(["title", "tag", "repo", "namespace", "path", "kind", "is", "linksto"]);

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
