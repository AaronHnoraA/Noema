#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { apiReference, call } from "./client.mjs";

export function createMarginNoteMcp(invoke = call) {
  const server = new McpServer({ name: "Noema MarginNote", version: "1.0.0" }, {
    instructions: "Operate MarginNote through its native JSB plugin runtime. Query marginnote_api for declarations, marginnote_status for windows. Execute JavaScript function bodies with return/await. For native callback APIs call bridge.defer() then bridge.done(value) or bridge.fail(error). All native globals are available; app, db, window, study, reader, notebook, args, bridge and console are convenience bindings. bridge.state retains native objects per window. Return explicit JSON fields rather than native object graphs. A timeout after execution started means outcome unknown: inspect request status before deciding what to do; never retry a mutation automatically.",
  });
  const wrap = (fn) => async (args) => {
    try {
      const result = await fn(args);
      return { isError: result.ok === false, content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: "text", text: String(error.message || error) }] }; }
  };
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  server.registerTool("marginnote_status", { description: "List connected native MarginNote windows and their installed version, document and notebook context.", inputSchema: {}, annotations: readOnly }, wrap(() => invoke("/sessions")));
  server.registerTool("marginnote_api", { description: "Search the complete upstream JSB API declaration snapshot, including Foundation/UIKit. Actual support depends on installed MarginNote; use bridge.globals()/bridge.inspect(object) to probe.",
    inputSchema: { query: z.string().default(""), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(30).default(10) }, annotations: readOnly }, wrap(({ query, offset, limit }) => apiReference(query, offset, limit)));
  server.registerTool("marginnote_execute", { description: "Execute arbitrary JavaScript in the native MarginNote plugin, with full host API access and async/await. Code is a function body; use return for JSON results. Mutations have native effects. Select sessionId when multiple windows are connected.",
    inputSchema: { code: z.string().min(1), args: z.record(z.string(), z.unknown()).optional(), sessionId: z.string().optional(),
      requestId: z.string().optional(), timeoutMs: z.number().int().min(100).max(120000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, wrap((args) => invoke("/execute", args)));
  server.registerTool("marginnote_result", { description: "Inspect queued/running/completed or timed-out requests, including late native results. Does not repeat execution.", inputSchema: { requestId: z.string() }, annotations: readOnly }, wrap(({ requestId }) => invoke("/requests/" + encodeURIComponent(requestId))));
  return server;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const server = createMarginNoteMcp();
  await server.connect(new StdioServerTransport());
}
