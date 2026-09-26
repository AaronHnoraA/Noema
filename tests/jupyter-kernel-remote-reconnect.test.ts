import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createKernelRegistry } from "../server/jupyter/kernel-registry.mjs";

function makeSignal(owner: object) {
  const handlers = new Set<(sender: object, value?: unknown) => void>();
  return {
    connect(handler: (sender: object, value?: unknown) => void) {
      handlers.add(handler);
    },
    disconnect(handler: (sender: object, value?: unknown) => void) {
      handlers.delete(handler);
    },
    emit(value?: unknown) {
      for (const handler of handlers) handler(owner, value);
    },
  };
}

function fakeKernel({ responsive = true } = {}) {
  const kernel: any = {
    username: "test-user",
    clientId: "test-client",
    connectionStatus: "connected",
    disposed: 0,
  };
  kernel.connectionStatusChanged = makeSignal(kernel);
  kernel.iopubMessage = makeSignal(kernel);
  const reply = { content: { status: "ok", language_info: { name: "python" } } };
  const answer = () => {
    if (!responsive) return new Promise(() => {});
    queueMicrotask(() => kernel.iopubMessage.emit({}));
    return Promise.resolve(reply);
  };
  kernel.requestKernelInfo = answer;
  kernel.sendControlMessage = () => ({ done: answer() });
  kernel.dispose = () => {
    kernel.disposed += 1;
    kernel.connectionStatus = "disconnected";
    kernel.connectionStatusChanged.emit("disconnected");
  };
  return kernel;
}

describe("remote Jupyter kernel reconnect", () => {
  test("a failed provider rebind stays disconnected and retries the same server kernel", async () => {
    const original = fakeKernel();
    const failedRoute = fakeKernel({ responsive: false });
    const recovered = fakeKernel();
    const afterRestart = fakeKernel();
    let starts = 0;
    let connects = 0;
    let shutdowns = 0;
    const serverRegistry = {
      async startKernel() {
        starts += 1;
        return {
          model: { id: "kernel-stable", name: "python3" },
          sessionId: "session-stable",
          kernel: original,
          connectionVersion: "route-1",
        };
      },
      async refresh() {
        // Simulate another server operation having refreshed the provider
        // first: registry.changed is false, but this record still has route-1.
        return { changed: false, version: "route-2" };
      },
      async connectKernel(_serverId: string, kernelId: string) {
        expect(kernelId).toBe("kernel-stable");
        connects += 1;
        return {
          model: { id: kernelId, name: "python3" },
          sessionId: "",
          kernel: connects === 1 ? failedRoute : connects === 2 ? recovered : afterRestart,
          connectionVersion: "route-2",
        };
      },
      async restartKernel() {},
      async shutdownKernel() {
        shutdowns += 1;
      },
    };
    const registry = createKernelRegistry({
      runtimeDir: "/tmp",
      zmq: {},
      serverRegistry: serverRegistry as any,
      launchTimeoutMs: 20,
      shutdownGraceMs: 0,
      stderr: { write() { return true; } } as any,
    });

    const target = { serverId: "lab", kernelSpecName: "python3" };
    const first = await registry.ensureServer("note\0server:lab:python3", "python3", target);
    expect(first.status).toBe("idle");

    await expect(
      registry.ensureServer("note\0server:lab:python3", "python3", target),
    ).rejects.toThrow(/reconnecting/);
    expect(first.status).toBe("disconnected");
    expect(first.serverKernelId).toBe("kernel-stable");
    expect(registry.get("note\0server:lab:python3")).toBeUndefined();
    expect(starts).toBe(1);

    const rebound = await registry.ensureServer(
      "note\0server:lab:python3", "python3", target,
    );
    expect(rebound).toBe(first);
    expect(rebound.status).toBe("idle");
    expect(registry.get("note\0server:lab:python3")).toBe(rebound);
    expect(rebound.serverKernelId).toBe("kernel-stable");
    expect(rebound.stateLost).not.toBe(true);
    expect(starts).toBe(1);
    expect(connects).toBe(2);

    const restarted = await registry.restart("note\0server:lab:python3");
    expect(restarted).toBe(first);
    expect(restarted.status).toBe("idle");
    expect(restarted.stateLost).toBe(true);
    expect(restarted.serverKernelId).toBe("kernel-stable");
    expect(connects).toBe(3);
    expect(recovered.disposed).toBe(1);

    await registry.shutdownAll();
    expect(shutdowns).toBe(1);
  });

  test("disconnecting an adopted server kernel never shuts it down", async () => {
    const adopted = fakeKernel();
    let shutdowns = 0;
    const serverRegistry = {
      async connectKernel(_serverId: string, kernelId: string) {
        return {
          model: { id: kernelId, name: "python3" },
          sessionId: "",
          kernel: adopted,
          connectionVersion: "route-1",
        };
      },
      async refresh() {
        return { changed: false, version: "route-1" };
      },
      async shutdownKernel() {
        shutdowns += 1;
      },
    };
    const registry = createKernelRegistry({
      runtimeDir: "/tmp",
      zmq: {},
      serverRegistry: serverRegistry as any,
      launchTimeoutMs: 20,
      shutdownGraceMs: 0,
      stderr: { write() { return true; } } as any,
    });

    const record = await registry.ensureServer(
      "note\0server:lab:kernel:existing",
      "server:lab:kernel:existing",
      { serverId: "lab", kernelId: "existing" },
    );
    expect(record.serverOwned).toBe(false);
    await registry.shutdownAll();
    expect(adopted.disposed).toBe(1);
    expect(shutdowns).toBe(0);
  });
});
