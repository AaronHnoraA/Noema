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

export function resolveNoteReference(notes, ref) {
  const target = canonicalNoteRef(ref).toLowerCase();
  if (!target) return undefined;
  return notes.find((note) =>
    noteReferenceValues(note).some((value) => canonicalNoteRef(value).toLowerCase() === target));
}
