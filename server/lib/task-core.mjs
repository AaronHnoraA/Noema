import { randomUUID } from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function abortError(message = "Task canceled") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbort(error) {
  return error?.name === "AbortError" || /abort|cancel/i.test(String(error?.message || ""));
}

export class CoreTaskManager {
  constructor({ maxConcurrent = 3, maxPending = 24, maxRetained = 100 } = {}) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 3);
    this.maxPending = Math.max(1, Number(maxPending) || 24);
    this.maxRetained = Math.max(this.maxConcurrent, Number(maxRetained) || 100);
    this.tasks = new Map();
    this.queue = [];
    this.running = 0;
  }

  start({ kind = "task", title = "Task", description = "", metadata = {}, run, restartable = false, exclusiveKey = "" }) {
    if (typeof run !== "function") throw new TypeError("Core task requires a run function");
    const key = String(exclusiveKey || "");
    if (key && [...this.tasks.values()].some((task) => task.exclusiveKey === key && ["queued", "running", "canceling"].includes(task.status))) {
      throw new Error("An equivalent task is already active");
    }
    const active = [...this.tasks.values()].filter((task) => ["queued", "running", "canceling"].includes(task.status)).length;
    if (active >= this.maxConcurrent + this.maxPending) throw new Error("Core task pool is full; close or cancel existing work before adding more");
    const createdAt = nowIso();
    const task = {
      id: randomUUID(), kind: String(kind), title: String(title), description: String(description),
      metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
      status: "queued", phase: "Queued", message: "Waiting for a worker", progress: [],
      createdAt, updatedAt: createdAt, startedAt: "", finishedAt: "", result: null, error: "",
      controller: new AbortController(), run,
      // Keep only an explicitly opted-in restart closure.  A retry always gets
      // a fresh task id/controller and never attempts to revive an old process.
      restart: restartable ? run : null,
      exclusiveKey: key,
    };
    this.tasks.set(task.id, task);
    this.queue.push(task.id);
    this.#prune();
    this.#drain();
    return this.snapshot(task);
  }

  list({ kind = "", activeOnly = false } = {}) {
    return [...this.tasks.values()]
      .filter((task) => !kind || task.kind === kind)
      .filter((task) => !activeOnly || ["queued", "running", "canceling"].includes(task.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((task) => this.snapshot(task));
  }

  get(id) {
    const task = this.tasks.get(String(id || ""));
    return task ? this.snapshot(task) : null;
  }

  cancel(id) {
    const task = this.tasks.get(String(id || ""));
    if (!task) return { ok: false, message: "Task not found" };
    if (task.status === "queued") {
      this.queue = this.queue.filter((queuedId) => queuedId !== task.id);
      task.controller.abort();
      task.status = "canceled";
      task.phase = "Canceled";
      task.message = "Canceled before starting";
      task.finishedAt = task.updatedAt = nowIso();
      task.run = null;
      this.#drain();
      return { ok: true, task: this.snapshot(task) };
    }
    if (task.status === "running") {
      task.status = "canceling";
      task.phase = "Canceling";
      task.message = "Waiting for the active process to stop";
      task.updatedAt = nowIso();
      task.controller.abort();
      return { ok: true, task: this.snapshot(task) };
    }
    return { ok: false, message: `Task is already ${task.status}`, task: this.snapshot(task) };
  }

  retry(id) {
    const task = this.tasks.get(String(id || ""));
    if (!task) return { ok: false, message: "Task not found" };
    if (!["completed", "failed", "canceled"].includes(task.status)) {
      return { ok: false, message: `Task is still ${task.status}`, task: this.snapshot(task) };
    }
    if (typeof task.restart !== "function") {
      return { ok: false, message: "Task cannot be rerun", task: this.snapshot(task) };
    }
    let retried;
    try {
      retried = this.start({
        kind: task.kind,
        title: task.title,
        description: task.description,
        metadata: task.metadata,
        run: task.restart,
        restartable: true,
        exclusiveKey: task.exclusiveKey,
      });
    } catch (error) {
      return { ok: false, message: String(error?.message || error), task: this.snapshot(task) };
    }
    return { ok: true, task: retried, previousId: task.id };
  }

  close(id) {
    const task = this.tasks.get(String(id || ""));
    if (!task) return { ok: false, message: "Task not found" };
    if (["queued", "running", "canceling"].includes(task.status)) {
      return { ok: false, message: "Cancel an active task before closing it", task: this.snapshot(task) };
    }
    this.tasks.delete(task.id);
    return { ok: true, id: task.id };
  }

  snapshot(task) {
    return {
      id: task.id, kind: task.kind, title: task.title, description: task.description,
      metadata: { ...task.metadata }, status: task.status, phase: task.phase, message: task.message,
      progress: task.progress.map((entry) => ({ ...entry })), createdAt: task.createdAt,
      updatedAt: task.updatedAt, startedAt: task.startedAt, finishedAt: task.finishedAt,
      result: task.result && typeof task.result === "object" ? { ...task.result } : task.result,
      error: task.error, cancellable: ["queued", "running"].includes(task.status),
      retryable: typeof task.restart === "function" && ["completed", "failed", "canceled"].includes(task.status),
      closeable: ["completed", "failed", "canceled"].includes(task.status),
    };
  }

  #progress(task, text) {
    if (!text || !["running", "canceling"].includes(task.status)) return;
    const at = nowIso();
    task.phase = String(text).replace(/…+$/, "").trim() || task.phase;
    task.message = String(text).trim();
    task.updatedAt = at;
    task.progress.push({ at, text: task.message });
    if (task.progress.length > 30) task.progress.splice(0, task.progress.length - 30);
  }

  #drain() {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      const task = this.tasks.get(id);
      if (!task || task.status !== "queued") continue;
      this.running += 1;
      task.status = "running";
      task.phase = "Starting";
      task.message = "Task started";
      task.startedAt = task.updatedAt = nowIso();
      Promise.resolve()
        .then(() => {
          if (task.controller.signal.aborted) throw abortError();
          return task.run({ signal: task.controller.signal, progress: (text) => this.#progress(task, text) });
        })
        .then((result) => {
          if (task.controller.signal.aborted) throw abortError();
          task.status = "completed";
          task.phase = "Completed";
          task.message = "Task completed";
          task.result = result ?? null;
        })
        .catch((error) => {
          if (task.controller.signal.aborted || isAbort(error)) {
            task.status = "canceled";
            task.phase = "Canceled";
            task.message = "Task canceled";
          } else {
            task.status = "failed";
            task.phase = "Failed";
            task.message = String(error?.message || error || "Task failed");
            task.error = task.message;
          }
        })
        .finally(() => {
          task.finishedAt = task.updatedAt = nowIso();
          task.run = null;
          this.running = Math.max(0, this.running - 1);
          this.#prune();
          this.#drain();
        });
    }
  }

  #prune() {
    if (this.tasks.size <= this.maxRetained) return;
    const terminal = [...this.tasks.values()]
      .filter((task) => ["completed", "failed", "canceled"].includes(task.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    while (this.tasks.size > this.maxRetained && terminal.length > 0) this.tasks.delete(terminal.shift().id);
  }
}

export const coreTasks = new CoreTaskManager();
