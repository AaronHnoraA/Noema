import type { WikiIndex } from "./wiki-workspace.mjs";

export type ReadingNeighbor = { file: string; title: string };
export type ReadingNeighbors = { previous: ReadingNeighbor | null; next: ReadingNeighbor | null };

export type ServerPublicCatalog = Readonly<{
  index: Omit<WikiIndex, "notes"> & {
    notes: Array<WikiIndex["notes"][number] & { pinned: boolean; order: number | null }>;
  };
  noteByRef: Map<string, string>;
  assetByRef: Map<string, string>;
  repositoryRootById: Map<string, string>;
  createdAt: string;
  note(ref: string): string;
  neighbors(ref: string): ReadingNeighbors;
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
  mtimeMs: number; size: number; standalone: false; remote: true; pinned: boolean;
} & ReadingNeighbors>;
