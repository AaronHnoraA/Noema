export type ResearchDirectives = {
  agent: string;
  session: "" | "continue" | "fork" | "fresh";
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
