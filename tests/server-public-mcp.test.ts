// @vitest-environment node
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "@voidzero-dev/vite-plus-test";

import { handleServerPublicMcp } from "../server/lib/server-public-mcp.mjs";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

test("public MCP serves only published notes without credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "noema-public-mcp-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "visible.md");
  await writeFile(file, "# Public page\n");
  const note = { file: "public/wiki/visible.md", title: "Public page", repositoryId: "public/wiki", tags: ["published"] };
  const catalog = {
    index: { generation: "test", notes: [note] },
    note: (path: string) => path === note.file ? file : "",
    search: () => ({ items: [note], total: 1 }),
  };
  const http = createServer((req, res) => {
    void handleServerPublicMcp(req, res, () => catalog).catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: "noema-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  cleanup.push(() => client.close());

  const tools = (await client.listTools()).tools;
  expect(tools.map((tool) => tool.name).sort()).toEqual(["list_notes", "list_tags", "read_note", "search_notes"]);
  expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
  const listed = await client.callTool({ name: "list_notes", arguments: {} });
  expect(JSON.parse((listed.content as Array<{ text: string }>)[0].text).notes).toEqual([note]);
  const read = await client.callTool({ name: "read_note", arguments: { path: note.file } });
  expect(JSON.parse((read.content as Array<{ text: string }>)[0].text).content).toBe("# Public page\n");
  const hidden = await client.callTool({ name: "read_note", arguments: { path: "private/wiki/secret.md" } });
  expect(hidden.isError).toBe(true);
  expect((hidden.content as Array<{ text: string }>)[0].text).not.toContain(root);
  expect((await client.callTool({ name: "list_tags", arguments: {} })).isError).toBeFalsy();
  expect((await fetch(url)).status).toBe(405);
});
