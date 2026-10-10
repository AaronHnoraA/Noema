export type NoteReferenceTarget = {
  id?: string;
  key?: string;
  title?: string;
  path?: string;
  link?: string;
  source?: string;
  file?: string;
  aliases?: readonly string[];
};

export function noteRefFromRoamHref(value: unknown): string;
export function canonicalNoteRef(value: unknown): string;
export function noteReferenceValues(note: NoteReferenceTarget | null | undefined): string[];
export function resolveNoteReference<T extends NoteReferenceTarget>(
  notes: readonly T[],
  ref: unknown,
): T | undefined;
