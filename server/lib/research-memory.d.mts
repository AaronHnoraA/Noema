export type RunMemoryFinding = {
  id: string;
  version: number;
  workstreamId: string;
  kind: string;
  statement: string;
  status: string;
  verificationLevel: string;
  disclosure: string;
  evidence: Array<{ artifactId: string; byteStart: number; byteEnd: number }>;
};

export function memoryTerms(text: string): string[];
export function statementOverlap(left: string | string[], right: string | string[]): number;
export function similarFindings<T extends Pick<RunMemoryFinding, "id" | "workstreamId" | "statement">>(
  findings: T[],
  statement: string,
  workstreamId: string,
  options?: { threshold?: number; limit?: number },
): Array<{ finding: T; overlap: number }>;
export function selectRunMemory(
  findings: RunMemoryFinding[],
  prompt: string,
  workstreamId: string,
  options?: { maxResults?: number; maxBytes?: number },
): Array<{ id: string; version: number; content: string }>;
