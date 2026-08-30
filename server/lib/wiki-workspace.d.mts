export type WikiPartition = "public" | "private";
export type WikiLayout = "legacy" | "wiki";
export type WikiRepository = {
  id: string;
  uid?: string;
  identityStatus?: "managed" | "provisional" | "legacy";
  name: string;
  namespace: string;
  qualifiedNamespace: string;
  namespaceAliases: string[];
  partition: WikiPartition;
  path: string;
  public?: boolean;
  headSha?: string;
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
  namespace: string;
  qualifiedNamespace: string;
  qualifiedTitle: string;
  fullTitle: string;
  namespaceSource: "page" | "repository";
  namespaceAliases: string[];
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
  blocks: Array<{ id: string; kind: string; envKind?: string; label: string; offset: number }>;
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
  generation?: string;
  root: string;
  layout: WikiLayout;
  repositories: WikiRepository[];
  diagnostics: WikiDiagnostic[];
  notes: WikiNote[];
  files: WikiFile[];
  directories: WikiDirectory[];
  reports: {
    wanted: Array<{ title: string; namespace?: string; qualifiedTitle?: string; references: Array<{ sourceId: string; sourceTitle: string; sourceFile: string }> }>;
    ambiguous: Array<Record<string, unknown>>;
    duplicates: Array<Record<string, unknown>>;
    duplicateIds?: Array<Record<string, unknown>>;
    missingFragments?: Array<Record<string, unknown>>;
  };
  maintenance?: WikiIndexMaintenance;
};

export type WikiIndexMaintenance = {
  ok: boolean;
  dbFile: string;
  mode: "incremental" | "full";
  reason: string;
  changedFiles: string[];
  changes: { repositories: number; files: number; pages: number; relationships: number; removed: number };
};

export type WikiGitProvider = {
  owns(repositoryPath: string): boolean;
  status(repositoryPath: string): Promise<{
    branch: string; remote: string; clean: boolean; status: string; source: "kernel-vaultgit";
  }>;
  history(repositoryPath: string, filePath: string, limit?: number): Promise<{
    path: string; source: "kernel-vaultgit";
    commits: Array<{ sha: string; date: string; author: string; email: string; subject: string }>;
  }>;
  diff(repositoryPath: string, filePath: string, sha: string): Promise<{
    path: string; diff: string; scope: "commit"; sha: string; source: "kernel-vaultgit";
  }>;
  restore(repositoryPath: string, filePath: string, sha: string): Promise<{
    path: string; sha: string; source: "kernel-vaultgit"; bytes: number;
  }>;
  checkpoint?(repositoryPath: string, request: {
    branch: string; message?: string; deviceName: string; deviceId: string;
  }): Promise<{
    branch: string; head: string; committed: boolean; changedFiles: number;
    identityFallback: boolean; source: "kernel-vaultgit";
  }>;
  action(request: {
    repositoryPath: string; action: string; message: string; paths: string[];
  }): Promise<{
    branch: string; remote: string; clean: boolean; status: string; source: "kernel-vaultgit";
    action: string; phase: "idle"; changedPaths: string[]; message: string;
  }>;
};

export function configureWikiGitProvider(provider?: WikiGitProvider | null): void;

export function expandNoemaPath(value?: string, fallback?: string): string;
export function wikiLayout(value?: string): WikiLayout;
export function discoverWikiRepositories(root: string): Promise<{
  root: string; layout: "wiki"; repositories: WikiRepository[]; diagnostics: WikiDiagnostic[];
}>;
export function buildWikiIndex(root: string, options?: {
  layout?: WikiLayout;
  mode?: "auto" | "incremental" | "full";
  force?: boolean;
  changedFiles?: string[];
}): Promise<WikiIndex>;
export function resolveWikiLink(index: WikiIndex, target: string, options?: { sourceFile?: string }): {
  type: "wiki-link";
  target: string;
  status: "resolved" | "ambiguous" | "missing" | "missing-fragment";
  fragment: string;
  targetBlockId: string;
  candidates: Array<{
    id: string; title: string; namespace: string; qualifiedNamespace: string; qualifiedTitle: string; fullTitle: string;
    file: string; path: string; repositoryId: string; partition: WikiPartition;
  }>;
};
export function wikiDatabaseFile(root: string): string;
export function persistWikiIndex(index: WikiIndex, options?: {
  mode?: "auto" | "incremental" | "full";
  force?: boolean;
  changedFiles?: string[];
}): Promise<WikiIndexMaintenance>;
export function wikiIndexStatus(root: string): {
  ok: boolean;
  dbFile: string;
  schemaVersion: number;
  generation: string;
  updatedAt?: string;
  lastMode?: string;
  lastReason?: string;
  lastIncrementalAt?: string;
  lastFullAt?: string;
  lastError?: string;
  changedFiles?: string[];
  repositories: Array<{ repositoryId: string; repositoryUid: string; headSha: string; scannedAt: string }>;
  message?: string;
};
export function searchWikiDatabase(root: string, body?: {
  query?: string;
  q?: string;
  repositoryId?: string;
  partition?: WikiPartition;
  namespace?: string;
  cursor?: number;
  limit?: number;
}): {
  ok: true;
  type: "wiki-search";
  generation: string;
  items: WikiNote[];
  total: number;
  nextCursor: number | null;
};
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
export function wikiRepositoryDiff(root: string, body?: Record<string, unknown>): Promise<Record<string, unknown>>;
export function wikiRepositoryBranches(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
export function runWikiBranchAction(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
export function wikiRepositoryRemotes(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
export function runWikiRemoteAction(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
export function createWikiPage(root: string, layout: WikiLayout, body?: Record<string, unknown>): Promise<{
  ok: true; file: string; id: string; title: string; namespace: string; qualifiedTitle: string; repositoryId: string; partition: WikiPartition;
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
export function updateWikiNamespace(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
export function exportWiki(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
export function wikiPageHistory(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
export function wikiPageDiff(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
export function restoreWikiPageVersion(root: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
