import type { MarginNoteBridge } from "./bridge.mjs";
export function startMarginNoteListener(options: { bridge: MarginNoteBridge; token: string; port?: number }): Promise<{
  url: string;
  close(): Promise<void>;
}>;
