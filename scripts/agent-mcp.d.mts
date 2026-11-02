import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export function markPiMessage(channel: string, args: any[], caller?: string): any[];
export function createAgentMcp(invoke?: (channel: string, args?: any[]) => Promise<any>): McpServer;
