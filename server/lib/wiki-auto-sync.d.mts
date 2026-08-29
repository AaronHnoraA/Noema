export type WikiAutoSyncState = { phase?: string; [key: string]: unknown };
export type WikiAutoSyncFailure = { repositoryId: string; error: string };

export type WikiAutoSync = {
  mark(repositoryId: string): void;
  cancel(repositoryId: string): void;
  retry(repositoryId: string, delayMs?: number): void;
  pause(repositoryId: string): void;
  resume(repositoryId: string, options?: { immediate?: boolean }): void;
  start(repositoryIds?: string[]): void;
  syncNow(repositoryId: string): Promise<WikiAutoSyncState | null>;
  close(options?: { flush?: boolean }): Promise<void>;
  snapshot(): {
    known: string[];
    pending: string[];
    active: string[];
    waiting: string[];
    rerun: string[];
    blocked: string[];
    blockedDirty: string[];
  };
};

export function createWikiAutoSync(options: {
  sync(repositoryId: string): Promise<WikiAutoSyncState>;
  flush?(repositoryId: string): Promise<WikiAutoSyncState>;
  onResult?(repositoryId: string, result: WikiAutoSyncState): void;
  onError?(repositoryId: string, error: unknown): void;
  onBatchError?(failures: WikiAutoSyncFailure[]): void;
  debounceMs?: number;
  startupMs?: number;
  syncOnStart?: boolean;
  periodicMs?: number;
  periodicJitterMs?: number;
  busyRetryMs?: number;
  maxConcurrency?: number;
}): WikiAutoSync;
