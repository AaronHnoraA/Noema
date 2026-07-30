import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import {
  ProseCheckLifecycle,
  type ProseCheckContext,
  type ProseCheckOutcome,
  type ProseCheckState,
} from "../aaronnote/prose-check-lifecycle.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  // run -> Promise.race -> apply -> terminal -> pump spans several jobs.
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ProseCheckLifecycle", () => {
  test("debounces automatic checks and caches only an applied signature", async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    let shouldApply = false;
    const lifecycle = new ProseCheckLifecycle<string, string>({
      autoDebounceMs: 40,
      run: async (input) => {
        runs.push(input);
        return input;
      },
      apply: () => shouldApply,
    });

    expect(lifecycle.scheduleAuto("old", "sig-old")).toBe(true);
    expect(lifecycle.scheduleAuto("old duplicate", "sig-old")).toBe(false);
    vi.advanceTimersByTime(20);
    expect(lifecycle.scheduleAuto("new", "sig-new")).toBe(true);
    vi.advanceTimersByTime(39);
    await flushAsync();
    expect(runs).toEqual([]);
    vi.advanceTimersByTime(1);
    await flushAsync();
    expect(runs).toEqual(["new"]);
    expect(lifecycle.appliedAutoSignature).toBeNull();

    // apply=false deliberately leaves the signature retryable.
    shouldApply = true;
    expect(lifecycle.scheduleAuto("retry", "sig-new", 0)).toBe(true);
    vi.advanceTimersByTime(0);
    await flushAsync();
    expect(lifecycle.appliedAutoSignature).toBe("sig-new");
    expect(lifecycle.scheduleAuto("deduplicated", "sig-new", 0)).toBe(false);
  });

  test("manual work keeps ownership of busy state while auto work queues", async () => {
    vi.useFakeTimers();
    const manual = deferred<string>();
    const calls: string[] = [];
    const states: ProseCheckState[] = [];
    let checking = false;
    const lifecycle = new ProseCheckLifecycle<string, string>({
      autoDebounceMs: 0,
      run: async (input) => {
        calls.push(input);
        return input === "manual" ? manual.promise : input;
      },
      apply: () => true,
      onState: (state) => {
        states.push(state);
        if (state.kind === "manual" && state.phase === "running") checking = true;
        if (state.kind === "manual" && state.phase === "terminal") checking = false;
      },
    });

    const manualOutcome = lifecycle.runManual("manual");
    await flushAsync();
    expect(checking).toBe(true);
    expect(lifecycle.scheduleAuto("automatic", "doc-1", 0)).toBe(true);
    vi.advanceTimersByTime(0);
    await flushAsync();
    expect(calls).toEqual(["manual"]);

    manual.resolve("manual result");
    expect((await manualOutcome).terminal).toBe("applied");
    expect(checking).toBe(false);
    vi.advanceTimersByTime(0);
    await flushAsync();
    expect(calls).toEqual(["manual", "automatic"]);
    expect(states.some((state) => state.kind === "manual" && state.phase === "terminal")).toBe(true);
  });

  test("manual work cancels an active auto request and its late result is stale", async () => {
    vi.useFakeTimers();
    const automatic = deferred<string>();
    const manual = deferred<string>();
    const contexts: ProseCheckContext[] = [];
    const applied: string[] = [];
    const cancelled: string[] = [];
    const outcomes: ProseCheckOutcome[] = [];
    const lifecycle = new ProseCheckLifecycle<string, string>({
      autoDebounceMs: 0,
      run: (input, context) => {
        contexts.push(context);
        return input === "auto" ? automatic.promise : manual.promise;
      },
      apply: (result) => {
        applied.push(result);
        return true;
      },
      onCancel: ({ reason }) => {
        cancelled.push(reason);
      },
      onFinally: (outcome) => outcomes.push(outcome),
    });

    lifecycle.scheduleAuto("auto", "doc-1", 0);
    vi.advanceTimersByTime(0);
    await flushAsync();
    expect(lifecycle.activeKind).toBe("auto");

    const manualOutcome = lifecycle.runManual("manual");
    await flushAsync();
    expect(contexts[0]!.signal.aborted).toBe(true);
    expect(cancelled).toEqual(["manual-priority"]);
    expect(lifecycle.activeKind).toBe("manual");

    automatic.resolve("late automatic result");
    await flushAsync();
    expect(applied).toEqual([]);
    manual.resolve("manual result");
    expect((await manualOutcome).terminal).toBe("applied");
    expect(applied).toEqual(["manual result"]);
    expect(outcomes.find((item) => item.kind === "auto")?.terminal).toBe("cancelled");
  });

  test("manual work drops automatic work that was pending before the command", async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const lifecycle = new ProseCheckLifecycle<string, string>({
      autoDebounceMs: 100,
      run: async (input) => {
        runs.push(input);
        return input;
      },
      apply: () => true,
    });

    lifecycle.scheduleAuto("automatic", "doc", 100);
    expect((await lifecycle.runManual("manual")).terminal).toBe("applied");
    vi.advanceTimersByTime(100);
    await flushAsync();

    expect(runs).toEqual(["manual"]);
  });

  test("repeating a manual check cancels and replaces the active request", async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const second = deferred<string>();
    const contexts: ProseCheckContext[] = [];
    const applied: string[] = [];
    const lifecycle = new ProseCheckLifecycle<string, string>({
      run: (input, context) => {
        contexts.push(context);
        return input === "first" ? first.promise : second.promise;
      },
      apply: (result) => {
        applied.push(result);
        return true;
      },
    });

    const firstOutcome = lifecycle.runManual("first");
    await flushAsync();
    const secondOutcome = lifecycle.runManual("second");
    await flushAsync();
    expect(contexts[0]!.signal.aborted).toBe(true);
    expect((await firstOutcome)).toMatchObject({ terminal: "cancelled", reason: "manual-restarted" });

    first.resolve("late");
    second.resolve("latest");
    expect((await secondOutcome).terminal).toBe("applied");
    expect(applied).toEqual(["latest"]);
  });

  test("coalesces auto work behind a manual request and never overlaps runs", async () => {
    vi.useFakeTimers();
    const gates = new Map<string, ReturnType<typeof deferred<string>>>();
    const starts: string[] = [];
    const applied: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const lifecycle = new ProseCheckLifecycle<string, string>({
      autoDebounceMs: 0,
      run: async (input) => {
        starts.push(input);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const gate = deferred<string>();
        gates.set(input, gate);
        try {
          return await gate.promise;
        } finally {
          inFlight -= 1;
        }
      },
      apply: (result) => {
        applied.push(result);
        return true;
      },
    });

    const manualOutcome = lifecycle.runManual("manual");
    await flushAsync();
    lifecycle.scheduleAuto("auto-1", "sig-1", 0);
    lifecycle.scheduleAuto("auto-2", "sig-2", 0);
    lifecycle.scheduleAuto("auto-3", "sig-3", 0);
    vi.advanceTimersByTime(0);
    await flushAsync();
    expect(starts).toEqual(["manual"]);

    gates.get("manual")!.resolve("manual-result");
    await manualOutcome;
    vi.advanceTimersByTime(0);
    await flushAsync();
    expect(starts).toEqual(["manual", "auto-3"]);
    expect(maxInFlight).toBe(1);
    gates.get("auto-3")!.resolve("auto-result");
    await flushAsync();
    expect(applied).toEqual(["manual-result", "auto-result"]);
  });

  test("a newer auto request drains the active request without applying stale data", async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const second = deferred<string>();
    const starts: string[] = [];
    const applied: string[] = [];
    const observed: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const lifecycle = new ProseCheckLifecycle<string, string>({
      autoDebounceMs: 0,
      run: async (input) => {
        starts.push(input);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await (input === "first" ? first.promise : second.promise);
        } finally {
          inFlight -= 1;
        }
      },
      apply: (result) => {
        applied.push(result);
        return true;
      },
      observe: (result) => observed.push(result),
    });

    lifecycle.scheduleAuto("first", "sig-1", 0);
    vi.advanceTimersByTime(0);
    await flushAsync();
    lifecycle.scheduleAuto("second", "sig-2", 0);
    vi.advanceTimersByTime(0);
    await flushAsync();
    expect(starts).toEqual(["first"]);

    first.resolve("old result");
    await flushAsync();
    expect(applied).toEqual([]);
    expect(observed).toEqual(["old result"]);
    vi.advanceTimersByTime(0);
    await flushAsync();
    expect(starts).toEqual(["first", "second"]);
    second.resolve("new result");
    await flushAsync();
    expect(applied).toEqual(["new result"]);
    expect(observed).toEqual(["old result", "new result"]);
    expect(maxInFlight).toBe(1);
  });

  test("deadline aborts the request, emits terminal and finally, and ignores late data", async () => {
    vi.useFakeTimers();
    const gate = deferred<string>();
    const states: ProseCheckState[] = [];
    const final: ProseCheckOutcome[] = [];
    const cancelled: Array<{ reason: string; aborted: boolean }> = [];
    const applied: string[] = [];
    let context: ProseCheckContext | undefined;
    const lifecycle = new ProseCheckLifecycle<string, string>({
      deadlines: { manual: 50 },
      run: (_input, runContext) => {
        context = runContext;
        return gate.promise;
      },
      apply: (result) => {
        applied.push(result);
        return true;
      },
      onState: (state) => states.push(state),
      onFinally: (outcome) => final.push(outcome),
      onCancel: ({ context: cancelledContext, reason }) => {
        cancelled.push({ reason, aborted: cancelledContext.signal.aborted });
      },
    });

    const outcomePromise = lifecycle.runManual("manual");
    await flushAsync();
    vi.advanceTimersByTime(50);
    await flushAsync();
    const outcome = await outcomePromise;
    expect(outcome).toMatchObject({ kind: "manual", terminal: "timeout", reason: "deadline" });
    expect(context?.signal.aborted).toBe(true);
    expect(cancelled).toEqual([{ reason: "deadline", aborted: true }]);
    expect(final).toEqual([outcome]);
    expect(states.at(-1)).toMatchObject({ phase: "terminal", terminal: "timeout" });

    gate.resolve("too late");
    await flushAsync();
    expect(applied).toEqual([]);
    expect(final).toHaveLength(1);
  });

  test("resolves the deadline from live input when a request starts", async () => {
    vi.useFakeTimers();
    const lifecycle = new ProseCheckLifecycle<{ timeoutMs: number }, string>({
      deadlines: { manual: 500 },
      deadlineMs: (input, kind) => kind === "manual" ? input.timeoutMs : 500,
      run: async (_input, context) => new Promise<string>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      }),
      apply: () => true,
    });

    const outcomePromise = lifecycle.runManual({ timeoutMs: 35 });
    await flushAsync();
    vi.advanceTimersByTime(34);
    await flushAsync();
    expect(lifecycle.activeKind).toBe("manual");
    vi.advanceTimersByTime(1);
    await flushAsync();
    await expect(outcomePromise).resolves.toMatchObject({ terminal: "timeout", reason: "deadline" });
  });

  test("pause and invalidate cancel pending or active work and block stale apply", async () => {
    vi.useFakeTimers();
    const gate = deferred<string>();
    const contexts: ProseCheckContext[] = [];
    const applied: string[] = [];
    const terminals: ProseCheckOutcome[] = [];
    const lifecycle = new ProseCheckLifecycle<string, string>({
      autoDebounceMs: 100,
      run: (_input, context) => {
        contexts.push(context);
        return gate.promise;
      },
      apply: (result) => {
        applied.push(result);
        return true;
      },
      onFinally: (outcome) => terminals.push(outcome),
    });

    lifecycle.scheduleAuto("pending", "sig-pending");
    lifecycle.setPaused(true);
    vi.advanceTimersByTime(100);
    await flushAsync();
    expect(contexts).toEqual([]);
    expect(terminals.at(-1)).toMatchObject({ terminal: "cancelled", reason: "paused" });
    expect(lifecycle.scheduleAuto("blocked", "sig-blocked", 0)).toBe(false);

    lifecycle.setPaused(false);
    lifecycle.scheduleAuto("active", "sig-active", 0);
    vi.advanceTimersByTime(0);
    await flushAsync();
    lifecycle.invalidate("note-changed");
    expect(contexts[0]!.signal.aborted).toBe(true);
    gate.resolve("obsolete result");
    await flushAsync();
    expect(applied).toEqual([]);
    expect(terminals.at(-1)).toMatchObject({ terminal: "cancelled", reason: "note-changed" });
  });

  test("dispose cancels work and every accepted task reaches finally exactly once", async () => {
    vi.useFakeTimers();
    const gate = deferred<string>();
    const final: ProseCheckOutcome[] = [];
    const lifecycle = new ProseCheckLifecycle<string, string>({
      autoDebounceMs: 0,
      run: () => gate.promise,
      apply: () => true,
      onFinally: (outcome) => final.push(outcome),
    });

    lifecycle.scheduleAuto("active", "sig", 0);
    vi.advanceTimersByTime(0);
    await flushAsync();
    lifecycle.dispose();
    await flushAsync();
    gate.resolve("late");
    await flushAsync();

    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ terminal: "cancelled", reason: "disposed" });
    expect(lifecycle.scheduleAuto("ignored", "next", 0)).toBe(false);
    expect((await lifecycle.runManual("ignored"))).toMatchObject({ terminal: "cancelled", reason: "disposed" });
    expect(final).toHaveLength(2);
  });
});
