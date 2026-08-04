import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import { createWikiAutoSync } from "../server/lib/wiki-auto-sync.mjs";

afterEach(() => {
  vi.useRealTimers();
});

describe("Wiki automatic synchronization", () => {
  test("syncs at startup and the periodic pass flushes a dirty repository without per-save commits", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = createWikiAutoSync({
      startupMs: 20,
      debounceMs: 1_000,
      periodicMs: 100,
      periodicJitterMs: 0,
      async sync(repositoryId) {
        calls.push(repositoryId);
        return { phase: "idle" };
      },
    });

    scheduler.start(["public/README"]);
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toEqual(["public/README"]);
    scheduler.mark("public/README");
    await vi.advanceTimersByTimeAsync(79);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["public/README", "public/README"]);
    await scheduler.close();
  });

  test("debounces each repository independently", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = createWikiAutoSync({
      debounceMs: 100,
      periodicMs: 0,
      async sync(repositoryId) {
        calls.push(repositoryId);
        return { phase: "idle" };
      },
    });

    scheduler.mark("public/Math");
    await vi.advanceTimersByTimeAsync(50);
    scheduler.mark("public/Math");
    scheduler.mark("private/research");
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.sort()).toEqual(["private/research", "public/Math"]);
    await scheduler.close();
  });

  test("never overlaps one repository and runs once more after an in-flight edit", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const scheduler = createWikiAutoSync({
      debounceMs: 10,
      periodicMs: 0,
      async sync() {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) await first;
        active -= 1;
        return { phase: "idle" };
      },
    });

    scheduler.mark("public/README");
    await vi.advanceTimersByTimeAsync(10);
    scheduler.mark("public/README");
    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    await scheduler.close();
  });

  test("keeps the historical two-repository concurrency limit", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const scheduler = createWikiAutoSync({
      startupMs: 10,
      periodicMs: 0,
      maxConcurrency: 2,
      async sync() {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { phase: "idle" };
      },
    });

    scheduler.start(["public/AI", "public/Bio", "public/CS"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(2);
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(3);
    while (releases.length) releases.shift()?.();
    await Promise.resolve();
    expect(maxActive).toBe(2);
    await scheduler.close();
  });

  test("retries an error state and flushes a pending repository on close", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const scheduler = createWikiAutoSync({
      debounceMs: 100,
      retryMs: 500,
      periodicMs: 0,
      async sync() {
        calls += 1;
        return { phase: calls === 1 ? "error" : "idle" };
      },
    });

    scheduler.mark("public/AI");
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(2);

    scheduler.mark("public/Bio");
    await scheduler.close({ flush: true });
    expect(calls).toBe(3);
  });

  test("uses a local checkpoint callback rather than network sync when closing", async () => {
    vi.useFakeTimers();
    const actions: string[] = [];
    const scheduler = createWikiAutoSync({
      debounceMs: 1_000,
      periodicMs: 0,
      async sync(repositoryId) {
        actions.push(`sync:${repositoryId}`);
        return { phase: "idle" };
      },
      async flush(repositoryId) {
        actions.push(`checkpoint:${repositoryId}`);
        return { phase: "idle" };
      },
    });

    scheduler.mark("private/research");
    await scheduler.close({ flush: true });
    expect(actions).toEqual(["checkpoint:private/research"]);
  });
});
