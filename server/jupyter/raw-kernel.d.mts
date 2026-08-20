// Ambient types for the ported vscode-jupyter raw kernel connection helpers.

import type { Kernel, KernelMessage } from "@jupyterlab/services";
import type { KernelConnectionInfo, RawSocket } from "./raw-socket.d.mts";

export function createRawKernelConnection(options: {
  connectionInfo: KernelConnectionInfo;
  clientId: string;
  username: string;
  model: Kernel.IModel;
  zmq: unknown;
  stderr?: NodeJS.WritableStream;
}): { kernel: Kernel.IKernelConnection; socket: RawSocket };

export function waitForConnected(kernel: Kernel.IKernelConnection, timeoutMs: number): Promise<boolean>;

export function sendInterruptRequest(
  kernel: Kernel.IKernelConnection,
  options?: { stderr?: NodeJS.WritableStream },
): Promise<void>;

/**
 * Runs the jupyter_client `wait_for_ready` handshake and keeps the reply:
 * `info` is the `kernel_info_reply` content (language_info, banner, help_links).
 */
export function warmupKernelInfo(
  kernel: Kernel.IKernelConnection,
  timeoutMs: number,
  options?: { stderr?: NodeJS.WritableStream },
): Promise<{ ok: boolean; info?: KernelMessage.IInfoReply }>;
