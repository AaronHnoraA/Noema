#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { callAgentApi } from "../server/lib/agent-api-client.mjs";

export function createAgentMcp(invoke = callAgentApi) {
  const server = new McpServer({ name: "Noema API", version: "1.0.0" }, {
    instructions: "Use noema_api to search live API names or describe one channel, then noema_call with positional args. Disclose only the operation needed. For Markdown revisions, document:read then document:propose; Noema creates review cards and the person accepts. Never replace this with direct file edits. Keep existing authorization and version checks; after transport interruption inspect current state before retrying mutations.",
  });
  const wrap = (fn) => async (args) => {
    try {
      const value = await fn(args);
      return { isError: value?.ok === false, content: [{ type: "text", text: JSON.stringify(value) }] };
    } catch (error) { return { isError: true, content: [{ type: "text", text: String(error.message || error) }] }; }
  };
  server.registerTool("noema_api", {
    description: "Search live Noema API names, or describe one channel. Parameters and implementation are disclosed on demand.",
    inputSchema: { query: z.string().optional(), channel: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, wrap(({ channel, ...search }) => channel
    ? invoke("noema:api:agent:describe", [{ channel }]) : invoke("noema:api:agent:discover", [search])));
  server.registerTool("noema_call", {
    description: "Invoke one discovered Noema backend API, through its existing handlers and UI notifications. May change local state or invoke external services depending on channel.",
    inputSchema: { channel: z.string(), args: z.array(z.unknown()).default([]) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, wrap(({ channel, args }) => invoke(channel, args)));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  await createAgentMcp().connect(new StdioServerTransport());
