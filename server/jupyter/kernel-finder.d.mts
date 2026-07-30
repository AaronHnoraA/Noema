export interface KernelSpecEntry {
  name: string;
  spec: {
    argv: string[];
    display_name?: string;
    language?: string;
    env?: Record<string, string>;
    interrupt_mode?: "signal" | "message";
    metadata?: Record<string, unknown>;
  };
  resourceDir: string;
}

export function defaultKernelSearchDirs(options: {
  dataDir?: string;
  environmentPrefix?: string;
  /** @deprecated Use environmentPrefix. */
  venvPrefix?: string;
  useHomeKernels?: boolean;
  extraJupyterPath?: string;
}): string[];

export function findKernelSpecs(options: {
  searchDirs: string[];
  allowedNames?: string[];
}): Promise<KernelSpecEntry[]>;

export interface AttachableConnectionFile {
  token: string;
  path: string;
  mtimeMs: number;
  connectionInfo: Record<string, unknown>;
}

export function findAttachableConnectionFiles(attachDirs: string[]): Promise<AttachableConnectionFile[]>;

export function resolveAttachToken(token: string, attachDirs: string[]): Promise<string | undefined>;
