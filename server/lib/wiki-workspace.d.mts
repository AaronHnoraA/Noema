export type WikiPartition = "public" | "private";
export type WikiLayout = "legacy" | "wiki";
export type WikiRepository = {
  id: string;
  uid?: string;
  identityStatus?: "managed" | "provisional" | "legacy";
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
  pageKey?: string;
  id: string;
  title: string;
  kind?: string;
  redirectTo?: string;
  identityStatus?: "managed" | "provisional" | "legacy" | "duplicate";
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
  blocks: Array<{ id: string; kind: string; offset: number }>;
  dependencies: Array<{ kind: string; raw: string; path: string; status: string }>;
};
export type WikiFile = {
  repositoryId: string;
  partition: WikiPartition;
  file: string;
  path: string;
  repositoryPath: string;
  name: string;
  ext: string;
  kind: "note" | "file";
  size: number;
  mtimeMs: number;
  gitStatus: string;
};
export type WikiDirectory = {
  repositoryId: string;
  partition: WikiPartition;
  path: string;
  name: string;
  fileCount: number;
};
export type WikiIndex = {
  type: "wiki-index";
  root: string;
  layout: WikiLayout;
  repositories: WikiRepository[];
  diagnostics: WikiDiagnostic[];
  notes: WikiNote[];
  files: WikiFile[];
  directories: WikiDirectory[];
  reports: {
    wanted: Array<{ title: string; references: Array<{ sourceId: string; sourceTitle: string; sourceFile: string }> }>;
    ambiguous: Array<Record<string, unknown>>;
    duplicates: Array<Record<string, unknown>>;
    duplicateIds?: Array<Record<string, unknown>>;
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
export function initWikiRepository(root: string, partition: WikiPartition, name: string): Promise<{
  ok: true;
  repository: WikiRepository & { uid: string };
}>;
export function cloneWikiRepository(root: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
export function repositoryFromId(root: string, repositoryId: string): Promise<WikiRepository>;
export function adoptWikiRepository(root: string, repositoryId: string): Promise<{
  ok: true;
  type: "wiki-repository-adopted";
  repository: WikiRepository & { uid: string; identityStatus: "managed" };
  manifest: string;
}>;
export function wikiRepositoryStatus(root: string, repositoryId: string): Promise<Record<string, unknown>>;
export function runWikiGitAction(root: string, action: string, body?: Record<string, unknown>): Promise<Record<string, unknown>>;
export function createWikiPage(root: string, layout: WikiLayout, body?: Record<string, unknown>): Promise<{
  ok: true; file: string; id: string; title: string; repositoryId: string; partition: WikiPartition;
}>;
export function publicWikiNotes(index: WikiIndex): WikiNote[];
export function moveWikiPage(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
export function deleteWikiPage(root: string, body?: Record<string, unknown>, options?: { trashRoot?: string }): Promise<Record<string, any>>;
export function copyWikiPage(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
export function mergeWikiPages(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
export function wikiTagIndex(index: WikiIndex): Array<{
  name: string;
  count: number;
  pages: Array<{ id: string; title: string; repositoryId: string; path: string }>;
  variants: string[];
}>;
export function updateWikiTag(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
export function exportWiki(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
