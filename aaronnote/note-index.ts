import type { NoteSummary } from "./types.ts";

type NoteIndexPayload = {
  notes?: NoteSummary[];
  note?: NoteSummary;
};

/** True only when a response carries an actual catalog replacement or row. */
export function payloadUpdatesNoteIndex(payload: NoteIndexPayload): boolean {
  return Array.isArray(payload.notes) || Boolean(payload.note?.file);
}

/**
 * Opening a document does not make the catalog stale. Bootstrap normally
 * supplies it once, and host/kernel watchers deliver later invalidations.
 */
export function openedNoteNeedsIndexReload(payload: NoteIndexPayload, indexLoaded: boolean): boolean {
  return !Array.isArray(payload.notes) && !indexLoaded;
}

function normalizedPath(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

/**
 * Resolve the open file against the portable note index. Exact file/path/link
 * identity always wins. The suffix fallback exists for roots that macOS
 * canonicalizes through a symlink (`/tmp` -> `/private/tmp`); it succeeds only
 * when the portable relative path identifies one catalog entry.
 */
export function currentNoteFromIndex(
  notes: readonly NoteSummary[],
  currentFile: string,
  currentTitle = "",
): NoteSummary | undefined {
  const exact = notes.find((note) => note.file === currentFile)
    ?? notes.find((note) => note.path === currentFile || note.link === currentFile);
  if (exact || !currentFile) return exact;

  const file = normalizedPath(currentFile);
  const suffixMatches = notes.filter((note) => {
    const relative = normalizedPath(note.path || note.link);
    return Boolean(relative && !relative.startsWith("/") && file.endsWith(`/${relative}`));
  });
  if (suffixMatches.length === 1) return suffixMatches[0];

  const title = String(currentTitle || "").trim();
  if (!title) return undefined;
  const titled = suffixMatches.filter((note) => String(note.title || "").trim() === title);
  return titled.length === 1 ? titled[0] : undefined;
}
