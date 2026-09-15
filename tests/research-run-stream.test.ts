import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { pumpResearchRunStream } from "../server/lib/research-run-stream.mjs";

describe("research Run SSE pump", () => {
  test("unchanged idle snapshots are suppressed and polling backs off", async () => {
    let calls = 0;
    const run = vi.fn(async () => ({ run: { id: "run_1", status: ++calls < 6 ? "running" : "completed" } }));
    const write = vi.fn();
    const wait = vi.fn(async (_ms: number) => {});
    await pumpResearchRunStream({ service: { run }, root: "/project", runId: "run_1", detail: "status", pollMs: 150, write, wait });
    expect(write).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls.map((args) => args[0])).toEqual([150, 300, 600, 1000, 1000]);
  });

  test("terminal reconnect drains every page before declaring the stream finished", async () => {
    const liveRun = vi.fn()
      .mockResolvedValueOnce({ run: { id: "run_1", status: "completed" }, events: [{ seq: 1 }, { seq: 2 }], seq: 2 })
      .mockResolvedValueOnce({ run: { id: "run_1", status: "completed" }, events: [{ seq: 3 }, { seq: 4 }], seq: 4 })
      .mockResolvedValueOnce({ run: { id: "run_1", status: "completed" }, events: [], seq: 4 });
    const snapshots: any[] = [];
    const wait = vi.fn(async () => {});
    expect(await pumpResearchRunStream({ service: { liveRun }, root: "/project", runId: "run_1", limit: 2,
      write: (snapshot) => { snapshots.push(snapshot); }, wait })).toBe(4);
    expect(snapshots.map((snapshot) => Boolean(snapshot.hasMore))).toEqual([true, true, false]);
    expect(snapshots.flatMap((snapshot) => snapshot.events).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(wait).not.toHaveBeenCalled();
  });

  test("resumes by durable sequence and closes only after publishing terminal state", async () => {
    const liveRun = vi.fn()
      .mockResolvedValueOnce({ run: { id: "run_1", status: "running" }, events: [{ seq: 8 }], seq: 8 })
      .mockResolvedValueOnce({ run: { id: "run_1", status: "completed" }, events: [{ seq: 9 }], seq: 9 });
    const snapshots: any[] = [];
    const seq = await pumpResearchRunStream({
      service: { liveRun }, root: "/project", runId: "run_1", after: 7,
      write: (snapshot) => { snapshots.push(snapshot); }, wait: async () => {},
    });
    expect(seq).toBe(9);
    expect(snapshots).toHaveLength(2);
    expect(liveRun).toHaveBeenNthCalledWith(1, { root: "/project", runId: "run_1", after: 7, limit: 200 });
    expect(liveRun).toHaveBeenNthCalledWith(2, { root: "/project", runId: "run_1", after: 8, limit: 200 });
  });

  test("does not fetch or write after the connection is closed", async () => {
    const liveRun = vi.fn();
    const write = vi.fn();
    await expect(pumpResearchRunStream({
      service: { liveRun }, root: "/project", runId: "run_1", closed: () => true, write,
    })).resolves.toBe(0);
    expect(liveRun).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test("status mode polls only Run metadata and never fetches event payloads", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ root: "/project", run: { id: "run_1", status: "running" } })
      .mockResolvedValueOnce({ root: "/project", run: { id: "run_1", status: "completed" } });
    const liveRun = vi.fn();
    const snapshots: any[] = [];
    await pumpResearchRunStream({
      service: { run, liveRun }, root: "/project", runId: "run_1", detail: "status",
	  write: (snapshot) => { snapshots.push(snapshot); }, wait: async () => {},
    });
    expect(liveRun).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(2);
    expect(snapshots.every((snapshot) => Array.isArray(snapshot.events) && snapshot.events.length === 0)).toBe(true);
  });
});
