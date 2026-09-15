export type ResearchDirectives = {
  agent: string;
  /** D-031: a keyword, a project session name, or parent:child. */
  session: string;
  context: string[];
  skills: string[];
  workstreamId: string;
  prompt: string;
};

export declare function parseResearchDirectives(text: string, options?: {
  allowWorkstream?: boolean;
  allowLegacySingleAt?: boolean;
  sourceName?: string;
}): ResearchDirectives;
