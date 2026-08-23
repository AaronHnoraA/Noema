export function configure(options?: {
  root?: string;
  workspaceRoot?: string;
  workspaceLayout?: "legacy" | "wiki";
  stateRoot?: string;
  [key: string]: unknown;
}): void;
export function assetRefsFromContent(content: string, noteFile: string): string[];
export function scanRoamNotes(): Promise<Array<{
  id?: string;
  title?: string;
  path?: string;
  file?: string;
  tags?: string[];
  refs?: string[];
  backlinks?: string[];
  [key: string]: unknown;
}>>;
