export type ResearchDirectives = {
  agent: string;
  /** D-031: a keyword, a project session name, or parent:child. */
  session: string;
  context: string[];
  skills: string[];
  workstreamId: string;
  /** Visible native Agenda fields; excluded from prompt text. */
  agenda: Record<string, unknown> | null;
  prompt: string;
};

export declare function parseResearchDirectives(text: string, options?: {
  allowWorkstream?: boolean;
  allowLegacySingleAt?: boolean;
  allowAgenda?: boolean;
  agendaKind?: "work" | "question" | "checkpoint";
  sourceName?: string;
}): ResearchDirectives;
