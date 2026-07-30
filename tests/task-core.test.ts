import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Node ESM module outside the TS app graph.
import { CoreTaskManager } from "../server/lib/task-core.mjs";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Core task manager", () => {
  test("pools generic work, runs several tasks concurrently, and queues overflow", async () => {
    const manager = new CoreTaskManager({ maxConcurrent: 2, maxRetained: 10 });
    const releases: Array<() => void> = [];
    let running = 0;
    let maxRunning = 0;
    const run = () => new Promise((resolve) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      releases.push(() => { running -= 1; resolve({ ok: true }); });
    });
    manager.start({ kind: "latex-export", title: "One", run });
    manager.start({ kind: "future-task", title: "Two", run });
    manager.start({ kind: "latex-export", title: "Three", run });
    await turn();
    expect(manager.list({ activeOnly: true }).map((task: { status: string }) => task.status).sort())
      .toEqual(["queued", "running", "running"]);
    expect(maxRunning).toBe(2);
    releases.shift()?.();
    await turn();
    expect(manager.list({ activeOnly: true }).filter((task: { status: string }) => task.status === "running")).toHaveLength(2);
    releases.splice(0).forEach((release) => release());
    await turn();
    expect(manager.list({ activeOnly: true })).toEqual([]);
    expect(manager.list()).toHaveLength(3);
  });

  test("cancels active work and only closes terminal tasks", async () => {
    const manager = new CoreTaskManager({ maxConcurrent: 1 });
    const started = manager.start({
      kind: "latex-export",
      title: "Cancelable",
      run: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("canceled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    });
    await turn();
    expect(manager.close(started.id).ok).toBe(false);
    expect(manager.cancel(started.id).ok).toBe(true);
    await turn();
    expect(manager.get(started.id)?.status).toBe("canceled");
    expect(manager.close(started.id).ok).toBe(true);
    expect(manager.get(started.id)).toBeNull();
  });

  test("keeps progress in bounded snapshots without exposing executable state", async () => {
    const manager = new CoreTaskManager({ maxConcurrent: 1 });
    const started = manager.start({
      kind: "latex-export",
      title: "Export",
      description: "Convert and compile",
      metadata: { file: "note.md" },
      run: ({ progress }: { progress: (text: string) => void }) => {
        for (let index = 0; index < 40; index += 1) progress(`phase ${index}`);
        return { pdfFile: "note.pdf" };
      },
    });
    await turn();
    const task = manager.get(started.id)!;
    expect(task.status).toBe("completed");
    expect(task.progress).toHaveLength(30);
    expect(task.result).toMatchObject({ pdfFile: "note.pdf" });
    expect(task).not.toHaveProperty("run");
    expect(task).not.toHaveProperty("controller");
  });

  test("reruns an opted-in terminal task with a fresh task and controller", async () => {
    const manager = new CoreTaskManager({ maxConcurrent: 1 });
    let runs = 0;
    const first = manager.start({
      kind: "latex-export",
      title: "Retry export",
      restartable: true,
      run: () => {
        runs += 1;
        if (runs === 1) throw new Error("first export failed");
        return { ok: true };
      },
    });
    await turn();
    expect(manager.get(first.id)).toMatchObject({ status: "failed", retryable: true });
    const retry = manager.retry(first.id);
    expect(retry.ok).toBe(true);
    expect(retry.task.id).not.toBe(first.id);
    await turn();
    expect(manager.get(retry.task.id)).toMatchObject({ status: "completed", retryable: true });
    expect(runs).toBe(2);
  });
});
