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
export function selectRunMemory(
  findings: RunMemoryFinding[],
  prompt: string,
  workstreamId: string,
  options?: { maxResults?: number; maxBytes?: number },
): Array<{ id: string; version: number; content: string }>;
