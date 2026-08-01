function noteKey(note) {
  return String(note?.pageKey || note?.key || note?.id || note?.file || "");
}

function relationSet(note) {
  return new Set([...(note?.refs || []), ...(note?.backlinks || [])].map(String));
}

function tagSet(note) {
  return new Set((note?.tags || []).map((tag) => String(tag).toLocaleLowerCase()));
}

function currentNote(index, context = {}) {
  const candidates = [context.pageKey, context.id, context.file, context.path].map((value) => String(value || "")).filter(Boolean);
  return (index?.notes || []).find((note) => candidates.some((value) => [noteKey(note), note.id, note.file, note.path].includes(value)));
}

export function recommendKnowledgeNotes(index, body = {}) {
  const limit = Math.max(1, Math.min(40, Number(body.limit) || 8));
  const current = currentNote(index, body.context || {});
  const currentRelations = relationSet(current);
  const currentTags = tagSet(current);
  const now = Date.now();
  const degrees = new Map();
  for (const note of index?.notes || []) {
    for (const target of note.refs || []) degrees.set(String(target), (degrees.get(String(target)) || 0) + 1);
    degrees.set(String(note.id || noteKey(note)), (degrees.get(String(note.id || noteKey(note))) || 0) + (note.refs || []).length + (note.backlinks || []).length);
  }
  const ranked = (index?.notes || []).filter((note) => note !== current).map((note) => {
    const relations = relationSet(note);
    const tags = tagSet(note);
    const sharedTags = [...tags].filter((tag) => currentTags.has(tag));
    const direct = Boolean(current && (
      currentRelations.has(String(note.id || ""))
      || relations.has(String(current.id || ""))
      || currentRelations.has(noteKey(note))
    ));
    const sameNamespace = Boolean(current && note.qualifiedNamespace && note.qualifiedNamespace === current.qualifiedNamespace);
    const ageDays = Math.max(0, (now - Number(note.mtimeMs || 0)) / 86_400_000);
    const freshness = Math.max(0, 20 * Math.exp(-ageDays / 180));
    const centrality = Math.min(80, Math.log2(2 + Number(degrees.get(String(note.id || noteKey(note))) || 0)) * 14);
    const score = (direct ? 140 : 0) + Math.min(80, sharedTags.length * 20) + (sameNamespace ? 50 : 0) + centrality + freshness;
    const reasons = [direct ? "direct link" : "", sharedTags.length ? `shared tags: ${sharedTags.slice(0, 3).join(", ")}` : "", sameNamespace ? "same namespace" : ""]
      .filter(Boolean);
    return { note, score, reasons };
  }).sort((a, b) => b.score - a.score || Number(b.note.mtimeMs || 0) - Number(a.note.mtimeMs || 0) || noteKey(a.note).localeCompare(noteKey(b.note)));

  const chosen = [];
  const repositoryCounts = new Map();
  for (const candidate of ranked) {
    const repository = String(candidate.note.repositoryId || "");
    if ((repositoryCounts.get(repository) || 0) >= 2 && chosen.length < Math.min(limit, 8)) continue;
    chosen.push(candidate);
    repositoryCounts.set(repository, (repositoryCounts.get(repository) || 0) + 1);
    if (chosen.length >= limit) break;
  }
  if (chosen.length < limit) {
    for (const candidate of ranked) {
      if (chosen.includes(candidate)) continue;
      chosen.push(candidate);
      if (chosen.length >= limit) break;
    }
  }
  return chosen.map(({ note, score, reasons }) => ({ ...note, score, reasons, resultKind: "note" }));
}

function facet(items, read) {
  const counts = new Map();
  for (const item of items) {
    for (const value of read(item)) {
      const name = String(value || "").trim();
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 20);
}

function editDistanceWithinTwo(leftValue, rightValue) {
  const left = String(leftValue || "").toLocaleLowerCase();
  const right = String(rightValue || "").toLocaleLowerCase();
  if (Math.abs(left.length - right.length) > 2) return 3;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let best = current[0];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + Number(left[row - 1] !== right[column - 1]),
      );
      best = Math.min(best, current[column]);
    }
    if (best > 2) return 3;
    previous = current;
  }
  return previous[right.length];
}

function fuzzyTitleSuggestions(index, query, limit) {
  const needle = String(query || "").toLocaleLowerCase().trim();
  if (needle.length < 3 || /[:\s"]/u.test(needle)) return [];
  return (index?.notes || []).map((note) => {
    const candidates = [note.title, ...(note.aliases || [])].map((value) => String(value || "").toLocaleLowerCase());
    const distances = candidates.flatMap((value) => [value.slice(0, needle.length), ...value.split(/\s+/u).map((word) => word.slice(0, needle.length))])
      .map((value) => editDistanceWithinTwo(needle, value));
    return { note, distance: Math.min(...distances, 3) };
  }).filter((item) => item.distance <= 2)
    .sort((a, b) => a.distance - b.distance || String(a.note.title || "").localeCompare(String(b.note.title || "")))
    .slice(0, limit)
    .map(({ note, distance }) => ({ ...note, score: 100 - distance * 20, reasons: ["spelling suggestion"], resultKind: "note" }));
}

export function knowledgeSearchResponse(index, body, lexicalResult) {
  const query = String(body?.query || body?.q || "").normalize("NFKC").trim();
  const mode = ["suggest", "related"].includes(String(body?.mode || "")) ? String(body.mode) : "results";
  const recommendation = mode === "related" || (!query && mode === "suggest");
  let items = recommendation
    ? recommendKnowledgeNotes(index, body)
    : (lexicalResult?.items || []).map((item) => ({ ...item, score: Math.max(0, -Number(item.rank || 0)), reasons: [], resultKind: "note" }));
  if (!recommendation && mode === "suggest" && items.length === 0) {
    items = fuzzyTitleSuggestions(index, query, Math.max(1, Math.min(12, Number(body?.limit) || 8)));
  }
  return {
    ok: true,
    type: "knowledge-search",
    generation: String(index?.generation || lexicalResult?.generation || ""),
    query,
    mode,
    items,
    total: recommendation ? items.length : Number(lexicalResult?.total || items.length),
    nextCursor: recommendation ? null : lexicalResult?.nextCursor ?? null,
    facets: {
      tags: facet(items, (item) => item.tags || []),
      namespaces: facet(items, (item) => [item.qualifiedNamespace || item.namespace]),
      repositories: facet(items, (item) => [item.repositoryId]),
    },
  };
}
