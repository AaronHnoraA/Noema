#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { apiReference, call } from "./client.mjs";

export function createMarginNoteMcp(invoke = call) {
  const server = new McpServer({ name: "Noema MarginNote", version: "1.0.0" }, {
    instructions: "Operate Noema in MarginNote through the named device's official Bridge. Query marginnote_api for declarations and marginnote_status for the active panel's window, then pin sessionId. marginnote_open explicitly shows the plugin panel; other tools do not open it. Execute JavaScript function bodies with return/await. For native callback APIs call bridge.defer() then bridge.done(value) or bridge.fail(error). All native globals are available; app, db, window, study, reader, notebook, args, bridge and console are convenience bindings. bridge.state retains native objects per window. This is full native authority, not a sandbox. Return explicit JSON fields rather than native object graphs. A timeout after execution started means outcome unknown: inspect request status and the business target; never retry a mutation automatically.",
  });
  const wrap = (fn) => async (args) => {
    try {
      const result = await fn(args);
      return { isError: result.ok === false, content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: "text", text: String(error.message || error) }] }; }
  };
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  const device = z.enum(["mac", "ipad"]).default("mac");
  server.registerTool("marginnote_status", { description: "Read the active Noema panel's native window and installed version through the named device's official Bridge.", inputSchema: {device}, annotations: readOnly }, wrap(({device}) => invoke("/sessions", undefined, {device})));
  server.registerTool("marginnote_open", { description: "Show the existing Noema panel using MarginNote's official addon command. Changes the visible UI; requires the user's task to authorize operating the plugin.", inputSchema: {device}, annotations: {readOnlyHint:false,destructiveHint:false,idempotentHint:true} }, wrap(({device}) => invoke("/open", undefined, {device})));
  server.registerTool("marginnote_api", { description: "Search the complete upstream JSB API declaration snapshot, including Foundation/UIKit. Actual support depends on installed MarginNote; use bridge.globals()/bridge.inspect(object) to probe.",
    inputSchema: { query: z.string().default(""), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(30).default(10) }, annotations: readOnly }, wrap(({ query, offset, limit }) => apiReference(query, offset, limit)));
  server.registerTool("marginnote_execute", { description: "Execute arbitrary JavaScript in the active Noema panel's native window, with full host API access and async/await. Code is a function body; use return for JSON results. Mutations have native effects. Pin the sessionId returned by status; a changed window is rejected.",
    inputSchema: { device, code: z.string().min(1), args: z.record(z.string(), z.unknown()).optional(), sessionId: z.string().optional(),
      requestId: z.string().optional(), timeoutMs: z.number().int().min(100).max(120000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, wrap(({device, ...args}) => invoke("/execute", args, {device})));
  server.registerTool("marginnote_result", { description: "Inspect running/completed or timed-out requests, including late native results. Does not repeat execution.", inputSchema: { device, requestId: z.string(), sessionId: z.string().optional() }, annotations: readOnly }, wrap(({ device, requestId, sessionId }) => invoke("/requests/" + encodeURIComponent(requestId), {sessionId}, {device})));
  return server;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const server = createMarginNoteMcp();
  await server.connect(new StdioServerTransport());
}
