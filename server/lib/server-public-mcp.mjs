import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";

import { publicOpenedNote } from "./server-public-catalog.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function createServerPublicMcp(getCatalog) {
  const server = new McpServer({ name: "Noema Public Wiki", version: "1.0.0" }, {
    instructions: "Read-only access to published Noema notes. Only public pages appear here.",
  });

  server.registerTool("search_notes", {
    description: "Search published notes by title, content, tags, or links.",
    inputSchema: {
      query: z.string().min(1),
      repositoryId: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: readOnly,
  }, async (args) => result(getCatalog().search(args)));

  server.registerTool("list_notes", {
    description: "List published notes, optionally within one repository.",
    inputSchema: {
      repositoryId: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: readOnly,
  }, async ({ repositoryId, offset = 0, limit = 40 }) => {
    const catalog = getCatalog();
    const notes = catalog.index.notes.filter((note) => !repositoryId || note.repositoryId === repositoryId);
    return result({ generation: catalog.index.generation, total: notes.length,
      notes: notes.slice(offset, offset + limit), nextOffset: offset + limit < notes.length ? offset + limit : null });
  });

  server.registerTool("read_note", {
    description: "Read the Markdown source of one published note using its public path from search_notes or list_notes.",
    inputSchema: { path: z.string().min(1) },
    annotations: readOnly,
  }, async ({ path }) => {
    try {
      const opened = await publicOpenedNote(getCatalog(), path);
      return result({ path: opened.file, title: opened.title, content: opened.content });
    } catch (error) {
      if (error?.statusCode === 404) return { isError: true, content: [{ type: "text", text: "Published note not found" }] };
      throw error;
    }
  });

  server.registerTool("list_tags", {
    description: "List tags used by published notes and their note counts.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    const counts = new Map();
    for (const note of getCatalog().index.notes) {
      for (const tag of new Set(note.tags || [])) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return result({ tags: [...counts].map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name)) });
  });

  return server;
}

export async function handleServerPublicMcp(req, res, getCatalog) {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
    return;
  }
  const server = createServerPublicMcp(getCatalog);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } finally {
    await server.close();
  }
}
