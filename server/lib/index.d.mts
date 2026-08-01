export function configure(options?: {
  root?: string;
  workspaceRoot?: string;
  workspaceLayout?: "legacy" | "wiki";
  stateRoot?: string;
  [key: string]: unknown;
}): void;
export function assetRefsFromContent(content: string, noteFile: string): string[];
