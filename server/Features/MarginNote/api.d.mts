import type { IncomingMessage, ServerResponse } from "node:http";
import type { MarginNoteBridge } from "./bridge.mjs";
export function createMarginNoteHttpHandler(options: { bridge: MarginNoteBridge; token: string }):
  (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
