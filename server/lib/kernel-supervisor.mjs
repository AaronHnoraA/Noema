import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

const LOOPBACK_KERNEL = /^http:\/\/127\.0\.0\.1:\d+$/;

export function normalizeKernelBase(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  const parsed = new URL(raw);
  const normalized = parsed.toString().replace(/\/+$/, "");
  if (!LOOPBACK_KERNEL.test(normalized)) {
    throw new Error("NOEMA_KERNEL_BASE must be an http://127.0.0.1:<port> URL");
  }
  return normalized;
}

export function kernelBaseFromOutput(output) {
  const match = String(output || "").match(/\[noema-kernel\]\s+(http:\/\/127\.0\.0\.1:\d+)/);
  return match ? normalizeKernelBase(match[1]) : "";
}

export function localKernelRoot(root) {
  const value = String(root || "").trim();
  return isAbsolute(value)
    && !/^\/fs:/i.test(value)
    && !/^fs:\/\//i.test(value)
    && !/^\/[a-z]+:/i.test(value);
}

function executableName(platform) {
  return platform === "win32" ? "noema-kernel.exe" : "noema-kernel";
}

function goPlatform(platform) {
  return platform === "win32" ? "windows" : platform;
}

function goArchitecture(arch) {
  if (arch === "x64") return "amd64";
  if (arch === "ia32") return "386";
  return arch;
}

function pathExecutables(env, name) {
  return String(env.PATH || "")
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => resolve(entry, name));
}

function firstExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    const file = resolve(String(candidate));
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // Keep searching. A source checkout is allowed to run Node-only before
      // `make kernel-build` has produced its canonical binary.
    }
  }
  return "";
}

export function resolveKernelLaunchConfig({
  env = process.env,
  runtimeRoot,
  stateRoot,
  platform = process.platform,
  arch = process.arch,
  execPath = process.execPath,
} = {}) {
  const externalBase = normalizeKernelBase(env.NOEMA_KERNEL_BASE);
  if (externalBase) {
    return { enabled: true, owned: false, baseUrl: externalBase };
  }
  if (String(env.NOEMA_KERNEL_DISABLED || "") === "1") {
    return { enabled: false, owned: false, reason: "disabled" };
  }

  const name = executableName(platform);
  const explicitBinary = String(env.NOEMA_KERNEL_BIN || "").trim();
  const binary = explicitBinary
    ? firstExecutable([explicitBinary])
    : firstExecutable([
      join(dirname(execPath), name),
      join(
        resolve(runtimeRoot),
        "build",
        "kernel",
        `${goPlatform(platform)}-${goArchitecture(arch)}`,
        name,
      ),
      ...pathExecutables(env, name),
    ]);
  if (!binary) {
    return {
      enabled: false,
      owned: false,
      reason: explicitBinary
        ? `configured kernel executable is not runnable: ${resolve(explicitBinary)}`
        : "kernel executable not found",
    };
  }

  const workingDir = resolve(env.NOEMA_KERNEL_WD || join(runtimeRoot, "app"));
  if (!existsSync(join(workingDir, "appearance", "langs"))) {
    return {
      enabled: false,
      owned: false,
      reason: `kernel appearance assets not found at ${workingDir}`,
    };
  }
  const workspace = resolve(env.NOEMA_KERNEL_WORKSPACE || join(stateRoot, "kernel-workspace"));
  return {
    enabled: true,
    owned: true,
    baseUrl: "",
    binary,
    workingDir,
    workspace,
  };
}

function frozenState(state, detail = {}) {
  return Object.freeze({
    state,
    baseUrl: "",
    box: null,
    owned: false,
    reason: "",
    ...detail,
  });
}

export function createKernelSupervisor({
  enabled = true,
  env = process.env,
  runtimeRoot,
  stateRoot,
  noteRoot,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  stderr = process.stderr,
  onState = () => {},
  startupTimeoutMs = 10_000,
  bootTimeoutMs = 120_000,
  requestTimeoutMs = 2_000,
  healthIntervalMs = 5_000,
  restartDelayMs = 500,
  supervisorPid = process.pid,
} = {}) {
  const config = enabled && localKernelRoot(noteRoot)
    ? resolveKernelLaunchConfig({ env, runtimeRoot, stateRoot })
    : { enabled: false, owned: false, reason: enabled ? "non-local note root" : "host disabled" };
  let state = frozenState(config.enabled ? "starting" : "unavailable", {
    baseUrl: config.baseUrl || "",
    owned: config.owned === true,
    reason: config.reason || "",
  });
  let child = null;
  let childExit = null;
  let loopPromise = null;
  let closing = false;
  const sleepers = new Set();

  const publish = (next, detail = {}) => {
    state = frozenState(next, {
      baseUrl: detail.baseUrl || "",
      box: detail.box || null,
      owned: config.owned === true,
      reason: detail.reason || "",
    });
    try {
      onState(state);
    } catch (error) {
      stderr.write(`[aaronnote-web] kernel state callback failed: ${error?.message || error}\n`);
    }
    return state;
  };

  const sleep = (ms) => new Promise((resolveSleep) => {
    const sleeper = { timer: null, wake: null };
    sleeper.wake = () => {
      if (sleeper.timer) clearTimeout(sleeper.timer);
      sleepers.delete(sleeper);
      resolveSleep();
    };
    sleeper.timer = setTimeout(sleeper.wake, ms);
    sleepers.add(sleeper);
  });

  const wakeSleepers = () => {
    for (const sleeper of [...sleepers]) sleeper.wake();
  };

  const stopChild = async ({ force = false } = {}) => {
    const target = child;
    if (!target) return;
    try {
      target.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      // It may already have exited between the health failure and cleanup.
    }
    if (!force && childExit) {
      let forceTimer = null;
      await Promise.race([
        childExit,
        new Promise((resolveTimeout) => {
          forceTimer = setTimeout(resolveTimeout, 10_000);
        }),
      ]);
      if (forceTimer) clearTimeout(forceTimer);
      if (child === target) {
        try { target.kill("SIGKILL"); } catch {}
      }
    }
    if (child === target) child = null;
  };

  const startOwned = async () => {
    mkdirSync(config.workspace, { recursive: true });
    const args = [
      "serve",
      "--workspace", config.workspace,
      "--wd", config.workingDir,
      "--port", "0",
      "--mode", "prod",
      "--supervisor-pid", String(supervisorPid),
    ];
    const spawned = spawnImpl(config.binary, args, {
      cwd: runtimeRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child = spawned;
    let output = "";
    let discovered = "";
    let resolveExit;
    childExit = new Promise((resolveChildExit) => { resolveExit = resolveChildExit; });
    let exitSettled = false;
    const settleExit = (detail) => {
      if (exitSettled) return;
      exitSettled = true;
      if (child === spawned) child = null;
      resolveExit(detail);
    };
    spawned.once("exit", (code, signal) => settleExit({ code, signal }));
    spawned.once("error", (error) => settleExit({ error }));

    return await new Promise((resolveStart, rejectStart) => {
      let settled = false;
      let timer = null;
      const finish = (error, baseUrl = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectStart(error);
        else resolveStart({ baseUrl, exit: childExit });
      };
      const consume = (chunk) => {
        const text = String(chunk || "");
        stderr.write(text);
        output = `${output}${text}`.slice(-32_000);
        discovered = kernelBaseFromOutput(output);
        if (discovered) finish(null, discovered);
      };
      spawned.stdout?.on("data", consume);
      spawned.stderr?.on("data", consume);
      childExit.then((detail) => {
        if (!discovered) {
          finish(detail?.error || new Error(`Noema kernel exited before listening (code=${detail?.code ?? "unknown"})`));
        }
      });
      timer = setTimeout(() => {
        finish(new Error(`Noema kernel did not announce a loopback port within ${startupTimeoutMs}ms`));
      }, startupTimeoutMs);
    });
  };

  const kernelJson = async (baseUrl, path, body) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code) !== 0) {
      throw new Error(payload?.msg || `kernel request failed with HTTP ${response.status}`);
    }
    return payload;
  };

  const attach = async (baseUrl, exitPromise) => {
    const deadline = Date.now() + bootTimeoutMs;
    let lastError = null;
    while (!closing && Date.now() < deadline) {
      if (config.owned && child === null) {
        const detail = await exitPromise;
        throw detail?.error || new Error(`Noema kernel stopped while booting (code=${detail?.code ?? "unknown"})`);
      }
      try {
        const boot = await kernelJson(baseUrl, "/api/system/bootProgress");
        if (Number(boot?.data?.progress || 0) >= 100) {
          const registration = await kernelJson(baseUrl, "/api/noema/markdown/registerExternalBox", {
            name: "Noema",
            root: noteRoot,
          });
          const box = registration?.data?.box || null;
          if (!box?.id || !box?.root) throw new Error("kernel registration returned no Markdown box");
          return box;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(100);
    }
    if (closing) throw new Error("kernel supervisor is shutting down");
    throw new Error(`Noema kernel did not become ready: ${lastError?.message || "startup timed out"}`);
  };

  const monitor = async (baseUrl, exitPromise) => {
    let failures = 0;
    let lastError = null;
    while (!closing) {
      await sleep(healthIntervalMs);
      if (closing) return;
      if (config.owned && child === null) {
        const detail = await exitPromise;
        throw detail?.error || new Error(`Noema kernel stopped (code=${detail?.code ?? "unknown"})`);
      }
      try {
        const boot = await kernelJson(baseUrl, "/api/system/bootProgress");
        if (Number(boot?.data?.progress || 0) < 100) {
          throw new Error("Noema kernel left the ready state");
        }
        failures = 0;
        lastError = null;
      } catch (error) {
        failures++;
        lastError = error;
        if (failures >= 3) throw lastError;
      }
    }
  };

  const run = async () => {
    if (!config.enabled) {
      publish("unavailable", { reason: config.reason });
      return;
    }
    let backoff = restartDelayMs;
    while (!closing) {
      let baseUrl = config.baseUrl || "";
      let exitPromise = Promise.resolve({ code: null, signal: null });
      try {
        publish("starting", { baseUrl });
        if (config.owned) {
          const started = await startOwned();
          baseUrl = started.baseUrl;
          exitPromise = started.exit;
          publish("starting", { baseUrl });
        }
        const box = await attach(baseUrl, exitPromise);
        publish("listening", { baseUrl, box });
        stderr.write(`[aaronnote-web] kernel ${baseUrl} box=${box.id} owner=web-host\n`);
        backoff = restartDelayMs;
        await monitor(baseUrl, exitPromise);
      } catch (error) {
        if (!closing) {
          publish("degraded", { baseUrl, reason: error?.message || String(error) });
          stderr.write(`[aaronnote-web] kernel degraded: ${error?.message || error}\n`);
        }
      } finally {
        if (config.owned) await stopChild();
      }
      if (!closing) {
        await sleep(backoff);
        backoff = Math.min(Math.max(backoff * 2, restartDelayMs), 10_000);
      }
    }
  };

  return {
    config,
    status() { return state; },
    start() {
      if (!loopPromise) loopPromise = run();
      return loopPromise;
    },
    async close() {
      if (closing) return loopPromise;
      closing = true;
      wakeSleepers();
      await stopChild();
      await loopPromise;
    },
    forceCloseSync() {
      closing = true;
      wakeSleepers();
      const target = child;
      child = null;
      if (target) {
        try { target.kill("SIGKILL"); } catch {}
      }
    },
  };
}
