export type NoteCodeLine = {
  commandFrom: number;
  commandTo: number;
  path: string;
  id: string;
};

export function parseNoteCodeLine(line: unknown): NoteCodeLine | null;
