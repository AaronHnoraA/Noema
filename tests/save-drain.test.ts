import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { SaveDrain } from "../aaronnote/save-drain.ts";

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
