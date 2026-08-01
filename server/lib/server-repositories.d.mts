import type { ServerRepositoryConfig, ServerRuntimeConfig } from "./server-config.mjs";

export type ServerRepositoryResult = {
  ok: boolean;
  id: string;
  path: string;
  branch?: "main" | "master";
  head?: string;
  cloned?: boolean;
  stale?: boolean;
  error?: string;
  syncedAt: string;
};

export type ServerRepositoryState = {
  schemaVersion: 1;
  updatedAt: string;
  degraded: boolean;
  contentChanged: boolean;
  repositories: ServerRepositoryResult[];
};

type ServerRepositoriesConfig = Pick<ServerRuntimeConfig, "repositoriesRoot" | "stateRoot" | "repositories">;

export function resolveServerRepositoryBranch(path: string, requested?: "auto" | "main" | "master"): Promise<"main" | "master">;
export function syncServerRepository(
  config: Pick<ServerRuntimeConfig, "repositoriesRoot" | "stateRoot">,
  repository: ServerRepositoryConfig,
): Promise<ServerRepositoryResult & { ok: true; branch: "main" | "master"; head: string; cloned: boolean }>;
export function readServerRepositoryState(config: Pick<ServerRuntimeConfig, "stateRoot">): Promise<Record<string, unknown>>;
export function serverRepositoryContentSignature(
  config: Pick<ServerRuntimeConfig, "repositories">,
  state: Partial<ServerRepositoryState>,
  fallbackState?: Partial<ServerRepositoryState> | null,
): string;
export function syncServerRepositories(
  config: ServerRepositoriesConfig,
  options?: { concurrency?: number; previousState?: ServerRepositoryState | null },
): Promise<ServerRepositoryState>;
