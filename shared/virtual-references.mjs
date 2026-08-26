const WORD_RE = /[\p{L}\p{N}_]/u;

function normalize(value, caseSensitive) {
  const text = String(value || "").normalize("NFC");
  return caseSensitive ? text : text.toLocaleLowerCase();
}

function cleanSearchText(markdown) {
  return String(markdown || "")
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!?(?:\[\[[^\]\n]+\]\]|\[[^\]\n]*\]\([^\n)]*\))/g, " ")
    .replace(/^---\s*$[\s\S]*?^---\s*$/m, " ");
}

function snippetAt(text, from, to, radius = 72) {
  const start = Math.max(0, from - radius);
  const end = Math.min(text.length, to + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

export class AhoCorasickMatcher {
  constructor(patterns = []) {
    this.nodes = [{ next: new Map(), fail: 0, outputs: [] }];
    for (const pattern of patterns) this.add(pattern);
    this.buildFailures();
  }

  add(pattern) {
    const value = String(pattern || "");
    if (!value) return;
    let nodeIndex = 0;
    for (const character of value) {
      const node = this.nodes[nodeIndex];
      let next = node.next.get(character);
      if (next === undefined) {
        next = this.nodes.length;
        node.next.set(character, next);
        this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
      }
      nodeIndex = next;
    }
    this.nodes[nodeIndex].outputs.push(value);
  }

  buildFailures() {
    const queue = [];
    for (const next of this.nodes[0].next.values()) queue.push(next);
    for (let offset = 0; offset < queue.length; offset++) {
      const current = queue[offset];
      for (const [character, next] of this.nodes[current].next) {
        queue.push(next);
        let failure = this.nodes[current].fail;
        while (failure && !this.nodes[failure].next.has(character)) failure = this.nodes[failure].fail;
        this.nodes[next].fail = this.nodes[failure].next.get(character) ?? 0;
        this.nodes[next].outputs.push(...this.nodes[this.nodes[next].fail].outputs);
      }
    }
  }

  search(text) {
    const matches = [];
    let nodeIndex = 0;
    let offset = 0;
    for (const character of String(text || "")) {
      while (nodeIndex && !this.nodes[nodeIndex].next.has(character)) nodeIndex = this.nodes[nodeIndex].fail;
      nodeIndex = this.nodes[nodeIndex].next.get(character) ?? 0;
      offset += character.length;
      for (const pattern of this.nodes[nodeIndex].outputs) {
        matches.push({ pattern, from: offset - pattern.length, to: offset });
      }
    }
    return matches;
  }
}

export class VirtualReferenceTTLCache {
  constructor({ ttlMs = 10 * 60_000, maxEntries = 16, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(String(key));
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(String(key));
      return undefined;
    }
    this.entries.delete(String(key));
    this.entries.set(String(key), entry);
    return entry.value;
  }

  set(key, value) {
    const identity = String(key);
    this.entries.delete(identity);
    this.entries.set(identity, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return value;
  }

  clear() { this.entries.clear(); }
}

function keywordIndex(documents, caseSensitive) {
  const owners = new Map();
  const labels = new Map();
  for (const document of documents) {
    for (const candidate of [document.title, ...(document.aliases || [])]) {
      const label = String(candidate || "").trim();
      const key = normalize(label, caseSensitive);
      if (key.length < 2 || key === "*") continue;
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(String(document.id || ""));
      if (!labels.has(key)) labels.set(key, label);
    }
  }
  const unambiguous = new Map();
  for (const [key, ids] of owners) {
    if (ids.size === 1) unambiguous.set(key, { targetId: [...ids][0], label: labels.get(key) || key });
  }
  return unambiguous;
}

function validBoundary(text, match) {
  const first = match.pattern[0] || "";
  const last = match.pattern.at(-1) || "";
  const before = match.from > 0 ? text[match.from - 1] : "";
  const after = match.to < text.length ? text[match.to] : "";
  if (WORD_RE.test(first) && before && WORD_RE.test(before)) return false;
  if (WORD_RE.test(last) && after && WORD_RE.test(after)) return false;
  return true;
}

export function scanVirtualReferences(documents = [], options = {}) {
  const caseSensitive = options.caseSensitive === true;
  const bounded = (Array.isArray(documents) ? documents : []).slice(0, options.maxDocuments || 5_000);
  const keywords = keywordIndex(bounded, caseSensitive);
  const matcher = new AhoCorasickMatcher([...keywords.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b)));
  const byTarget = new Map();
  for (const source of bounded) {
    const sourceId = String(source.id || "");
    if (!sourceId) continue;
    const rawText = cleanSearchText(source.text).slice(0, options.maxDocumentChars || 8 * 1024 * 1024);
    const searchText = normalize(rawText, caseSensitive);
    const linked = new Set((source.refs || []).map(String));
    const seenRanges = [];
    const grouped = new Map();
    for (const match of matcher.search(searchText)) {
      const keyword = keywords.get(match.pattern);
      if (!keyword || keyword.targetId === sourceId || linked.has(keyword.targetId) || !validBoundary(searchText, match)) continue;
      if (seenRanges.some((range) => match.from >= range.from && match.to <= range.to)) continue;
      seenRanges.push(match);
      const hit = grouped.get(keyword.targetId) || { count: 0, keywords: new Set(), first: match };
      hit.count++;
      hit.keywords.add(keyword.label);
      grouped.set(keyword.targetId, hit);
    }
    for (const [targetId, hit] of grouped) {
      if (!byTarget.has(targetId)) byTarget.set(targetId, []);
      byTarget.get(targetId).push({
        sourceId,
        sourceTitle: String(source.title || source.file || "Untitled"),
        file: String(source.file || ""),
        count: hit.count,
        keywords: [...hit.keywords],
        snippet: snippetAt(rawText, hit.first.from, hit.first.to),
      });
    }
  }
  return [...keywords.values()].map(({ targetId, label }) => ({
    targetId,
    targetTitle: label,
    mentions: (byTarget.get(targetId) || []).sort((a, b) => b.count - a.count || a.sourceTitle.localeCompare(b.sourceTitle)),
  }));
}
