import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Node ESM modules live outside the TS application graph.
import { createKernelSupervisor, kernelBaseFromOutput, localKernelRoot, normalizeKernelBase, resolveKernelLaunchConfig } from "../server/lib/kernel-supervisor.mjs";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

function response(payload: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    async json() { return payload; },
  } as Response;
}

describe("shared kernel supervisor", () => {
  test("accepts only explicit loopback bases and local note roots", () => {
    expect(normalizeKernelBase("http://127.0.0.1:43127/")).toBe("http://127.0.0.1:43127");
    expect(() => normalizeKernelBase("http://localhost:43127")).toThrow(/127\.0\.0\.1/);
    expect(() => normalizeKernelBase("https://127.0.0.1:43127")).toThrow(/127\.0\.0\.1/);
    expect(kernelBaseFromOutput("boot\n[noema-kernel] http://127.0.0.1:43127\n"))
      .toBe("http://127.0.0.1:43127");
    expect(localKernelRoot("/tmp/Noema")).toBe(true);
    expect(localKernelRoot("/fs:remote/Documents/Noema")).toBe(false);
    expect(localKernelRoot("fs://remote/Documents/Noema")).toBe(false);
  });

  test("resolves one canonical binary and keeps workspace data outside the note root", async () => {
    const suite = await mkdtemp(join(tmpdir(), "noema-kernel-config-"));
    cleanups.push(suite);
    const binary = join(suite, "noema-kernel");
    const runtimeRoot = join(suite, "runtime");
    const stateRoot = join(suite, "state");
    await writeFile(binary, "kernel");
    await chmod(binary, 0o755);
    await mkdir(join(runtimeRoot, "app", "appearance", "langs"), { recursive: true });

    const config = resolveKernelLaunchConfig({
      env: { NOEMA_KERNEL_BIN: binary, PATH: "" },
      runtimeRoot,
      stateRoot,
      execPath: join(suite, "node"),
      platform: "darwin",
      arch: "arm64",
    });
    expect(config).toMatchObject({
      enabled: true,
      owned: true,
      binary,
      workingDir: join(runtimeRoot, "app"),
      workspace: join(stateRoot, "kernel-workspace"),
      configDir: join(stateRoot, "kernel-config"),
    });
    expect(resolveKernelLaunchConfig({
      env: { NOEMA_KERNEL_BIN: join(suite, "missing-kernel"), PATH: suite },
      runtimeRoot,
      stateRoot,
      execPath: join(suite, "node"),
      platform: "darwin",
      arch: "arm64",
    })).toMatchObject({
      enabled: false,
      reason: expect.stringContaining("configured kernel executable is not runnable"),
    });
  });

  test("attaches an externally managed kernel and detaches providers on health loss", async () => {
    const states: string[] = [];
    let healthy = true;
    const supervisor = createKernelSupervisor({
      env: { NOEMA_KERNEL_BASE: "http://127.0.0.1:43127" },
      runtimeRoot: "/tmp/runtime",
      stateRoot: "/tmp/state",
      noteRoot: "/tmp/notes",
      healthIntervalMs: 10,
      restartDelayMs: 10,
      fetchImpl: async (url: string) => {
        if (!healthy) throw new Error("kernel offline");
        if (String(url).endsWith("/api/system/bootProgress")) {
          return response({ code: 0, data: { progress: 100 } });
        }
        return response({ code: 0, data: { box: { id: "box-1", root: "/tmp/notes" } } });
      },
      stderr: { write() {} } as unknown as NodeJS.WritableStream,
      onState(state: { state: string }) { states.push(state.state); },
    });

    void supervisor.start();
    await waitFor(() => supervisor.status().state === "listening");
    expect(supervisor.status()).toMatchObject({
      state: "listening",
      baseUrl: "http://127.0.0.1:43127",
      owned: false,
      box: { id: "box-1", root: "/tmp/notes" },
    });
    healthy = false;
    await waitFor(() => states.includes("degraded"));
    await supervisor.close();
    expect(states).toContain("listening");
    expect(states).toContain("degraded");
  });

  test("owns discovery, supervisor pid, and graceful shutdown for both host adapters", async () => {
    const suite = await mkdtemp(join(tmpdir(), "noema-kernel-owned-"));
    cleanups.push(suite);
    const binary = join(suite, "noema-kernel");
    const runtimeRoot = join(suite, "runtime");
    const stateRoot = join(suite, "state");
    const noteRoot = join(suite, "notes");
    await writeFile(binary, "kernel");
    await chmod(binary, 0o755);
    await mkdir(join(runtimeRoot, "app", "appearance", "langs"), { recursive: true });
    await mkdir(noteRoot);

    const signals: string[] = [];
    let spawnedArgs: string[] = [];
    let spawnedEnv: NodeJS.ProcessEnv = {};
    const spawnImpl = (_file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawnedArgs = args;
      spawnedEnv = options.env || {};
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill(signal: string): boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal: string) => {
        signals.push(signal);
        queueMicrotask(() => child.emit("exit", 0, signal));
        return true;
      };
      queueMicrotask(() => {
        child.stdout.write("[noema-");
        child.stdout.write("kernel] http://127.0.0.1:43128\n");
      });
      return child;
    };
    const supervisor = createKernelSupervisor({
      env: { NOEMA_KERNEL_BIN: binary, PATH: "" },
      runtimeRoot,
      stateRoot,
      noteRoot,
      supervisorPid: 4242,
      spawnImpl: spawnImpl as never,
      fetchImpl: async (url: string) => String(url).endsWith("/api/system/bootProgress")
        ? response({ code: 0, data: { progress: 100 } })
        : response({ code: 0, data: { box: { id: "box-owned", root: noteRoot } } }),
      stderr: { write() {} } as unknown as NodeJS.WritableStream,
      healthIntervalMs: 10_000,
    });

    void supervisor.start();
    await waitFor(() => supervisor.status().state === "listening");
    expect(spawnedArgs).toEqual(expect.arrayContaining([
      "serve",
      "--workspace", join(stateRoot, "kernel-workspace"),
      "--wd", join(runtimeRoot, "app"),
      "--supervisor-pid", "4242",
    ]));
    expect(spawnedEnv.NOEMA_KERNEL_CONFIG_DIR).toBe(join(stateRoot, "kernel-config"));
    expect(supervisor.status()).toMatchObject({
      state: "listening",
      baseUrl: "http://127.0.0.1:43128",
      owned: true,
    });
    await supervisor.close();
    expect(signals).toContain("SIGTERM");
    expect(signals).not.toContain("SIGKILL");
  });

  test("keeps starting while a first external-box registration builds its index", async () => {
    let registrationFinished = false;
    let bootProbes = 0;
    const states: string[] = [];
    const supervisor = createKernelSupervisor({
      env: { NOEMA_KERNEL_BASE: "http://127.0.0.1:43129" },
      runtimeRoot: "/tmp/runtime",
      stateRoot: "/tmp/state",
      noteRoot: "/tmp/notes",
      requestTimeoutMs: 5,
      bootTimeoutMs: 40,
      registrationTimeoutMs: 1_000,
      registrationProbeIntervalMs: 10,
      healthIntervalMs: 10_000,
      fetchImpl: async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/api/system/bootProgress")) {
          bootProbes++;
          return response({ code: 0, data: { progress: 100 } });
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            registrationFinished = true;
            resolve();
          }, 120);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(init.signal?.reason || new Error("aborted"));
          }, { once: true });
        });
        return response({ code: 0, data: { box: { id: "box-slow", root: "/tmp/notes" } } });
      },
      stderr: { write() {} } as unknown as NodeJS.WritableStream,
      onState(state: { state: string }) { states.push(state.state); },
    });

    void supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registrationFinished).toBe(false);
    expect(supervisor.status().state).toBe("starting");
    await waitFor(() => supervisor.status().state === "listening");
    expect(registrationFinished).toBe(true);
    expect(bootProbes).toBeGreaterThan(2);
    expect(states.filter((state) => state === "listening")).toHaveLength(1);
    await supervisor.close();
  });

  test("bounds a live but stuck external-box registration", async () => {
    let registrationAborted = false;
    const states: string[] = [];
    const supervisor = createKernelSupervisor({
      env: { NOEMA_KERNEL_BASE: "http://127.0.0.1:43130" },
      runtimeRoot: "/tmp/runtime",
      stateRoot: "/tmp/state",
      noteRoot: "/tmp/notes",
      requestTimeoutMs: 5,
      bootTimeoutMs: 40,
      registrationTimeoutMs: 70,
      registrationProbeIntervalMs: 10,
      restartDelayMs: 10_000,
      fetchImpl: async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/api/system/bootProgress")) {
          return response({ code: 0, data: { progress: 100 } });
        }
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            registrationAborted = true;
            reject(init.signal?.reason || new Error("aborted"));
          }, { once: true });
        });
        throw new Error("unreachable");
      },
      stderr: { write() {} } as unknown as NodeJS.WritableStream,
      onState(state: { state: string }) { states.push(state.state); },
    });

    void supervisor.start();
    await waitFor(() => states.includes("degraded"));
    expect(registrationAborted).toBe(true);
    expect(states).not.toContain("listening");
    await supervisor.close();
  });

  test("aborts registration when the kernel stops responding during indexing", async () => {
    let bootProbes = 0;
    let registrationAborted = false;
    const states: string[] = [];
    const supervisor = createKernelSupervisor({
      env: { NOEMA_KERNEL_BASE: "http://127.0.0.1:43131" },
      runtimeRoot: "/tmp/runtime",
      stateRoot: "/tmp/state",
      noteRoot: "/tmp/notes",
      requestTimeoutMs: 5,
      bootTimeoutMs: 35,
      registrationTimeoutMs: 1_000,
      registrationProbeIntervalMs: 10,
      restartDelayMs: 10_000,
      fetchImpl: async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/api/system/bootProgress")) {
          bootProbes++;
          if (bootProbes === 1) return response({ code: 0, data: { progress: 100 } });
          throw new Error("kernel offline");
        }
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            registrationAborted = true;
            reject(init.signal?.reason || new Error("aborted"));
          }, { once: true });
        });
        throw new Error("unreachable");
      },
      stderr: { write() {} } as unknown as NodeJS.WritableStream,
      onState(state: { state: string }) { states.push(state.state); },
    });

    void supervisor.start();
    await waitFor(() => states.includes("degraded"));
    expect(registrationAborted).toBe(true);
    expect(states).not.toContain("listening");
    await supervisor.close();
  });

  test("rebinds the shared providers after an owned kernel exits with a new port", async () => {
    const suite = await mkdtemp(join(tmpdir(), "noema-kernel-restart-"));
    cleanups.push(suite);
    const binary = join(suite, "noema-kernel");
    const runtimeRoot = join(suite, "runtime");
    const stateRoot = join(suite, "state");
    const noteRoot = join(suite, "notes");
    await writeFile(binary, "kernel");
    await chmod(binary, 0o755);
    await mkdir(join(runtimeRoot, "app", "appearance", "langs"), { recursive: true });
    await mkdir(noteRoot);

    const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(signal: string): boolean }> = [];
    const states: Array<{ state: string; baseUrl: string }> = [];
    const spawnImpl = () => {
      const port = 43200 + children.length;
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill(signal: string): boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal: string) => {
        queueMicrotask(() => child.emit("exit", 0, signal));
        return true;
      };
      children.push(child);
      queueMicrotask(() => child.stdout.write(`[noema-kernel] http://127.0.0.1:${port}\n`));
      return child;
    };
    const supervisor = createKernelSupervisor({
      env: { NOEMA_KERNEL_BIN: binary, PATH: "" },
      runtimeRoot,
      stateRoot,
      noteRoot,
      spawnImpl: spawnImpl as never,
      fetchImpl: async (url: string) => String(url).endsWith("/api/system/bootProgress")
        ? response({ code: 0, data: { progress: 100 } })
        : response({ code: 0, data: { box: { id: "box-restart", root: noteRoot } } }),
      stderr: { write() {} } as unknown as NodeJS.WritableStream,
      healthIntervalMs: 10,
      restartDelayMs: 5,
      onState(state: { state: string; baseUrl: string }) {
        states.push({ state: state.state, baseUrl: state.baseUrl });
      },
    });

    void supervisor.start();
    await waitFor(() => supervisor.status().baseUrl === "http://127.0.0.1:43200"
      && supervisor.status().state === "listening");
    children[0].emit("exit", 17, null);
    await waitFor(() => states.some((state) => state.state === "degraded"));
    await waitFor(() => supervisor.status().baseUrl === "http://127.0.0.1:43201"
      && supervisor.status().state === "listening");
    expect(children).toHaveLength(2);
    await supervisor.close();
  });
});
