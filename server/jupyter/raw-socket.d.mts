// Ambient types for the ported vscode-jupyter RawSocket (WebSocket-shaped
// front end over ZMQ). Kept loose (`unknown`/`any`-ish) since consumers only
// need it to satisfy @jupyterlab/services' `IWebSocket`-like duck type.

export interface KernelConnectionInfo {
  key: string;
  signature_scheme: string;
  transport: "tcp" | "ipc";
  ip: string;
  hb_port: number;
  control_port: number;
  shell_port: number;
  stdin_port: number;
  iopub_port: number;
  kernel_name?: string;
}

export class RawSocket {
  onopen: (event: { target: unknown }) => void;
  onerror: (event: { error: unknown; message: string; type: string; target: unknown }) => void;
  onclose: (event: { wasClean: boolean; code: number; reason: string; target: unknown }) => void;
  onmessage: (event: { data: unknown; type: string; target: unknown }) => void;
  readonly protocol: string;
  constructor(
    connection: KernelConnectionInfo,
    serialize: (msg: unknown) => string | ArrayBuffer,
    zmq: unknown,
    options?: { stderr?: NodeJS.WritableStream },
  );
  dispose(): void;
  close(): void;
  emit(event: string, ...args: unknown[]): boolean;
  send(data: unknown, callback?: unknown): void;
  addReceiveHook(hook: (data: unknown) => Promise<void>): void;
  removeReceiveHook(hook: (data: unknown) => Promise<void>): void;
  addSendHook(hook: (data: unknown, cb?: (err?: Error) => void) => Promise<void>): void;
  removeSendHook(hook: (data: unknown, cb?: (err?: Error) => void) => Promise<void>): void;
}
