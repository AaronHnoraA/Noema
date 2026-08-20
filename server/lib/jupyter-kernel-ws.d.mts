import type { Server } from "node:http";

export function jupyterKernelWsId(pathname: string): string;

export function installJupyterKernelWebSocket(options: {
  server: Server;
  /**
   * Where to bridge a live kernel id: raw ZMQ for a local or attached kernel,
   * or the remote Jupyter server's own channels endpoint.
   */
  resolveKernelChannel: (id: string) => Promise<
    | { kind: "zmq"; connectionInfo: unknown }
    | { kind: "server"; upstream: { url: string; headers?: Record<string, string>; allowUnauthorized?: boolean; serverName?: string } }
    | undefined
  > | undefined;
  zmq: unknown;
  touchKernel?: (id: string) => void;
  stderr?: NodeJS.WritableStream;
}): { close(): void };
