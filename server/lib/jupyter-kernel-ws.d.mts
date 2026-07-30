import type { Server } from "node:http";

export function jupyterKernelWsId(pathname: string): string;

export function installJupyterKernelWebSocket(options: {
  server: Server;
  resolveConnectionInfo: (id: string) => unknown | undefined | Promise<unknown | undefined>;
  zmq: unknown;
  touchKernel?: (id: string) => void;
  stderr?: NodeJS.WritableStream;
}): { close(): void };
