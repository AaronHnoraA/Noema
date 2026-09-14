import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { pumpResearchRunStream } from "../server/lib/research-run-stream.mjs";

describe("research Run SSE pump", () => {
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
});
