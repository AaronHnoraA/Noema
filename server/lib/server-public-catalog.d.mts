import type { WikiIndex } from "./wiki-workspace.mjs";

export type ServerPublicCatalog = Readonly<{
  index: WikiIndex;
  noteByRef: Map<string, string>;
  assetByRef: Map<string, string>;
  repositoryRootById: Map<string, string>;
  createdAt: string;
  note(ref: string): string;
  search(body?: Record<string, unknown>): {
    ok: true; type: "wiki-search"; generation: string; items: WikiIndex["notes"]; total: number; nextCursor: number | null;
  };
  resolveLink(target: string, sourceFile?: string): unknown;
  asset(source: string, baseRef: string): string;
}>;

export function buildServerPublicCatalog(
  fullIndex: WikiIndex,
  config: { repositories: readonly Array<{ id: string }> },
): Promise<ServerPublicCatalog>;
export function publicOpenedNote(catalog: ServerPublicCatalog, ref: string): Promise<{
  type: "open"; file: string; title: string; mode: "markdown"; content: string; kind: string;
  mtimeMs: number; size: number; standalone: false; remote: true;
}>;
