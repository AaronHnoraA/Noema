import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

import { scanVirtualReferences, VirtualReferenceTTLCache } from "../../shared/virtual-references.mjs";

const TTL_MS = 10 * 60_000;
const MAX_DOCUMENTS = 5_000;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const cache = new VirtualReferenceTTLCache({ ttlMs: TTL_MS, maxEntries: 16 });

async function mapLimit(items, limit, mapper) {
  const values = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      values[index] = await mapper(items[index], index);
    }
  }));
  return values;
}

function noteIdentity(note) {
  return String(note?.id || note?.key || note?.file || "").trim();
}

function cacheIdentity(index, targetId, caseSensitive) {
  const generation = String(index?.generation || index?.indexVersion || "");
  if (generation) return `${generation}\0${targetId}\0${caseSensitive}`;
  const hash = createHash("sha1");
  for (const note of (index?.notes || []).slice(0, MAX_DOCUMENTS)) {
    hash.update(`${noteIdentity(note)}\0${note?.mtimeMs || 0}\0${note?.size || 0}\n`);
  }
  return `${hash.digest("hex")}\0${targetId}\0${caseSensitive}`;
}

export async function virtualReferencesPayload(index, body = {}) {
  const notes = (Array.isArray(index?.notes) ? index.notes : []).slice(0, MAX_DOCUMENTS);
  const requested = String(body.targetId || body.id || body.file || body.title || "").trim();
  const target = notes.find((note) => [noteIdentity(note), note.file, note.path, note.title]
    .some((value) => String(value || "") === requested));
  if (!target) return { type: "virtual-references", evaluationSource: "noema-aho-corasick", target: null, mentions: [], ttlMs: TTL_MS };
  const targetId = noteIdentity(target);
  const caseSensitive = body.caseSensitive === true;
  const key = cacheIdentity(index, targetId, caseSensitive);
  const cached = cache.get(key);
  if (cached) return structuredClone(cached);

  let totalBytes = 0;
  const documents = (await mapLimit(notes, 8, async (note) => {
    const file = String(note?.file || "");
    if (!file) return null;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES || totalBytes + info.size > MAX_TOTAL_BYTES) return null;
      totalBytes += info.size;
      return {
        id: noteIdentity(note),
        title: String(note.title || note.path || file),
        aliases: Array.isArray(note.aliases) ? note.aliases : [],
        refs: Array.isArray(note.refs) ? note.refs : [],
        file,
        text: await readFile(file, "utf8"),
      };
    } catch {
      return null;
    }
  })).filter(Boolean);
  const match = scanVirtualReferences(documents, { caseSensitive, maxDocuments: MAX_DOCUMENTS })
    .find((entry) => entry.targetId === targetId);
  const byId = new Map(notes.map((note) => [noteIdentity(note), note]));
  const payload = {
    type: "virtual-references",
    evaluationSource: "noema-aho-corasick",
    target: { id: targetId, title: target.title, file: target.file, path: target.path },
    mentions: (match?.mentions || []).map((mention) => ({
      ...mention,
      note: byId.get(mention.sourceId) || null,
    })),
    scannedDocuments: documents.length,
    ttlMs: TTL_MS,
  };
  cache.set(key, payload);
  return structuredClone(payload);
}

export function clearVirtualReferencesCache() {
  cache.clear();
}
