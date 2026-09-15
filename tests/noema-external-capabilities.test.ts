import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExternalSource, validateExternalSources } from "../server/lib/noema-external-capabilities.mjs";
import type { ExternalCapabilitySource } from "../server/lib/noema-external-capabilities.mjs";

async function fixture(format: ExternalCapabilitySource["format"], text: string, run: (result: any) => void) {
  const root = await mkdtemp(join(tmpdir(), "noema-native-"));
  try {
    await writeFile(join(root, "native"), text);
    run(await loadExternalSource({ id: "native", format, config: "native" }, root, { TEST_VALUE: "fixture-value" }));
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("native capability library adapters", () => {
  test("OpenCode JSONC command arrays and env references", async () => fixture("opencode", `{
    // A native configuration; unrelated providers are not imported.
    "mcp": { "local": { "type": "local", "command": ["node", "server.mjs"], "environment": { "VALUE": "{env:TEST_VALUE}" }, "enabled": false, }, },
    "provider": { "ignored": {} },
  }`, (result) => {
    expect(result.state).toBe("available");
    expect(result.config.mcp.servers).toEqual([{ id: "local", type: "stdio", default_enabled: false,
      description: "Linked opencode MCP; enable explicitly in Noema.", command: "node", args: ["server.mjs"], env: [{ name: "VALUE", value: "fixture-value" }] }]);
    expect(result.config.mcp.disabled).toEqual(["local"]);
  }));

  test.each(["claude", "pi"] as const)("%s standard mcpServers layout", async (format) => fixture(format,
    JSON.stringify({ mcpServers: { search: { type: "sse", url: "https://example.test/sse", headers: { "X-Key": "${TEST_VALUE}" } } } }),
    (result) => {
      expect(result.config.mcp.servers[0]).toMatchObject({ type: "sse", default_enabled: false, headers: [{ name: "X-Key", value: "fixture-value" }] });
    }));

  test("does not discard native security restrictions or leak syntax errors", async () => {
    await fixture("codex", '[mcp_servers.restricted]\ncommand="node"\nenabled_tools=["read"]\n', (result) => {
      expect(result.errors.get("restricted")[0]).toContain("enabled_tools");
    });
    await fixture("codex", 'secret = "private-syntax-fragment', (result) => {
      expect(result.state).toBe("error");
      expect(JSON.stringify(result)).not.toContain("private-syntax-fragment");
    });
    await fixture("claude", '{"mcpServers":{"server":{"command":"node","env":{"KEY":"${MISSING}"}}}}', (result) => {
      expect(result.errors.get("server")).toContain("Missing environment variable: MISSING");
    });
  });

  test("missing optional libraries and duplicate source ids", async () => {
    expect((await loadExternalSource({ id: "pi", format: "pi", config: "missing" }, "/nonexistent-noema", {})).state).toBe("missing");
    expect(() => validateExternalSources([{ id: "a", format: "codex" }, { id: "a", format: "pi" }])).toThrow(/unique/);
  });

  test("an imported noema id cannot shadow the live built-in endpoint", async () => fixture("pi",
    '{"mcpServers":{"noema":{"command":"node"}}}', (result) => {
      expect(result.config.mcp.servers[0].id).toBe("external-native-reserved-noema");
      expect(result.errors.get("external-native-reserved-noema")[0]).toContain("reserved");
    }));
});
