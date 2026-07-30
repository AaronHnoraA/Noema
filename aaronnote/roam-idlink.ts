import type { NoteSummary } from "./types.ts";

function decodeRef(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

function cleanInput(value: string): string {
  return String(value || "").trim();
}

function cleanInlineTag(value: string): string {
  return cleanInput(value)
    .replace(/^#/, "")
    .replace(/[\r\n\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function noteTitle(note: NoteSummary): string {
  return note.title || note.id || note.key || note.path || note.file || "Untitled";
}

function searchValues(note: NoteSummary): string[] {
  return [
    note.id,
    note.key,
    note.title,
    note.path,
    note.link,
    note.source,
    note.file,
    ...(note.aliases ?? []),
    ...(note.tags ?? []),
  ].filter((value): value is string => Boolean(value));
}

export function canonicalRoamNoteId(note: NoteSummary | undefined): string {
  if (!note) return "";
  return String(note.id || note.key || note.source || note.path || note.link || note.file || "").trim();
}

export function roamHrefForNote(note: NoteSummary | undefined, hash = ""): string {
  const id = canonicalRoamNoteId(note);
  if (!id) return "";
  const cleanHash = cleanInput(hash).replace(/^#/, "");
  return `roam://${encodeURIComponent(id)}${cleanHash ? `#${cleanHash}` : ""}`;
}

export function inlineTagHash(tag: string): string {
  const clean = cleanInlineTag(tag);
  return clean ? `tag-${encodeURIComponent(clean)}` : "";
}

export function inlineTagFromHash(hash: string): string {
  const clean = cleanInput(hash).replace(/^#/, "");
  if (!/^tag-/i.test(clean)) return "";
  try {
    return cleanInlineTag(decodeURIComponent(clean.slice(4)));
  } catch {
    return cleanInlineTag(clean.slice(4));
  }
}

export function roamNoteSearchValue(note: NoteSummary): string {
  const id = canonicalRoamNoteId(note);
  const title = noteTitle(note);
  return title && title !== id ? `${title} <${id}>` : id;
}

export function roamNoteInputRef(input: string): string {
  const raw = cleanInput(input);
  const angle = raw.match(/<([^<>]+)>\s*$/);
  const value = angle?.[1] || raw;
  const withoutScheme = value.replace(/^roam:\/\//i, "");
  return decodeRef(withoutScheme.split(/[?#@]/, 1)[0] || "").replace(/^\/+/, "").trim();
}

export function resolveRoamNoteSearch(notes: NoteSummary[], input: string): NoteSummary | undefined {
  const ref = roamNoteInputRef(input);
  if (!ref) return undefined;
  const normalized = ref.toLowerCase();
  const roamNotes = notes.filter((note) => note.roam);
  const exact = roamNotes.find((note) =>
    searchValues(note).some((value) => value.toLowerCase() === normalized));
  if (exact) return exact;
  return roamNotes.find((note) =>
    searchValues(note).some((value) => value.toLowerCase().includes(normalized)));
}

export function escapeMarkdownLinkText(value: string): string {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

export function markdownRoamIdLink(note: NoteSummary, label: string): string {
  const href = roamHrefForNote(note);
  if (!href) return "";
  const text = escapeMarkdownLinkText(label || noteTitle(note));
  return `[${text}](${href})`;
}
