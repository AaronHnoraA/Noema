import type { WikiRepository } from "./wiki-workspace.mjs";

export type WikiSyncConflict = {
  path: string;
  kind: string;
  stages: number[];
  oursStage?: 2 | 3;
  theirsStage?: 2 | 3;
  oursLabel?: string;
  theirsLabel?: string;
};
export type WikiRecoveryArtifact = {
  kind: "working-files";
  source: "integration" | "primary";
  createdAt: string;
  path: string;
  files: string[];
};
export type WikiRecoveredGitLock = {
  kind: "orphan-index-lock";
  recoveredAt: string;
  ageMs: number;
  size: number;
  backup: string;
  previousOwnerPid?: number;
};
export type WikiSyncState = {
  schema?: number;
  repositoryId: string;
  repositoryUid?: string;
  phase: "idle" | "waiting" | "checkpointing" | "fetching" | "merging" | "conflicted" | "pushing" | "applying" | "error";
  updatedAt?: string;
  lastSyncedAt?: string;
  checkpointedAt?: string;
  failedAt?: string;
  branch?: string;
  localOnly?: boolean;
  committed?: boolean;
  changedFiles?: number;
  changedPaths?: string[];
  source?: "kernel-vaultgit" | "node-vaultgit";
  checkpointSource?: "kernel-vaultgit" | "node-vaultgit";
  transportSource?: "kernel-vaultgit" | "node-vaultgit";
  error?: string;
  message?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  nextRetryAt?: string;
  errorKind?: "busy" | "network" | "authentication" | "configuration" | "remote-race" | "workspace" | "conflict" | "internal";
  actionRequired?: string;
  operationId?: string;
  snapshotHead?: string;
  remoteHead?: string;
  integrationHead?: string;
  publishedHead?: string;
  integrationBranch?: string;
  integrationPath?: string;
  recoveryArtifacts?: WikiRecoveryArtifact[];
  recoveredGitLock?: WikiRecoveredGitLock;
  conflicts?: WikiSyncConflict[];
};

export function configureWikiSyncGitProvider(provider?: {
  owns(repositoryPath: string): boolean;
  checkpoint(repositoryPath: string, request: {
    branch: string; message?: string; deviceName: string; deviceId: string;
  }): Promise<{
    branch: string; head: string; committed: boolean; changedFiles: number;
    identityFallback: boolean; source: "kernel-vaultgit";
  }>;
  ensureMain?(repositoryPath: string, commit: string): Promise<{
    action: "ensure-main"; commit: string; remoteHead: string; bootstrapped: boolean; source: "kernel-vaultgit";
  }>;
  fetchMain?(repositoryPath: string): Promise<{
    action: "fetch-main"; commit: string; remoteHead: string; bootstrapped: boolean; source: "kernel-vaultgit";
  }>;
  pushMain?(repositoryPath: string, commit: string): Promise<{
    action: "push-main"; commit: string; remoteHead: string; bootstrapped: boolean; source: "kernel-vaultgit";
  }>;
} | null): void;
export function ensureNoemaDeviceIdentity(options?: Record<string, unknown>): Promise<Record<string, any>>;
export function readWikiSyncState(root: string, repositoryId?: string): Promise<WikiSyncState | Record<string, any>>;
export function checkpointWikiRepository(root: string, repositoryId: string, options?: Record<string, unknown>): Promise<
  WikiSyncState & { ok: true; type: "wiki-checkpoint"; repository: WikiRepository }
>;
export function syncWikiRepository(root: string, repositoryId: string, options?: Record<string, unknown>): Promise<WikiSyncState>;
export function classifyGitFailure(value: unknown): {
  errorKind: "remote-race" | "authentication" | "configuration" | "network" | "workspace" | "internal";
  retryable: boolean;
  actionRequired?: string;
  message: string;
};
export function defaultWikiSyncIntervalMs(): number;
export function defaultWikiGitMaintenanceBytes(): number;
export function readWikiConflict(root: string, body?: Record<string, unknown>): Promise<{
  ok: true;
  type: "wiki-conflict-file";
  repositoryId: string;
  path: string;
  kind: "text" | "binary";
  base: string;
  ours: string;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
}>;
export function resolveWikiConflict(root: string, body?: Record<string, unknown>): Promise<WikiSyncState>;
export function abortWikiConflict(root: string, repositoryId: string): Promise<WikiSyncState>;
