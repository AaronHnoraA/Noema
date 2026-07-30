import type { Kernel } from "@jupyterlab/services";
import type { KernelSpecEntry } from "./kernel-finder.d.mts";
import type { KernelProcessHandle } from "./kernel-process.d.mts";
import type { RawSocket } from "./raw-socket.d.mts";

export interface KernelRecord {
  id: string;
  key: string;
  kernelName: string;
  kernelSpec: KernelSpecEntry["spec"];
  owned: boolean;
  attached: boolean;
  process: KernelProcessHandle | undefined;
  connectionInfo: unknown;
  connectionFilePath: string | undefined;
  ports: number[];
  kernel: Kernel.IKernelConnection;
  socket: RawSocket;
  widgetGeneration: number;
  status: "starting" | "idle" | "busy" | "dead";
  createdAt: number;
  lastActivity: number;
  running: number;
  executionCount: number | null;
  lastStatus: string;
  lastCellId: string;
  totalRuns: number;
  lastError: string | undefined;
  disposed: boolean;
  variableBaseline: Set<string> | null;
}

export function sweepOrphanKernels(options: {
  sidecarPath: string;
  stderr?: NodeJS.WritableStream;
}): Promise<{ reaped: number }>;

export function createKernelRegistry(options: {
  runtimeDir: string;
  runtimeBinDir?: string;
  /** @deprecated Use runtimeBinDir. */
  venvBinDir?: string;
  cwd?: string;
  zmq: unknown;
  launchTimeoutMs?: number;
  stderr?: NodeJS.WritableStream;
}): {
  get(key: string): KernelRecord | undefined;
  ensure(key: string, kernelSpecEntry: KernelSpecEntry): Promise<KernelRecord>;
  ensureAttached(key: string, kernelName: string, connectionFilePath: string): Promise<KernelRecord>;
  touch(key: string): void;
  restart(key: string): Promise<KernelRecord>;
  interrupt(key: string): Promise<boolean>;
  shutdown(key: string): Promise<void>;
  shutdownAll(): Promise<void>;
  list(): KernelRecord[];
  listOwnedPids(): number[];
};
