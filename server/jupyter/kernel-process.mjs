// Kernel process launch/teardown.
// Ported concept from microsoft/vscode-jupyter (MIT)
// src/kernels/raw/launcher/kernelProcess.node.ts, trimmed to macOS/Node: no
// Windows interrupt-daemon, no VS Code telemetry/progress ceremony, no
// `pidtree` dependency (we spawn our own process group and signal it as a
// whole, same net effect as vscode's child-tree walk for our use case).

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { noop, makeLogger } from "./util.mjs";

/** Index of the argv element containing the `{connection_file}` placeholder. */
export function findConnectionFileArgIndex(argv) {
  return argv.findIndex((arg) => typeof arg === "string" && arg.includes("{connection_file}"));
}

/** Substitute `{connection_file}` in a kernelspec argv (handles both a bare token and `--flag={connection_file}` forms). */
export function substituteConnectionFile(argv, connectionFilePath) {
  const idx = findConnectionFileArgIndex(argv);
  if (idx === -1) {
    throw new Error(`kernelspec argv has no {connection_file} placeholder: ${JSON.stringify(argv)}`);
  }
  const next = argv.slice();
  next[idx] = next[idx].replace("{connection_file}", connectionFilePath);
  return next;
}

export async function writeConnectionFile(filePath, connectionInfo) {
  await fs.writeFile(filePath, JSON.stringify(connectionInfo), { mode: 0o600 });
}

/**
 * Spawn a kernel process for `kernelSpec.argv` (with `{connection_file}`
 * substituted), in its own process group. Returns a handle:
 * - `.pid`
 * - `.exited` — EventEmitter firing `"exit"` with `{ exitCode, signal, stderrTail }` exactly once
 * - `.interrupt()` — SIGINT the process group (only meaningful for `interrupt_mode !== "message"` kernels)
 * - `.dispose()` — SIGTERM then SIGKILL the process group, and best-effort delete the connection file
 */
export function spawnKernelProcess({ kernelSpec, connectionFilePath, env, cwd, stderr }) {
  const log = makeLogger(stderr);
  const argv = substituteConnectionFile(kernelSpec.argv, connectionFilePath);
  const [command, ...args] = argv;

  const proc = spawn(command, args, {
    cwd: cwd || process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so dispose()/interrupt() can signal the whole tree
    // (kernels like remote_ikernel fork helper processes) without a pidtree dependency.
    detached: process.platform !== "win32",
  });

  const exited = new EventEmitter();
  let stderrTail = "";
  let exitFired = false;

  proc.stdout?.on("data", (chunk) => {
    log.warn(`kernel[${proc.pid}] stdout: ${String(chunk).trim().slice(0, 2000)}`);
  });
  proc.stderr?.on("data", (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-4000);
  });
  const fireExit = (exitCode, signal) => {
    if (exitFired) return;
    exitFired = true;
    exited.emit("exit", { exitCode, signal, stderrTail });
  };
  proc.on("exit", fireExit);
  proc.on("error", (ex) => {
    log.error(`kernel process error (pid ${proc.pid})`, ex);
    fireExit(null, null);
  });

  const killGroup = (signal) => {
    if (proc.exitCode != null || proc.signalCode != null || !proc.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-proc.pid, signal);
      else proc.kill(signal);
    } catch {
      try { proc.kill(signal); } catch { /* already gone */ }
    }
  };

  return {
    get pid() {
      return proc.pid;
    },
    get exitCode() {
      return proc.exitCode;
    },
    exited,
    interrupt() {
      killGroup("SIGINT");
    },
    async dispose() {
      killGroup("SIGTERM");
      if (!exitFired) await new Promise((resolve) => setTimeout(resolve, 300));
      killGroup("SIGKILL");
      await fs.unlink(connectionFilePath).catch(noop);
    },
  };
}
