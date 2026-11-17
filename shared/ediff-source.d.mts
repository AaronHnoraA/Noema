export interface EdiffLine {
  kind: " " | "-" | "+";
  text: string;
  noNewline: boolean;
}
export interface EdiffBlock {
  from: number;
  to: number;
  end: number;
  title: string;
  rejected: boolean;
  comments: string[];
  /** The collaborator that proposed it (C66). */
  author?: { name: string; session?: string };
  changes: EdiffLine[];
  oldLines: EdiffLine[];
  newLines: EdiffLine[];
  error?: string;
}
export function scanEdiffBlocks(source: string): EdiffBlock[];
export function ediffSide(block: EdiffBlock, side: "old" | "new"): string;
export function approvedEdiffMarkdown(source: string): string;
