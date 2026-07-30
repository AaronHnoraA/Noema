// Kernel lifecycle registry: launches/attaches/tracks raw-ZMQ kernel
// connections keyed the same way server/lib/jupyter-cell.mjs already keys
// kernels (one per note-script-file + kernel-name). Replaces the
// jupyter-server-backed kernel bookkeeping that used to live inline in
// jupyter-cell.mjs (`ensureServer`/`ensureKernel`/`reconcileKernels`).
//
// A record's `widgetGeneration` is bumped on every relaunch (manual restart
// *and* self-heal after an unexpected death) — the ephemeral-WS design this
// replaces only bumped it on manual restart, which let the browser's
// ipywidgets runtime reuse a stale connection after a self-healed kernel.

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRawKernelConnection, waitForConnected, warmupKernelInfo, sendInterruptRequest } from "./raw-kernel.mjs";
import { allocateKernelPorts, releaseKernelPorts } from "./kernel-ports.mjs";
import { writeConnectionFile, spawnKernelProcess } from "./kernel-process.mjs";
import { buildKernelEnv } from "./kernel-env.mjs";
import { noop, makeLogger } from "./util.mjs";

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommandLine(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], (err, stdout) => resolve(err ? "" : stdout));
  });
}

/**
 * Reap kernel processes left running by a *previous, crashed* server
 * instance: reads `sidecarPath` (written by this module's own registries as
 * they launch kernels), and for each entry whose PID is alive AND whose
 * command line still references that exact connection file (avoiding killing
 * an unrelated process that happens to have reused the PID), sends SIGTERM.
 * Always removes stale connection files for entries that are no longer
 * running. Safe to call with no prior sidecar (no-op).
 */
export async function sweepOrphanKernels({ sidecarPath, stderr = process.stderr } = {}) {
  const log = makeLogger(stderr);
  let entries = [];
  try {
    entries = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
    if (!Array.isArray(entries)) entries = [];
  } catch {
    return { reaped: 0 };
  }
  let reaped = 0;
  for (const entry of entries) {
    const { pid, connectionFile } = entry || {};
    if (!pid || !connectionFile) continue;
    if (isProcessAlive(pid)) {
      const commandLine = await processCommandLine(pid);
      if (commandLine.includes(connectionFile)) {
        log.warn(`reaping orphaned kernel process ${pid} from a previous run`);
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
        }
        reaped += 1;
      }
    }
    await fs.unlink(connectionFile).catch(noop);
  }
  await fs.unlink(sidecarPath).catch(noop);
  return { reaped };
}

/**
 * Reap aaronnote kernel processes whose spawning server process is gone
 * entirely (e.g. an ephemeral diagnostics/test harness that mkdtemp'd its
 * own one-off `runtimeDir` and exited without calling `shutdown()`).
 *
 * `sweepOrphanKernels` above only catches kernels from a *previous run of
 * this same runtimeDir* via its sidecar file; a harness that uses a fresh
 * temp runtimeDir every run never revisits its own sidecar, so those
 * kernels are invisible to it. Kernels are spawned `detached` (own process
 * group) but keep the spawning node process as their ppid while it's
 * alive — once that parent exits, they're reparented to init (ppid 1).
 * Since only this module ever launches a process matching
 * `ipykernel_launcher ... aaronnote-kernel-*.json`, any such process with
 * ppid 1 is unowned by construction and safe to kill regardless of which
 * runtimeDir spawned it.
 */
export async function sweepGlobalOrphanKernels({ stderr = process.stderr } = {}) {
  const log = makeLogger(stderr);
  const listing = await new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid=,args="], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? "" : stdout),
    );
  });
  let reaped = 0;
  for (const line of listing.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pidStr, ppidStr, args] = match;
    if (ppidStr !== "1") continue;
    if (!args.includes("ipykernel_launcher")) continue;
    if (!/aaronnote-kernel-[0-9a-f-]+\.json/.test(args)) continue;
    const pid = Number(pidStr);
    log.warn(`reaping orphaned kernel process ${pid} (parent server process is gone)`);
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    reaped += 1;
  }
  return { reaped };
}

function makeConnectionInfo(ports, kernelName) {
  return {
    key: crypto.randomUUID(),
    signature_scheme: "hmac-sha256",
    transport: "tcp",
    ip: "127.0.0.1",
    hb_port: ports[0],
    control_port: ports[1],
    shell_port: ports[2],
    stdin_port: ports[3],
    iopub_port: ports[4],
    kernel_name: kernelName,
  };
}

/**
 * @param {object} options
 * @param {string} options.runtimeDir - where connection files are written (owned kernels)
 * @param {string} [options.runtimeBinDir] - prepended to PATH for launched kernels
 * @param {string} [options.venvBinDir] - deprecated alias for runtimeBinDir
 * @param {string} [options.cwd] - working directory for launched kernel processes
 * @param {object} options.zmq - the `zeromq` module (injected so tests can stub it)
 * @param {number} [options.launchTimeoutMs]
 * @param {NodeJS.WritableStream} [options.stderr]
 */
export function createKernelRegistry({
  runtimeDir,
  runtimeBinDir,
  venvBinDir,
  cwd,
  zmq,
  launchTimeoutMs = 15_000,
  stderr = process.stderr,
} = {}) {
  const log = makeLogger(stderr);
  /** @type {Map<string, object>} key -> record */
  const records = new Map();
  const sidecarPath = path.join(runtimeDir, "aaronnote-owned.json");
  let sidecarChain = Promise.resolve();

  function newId() {
    return crypto.randomUUID();
  }

  /** Best-effort, serialized rewrite of the owned-kernels sidecar (used by sweepOrphanKernels after a crash). */
  function persistSidecar() {
    const owned = Array.from(records.values())
      .filter((record) => record.owned && record.process?.pid && !record.disposed)
      .map((record) => ({ pid: record.process.pid, connectionFile: record.connectionFilePath, key: record.key }));
    sidecarChain = sidecarChain.then(async () => {
      if (owned.length === 0) {
        await fs.unlink(sidecarPath).catch(noop);
        return;
      }
      await fs.mkdir(path.dirname(sidecarPath), { recursive: true }).catch(noop);
      await fs.writeFile(sidecarPath, JSON.stringify(owned), "utf8").catch((ex) => log.warn(`failed to persist owned-kernels sidecar: ${ex?.message || ex}`));
    });
  }

  async function launchOwned(key, kernelSpecEntry) {
    const ports = await allocateKernelPorts(5);
    const connectionInfo = makeConnectionInfo(ports, kernelSpecEntry.name);
    const connectionFilePath = path.join(runtimeDir, `aaronnote-kernel-${crypto.randomUUID()}.json`);
    await writeConnectionFile(connectionFilePath, connectionInfo);

    const env = buildKernelEnv({
      kernelSpecEnv: kernelSpecEntry.spec.env,
      runtimeBinDir: runtimeBinDir || venvBinDir,
    });
    const process_ = spawnKernelProcess({
      kernelSpec: kernelSpecEntry.spec,
      connectionFilePath,
      env,
      cwd,
      stderr,
    });

    const clientId = crypto.randomUUID();
    const username = crypto.randomUUID();
    const { kernel, socket } = createRawKernelConnection({
      connectionInfo,
      clientId,
      username,
      model: { name: kernelSpecEntry.name, id: newId() },
      zmq,
      stderr,
    });

    const record = {
      id: newId(),
      key,
      kernelName: kernelSpecEntry.name,
      kernelSpec: kernelSpecEntry.spec,
      owned: true,
      attached: false,
      process: process_,
      connectionInfo,
      connectionFilePath,
      ports,
      kernel,
      socket,
      widgetGeneration: 1,
      status: "starting",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      running: 0,
      executionCount: null,
      lastStatus: "idle",
      lastCellId: "",
      totalRuns: 0,
      lastError: undefined,
      disposed: false,
      // Names present in the kernel's global namespace before any user code
      // ran (e.g. Sage's `from sage.all import *` injects thousands of
      // builtins at startup) — set lazily by the variables() introspection
      // caller so it can exclude them and show only user-defined names.
      variableBaseline: null,
    };

    process_.exited.once("exit", ({ exitCode, signal, stderrTail }) => {
      if (record.disposed) return;
      log.warn(
        `kernel process for ${key} exited unexpectedly (code=${exitCode}, signal=${signal}); marking dead`,
      );
      record.status = "dead";
      record.lastError = stderrTail || `kernel process exited (code=${exitCode}, signal=${signal})`;
      releaseKernelPorts(record.ports);
      persistSidecar();
      try {
        record.kernel.dispose();
      } catch {
        /* already gone */
      }
    });

    const connected = await waitForConnected(kernel, launchTimeoutMs);
    if (!connected) {
      await disposeRecord(record);
      throw new Error(`Timed out waiting for kernel "${kernelSpecEntry.name}" to connect`);
    }
    await warmupKernelInfo(kernel, launchTimeoutMs, { stderr });
    record.status = "idle";
    return record;
  }

  async function attachTo(key, kernelName, connectionFilePathOrInfo) {
    const connectionInfo =
      typeof connectionFilePathOrInfo === "string"
        ? JSON.parse(await (await import("node:fs/promises")).readFile(connectionFilePathOrInfo, "utf8"))
        : connectionFilePathOrInfo;

    const clientId = crypto.randomUUID();
    const username = crypto.randomUUID();
    const { kernel, socket } = createRawKernelConnection({
      connectionInfo,
      clientId,
      username,
      model: { name: kernelName, id: newId() },
      zmq,
      stderr,
    });

    const record = {
      id: newId(),
      key,
      kernelName,
      kernelSpec: { argv: [], language: undefined, interrupt_mode: "message" },
      owned: false,
      attached: true,
      process: undefined,
      connectionInfo,
      connectionFilePath: typeof connectionFilePathOrInfo === "string" ? connectionFilePathOrInfo : undefined,
      ports: [],
      kernel,
      socket,
      widgetGeneration: 1,
      status: "starting",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      running: 0,
      executionCount: null,
      lastStatus: "idle",
      lastCellId: "",
      totalRuns: 0,
      lastError: undefined,
      disposed: false,
      variableBaseline: null,
    };

    const connected = await waitForConnected(kernel, launchTimeoutMs);
    if (!connected) {
      await disposeRecord(record);
      throw new Error(`Timed out connecting to attached kernel at ${connectionFilePathOrInfo}`);
    }
    await warmupKernelInfo(kernel, launchTimeoutMs, { stderr });
    record.status = "idle";
    return record;
  }

  async function disposeRecord(record) {
    if (record.disposed) return;
    record.disposed = true;
    try {
      record.kernel?.dispose();
    } catch {
      /* ignore */
    }
    try {
      record.socket?.dispose();
    } catch {
      /* ignore */
    }
    if (record.owned && record.process) {
      await record.process.dispose().catch(noop);
      releaseKernelPorts(record.ports);
    }
  }

  return {
    /** Existing live (non-dead) record for `key`, or undefined. */
    get(key) {
      const record = records.get(key);
      return record && record.status !== "dead" ? record : undefined;
    },

    /**
     * Get-or-launch a kernel for `key`. If a prior record for this key died,
     * relaunches transparently and bumps `widgetGeneration` so stale browser
     * widget-runtime connections (keyed by `id:generation`) don't get reused.
     */
    async ensure(key, kernelSpecEntry) {
      const existing = records.get(key);
      if (existing && existing.status !== "dead") return existing;

      const record = await launchOwned(key, kernelSpecEntry);
      if (existing) record.widgetGeneration = existing.widgetGeneration + 1;
      records.set(key, record);
      persistSidecar();
      return record;
    },

    /** Get-or-attach to an existing kernel via its connection file. */
    async ensureAttached(key, kernelName, connectionFilePath) {
      const existing = records.get(key);
      if (existing && existing.status !== "dead") return existing;

      const record = await attachTo(key, kernelName, connectionFilePath);
      if (existing) record.widgetGeneration = existing.widgetGeneration + 1;
      records.set(key, record);
      return record;
    },

    touch(key) {
      const record = records.get(key);
      if (record) record.lastActivity = Date.now();
    },

    /** Relaunch an owned kernel in place (new process, new id, bumped generation). Rejects for attached kernels. */
    async restart(key) {
      const record = records.get(key);
      if (!record) throw new Error(`No kernel to restart for ${key}`);
      if (record.attached) throw new Error("Cannot restart an attached kernel");
      const kernelSpecEntry = { name: record.kernelName, spec: record.kernelSpec };
      await disposeRecord(record);
      const next = await launchOwned(key, kernelSpecEntry);
      next.widgetGeneration = record.widgetGeneration + 1;
      records.set(key, next);
      persistSidecar();
      return next;
    },

    /** Interrupt the kernel per its `interrupt_mode` (SIGINT process group, or a control-channel message). */
    async interrupt(key) {
      const record = records.get(key);
      if (!record || record.status === "dead") return false;
      if (record.kernelSpec.interrupt_mode === "message" || !record.process) {
        await sendInterruptRequest(record.kernel, { stderr });
      } else {
        record.process.interrupt();
      }
      return true;
    },

    async shutdown(key) {
      const record = records.get(key);
      if (!record) return;
      records.delete(key);
      await disposeRecord(record);
      persistSidecar();
    },

    async shutdownAll() {
      const all = Array.from(records.values());
      records.clear();
      persistSidecar();
      await Promise.all(all.map((record) => disposeRecord(record)));
    },

    list() {
      return Array.from(records.values());
    },

    /** Synchronous snapshot of owned kernel PIDs, for a `process.on("exit")` last-resort kill. */
    listOwnedPids() {
      return Array.from(records.values())
        .filter((record) => record.owned && record.process?.pid && !record.disposed)
        .map((record) => record.process.pid);
    },
  };
}
