// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "@voidzero-dev/vite-plus-test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMarginNoteHttpHandler } from "../server/Features/MarginNote/api.mjs";
import { createMarginNoteBridge } from "../server/Features/MarginNote/bridge.mjs";
import { startMarginNoteListener } from "../server/Features/MarginNote/listener.mjs";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function setup() {
  const bridge = createMarginNoteBridge({ pollMs: 5 });
  cleanups.push(() => bridge.close());
  return bridge;
}
async function register(bridge: ReturnType<typeof setup>, sessionId = "window1") {
  await bridge.poll({ sessionId, info: { appVersion: "4.4.6" } });
}

describe("MarginNote native mailbox", () => {
  it("MN-C3/C4: disconnected requests remain unknown but can be reclaimed after retention", async () => {
    const bridge = setup(); await register(bridge);
    const job = bridge.submit({ code: "return 1", requestId: "disconnected" });
    await bridge.poll({ sessionId: "window1" });
    bridge.disconnect("window1");
    expect(await job).toMatchObject({ state: "disconnected", execution: "unknown" });
    const future = Date.now() + 16 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(future);
    expect(bridge.list().sessions).toHaveLength(0);
    expect(() => bridge.request("disconnected")).toThrow("Unknown requestId");
  });
  it("MN-C3: keeps an unresolved running identity beyond result retention and accepts late completion", async () => {
    const bridge = setup(); await register(bridge);
    const job = bridge.submit({ code: "return 1", timeoutMs: 100, requestId: "old-running" });
    await bridge.poll({ sessionId: "window1" });
    expect(await job).toMatchObject({ execution: "unknown" });
    const future = Date.now() + 16 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(future);
    bridge.heartbeat({ sessionId: "window1" }); bridge.list();
    expect(bridge.request("old-running")).toMatchObject({ execution: "unknown" });
    await bridge.poll({ sessionId: "window1", completed: { id: "old-running", ok: true, value: 1 } });
    expect(bridge.request("old-running")).toMatchObject({ lateResult: { value: 1 } });
    expect(bridge.list().sessions[0].running).toBeNull();
    const next = bridge.submit({ code: "return 2", requestId: "next" });
    expect((await bridge.poll({ sessionId: "window1" })).task?.id).toBe("next");
    await bridge.poll({ sessionId: "window1", completed: { id: "next", ok: true, value: 2 } });
    expect(await next).toMatchObject({ value: 2 });
  });
  it("MN-C3: replays an unacknowledged envelope after a lost poll response", async () => {
    const bridge = setup(); await register(bridge);
    const job = bridge.submit({ code: "return 1", requestId: "delivery" });
    const first = (await bridge.poll({ sessionId: "window1" })).task;
    expect((await bridge.poll({ sessionId: "window1" })).task).toEqual(first);
    await bridge.poll({ sessionId: "window1", completed: { id: "delivery", ok: true, value: 1 } });
    expect(await job).toMatchObject({ ok: true, value: 1 });
  });
  it("MN-C2/C3: sends code to the selected native session and returns its result once", async () => {
    const bridge = setup(); await register(bridge);
    const job = bridge.submit({ code: "return db.allDocuments()", requestId: "request1" });
    const task = (await bridge.poll({ sessionId: "window1" })).task!;
    expect(task.code).toBe("return db.allDocuments()");
    await bridge.poll({ sessionId: "window1", completed: { id: task.id, ok: true, value: ["native document"] } });
    expect(await job).toMatchObject({ ok: true, value: ["native document"] });
    expect(await bridge.submit({ code: task.code, requestId: task.id })).toEqual(await job);
    expect((await bridge.poll({ sessionId: "window1" })).task).toBeNull();
  });
  it("MN-C3: never delivers an expired queued mutation", async () => {
    const bridge = setup(); await register(bridge);
    const result = await bridge.submit({ code: "db.deleteBookNote('x')", timeoutMs: 100 });
    expect(result).toMatchObject({ state: "timed_out", execution: "not_started" });
    expect((await bridge.poll({ sessionId: "window1" })).task).toBeNull();
  });
  it("MN-C3: a running timeout keeps its unknown outcome and admits a late result", async () => {
    const bridge = setup(); await register(bridge);
    const job = bridge.submit({ code: "return 1", timeoutMs: 100, requestId: "late" });
    await bridge.poll({ sessionId: "window1" });
    expect(await job).toMatchObject({ state: "timed_out", execution: "unknown" });
    await bridge.poll({ sessionId: "window1", completed: { id: "late", ok: true, value: 1 } });
    expect(bridge.request("late")).toMatchObject({ state: "timed_out", lateResult: { ok: true, value: 1 } });
  });
  it("MN-C2: refuses ambiguous windows and results belonging to another window", async () => {
    const bridge = setup(); await register(bridge); await register(bridge, "window2");
    expect(() => bridge.submit({ code: "return 1" })).toThrow("Choose sessionId");
    const job = bridge.submit({ code: "return 1", sessionId: "window1", requestId: "owned" });
    await bridge.poll({ sessionId: "window1" });
    await expect(bridge.poll({ sessionId: "window2", completed: { id: "owned", ok: true } })).rejects.toThrow("does not belong");
    bridge.disconnect("window1");
    expect(await job).toMatchObject({ execution: "unknown" });
  });
  it("MN-C3/C4: closes long polls and unclaimed jobs on shutdown", async () => {
    const bridge = setup(); await register(bridge);
    const poll = bridge.poll({ sessionId: "window2" });
    const job = bridge.submit({ code: "return 1", sessionId: "window1" });
    bridge.close();
    expect(await poll).toMatchObject({ task: null });
    expect(await job).toMatchObject({ state: "disconnected", execution: "not_started" });
  });
  it("MN-C3: does not let a reused request ID replace a mutation", async () => {
    const bridge = setup(); await register(bridge);
    const job = bridge.submit({ code: "return 1", requestId: "same" });
    expect(() => bridge.submit({ code: "return 2", requestId: "same" })).toThrow("different code");
    bridge.close(); await job;
  });
});

describe("MarginNote HTTP isolation", () => {
  it("MN-C2/C5: preserves split UTF-8 bytes, rejects oversized bodies and handles malformed URLs", async () => {
    const submit = vi.fn(async (body) => ({ ok: true, code: body.code, requestId: "test", sessionId: "test", state: "completed" }));
    const handle = createMarginNoteHttpHandler({ bridge: { ...setup(), submit }, token: "test-token" });
    async function request(chunks: Buffer[], url = "/v1/marginnote/execute", origin?: string) {
      const req = Object.assign(Readable.from(chunks), { url, method: "POST", socket: { remoteAddress: "127.0.0.1" },
        headers: { authorization: "Bearer test-token", ...(origin ? { origin } : {}) } });
      let status = 0, result: any;
      await handle(req as unknown as IncomingMessage, { destroyed: false, writeHead(code: number) { status = code; }, end(body: string) { result = JSON.parse(body); } } as unknown as ServerResponse);
      return { status, result };
    }
    const bytes = Buffer.from(JSON.stringify({ code: "return '眼睛批注'" }));
    const split = bytes.indexOf(Buffer.from("眼")) + 1;
    expect(await request([bytes.subarray(0, split), bytes.subarray(split)])).toMatchObject({ status: 200, result: { code: "return '眼睛批注'" } });
    expect((await request([Buffer.alloc(2 * 1024 * 1024 + 1)])).status).toBe(413);
    expect((await request([], "//[")).status).toBe(400);
    expect((await request([bytes], undefined, "null")).status).toBe(401);
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("MN-C5: authenticates native/agent traffic and exposes no other Noema routes", async () => {
    const bridge = setup();
    const listener = await startMarginNoteListener({ bridge, token: "test-token", port: 0 });
    cleanups.push(() => listener.close());
    const url = listener.url;
    expect((await fetch(url + "/sessions")).status).toBe(401);
    const headers = { Authorization: "Bearer test-token" };
    expect((await fetch(url + "/sessions", { headers })).status).toBe(200);
    expect((await fetch(url + "/sessions", { headers: { ...headers, Origin: "https://example.com" } })).status).toBe(401);
    expect((await fetch(new URL("/api", url), { headers })).status).toBe(404);
    expect((await fetch(url + "/execute", { method: "POST", headers, body: "invalid json" })).status).toBe(400);
    const native = fetch(url + "/poll", { method: "POST", headers, body: JSON.stringify({ sessionId: "native" }) });
    await native;
    const pending = fetch(url + "/execute", { method: "POST", headers,
      body: JSON.stringify({ code: "return 42", requestId: "over-http" }) });
    let task;
    for (let i = 0; i < 3 && !task; i++) task = (await (await fetch(url + "/poll", { method: "POST", headers, body: JSON.stringify({ sessionId: "native" }) })).json()).task;
    expect(task?.id).toBe("over-http");
    await fetch(url + "/poll", { method: "POST", headers,
      body: JSON.stringify({ sessionId: "native", completed: { id: task.id, ok: true, value: 42 } }) });
    expect(await (await pending).json()).toMatchObject({ ok: true, value: 42 });
  });
});
