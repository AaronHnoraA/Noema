import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export function createAgentMcp(invoke?: (channel: string, args?: any[]) => Promise<any>): McpServer;
