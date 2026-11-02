#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { agentToolGuide, callAgentApi, fullChannel } from "../server/lib/agent-api-client.mjs";

const PI_MARK = "[From Pi, not the person] ";

/** What Pi tells an Agent says so.  This is code because a model drops the mark
 * as soon as a request says to answer with nothing else. */
export function markPiMessage(channel, args, caller = process.env.NOEMA_CALLER) {
  const [body, ...rest] = args;
  if (caller !== "pi" || fullChannel(channel) !== "noema:api:emacs:agent" || body?.action !== "send"
      || typeof body.prompt !== "string" || body.prompt.startsWith(PI_MARK)) return args;
  return [{ ...body, prompt: PI_MARK + body.prompt }, ...rest];
}

export function createAgentMcp(invoke = callAgentApi) {
  const server = new McpServer({ name: "Noema API", version: "1.0.0" }, {
    instructions: agentToolGuide(),
  });
  const wrap = (fn) => async (args) => {
    try {
      const value = await fn(args);
      return { isError: value?.ok === false, content: [{ type: "text", text: JSON.stringify(value) }] };
    } catch (error) { return { isError: true, content: [{ type: "text", text: String(error.message || error) }] }; }
  };
  server.registerTool("noema_api", {
    description: "Search live Noema API names, purposes and aliases (e.g. emacs open file, emacs-open, 打开文件), or describe one known channel. Parameters are disclosed on demand; source:true adds the implementation. An empty search does not prove an API is absent.",
    inputSchema: { query: z.string().optional(), channel: z.string().optional(), source: z.boolean().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, wrap(({ channel, source, ...search }) => channel
    ? invoke("noema:api:agent:describe", [{ channel, source }]) : invoke("noema:api:agent:discover", [search])));
  server.registerTool("noema_call", {
    description: "Invoke one Noema backend API, through its existing handlers and UI notifications. Most channels take one object: args=[{\"action\":\"list\"}]. May change local state or invoke external services depending on channel.",
    inputSchema: { channel: z.string(), args: z.array(z.unknown()).default([]).describe("Usually one object holding the fields, as the channel's description shows") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, wrap(({ channel, args }) => invoke(channel, markPiMessage(channel, args))));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  await createAgentMcp().connect(new StdioServerTransport());
