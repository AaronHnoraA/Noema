function decodeRef(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function normalizePathLike(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  const absolute = raw.startsWith("/");
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

export function noteRefFromRoamHref(value) {
  const raw = String(value || "").trim();
  if (!/^roam:\/\//i.test(raw)) return "";
  let body = raw.replace(/^roam:\/\//i, "");
  body = body.split(/[?&]/, 1)[0] || "";
  body = body.split("#", 1)[0] || "";
  body = body.split("@", 1)[0] || "";
  return decodeRef(body.replace(/^\/+/, "").replace(/[.,;:]+$/, "")).trim();
}

export function canonicalNoteRef(value) {
  const ref = noteRefFromRoamHref(value) || String(value || "");
  return normalizePathLike(decodeRef(ref).trim().replace(/^\.\/+/, ""));
}

export function noteReferenceValues(note) {
  const file = String(note?.file || "");
  const base = file.split(/[\\/]/).filter(Boolean).at(-1) || "";
  return [
    note?.id,
    note?.key,
    note?.title,
    note?.path,
    note?.link,
    note?.source,
    note?.file,
    base,
    ...(note?.aliases || []),
  ].filter((value) => String(value || "").trim());
}

const NOTE_EXTENSION_RE = /\.(?:md|markdown|typ)$/i;

function notePathValues(note) {
  return [note?.path, note?.link, note?.file, note?.source]
    .map((value) => canonicalNoteRef(value).toLowerCase())
    .filter(Boolean);
}

/**
 * Whether PATH names the note TARGET refers to by location: the same path, the
 * path without its note extension, or either one as a whole trailing run of
 * directories (`topic/page` for `/vault/topic/page.md`). A reference is never
 * matched inside a segment, so `set` does not find `reset.md`.
 */
function notePathNames(path, target) {
  for (const candidate of [path, path.replace(NOTE_EXTENSION_RE, "")]) {
    if (candidate === target || candidate.endsWith(`/${target}`)) return true;
  }
  return false;
}

// Resolution runs once per link in a graph or an outline, so the note list is
// indexed once. The index belongs to the array it was built from: an updated
// note list is a new array and gets a new index.
const referenceIndexes = new WeakMap();

function referenceIndex(notes) {
  let index = referenceIndexes.get(notes);
  if (index) return index;
  const identity = new Map();
  const names = new Map();
  for (const note of notes) {
    for (const value of noteReferenceValues(note)) {
      const key = canonicalNoteRef(value).toLowerCase();
      if (key && !identity.has(key)) identity.set(key, note);
    }
    for (const path of notePathValues(note)) {
      for (const candidate of new Set([path, path.replace(NOTE_EXTENSION_RE, "")])) {
        const name = candidate.slice(candidate.lastIndexOf("/") + 1);
        if (!name) continue;
        const located = names.get(name);
        if (located) located.push({ note, path });
        else names.set(name, [{ note, path }]);
      }
    }
  }
  index = { identity, names };
  referenceIndexes.set(notes, index);
  return index;
}

/**
 * The note REF refers to: first by identity (id, key, title, alias, path),
 * then by location. Tags describe a note and never identify one, and a
 * reference that names no note resolves to nothing rather than to the nearest
 * substring match.
 */
export function resolveNoteReference(notes, ref) {
  const target = canonicalNoteRef(ref).toLowerCase();
  if (!target) return undefined;
  const index = referenceIndex(notes);
  const exact = index.identity.get(target);
  if (exact) return exact;
  const name = target.slice(target.lastIndexOf("/") + 1);
  return index.names.get(name)?.find(({ path }) => notePathNames(path, target))?.note;
}
