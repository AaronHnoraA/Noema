export type WikiPartition = "public" | "private";
export type WikiLayout = "legacy" | "wiki";
export type WikiRepository = {
  id: string;
  name: string;
  partition: WikiPartition;
  path: string;
  public?: boolean;
};
export type WikiDiagnostic = {
  code: string;
  severity: string;
  message: string;
  path?: string;
  partition?: WikiPartition;
  name?: string;
};
export type WikiNote = {
  key: string;
  id: string;
  title: string;
  aliases: string[];
  tags: string[];
  private: boolean;
  file: string;
  path: string;
  link: string;
  repositoryPath: string;
  repository: string;
  repositoryId: string;
  partition: WikiPartition;
  mtimeMs: number;
  size: number;
  refs: string[];
  backlinks: string[];
  unresolvedLinks: string[];
  wikiLinks: Array<{ target: string; label: string }>;
};
export type WikiIndex = {
  type: "wiki-index";
  root: string;
  layout: WikiLayout;
  repositories: WikiRepository[];
  diagnostics: WikiDiagnostic[];
  notes: WikiNote[];
  reports: {
    wanted: Array<{ title: string; references: Array<{ sourceId: string; sourceTitle: string; sourceFile: string }> }>;
    ambiguous: Array<Record<string, unknown>>;
    duplicates: Array<Record<string, unknown>>;
  };
};

export function expandNoemaPath(value?: string, fallback?: string): string;
export function wikiLayout(value?: string): WikiLayout;
export function discoverWikiRepositories(root: string): Promise<{
  root: string; layout: "wiki"; repositories: WikiRepository[]; diagnostics: WikiDiagnostic[];
}>;
export function buildWikiIndex(root: string, options?: { layout?: WikiLayout }): Promise<WikiIndex>;
export function resolveWikiLink(index: WikiIndex, target: string): {
  type: "wiki-link";
  target: string;
  status: "resolved" | "ambiguous" | "missing";
  candidates: Array<{
    id: string; title: string; file: string; path: string; repositoryId: string; partition: WikiPartition;
  }>;
};
export function wikiDatabaseFile(root: string): string;
export function persistWikiIndex(index: WikiIndex): Promise<{ ok: boolean; dbFile: string; message?: string }>;
export function initWikiWorkspace(root: string): Promise<unknown>;
export function initWikiRepository(root: string, partition: WikiPartition, name: string): Promise<Record<string, unknown>>;
export function cloneWikiRepository(root: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
export function wikiRepositoryStatus(root: string, repositoryId: string): Promise<Record<string, unknown>>;
export function runWikiGitAction(root: string, action: string, body?: Record<string, unknown>): Promise<Record<string, unknown>>;
export function createWikiPage(root: string, layout: WikiLayout, body?: Record<string, unknown>): Promise<{
  ok: true; file: string; id: string; title: string; repositoryId: string; partition: WikiPartition;
}>;
export function publicWikiNotes(index: WikiIndex): WikiNote[];
