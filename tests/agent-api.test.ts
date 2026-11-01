import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ApiRouter } from "../server/infrastructure/api-router.mjs";
import { createAgentApiHandlers, proposeMarkdown } from "../server/Features/Agent/api.mjs";
import { scanEdiffBlocks, ediffSide, approvedEdiffMarkdown } from "../shared/ediff-source.mjs";
import { createAgentMcp } from "../scripts/agent-mcp.mjs";
import { main } from "../scripts/agent-api.mjs";
import { callAgentApi } from "../server/lib/agent-api-client.mjs";
import { createEmacsApiHandlers } from "../server/Features/Emacs/api.mjs";

describe("Pi global butler API", () => {
  test("discovers file opening by purpose and alias, describes it, then preserves the chat by default", async () => {
    const opened: any[] = [];
    const router = new ApiRouter().register(createEmacsApiHandlers({
      apiOpenInEmacs: (...args: any[]) => { opened.push(args); return { ok: true, buffer: "document" }; },
    } as any));
    const call = async (channel: string, args: any[] = []): Promise<any> => router.call(channel, args);
    router.register(createAgentApiHandlers({ router, call }));
    for (const query of ["emacs open file", "emacs-open", "emacsopen", "emacs visit", "打开文件"]) {
      const names = await call("noema:api:agent:discover", [{ query }]);
      expect(names.channels[0]).toBe("noema:api:emacs:open");
      expect(JSON.stringify(names)).not.toContain("implementation");
    }
    expect(opened).toEqual([]);
    const doc = await call("noema:api:agent:describe", [{ channel: "noema:api:emacs:open" }]);
    expect(doc.parameters[0].placement).toContain("other");
    const body = { file: "/project/design.md" };
    await call("noema:api:agent:call", [{ channel: "noema:api:emacs:open", args: [body] }]);
    expect(opened.at(-1)[4]).toEqual({ ...body, placement: "other" });
    expect(body).toEqual({ file: "/project/design.md" });
    await call("noema:api:agent:call", [{ channel: "noema:api:emacs:open", args: [{ ...body, placement: "here" }] }]);
    expect(opened.at(-1)[4].placement).toBe("here");
    await call("noema:api:agent:call", [{ channel: "noema:api:emacs:open", args: [body.file] }]);
    expect(opened.at(-1)[4].placement).toBe("other");
    await call("noema:api:agent:call", [{ channel: "noema:api:emacs:open", args: [{ ...body, newWindow: true }] }]);
    expect(opened.at(-1)[4].placement).toBeUndefined();
    // Direct page callers keep their existing visit/clone behavior.
    await call("noema:api:emacs:open", [body]);
    expect(opened.at(-1)[4].placement).toBeUndefined();
    const count = opened.length;
    await expect(call("noema:api:agent:call", [{ channel: "noema:api:emacs:open", args: [] }]))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(opened).toHaveLength(count);
  });

  test("discovers and describes shared Agent operations, then forwards exact identity", async () => {
    const requests: unknown[] = [];
    const unused = () => { throw new Error("Unrelated editor operation"); };
    const router = new ApiRouter().register(createEmacsApiHandlers({
      apiOpenInEmacs: unused, apiOpenSurface: unused, apiSelectJupyterCell: unused,
      apiCurrentFile: unused, apiEmacsInputFocus: unused, apiEmacsUiState: unused,
      apiEmacsKey: unused, apiSystemOpen: unused, apiEmacsZotero: unused, apiChooseNotePath: unused,
      apiPi: (body) => { requests.push(body); return { ok: true, context: { file: "/tmp/source.md" } }; },
      apiAgent: (body) => { requests.push(body); return { ok: true, accepted: true }; },
    }));
    const call = async (channel: string, args: any[] = []): Promise<any> => router.call(channel, args);
    router.register(createAgentApiHandlers({ router, call }));
    const names = await call("noema:api:agent:discover", [{ query: "emacs agent" }]);
    expect(JSON.stringify(names)).toContain("noema:api:emacs:agent");
    expect(requests).toHaveLength(0);
    const doc = await call("noema:api:agent:describe", [{ channel: "noema:api:emacs:agent" }]);
    expect(JSON.stringify(doc)).toContain("nativeSessionId");
    expect(requests).toHaveLength(0);
    await call("noema:api:agent:call", [{ channel: "noema:api:emacs:pi", args: [{ action: "context" }] }]);
    const payload = { action: "send", buffer: "*worker*", nativeSessionId: "native-exact", prompt: "Explicit task" };
    await call("noema:api:agent:call", [{ channel: "noema:api:emacs:agent", args: [payload] }]);
    expect(requests).toEqual([{ action: "context" }, payload]);
  });
});

describe("Agent Markdown proposals", () => {
  test.each(["before\nalpha beta gamma\nafter\n", "alpha beta gamma", "\nalpha beta gamma\n", "😀 alpha beta gamma\n"])("preserves partial-line original and unselected source: %j", (source) => {
    const from = source.indexOf("beta");
    const output = proposeMarkdown(source, [{ from, to: from + 4, oldText: "beta", newText: "BETA", title: "Clarify" }]);
    expect(approvedEdiffMarkdown(output)).toBe(source);
    const block = scanEdiffBlocks(output)[0];
    expect(block.error).toBeUndefined();
    const accepted = output.slice(0, block.from) + ediffSide(block, "new") + output.slice(block.end);
    expect(accepted).toBe(source.replace("beta", "BETA"));
  });

  test.each([
    ["first\nsecond\n", 5, 6, ""],
    ["first\nsecond\n", 0, 0, "new\n"],
    ["first\n", 6, 6, "last"],
    ["", 0, 0, "new"],
    ["first\nsecond\n", 0, 6, ""],
  ] as const)("round-trips insertion, deletion and missing newline", (source, from, to, insert) => {
    const output = proposeMarkdown(source, [{ from, to, oldText: source.slice(from, to), newText: insert }]);
    expect(approvedEdiffMarkdown(output)).toBe(source);
    const block = scanEdiffBlocks(output)[0];
    expect(block.error).toBeUndefined();
    expect(output.slice(0, block.from) + ediffSide(block, "new") + output.slice(block.end))
      .toBe(source.slice(0, from) + insert + source.slice(to));
  });

  test("revises feedback without accepting or replacing the original", () => {
    const source = "intro\n#+begin ediff Fix\n@@ediff-status rejected\n@@ediff-comment \"too strong\"\n-old\n+first proposal\n#+end ediff\nend\n";
    const block = scanEdiffBlocks(source)[0];
    const output = proposeMarkdown(source, [{ from: block.from, to: block.end,
      oldText: source.slice(block.from, block.end), newText: "qualified proposal\n" }]);
    expect(approvedEdiffMarkdown(output)).toBe("intro\nold\nend\n");
    expect(scanEdiffBlocks(output)).toHaveLength(1);
    expect(ediffSide(scanEdiffBlocks(output)[0], "new")).toBe("qualified proposal\n");
    expect(output).not.toContain("@@ediff-");
    expect(() => proposeMarkdown(source, [{ from: block.from + 1, to: block.end,
      oldText: source.slice(block.from + 1, block.end), newText: "wrong" }])).toThrow("whole");
  });

  test("rejects stale source and overlapping line expansions atomically", () => {
    expect(() => proposeMarkdown("abc\n", [{ from: 0, to: 1, oldText: "z", newText: "A" }])).toThrow("oldText");
    expect(() => proposeMarkdown("abc\n", [
      { from: 0, to: 1, oldText: "a", newText: "A" },
      { from: 2, to: 3, oldText: "c", newText: "C" },
    ])).toThrow("overlap");
  });
});

describe("progressive live API", () => {
  test.each(["agent-api.mjs", "agent-mcp.mjs"])("starts %s through an Emacs directory symlink", async (filename) => {
    const temporary = mkdtempSync(join(tmpdir(), "noema-agent-entry-"));
    const linked = join(temporary, "emacs-noema");
    symlinkSync(resolve("."), linked, "dir");
    try {
      const script = join(linked, "scripts", filename);
      if (filename === "agent-api.mjs") {
        const { stdout } = await promisify(execFile)(process.execPath, [script, "help"], { timeout: 5000 });
        expect(JSON.parse(stdout).usage).toHaveLength(3);
      } else {
        const client = new Client({ name: "symlink-startup-test", version: "1" });
        const transport = new StdioClientTransport({ command: process.execPath, args: [script], stderr: "pipe" });
        try {
          await client.connect(transport);
          expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["noema_api", "noema_call"]);
        } finally { await client.close(); await transport.close(); }
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  function fixture() {
    let content = "😀 old text\n";
    let version = "v1";
    let race = false;
    const saved: any[] = [];
    const router = new ApiRouter().register({
      "noema:api:notes:open": () => ({ file: "/tmp/a.md", content, version }),
      "noema:api:notes:save": (body: any) => {
        saved.push(body);
        if (race) return { ok: false, conflict: true };
        content = body.content;
        version = "v2";
        return { ok: true, version };
      },
      "noema:api:test:sum": (a: number, b: number) => a + b,
      "noema:api:research:permission:decide": () => { throw new Error("Human decision handler must not be reached"); },
    });
    const call = async (channel: string, args: any[] = []): Promise<any> => router.call(channel, args);
    router.register(createAgentApiHandlers({ router, call }));
    return { router, call, saved, setRace: () => { race = true; } };
  }

  test("discovers names without implementations, and describes one actual handler", async () => {
    const { router, call } = fixture();
    const result = await call("noema:api:agent:discover", [{ query: "agent document", limit: 1 }]);
    expect(result.total).toBe(2);
    expect(result.nextOffset).toBe(1);
    expect(JSON.stringify(result)).not.toContain("implementation");
    const detail = await call("noema:api:agent:describe", [{ channel: "noema:api:agent:document:propose" }]);
    expect(detail.parameters[0].baseVersion).toContain("version");
    expect((await call("noema:api:agent:describe", [{ channel: "agent:document:propose" }])).channel).toBe("noema:api:agent:document:propose");
    expect(detail.arguments).toContain("[{");
    await expect(call("noema:api:agent:call", [{ channel: "noema:api:agent:document:read", args: [["a.md"]] }])).rejects.toThrow(/takes one object/);
    router.register({ "noema:api:late": () => 1 });
    expect((await call("noema:api:agent:discover", [{ query: "late" }])).total).toBe(1);
    await expect(call("noema:api:agent:describe", [{ channel: "absent" }])).rejects.toMatchObject({ statusCode: 404 });
  });

  test("reads UTF-16 ranges and writes through canonical save with exact CAS", async () => {
    const { call, saved } = fixture();
    const read = await call("noema:api:agent:document:read", [{ file: "/tmp/a.md", range: {
      from: { line: 1, column: 3 }, to: { line: 1, column: 6 },
    } }]);
    expect(read.content).toBe("old");
    const args = { file: "/tmp/a.md", baseVersion: read.version,
      edits: [{ from: read.from, to: read.to, oldText: read.content, newText: "new" }] };
    expect(await call("noema:api:agent:document:propose", [args])).toMatchObject({ ok: true, version: "v2" });
    expect(saved[0]).toMatchObject({ baseVersion: "v1", seq: 1 });
    expect(saved[0].force).toBeUndefined();
    expect(approvedEdiffMarkdown(saved[0].content)).toBe("😀 old text\n");
    expect(await call("noema:api:agent:document:propose", [args])).toMatchObject({ ok: false, conflict: true });
    expect(saved).toHaveLength(1);
  });

  test("propagates a concurrent save conflict without a force retry", async () => {
    const { call, saved, setRace } = fixture();
    setRace();
    expect(await call("noema:api:agent:document:propose", [{ file: "/tmp/a.md", baseVersion: "v1",
      edits: [{ from: 3, to: 6, oldText: "old", newText: "new" }] }])).toMatchObject({ ok: false, conflict: true });
    expect(saved).toHaveLength(1);
  });

  test("CLI and two-tool MCP expose the same live registry and preserve positional args", async () => {
    const { call } = fixture();
    expect(await main(["call", "noema:api:test:sum", "-"], call, async () => "[2,3]")).toBe(5);
    const server = createAgentMcp(call);
    const client = new Client({ name: "test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(left), client.connect(right)]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["noema_api", "noema_call"]);
      const result = await client.callTool({ name: "noema_call", arguments: { channel: "noema:api:test:sum", args: [2, 3] } });
      expect(result.content).toEqual([{ type: "text", text: "5" }]);
      expect((await client.callTool({ name: "noema_call", arguments: { channel: "unknown", args: [] } })).isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  });

  test("HTTP client dispatches through /api without replaying an unknown transport outcome", async () => {
    const requests: any[] = [];
    expect(await callAgentApi("noema:api:test:sum", [2, 3], {
      connection: async () => "http://127.0.0.1:1",
      fetcher: async (_url: any, options: any) => { requests.push(JSON.parse(options.body)); return new Response("5"); },
    })).toBe(5);
    expect(requests).toEqual([{ channel: "noema:api:agent:call", args: [{ channel: "noema:api:test:sum", args: [2, 3] }] }]);
    let attempts = 0;
    await expect(callAgentApi("noema:api:notes:save", [{}], {
      connection: async () => "http://127.0.0.1:1",
      fetcher: async () => { attempts++; throw new Error("disconnected"); },
    })).rejects.toThrow("outcome may be unknown");
    expect(attempts).toBe(1);
  });

  test("Agent dispatch retains human decision boundaries while exposing their contracts", async () => {
    const { call } = fixture();
    expect(await call("noema:api:agent:call", [{ channel: "noema:api:test:sum", args: [2, 3] }])).toBe(5);
    const channel = "noema:api:research:permission:decide";
    expect(await call("noema:api:agent:describe", [{ channel }])).toMatchObject({ agentCallable: false, audience: "human" });
    await expect(call("noema:api:agent:call", [{ channel, args: [{}] }])).rejects.toMatchObject({ statusCode: 403 });
    await expect(call("noema:api:agent:call", [{ channel: "noema:api:agent:call", args: [] }])).rejects.toThrow("Nested");
  });
});

test("what Pi tells an Agent is marked by code, once, and only for Pi", async () => {
  const { markPiMessage } = await import("../scripts/agent-mcp.mjs");
  const send = [{ action: "send", buffer: "b", nativeSessionId: "n", prompt: "pong" }];
  expect(markPiMessage("emacs:agent", send, "pi")[0].prompt).toBe("[From Pi, not the person] pong");
  expect(markPiMessage("noema:api:emacs:agent", markPiMessage("emacs:agent", send, "pi"), "pi")[0].prompt).toBe("[From Pi, not the person] pong");
  expect(markPiMessage("emacs:agent", send, undefined)).toBe(send);
  expect(markPiMessage("emacs:pi", send, "pi")).toBe(send);
  expect(markPiMessage("emacs:agent", [{ action: "read" }], "pi")[0]).toEqual({ action: "read" });
});
