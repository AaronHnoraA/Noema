// Ambient types for the ported @nteract/messaging wire-protocol module.

export interface RawJupyterMessage {
  header: Record<string, unknown>;
  parent_header: Record<string, unknown>;
  metadata: Record<string, unknown>;
  content: unknown;
  buffers: Buffer[];
  idents: Buffer[];
}

export function decode(messageFrames: Buffer[], key?: string, scheme?: string): RawJupyterMessage;
export function encode(message: Partial<RawJupyterMessage>, key?: string, scheme?: string): Buffer[];
