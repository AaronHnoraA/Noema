import type { KernelSpecEntry } from "./kernel-finder.d.mts";

export function findConnectionFileArgIndex(argv: string[]): number;
export function substituteConnectionFile(argv: string[], connectionFilePath: string): string[];
export function writeConnectionFile(filePath: string, connectionInfo: unknown): Promise<void>;

export interface KernelProcessHandle {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly exited: import("node:events").EventEmitter;
  interrupt(): void;
  dispose(): Promise<void>;
}

export function spawnKernelProcess(options: {
  kernelSpec: KernelSpecEntry["spec"];
  connectionFilePath: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  stderr?: NodeJS.WritableStream;
}): KernelProcessHandle;
