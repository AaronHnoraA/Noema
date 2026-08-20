// Kernel lifecycle registry: obtains/tracks kernel connections keyed the same
// way server/lib/jupyter-cell.mjs already keys kernels (one per
// note-script-file + kernel-name).
//
// A record is produced by one of several *connectors*, and every connector
// hands back the same shape: a live `@jupyterlab/services` KernelConnection
// plus the bookkeeping below. Nothing downstream (execution, comms,
// ipywidgets, the browser bridge) knows which connector produced it.
//
//   kind "owned"    — this process (or the Emacs broker, when `kernelHost` is
//                     set) launched the kernel process; we may signal it.
//   kind "attached" — an already-running kernel reached through its connection
//                     file; never killed, restarted, or force-shut by us.
//   kind "server"   — a kernel on a remote Jupyter server / JupyterHub /
//                     gateway, reached over HTTP(S) + WebSocket. Lifecycle
//                     verbs are REST calls; there is no process to signal.
//
// Lifecycle verbs branch on `record.kind`, never on a transport test.
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
import { noop, makeLogger, raceTimeout } from "./util.mjs";
import { createKernelHeartbeat } from "./kernel-heartbeat.mjs";

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
export async function sweepOrphanKernels({ sidecarPath, stderr = process.stderr, platform = process.platform } = {}) {
  const log = makeLogger(stderr);
  let entries = [];
  try {
    entries = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
    if (!Array.isArray(entries)) entries = [];
  } catch (ex) {
    // A missing sidecar is the normal case. One that exists but cannot be
    // parsed is not: leaving it in place makes every later start repeat this
    // failure, so the orphans it described are never reaped at all.
    const missing = ex?.code === "ENOENT";
    if (!missing) {
      log.warn(`discarding unreadable owned-kernels sidecar ${sidecarPath}: ${ex?.message || ex}`);
      await fs.unlink(sidecarPath).catch(noop);
    }
    return { reaped: 0 };
  }
  let reaped = 0;
  for (const entry of entries) {
    const { pid, connectionFile } = entry || {};
    if (!pid || !connectionFile) continue;
    if (platform !== "win32" && isProcessAlive(pid)) {
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
export async function sweepGlobalOrphanKernels({ stderr = process.stderr, platform = process.platform } = {}) {
  if (platform === "win32") return { reaped: 0 };
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
 * @param {object} [options.serverRegistry] - see server-registry.mjs; required for `server:` kernels
 * @param {number} [options.launchTimeoutMs]
 * @param {number} [options.shutdownGraceMs] - how long to wait for a graceful `shutdown_request` before signalling (0 disables)
 * @param {NodeJS.WritableStream} [options.stderr]
 * @param {Record<string, string>} [options.baseEnvironment]
 */
export function createKernelRegistry({
  runtimeDir,
  runtimeBinDir,
  venvBinDir,
  cwd,
  zmq,
  serverRegistry,
  launchTimeoutMs = 15_000,
  shutdownGraceMs = 2_000,
  stderr = process.stderr,
  kernelHost,
  baseEnvironment,
  heartbeatIntervalMs,
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
      .filter((record) => record.owned && !record.hosted
        && record.process?.pid && !record.disposed)
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

  /** Open a raw-ZMQ jlab connection for `connectionInfo` (fresh client identity each time). */
  function openConnection(connectionInfo, kernelName) {
    return createRawKernelConnection({
      connectionInfo,
      clientId: crypto.randomUUID(),
      username: crypto.randomUUID(),
      model: { name: kernelName, id: newId() },
      zmq,
      stderr,
    });
  }

  /**
   * Mark a record dead the way the process-exit handler does, so anything
   * waiting on the kernel (jlab rejects every in-flight future when the
   * connection is disposed) fails promptly instead of hanging.
   */
  function markRecordDead(record, reason) {
    if (record.disposed || record.status === "dead") return;
    record.status = "dead";
    record.lastError = reason;
    stopHeartbeat(record);
    try {
      record.kernel.dispose();
    } catch {
      /* already gone */
    }
    persistSidecar();
  }

  /**
   * Watch a raw-ZMQ record's `hb` channel.
   *
   * Locally spawned kernels also get one: process exit tells us a kernel is
   * gone, but not that a live process has stopped servicing its sockets. For
   * hosted (Emacs-broker) and attached kernels this is the *only* death
   * signal there is — their process handles cannot report an exit.
   */
  function startHeartbeat(record, connectionInfo) {
    if (record.kind === "server") return;
    if (!connectionInfo?.hb_port) return;
    record.heartbeat = createKernelHeartbeat({
      connection: connectionInfo,
      zmq,
      ...(heartbeatIntervalMs ? { intervalMs: heartbeatIntervalMs } : {}),
      stderr,
      onDead: () => {
        log.warn(`kernel for ${record.key} stopped answering its heartbeat; marking dead`);
        markRecordDead(record, "kernel stopped answering its heartbeat");
      },
    });
    record.heartbeat.start();
  }

  function stopHeartbeat(record) {
    try {
      record.heartbeat?.stop();
    } catch {
      /* ignore */
    }
    record.heartbeat = undefined;
  }

  /** The bookkeeping every connector's record shares; `base` supplies the connector-specific half. */
  function newRecord(base) {
    return {
      id: newId(),
      kind: "owned",
      owned: false,
      attached: false,
      process: undefined,
      hosted: false,
      ports: [],
      connectionFilePath: undefined,
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
      heartbeat: undefined,
      // `kernel_info_reply` content, captured during the readiness handshake:
      // language_info (file extension, codemirror mode), banner, help_links.
      kernelInfo: null,
      // Names present in the kernel's global namespace before any user code
      // ran (e.g. Sage's `from sage.all import *` injects thousands of
      // builtins at startup) — set lazily by the variables() introspection
      // caller so it can exclude them and show only user-defined names.
      variableBaseline: null,
      ...base,
    };
  }

  /**
   * Settle a restart-in-place attempt.
   *
   * A record left in `starting` after a failed handshake is worse than a dead
   * one: `ensure`/`ensureServer` only relaunch a record whose status is
   * `dead`, so anything else is handed back out as if it were usable.
   */
  async function markDeadOnFailure(record, promise) {
    try {
      return await promise;
    } catch (ex) {
      record.status = "dead";
      record.lastError = ex?.message || String(ex);
      stopHeartbeat(record);
      throw ex;
    }
  }

  /** Wait for the connection to come up, run the kernel_info handshake, and record what it reported. */
  async function readyRecord(record, label) {
    const connected = await waitForConnected(record.kernel, launchTimeoutMs);
    if (!connected) throw new Error(`Timed out ${label}`);
    // `waitForConnected` is not evidence of a kernel on the raw-ZMQ path:
    // `connect()` never fails on a ZMQ socket and the wrapper reports "open"
    // as soon as it is constructed. `warmupKernelInfo` is the only round trip
    // that proves something is answering, so its result decides readiness --
    // otherwise a kernel that never bound (bad port, failed ipykernel import)
    // gets cached as `idle` and the first execute() waits on it forever.
    const warm = await warmupKernelInfo(record.kernel, launchTimeoutMs, { stderr });
    if (!warm?.ok) {
      throw new Error(`Timed out ${label} (no reply to kernel_info_request)`);
    }
    if (warm.info) record.kernelInfo = warm.info;
    record.status = "idle";
    startHeartbeat(record, record.connectionInfo);
    return record;
  }

  /** Wrap an Emacs-broker runtime descriptor in the process-handle shape `launchOwned` expects. */
  function hostedProcessHandle(hosted) {
    return {
      pid: hosted.pid,
      exited: { once() {} },
      interrupt: () => kernelHost.interrupt(hosted.runtimeId),
      dispose: () => kernelHost.shutdown(hosted.runtimeId),
    };
  }

  async function launchOwned(key, kernelSpecEntry) {
    let ports;
    let connectionInfo;
    let connectionFilePath;
    let process_;
    let hosted;
    if (kernelHost) {
      hosted = await kernelHost.launch({
        key,
        sourceFile: kernelSpecEntry.sourceFile,
        kernelName: kernelSpecEntry.name,
        kernelSpec: kernelSpecEntry.spec,
      });
      connectionInfo = hosted.connectionInfo;
      connectionFilePath = hosted.connectionFile || "";
      ports = [];
      process_ = hostedProcessHandle(hosted);
    } else {
      ports = await allocateKernelPorts(5);
      try {
        connectionInfo = makeConnectionInfo(ports, kernelSpecEntry.name);
        connectionFilePath = path.join(runtimeDir, `aaronnote-kernel-${crypto.randomUUID()}.json`);
        await writeConnectionFile(connectionFilePath, connectionInfo);

        const env = buildKernelEnv({
          kernelSpecEnv: kernelSpecEntry.spec.env,
          runtimeBinDir: runtimeBinDir || venvBinDir,
          baseEnvironment,
        });
        process_ = spawnKernelProcess({
          kernelSpec: kernelSpecEntry.spec,
          connectionFilePath,
          env,
          cwd,
          stderr,
        });
      } catch (ex) {
        // `usedPorts` is process-wide and nothing else will ever release
        // these: without this the five ports are unusable until restart.
        releaseKernelPorts(ports);
        throw ex;
      }
    }

    const { kernel, socket } = openConnection(connectionInfo, kernelSpecEntry.name);
    const record = newRecord({
      key,
      kind: "owned",
      owned: true,
      kernelName: kernelSpecEntry.name,
      kernelSpec: kernelSpecEntry.spec,
      process: process_,
      hosted: Boolean(hosted),
      hostRuntimeId: hosted?.runtimeId,
      hostGeneration: Number(hosted?.generation || 1),
      stateLost: Boolean(hosted?.stateLost),
      connectionInfo,
      connectionFilePath,
      ports,
      kernel,
      socket,
    });

    process_.exited.once("exit", ({ exitCode, signal, stderrTail }) => {
      if (record.disposed) return;
      log.warn(
        `kernel process for ${key} exited unexpectedly (code=${exitCode}, signal=${signal}); marking dead`,
      );
      record.status = "dead";
      record.lastError = stderrTail || `kernel process exited (code=${exitCode}, signal=${signal})`;
      if (!record.hosted) releaseKernelPorts(record.ports);
      persistSidecar();
      try {
        record.kernel.dispose();
      } catch {
        /* already gone */
      }
    });

    try {
      return await readyRecord(record, `waiting for kernel "${kernelSpecEntry.name}" to connect`);
    } catch (ex) {
      await disposeRecord(record, { graceful: false });
      throw ex;
    }
  }

  async function attachTo(key, kernelName, connectionFilePathOrInfo) {
    const connectionInfo =
      typeof connectionFilePathOrInfo === "string"
        ? JSON.parse(await fs.readFile(connectionFilePathOrInfo, "utf8"))
        : connectionFilePathOrInfo;

    const { kernel, socket } = openConnection(connectionInfo, kernelName);
    const record = newRecord({
      key,
      kind: "attached",
      attached: true,
      kernelName,
      kernelSpec: { argv: [], language: undefined, interrupt_mode: "message" },
      connectionInfo,
      connectionFilePath: typeof connectionFilePathOrInfo === "string" ? connectionFilePathOrInfo : undefined,
      kernel,
      socket,
    });

    try {
      return await readyRecord(record, `connecting to attached kernel at ${connectionFilePathOrInfo}`);
    } catch (ex) {
      await disposeRecord(record, { graceful: false });
      throw ex;
    }
  }

  /**
   * Tear a record down. For kernels we own this first asks the kernel to stop
   * itself with a `shutdown_request` on the control channel and gives it
   * `shutdownGraceMs` to comply, so atexit handlers, open files, and child
   * processes get a chance to clean up before SIGTERM. Kernels we merely
   * attached to are never asked to shut down — we don't own them.
   */
  /**
   * Connect to a kernel on a remote Jupyter server. `target` is either
   * `{ kernelName }` to start a new one, or `{ kernelId }` to adopt one that
   * is already running there.
   */
  async function connectServer(key, kernelName, { serverId, kernelSpecName, kernelId, path, name }) {
    if (!serverRegistry) throw new Error("No Jupyter server registry is configured");
    const started = kernelId
      ? await serverRegistry.connectKernel(serverId, kernelId)
      : await serverRegistry.startKernel(serverId, { kernelName: kernelSpecName, path, name });

    const record = newRecord({
      key,
      kind: "server",
      kernelName,
      // A remote kernelspec's argv describes a process on the *server*, which
      // we must never try to run or signal. Message interrupt is the only
      // interrupt available without owning the process.
      kernelSpec: { argv: [], language: undefined, interrupt_mode: "message" },
      serverId,
      serverKernelId: String(started.model?.id || ""),
      serverSessionId: String(started.sessionId || ""),
      connectionInfo: undefined,
      kernel: started.kernel,
      socket: undefined,
    });

    try {
      return await readyRecord(record, `connecting to kernel "${kernelName}" on Jupyter server ${serverId}`);
    } catch (ex) {
      await disposeRecord(record, { graceful: false });
      throw ex;
    }
  }

  async function disposeRecord(record, { graceful = true } = {}) {
    if (record.disposed) return;
    record.disposed = true;
    stopHeartbeat(record);
    if (graceful && record.owned && record.status !== "dead" && shutdownGraceMs > 0) {
      const pending = Promise.resolve()
        .then(() => record.kernel?.shutdown?.())
        .catch(noop);
      await raceTimeout(shutdownGraceMs, null, pending);
    }
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
    if (record.kind === "server" && serverRegistry) {
      // No process to signal: ask the server to stop it, and remove the
      // session too so it does not linger in the server's own UI.
      await serverRegistry.shutdownKernel(record.serverId, {
        kernelId: record.serverKernelId,
        sessionId: record.serverSessionId,
      }).catch(noop);
    }
    if (record.owned && record.process) {
      await record.process.dispose().catch(noop);
      if (!record.hosted) releaseKernelPorts(record.ports);
    }
  }

  async function refreshHostedRecord(record) {
    if (!kernelHost || !record?.hostRuntimeId || record.disposed) return record;
    const status = await kernelHost.status(record.hostRuntimeId);
    if (!status?.alive) {
      await kernelHost.shutdown(record.hostRuntimeId).catch(noop);
      record.status = "dead";
      record.lastError = status?.message || "Remote kernel is not alive";
      return record;
    }
    const generation = Number(status.generation || 1);
    if (generation === Number(record.hostGeneration || 1)) return record;
    rebindHostedConnection(record, {
      connectionInfo: status.connectionInfo,
      generation,
      stateLost: Boolean(status.stateLost),
    });
    try {
      return await readyRecord(record, `reconnecting to hosted kernel "${record.kernelName}"`);
    } catch (ex) {
      record.status = "dead";
      throw ex;
    }
  }

  /**
   * Point an Emacs-broker-hosted record at a new set of forwarded channels
   * (the target process survived a transport drop, or the broker relaunched
   * it). Bumps `widgetGeneration` so a browser ipywidgets connection from
   * before the change is never reused. Passing `runtimeId` means the target
   * process itself is new, so in-kernel state and the process handle are
   * replaced too.
   */
  function rebindHostedConnection(record, { connectionInfo, generation, stateLost, runtimeId, connectionFile, pid }) {
    // The old heartbeat is watching the previous generation's forwarded
    // ports; readyRecord starts a fresh one for the new connection.
    stopHeartbeat(record);
    try { record.kernel?.dispose(); } catch { /* ignore */ }
    try { record.socket?.dispose(); } catch { /* ignore */ }
    const { kernel, socket } = openConnection(connectionInfo, record.kernelName);
    record.kernel = kernel;
    record.socket = socket;
    record.connectionInfo = connectionInfo;
    record.hostGeneration = Number(generation || 1);
    record.widgetGeneration += 1;
    record.stateLost = Boolean(stateLost);
    record.id = newId();
    record.status = "starting";
    record.kernelInfo = null;
    if (runtimeId) {
      record.hostRuntimeId = runtimeId;
      record.connectionFilePath = connectionFile || record.connectionFilePath;
      record.process = hostedProcessHandle({ pid, runtimeId });
      record.executionCount = null;
      record.variableBaseline = null;
    }
    return record;
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
      if (existing && existing.status !== "dead") {
        await refreshHostedRecord(existing);
        if (existing.status !== "dead") return existing;
      }

      const record = await launchOwned(key, kernelSpecEntry);
      if (existing) {
        record.widgetGeneration = existing.widgetGeneration + 1;
        record.stateLost = true;
        // Releasing the dead record is not optional bookkeeping: for a hosted
        // kernel this is the only `kernelHost.shutdown()` the Emacs broker
        // ever receives, and without it the broker keeps the runtime entry,
        // its connection file, and its five forwarded channels alive — one
        // more leaked set on every self-healing relaunch.
        await disposeRecord(existing, { graceful: false }).catch(noop);
      }
      records.set(key, record);
      persistSidecar();
      return record;
    },

    /**
     * Get-or-connect a kernel on a remote Jupyter server. Unlike `ensure`,
     * a dead record is not silently relaunched here: the server decides
     * whether a kernel still exists, so the caller re-resolves the target.
     */
    async ensureServer(key, kernelName, target) {
      const existing = records.get(key);
      if (existing && existing.status !== "dead") return existing;

      const record = await connectServer(key, kernelName, target);
      if (existing) {
        record.widgetGeneration = existing.widgetGeneration + 1;
        record.stateLost = true;
        await disposeRecord(existing, { graceful: false }).catch(noop);
      }
      records.set(key, record);
      return record;
    },

    /** Get-or-attach to an existing kernel via its connection file. */
    async ensureAttached(key, kernelName, connectionFilePath) {
      const existing = records.get(key);
      if (existing && existing.status !== "dead") return existing;

      const record = await attachTo(key, kernelName, connectionFilePath);
      if (existing) {
        record.widgetGeneration = existing.widgetGeneration + 1;
        // Attached kernels are never killed by dispose — this only releases
        // our own connection, heartbeat, and sockets for the stale record.
        await disposeRecord(existing, { graceful: false }).catch(noop);
      }
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
      if (record.kind === "server") {
        // The server restarts the process in place and keeps the kernel id,
        // so the existing connection stays valid — but in-kernel state is
        // gone, and any browser widget connection must not be reused.
        if (!serverRegistry) throw new Error("No Jupyter server registry is configured");
        await serverRegistry.restartKernel(record.serverId, record.serverKernelId);
        record.widgetGeneration += 1;
        record.stateLost = true;
        record.executionCount = null;
        record.variableBaseline = null;
        record.kernelInfo = null;
        record.status = "starting";
        return await markDeadOnFailure(
          record,
          readyRecord(record, `restarting kernel on Jupyter server ${record.serverId}`),
        );
      }
      if (record.hosted && typeof kernelHost?.restart === "function") {
        // The broker owns placement, so let it relaunch on the target and
        // rebuild the forward group itself. Disposing here and calling
        // launch() again would strand the previous runtime's channel group,
        // and the broker's own generation counter would never advance.
        const hosted = await kernelHost.restart(record.hostRuntimeId);
        rebindHostedConnection(record, {
          connectionInfo: hosted.connectionInfo,
          generation: hosted.generation,
          stateLost: true,
          runtimeId: hosted.runtimeId,
          connectionFile: hosted.connectionFile,
          pid: hosted.pid,
        });
        return await markDeadOnFailure(
          record,
          readyRecord(record, `restarting hosted kernel "${record.kernelName}"`),
        );
      }
      const kernelSpecEntry = {
        name: record.kernelName,
        spec: record.kernelSpec,
        sourceFile: record.sourceFile,
      };
      await disposeRecord(record);
      const next = await launchOwned(key, kernelSpecEntry);
      next.widgetGeneration = record.widgetGeneration + 1;
      for (const property of ["sourceFile", "scriptFile", "session", "language"]) {
        if (record[property] != null) next[property] = record[property];
      }
      records.set(key, next);
      persistSidecar();
      return next;
    },

    /** Interrupt the kernel per its `interrupt_mode` (SIGINT process group, or a control-channel message). */
    async interrupt(key) {
      const record = records.get(key);
      if (!record || record.status === "dead") return false;
      if (record.kind === "server") {
        // POST /api/kernels/<id>/interrupt: the server owns the process and
        // knows whether that means SIGINT or a control-channel message.
        await serverRegistry.interruptKernel(record.serverId, record.serverKernelId);
        return true;
      }
      if (record.kernelSpec.interrupt_mode === "message" || !record.process) {
        await sendInterruptRequest(record.kernel, { stderr });
      } else {
        await record.process.interrupt();
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
        .filter((record) => record.owned && !record.hosted
          && record.process?.pid && !record.disposed)
        .map((record) => record.process.pid);
    },
  };
}
