// Before a note goes to the Trash, say who links to it: their links will
// dangle.  NocoDB lists a field's dependents before a destructive change for
// the same reason.

type LinkedNote = { id: string; title?: string; file?: string; backlinks?: string[] };

const SHOWN = 5;

export function trashLinkNotice(file: string, notes: readonly LinkedNote[]): string {
  const note = notes.find((candidate) => candidate.file === file);
  const ids = [...new Set(note?.backlinks ?? [])];
  if (ids.length === 0) return "";
  const byId = new Map(notes.map((candidate) => [candidate.id, candidate]));
  const titles = ids.map((id) => byId.get(id)?.title || id);
  const shown = titles.slice(0, SHOWN).join(", ") + (titles.length > SHOWN ? ", …" : "");
  return `${ids.length} ${ids.length === 1 ? "note links" : "notes link"} here and will have a dangling link: ${shown}. `;
}
