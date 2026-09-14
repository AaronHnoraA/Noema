export function researchNotebookWatchFile(root: string, file: string, ignoredParts?: Set<string>): string;
export function researchNotebookWatchDirectory(root: string, file: string, ignoredParts?: Set<string>): string;

export interface ResearchNotebookWatchReconciler {
  filesChanged(files?: string[]): Promise<unknown>;
  fullRescan(): Promise<unknown>;
  drain(): Promise<unknown>;
  close(): void;
}

export function createResearchNotebookWatchReconciler(options: {
  root: string;
  snapshot: (body: Record<string, unknown>) => Promise<unknown>;
  readDirectory?: (...args: any[]) => Promise<any[]>;
  ignoredParts?: Set<string>;
  onError?: (error: unknown, file: string) => void;
}): ResearchNotebookWatchReconciler;
