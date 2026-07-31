import type { WikiRepository } from "./wiki-workspace.mjs";

export type WikiSyncConflict = { path: string; kind: string; stages: number[] };
export type WikiSyncState = {
  schema?: number;
  repositoryId: string;
  repositoryUid?: string;
  phase: "idle" | "checkpointing" | "fetching" | "merging" | "conflicted" | "pushing" | "error";
  updatedAt?: string;
  lastSyncedAt?: string;
  branch?: string;
  localOnly?: boolean;
  error?: string;
  message?: string;
  conflicts?: WikiSyncConflict[];
};

export function ensureNoemaDeviceIdentity(options?: Record<string, unknown>): Promise<Record<string, any>>;
export function readWikiSyncState(root: string, repositoryId?: string): Promise<WikiSyncState | Record<string, any>>;
export function checkpointWikiRepository(root: string, repositoryId: string, options?: Record<string, unknown>): Promise<
  WikiSyncState & { ok: true; type: "wiki-checkpoint"; repository: WikiRepository }
>;
export function syncWikiRepository(root: string, repositoryId: string, options?: Record<string, unknown>): Promise<WikiSyncState>;
export function readWikiConflict(root: string, body?: Record<string, unknown>): Promise<{
  ok: true;
  type: "wiki-conflict-file";
  repositoryId: string;
  path: string;
  kind: "text" | "binary";
  base: string;
  ours: string;
  theirs: string;
}>;
export function resolveWikiConflict(root: string, body?: Record<string, unknown>): Promise<WikiSyncState>;
export function abortWikiConflict(root: string, repositoryId: string): Promise<WikiSyncState>;
export function defaultWikiSyncIntervalMs(): number;
