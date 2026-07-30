export type RecentNote = { file: string; openedAt: number };
export type CursorPosition = {
  file: string;
  mode: "source" | "markdown";
  from: number;
  to: number;
  scrollY: number;
  updatedAt: number;
};

export class SessionManager {
  constructor(options: {
    stateRoot: string;
    resolveFile: (file: string) => string;
    writeFile: (file: string, data: string, encoding: "utf8") => Promise<unknown>;
  });
  normalizeRecentNotes(entries: unknown): RecentNote[];
  readRecentNotes(): Promise<RecentNote[]>;
  touchRecentNote(file: string, openedAt?: number): Promise<RecentNote[]>;
  normalizeCursorPositions(entries: unknown): CursorPosition[];
  readCursorPositions(): Promise<CursorPosition[]>;
  touchCursorPosition(body: Record<string, unknown> & { file: string }): Promise<CursorPosition[]>;
}
