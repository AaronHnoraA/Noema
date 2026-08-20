import type { Kernel } from "@jupyterlab/services";
import type { KernelSpecEntry } from "./kernel-finder.d.mts";
import type { KernelProcessHandle } from "./kernel-process.d.mts";
import type { RawSocket } from "./raw-socket.d.mts";

/**
 * Which connector produced a record. Lifecycle verbs branch on this, never on
 * a transport test.
 *
 *   "owned"    — we (or the Emacs broker) launched the process; signalable.
 *   "attached" — reached through an existing connection file; never killed.
 */
export type KernelRecordKind = "owned" | "attached";

/**
 * The Emacs broker, when Noema runs in `emacs` host mode. It owns kernel
 * placement on the note's Remote target: kernelspec discovery, the connection
 * file, the process, and the forwarded five-channel group.
 */
export interface KernelHost {
  listKernelSpecs(file: string): Promise<KernelSpecEntry[]>;
  launch(body: {
    key: string;
    sourceFile?: string;
    kernelName: string;
    kernelSpec: KernelSpecEntry["spec"];
  }): Promise<HostedRuntime>;
  status(runtimeId: string): Promise<HostedRuntime & { alive: boolean; message?: string }>;
  interrupt(runtimeId: string): Promise<unknown>;
  restart?(runtimeId: string): Promise<HostedRuntime>;
  shutdown(runtimeId: string): Promise<unknown>;
  readNbextension(runtimeId: string, relativePath: string): Promise<unknown>;
}

export interface HostedRuntime {
  runtimeId: string;
  pid: number;
  generation: number;
  stateLost?: boolean;
  connectionFile?: string;
  connectionInfo: unknown;
}

export interface KernelRecord {
  id: string;
  key: string;
  kind: KernelRecordKind;
  kernelName: string;
  kernelSpec: KernelSpecEntry["spec"];
  owned: boolean;
  attached: boolean;
  process: KernelProcessHandle | undefined;
  /** True when the process lives on a Remote target and is owned by the Emacs broker. */
  hosted: boolean;
  hostRuntimeId?: string;
  hostGeneration?: number;
  stateLost?: boolean;
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
  /** `kernel_info_reply` content captured during the readiness handshake. */
  kernelInfo: unknown | null;
  variableBaseline: Set<string> | null;
}

export function sweepOrphanKernels(options: {
  sidecarPath: string;
  stderr?: NodeJS.WritableStream;
  platform?: NodeJS.Platform;
}): Promise<{ reaped: number }>;

export function sweepGlobalOrphanKernels(options?: {
  stderr?: NodeJS.WritableStream;
  platform?: NodeJS.Platform;
}): Promise<{ reaped: number }>;

export function createKernelRegistry(options: {
  runtimeDir: string;
  runtimeBinDir?: string;
  /** @deprecated Use runtimeBinDir. */
  venvBinDir?: string;
  cwd?: string;
  zmq: unknown;
  launchTimeoutMs?: number;
  /** Grace period for a `shutdown_request` before signalling an owned kernel; 0 disables. */
  shutdownGraceMs?: number;
  stderr?: NodeJS.WritableStream;
  kernelHost?: KernelHost;
  baseEnvironment?: Record<string, string>;
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
