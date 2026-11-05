import type { MarginNoteConnection } from "../plugins/marginnote/client.mjs";
export function buildAddon(config: MarginNoteConnection | null, source: string, target: string): Promise<void>;
