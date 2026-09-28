import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface PublicMcpCatalog {
  index: {
    generation: string;
    notes: Array<{ file: string; title?: string; repositoryId?: string; tags?: string[] }>;
  };
  note(path: string): string;
  search(args: { query: string; repositoryId?: string; limit?: number }): unknown;
}

export function createServerPublicMcp(getCatalog: () => PublicMcpCatalog): McpServer;
export function handleServerPublicMcp(
  req: IncomingMessage,
  res: ServerResponse,
  getCatalog: () => PublicMcpCatalog,
): Promise<void>;
