import type { Contents, Kernel } from "@jupyterlab/services";
import type { JupyterServerConfig } from "./server-auth.d.mts";
import type { KernelSpecEntry } from "./kernel-finder.d.mts";

export interface RemoteKernelHandle {
  model: Kernel.IModel;
  /** Empty for gateway kernels, which have no session. */
  sessionId: string;
  kernel: Kernel.IKernelConnection;
}

export interface JupyterServerRegistry {
  config(serverId: string): Promise<JupyterServerConfig & { kind: "server" | "gateway"; baseUrl: string }>;
  listKernelSpecs(serverId: string): Promise<KernelSpecEntry[]>;
  listRunning(serverId: string): Promise<Kernel.IModel[]>;
  startKernel(serverId: string, options: { kernelName: string; path?: string; name?: string }): Promise<RemoteKernelHandle>;
  connectKernel(serverId: string, kernelId: string): Promise<RemoteKernelHandle>;
  interruptKernel(serverId: string, kernelId: string): Promise<void>;
  restartKernel(serverId: string, kernelId: string): Promise<void>;
  shutdownKernel(serverId: string, target: { kernelId?: string; sessionId?: string }): Promise<void>;
  contents(serverId: string): Promise<Contents.IManager>;
  /** Upstream WebSocket target for the browser-facing kernel-channels bridge. */
  kernelChannelTarget(serverId: string, kernelId: string): Promise<{
    url: string;
    headers: Record<string, string>;
    allowUnauthorized: boolean;
    serverName: string;
  }>;
  forget(serverId: string): Promise<void>;
  forgetAll(): Promise<void>;
}

export function createServerRegistry(options?: {
  resolveServer: (serverId: string) => Promise<JupyterServerConfig | undefined>;
  releaseServer?: (serverId: string) => Promise<void>;
  stderr?: NodeJS.WritableStream;
}): JupyterServerRegistry;
