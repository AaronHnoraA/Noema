import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import { defaultSaveRetryDelayMs, SaveDrain } from "../aaronnote/save-drain.ts";

describe("SaveDrain", () => {
  test("coalesces edits made in flight and applies the first mtime before the follow-up write", async () => {
    let revision = 1;
    let savedRevision = 0;
    let mtimeMs = 100;
    let releaseFirst!: (mtimeMs: number) => void;
    const firstResult = new Promise<number>((resolve) => { releaseFirst = resolve; });
    const writes: Array<{ revision: number; baseMtimeMs: number }> = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;

    const drain = new SaveDrain({
      capture: () => revision === savedRevision ? null : { revision, baseMtimeMs: mtimeMs },
      async write(snapshot) {
        writes.push(snapshot);
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        const result = writes.length === 1 ? await firstResult : 300;
        activeWrites -= 1;
        return result;
      },
      apply(snapshot, result) {
        mtimeMs = result;
        savedRevision = Math.max(savedRevision, snapshot.revision);
      },
      fail(error) {
        throw error;
      },
    });

    const first = drain.request();
    revision = 2;
    const joined = drain.request();
    expect(joined).toBe(first);
    releaseFirst(200);
    await first;

    expect(writes).toEqual([
      { revision: 1, baseMtimeMs: 100 },
      { revision: 2, baseMtimeMs: 200 },
    ]);
    expect(maxActiveWrites).toBe(1);
    expect(savedRevision).toBe(2);
  });

  test("stops after a rejected result and leaves the latest revision dirty", async () => {
    let revision = 1;
    let savedRevision = 0;
    let attempts = 0;
    const drain = new SaveDrain({
      capture: () => revision === savedRevision ? null : { revision },
      async write() {
        attempts += 1;
        revision = 2;
        return { conflict: true };
      },
      apply: () => false,
      fail(error) {
        throw error;
      },
    });

    await drain.request();
    expect(attempts).toBe(1);
    expect(savedRevision).toBe(0);
    expect(revision).toBe(2);
  });
});

describe("SaveDrain retry", () => {
  test("retries a thrown write with backoff until it succeeds", async () => {
    vi.useFakeTimers();
    try {
      let revision = 1;
      let savedRevision = 0;
      let attempts = 0;
      const delays: Array<number | null> = [];
      const drain = new SaveDrain({
        capture: () => revision === savedRevision ? null : { revision },
        async write() {
          attempts += 1;
          if (attempts < 3) throw new Error("host restarting");
          return "ok";
        },
        apply(snapshot) {
          savedRevision = snapshot.revision;
        },
        fail(_error, _snapshot, retryInMs) {
          delays.push(retryInMs);
        },
        retryDelayMs: defaultSaveRetryDelayMs,
      });

      await drain.request();
      expect(attempts).toBe(1);
      expect(drain.retryPending()).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(attempts).toBe(3);
      expect(delays).toEqual([1_000, 2_000]);
      expect(savedRevision).toBe(1);
      expect(drain.retryPending()).toBe(false);
      revision = 2;
      await drain.request();
      expect(savedRevision).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an explicit request replaces a pending retry and cancelRetry drops it", async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      let writes = 0;
      const drain = new SaveDrain({
        capture: () => writes < 5 ? { n: writes } : null,
        async write() {
          writes += 1;
          if (fail) throw new Error("down");
          writes = 5;
          return true;
        },
        apply: () => true,
        fail: () => {},
        retryDelayMs: () => 10_000,
      });
      await drain.request();
      expect(drain.retryPending()).toBe(true);
      drain.cancelRetry();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(writes).toBe(1);
      fail = false;
      await drain.request();
      expect(drain.retryPending()).toBe(false);
      expect(writes).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  test("never retries without a retry policy", async () => {
    let writes = 0;
    const drain = new SaveDrain({
      capture: () => ({}),
      async write() {
        writes += 1;
        throw new Error("down");
      },
      apply: () => true,
      fail: () => {},
    });
    await drain.request();
    expect(drain.retryPending()).toBe(false);
    expect(writes).toBe(1);
  });
});
