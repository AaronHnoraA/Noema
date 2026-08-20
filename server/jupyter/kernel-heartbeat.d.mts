// Ambient types for the Jupyter `hb` liveness probe.

import type { KernelConnectionInfo } from "./raw-socket.d.mts";

export const DEFAULT_HEARTBEAT_INTERVAL_MS: number;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS: number;
export const DEFAULT_HEARTBEAT_MAX_MISSES: number;

export interface KernelHeartbeat {
  start(): void;
  /** Idempotent; after this `onDead` can no longer fire. */
  stop(): void;
}

export function createKernelHeartbeat(options: {
  /** Only `transport`, `ip`, and `hb_port` are read. */
  connection: Pick<KernelConnectionInfo, "transport" | "ip" | "hb_port">;
  zmq: unknown;
  intervalMs?: number;
  timeoutMs?: number;
  maxMisses?: number;
  /** Called at most once, after `maxMisses` consecutive round trips fail. */
  onDead?: (reason: unknown) => void;
  stderr?: NodeJS.WritableStream;
}): KernelHeartbeat;
