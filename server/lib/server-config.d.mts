export type ServerRepositoryConfig = Readonly<{
  name: string;
  url: string;
  partition: "public" | "private";
  branch: "auto" | "main" | "master";
  id: string;
}>;

export type ServerRuntimeConfig = Readonly<{
  schemaVersion: 1;
  configFile: string;
  configDir: string;
  listen: Readonly<{ host: string; port: number }>;
  appearance: Readonly<{ theme: string }>;
  reader: Readonly<{
    showSource: boolean;
    showGraph: boolean;
    showSearch: boolean;
    showToc: boolean;
    showStatus: boolean;
    selectionToolbar: boolean;
    customContextMenu: boolean;
    editingAids: boolean;
  }>;
  pullIntervalMinutes: number;
  repositories: readonly ServerRepositoryConfig[];
  repositoriesRoot: string;
  stateRoot: string;
  noteRoot: string;
}>;

export type ServerDeployConfig = Readonly<{
  schemaVersion: 1;
  sshTarget: string;
  remoteRoot: string;
  serviceName: string;
  nodeBin: string;
  npmBin: string;
  retainReleases: number;
}>;

export function normalizeServerRuntimeConfig(raw: unknown, options?: { configFile?: string }): ServerRuntimeConfig;
export function readServerRuntimeConfig(file: string): Promise<ServerRuntimeConfig>;
export function normalizeServerDeployConfig(raw: unknown): ServerDeployConfig;
export function serverRepositoryPath(config: Pick<ServerRuntimeConfig, "repositoriesRoot">, repository: Pick<ServerRepositoryConfig, "partition" | "name">): string;
