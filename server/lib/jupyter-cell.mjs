import { createHash, randomUUID } from "node:crypto";
import {
  mkdir as nativeMkdir,
  readFile as nativeReadFile,
  rename as nativeRename,
  rm as nativeRm,
  stat as nativeStat,
  writeFile as nativeWriteFile,
} from "node:fs/promises";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createKernelRegistry, sweepOrphanKernels } from "../jupyter/kernel-registry.mjs";
import { defaultKernelSearchDirs, findKernelSpecs, findAttachableConnectionFiles, resolveAttachToken } from "../jupyter/kernel-finder.mjs";
import { executeOnKernel, jupyterWidgetCommOpenP } from "../jupyter/execution-message-handler.mjs";

export { jupyterWidgetCommOpenP };

function remoteLogicalPath(value) {
  const text = String(value || "");
  if (text.startsWith("/fs:")) return text;
  const match = /^fs:\/\/([^/]+)(\/.*)?$/.exec(text);
  return match ? `/fs:${match[1]}:${match[2] || "/"}` : "";
}

export function jupyterLogicalPath(value) {
  return remoteLogicalPath(value) || resolve(String(value || ""));
}

function inside(root, file) {
  if (remoteLogicalPath(root) || remoteLogicalPath(file)) return false;
  const rel = relative(resolve(root), resolve(file));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function error(message, statusCode = 500) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function cleanToken(value, fallback) {
  const clean = String(value || "").trim();
  return clean || fallback;
}

function safeSlug(value, fallback = "cell") {
  const clean = String(value || "")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return clean || fallback;
}

function markerId(value) {
  return String(value || "").trim().replace(/\s+/g, "-");
}

function languageForKernel(kernel, requested = "") {
  const explicit = String(requested || "").trim().toLowerCase();
  const value = String(kernel || "").toLowerCase();
  if (value.includes("lean") || explicit === "lean" || explicit === "lean4") return "lean4";
  if (["bash", "sh", "shell", "zsh"].includes(explicit)) return "bash";
  if (explicit) return explicit;
  if (value.includes("sage")) return "python";
  if (value.includes("python") || value === "py" || value === "python3") return "python";
  if (value.includes("julia")) return "julia";
  if (value === "r" || value.startsWith("ir")) return "r";
  if (value.includes("bash") || value.includes("zsh") || value.includes("shell")) return "bash";
  if (value.includes("javascript") || value === "js" || value.includes("node")) return "javascript";
  if (value.includes("typescript") || value === "ts") return "typescript";
  return "python";
}

function extensionForLanguage(language) {
  const map = {
    bash: "sh",
    c: "c",
    cpp: "cpp",
    csharp: "cs",
    elisp: "el",
    javascript: "js",
    julia: "jl",
    lean: "lean",
    lean4: "lean",
    lisp: "lisp",
    python: "py",
    r: "R",
    ruby: "rb",
    rust: "rs",
    sage: "py",
    scheme: "scm",
    shell: "sh",
    sql: "sql",
    typescript: "ts",
  };
  return map[String(language || "").toLowerCase()] || "txt";
}

function commentPrefix(language) {
  const value = String(language || "").toLowerCase();
  if (["javascript", "typescript", "c", "cpp", "java", "rust", "go", "swift", "kotlin", "csharp"].includes(value)) return "//";
  if (value === "sql") return "--";
  if (value === "lean" || value === "lean4") return "--";
  if (["elisp", "lisp", "scheme", "clojure"].includes(value)) return ";";
  return "#";
}

function cellStoreDir(noteFile) {
  return join(dirname(noteFile), ".cell");
}

function hiddenScriptPath(noteFile, session, language) {
  const noteExt = extname(noteFile);
  const noteBase = safeSlug(basename(noteFile, noteExt), "note");
  const safeLanguage = safeSlug(language, "python");
  const safeSession = safeSlug(session, "default");
  const ext = extensionForLanguage(language);
  return join(cellStoreDir(noteFile), `${noteBase}.${safeLanguage}.${safeSession}.${ext}`);
}

function outputMirrorPath(noteFile, session, language) {
  const noteExt = extname(noteFile);
  const noteBase = safeSlug(basename(noteFile, noteExt), "note");
  const safeLanguage = safeSlug(language, "python");
  const safeSession = safeSlug(session, "default");
  return join(cellStoreDir(noteFile), `${noteBase}.output.${safeLanguage}.${safeSession}.json`);
}

function normalizeCode(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function codeRevision(value) {
  return createHash("sha256").update(normalizeCode(value)).digest("hex");
}

function leanRuntimeP(language, kernel) {
  return /lean/i.test(String(language || "")) || /lean/i.test(String(kernel || ""));
}

export function durationFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isoTime(value) {
  return value ? new Date(value).toISOString() : "";
}

function parseHiddenScriptCells(text) {
  const lines = normalizeCode(text).split("\n");
  const cells = new Map();
  let current = null;
  let body = [];
  const startRe = /^\s*(?:\/\/|--|#|;)\s*%%\s+aaronnote-cell\s+id=([^\s]+)\s*$/;
  const endRe = /^\s*(?:\/\/|--|#|;)\s*%%\s+end-aaronnote-cell\s+id=([^\s]+)\s*$/;
  for (const line of lines) {
    const start = startRe.exec(line);
    if (start) {
      current = markerId(start[1]);
      body = [];
      continue;
    }
    const end = endRe.exec(line);
    if (end && current && markerId(end[1]) === current) {
      cells.set(current, body.join("\n").replace(/\n$/, ""));
      current = null;
      body = [];
      continue;
    }
    if (current) body.push(line);
  }
  return cells;
}

function hiddenScriptCellOrder(text) {
  const ids = [];
  const seen = new Set();
  const startRe = /^\s*(?:\/\/|--|#|;)\s*%%\s+aaronnote-cell\s+id=([^\s]+)\s*$/;
  for (const line of normalizeCode(text).split("\n")) {
    const start = startRe.exec(line);
    if (!start) continue;
    const id = markerId(start[1]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function readExistingHiddenCells(scriptFile, fallbackFile = "", files) {
  try {
    return parseHiddenScriptCells(await files.readFile(scriptFile, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      if (fallbackFile && fallbackFile !== scriptFile) {
        try {
          return parseHiddenScriptCells(await files.readFile(fallbackFile, "utf8"));
        } catch (fallbackErr) {
          if (fallbackErr?.code !== "ENOENT") throw fallbackErr;
        }
      }
      return new Map();
    }
    throw err;
  }
}

async function readOutputMirror(file, fallbackFile = "", files) {
  try {
    const parsed = JSON.parse(await files.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err?.code === "ENOENT") {
      if (fallbackFile && fallbackFile !== file) {
        try {
          const parsed = JSON.parse(await files.readFile(fallbackFile, "utf8"));
          return parsed && typeof parsed === "object" ? parsed : {};
        } catch (fallbackErr) {
          if (fallbackErr?.code !== "ENOENT") throw fallbackErr;
        }
      }
      return {};
    }
    if (err instanceof SyntaxError) {
      // A partially-written or hand-corrupted mirror must not brick the cell.
      process.stderr.write(`[aaronnote-jupyter] ignoring corrupt output mirror: ${file}\n`);
      return {};
    }
    throw err;
  }
}

async function writeOutputMirror(file, value, files) {
  await files.mkdir(dirname(file), { recursive: true });
  if (files.atomicWriteP(file)) {
    await files.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return;
  }
  // Atomic replace: a crash mid-write leaves the previous mirror intact instead
  // of a half-written JSON that readOutputMirror would then have to discard.
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await files.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await files.rename(tmp, file);
  } catch (err) {
    try { await files.rm(tmp, { force: true }); } catch {}
    throw err;
  }
}

async function readExistingHiddenScript(scriptFile, fallbackFile = "", files) {
  try {
    const text = await files.readFile(scriptFile, "utf8");
    return {
      text,
      cells: parseHiddenScriptCells(text),
      order: hiddenScriptCellOrder(text),
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      if (fallbackFile && fallbackFile !== scriptFile) {
        try {
          const text = await files.readFile(fallbackFile, "utf8");
          return {
            text: "",
            cells: parseHiddenScriptCells(text),
            order: hiddenScriptCellOrder(text),
          };
        } catch (fallbackErr) {
          if (fallbackErr?.code !== "ENOENT") throw fallbackErr;
        }
      }
      return { text: "", cells: new Map(), order: [] };
    }
    throw err;
  }
}

function buildHiddenScript({ noteFile, kernel, session, language, cells, targetCellId, storage = "markdown", existingCells = new Map(), existingOrder = [] }) {
  const prefix = commentPrefix(language);
  const leanRuntime = leanRuntimeP(language, kernel);
  const normalizedCells = [];
  const seen = new Set();
  for (const cell of cells) {
    const id = markerId(cell.cellId || cell.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalizedCells.push({ ...cell, cellId: id, id });
  }
  // Opening one cell must never discard another cell body already present in
  // the hidden script. This protects unsaved/older @@cell entries when the
  // current editor scan is stale, partial, or still generating a new id.
  for (const id of existingOrder) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalizedCells.push({ cellId: id, id, code: "" });
  }
  const lines = [
    `${prefix} Noema cell source: ${noteFile}`,
    `${prefix} Noema cell kernel: ${kernel}`,
    `${prefix} Noema cell session: ${session}`,
    `${prefix} Noema cell storage: ${storage}`,
    leanRuntime
      ? `${prefix} Noema Lean cell source; edit cell bodies between markers.`
      : `${prefix} Noema Jupyter cell script; edit cell bodies between markers.`,
    "",
  ];
  let targetLine = 1;
  for (const cell of normalizedCells) {
    const id = markerId(cell.cellId || cell.id);
    lines.push(`${prefix} %% aaronnote-cell id=${id}`);
    if (id === targetCellId) targetLine = lines.length + 1;
    const incoming = normalizeCode(cell.code);
    const code = incoming.trim() ? incoming : (existingCells.get(id) ?? incoming);
    const codeLines = normalizeCode(code).split("\n");
    lines.push(...codeLines);
    lines.push(`${prefix} %% end-aaronnote-cell id=${id}`);
    lines.push("");
  }
  return { text: `${lines.join("\n").replace(/\s*$/, "")}\n`, line: targetLine };
}

export function createJupyterCellService({
  runtimeRoot,
  stateRoot,
  noteRoot,
  workspaceRoot,
  stdout = process.stdout,
  stderr = process.stderr,
  zmq: injectedZmq,
  fileHost,
  kernelHost,
  openFile,
  toolEnvironment,
} = {}) {
  const root = resolve(runtimeRoot || process.cwd());
  const notes = resolve(noteRoot || root);
  const workspace = resolve(workspaceRoot || notes);
  const jupyterRoot = join(root, "jupyter");
  const dataDir = join(jupyterRoot, ".jupyter", "data");
  const runtimeDir = stateRoot
    ? join(resolve(stateRoot), "jupyter", "runtime")
    : join(jupyterRoot, ".jupyter", "runtime");
  const kernelIdleTtlMs = durationFromEnv("AARONNOTE_JUPYTER_KERNEL_IDLE_TTL_MS", 10 * 60 * 1000);
  const cleanupIntervalMs = durationFromEnv("AARONNOTE_JUPYTER_CLEANUP_INTERVAL_MS", 30 * 1000);
  const execTimeoutMs = durationFromEnv("AARONNOTE_JUPYTER_EXEC_TIMEOUT_MS", 0);
  const interruptGraceMs = durationFromEnv("AARONNOTE_JUPYTER_INTERRUPT_GRACE_MS", 5000);
  const useHomeKernels = process.env.AARONNOTE_JUPYTER_USE_HOME_KERNELS !== "0";
  const allowedKernelsRaw = String(process.env.AARONNOTE_JUPYTER_ALLOWED_KERNELS || "").trim();
  const allowedNames = allowedKernelsRaw ? allowedKernelsRaw.split(",").map((v) => v.trim()).filter(Boolean) : undefined;
  const attachDirs = [
    runtimeDir,
    ...(process.env.AARONNOTE_JUPYTER_ATTACH_DIRS ? process.env.AARONNOTE_JUPYTER_ATTACH_DIRS.split(delimiter).filter(Boolean) : []),
  ];
  const files = {
    atomicWriteP(file) {
      return Boolean(remoteLogicalPath(file) && fileHost);
    },
    readFile(file, encoding) {
      return remoteLogicalPath(file) && fileHost
        ? fileHost.readFile(file, encoding)
        : nativeReadFile(file, encoding);
    },
    writeFile(file, data, encoding) {
      return remoteLogicalPath(file) && fileHost
        ? fileHost.writeFile(file, data, encoding)
        : nativeWriteFile(file, data, encoding);
    },
    mkdir(file, options) {
      return remoteLogicalPath(file) && fileHost
        ? fileHost.mkdir(file, options)
        : nativeMkdir(file, options);
    },
    rename(from, to) {
      return remoteLogicalPath(from) && fileHost
        ? fileHost.rename(from, to)
        : nativeRename(from, to);
    },
    rm(file, options) {
      return remoteLogicalPath(file) && fileHost
        ? fileHost.rm(file, options)
        : nativeRm(file, options);
    },
    stat(file) {
      return remoteLogicalPath(file) && fileHost
        ? fileHost.stat(file)
        : nativeStat(file);
    },
  };

  let cleanupTimer = null;
  let cleanupRunning = false;
  let registryPromise = null;
  let registrySync = null;
  const mirrorLocks = new Map();
  const executionQueues = new Map();

  // Last-resort synchronous cleanup: `process.on("exit")` handlers cannot
  // await, so if the async SIGTERM/SIGINT shutdown() path didn't run to
  // completion (double signal, uncaught crash bypassing the handler), SIGKILL
  // any owned kernel process groups we know about before the event loop dies.
  // Installed lazily (only once a registry actually exists) and removed in
  // shutdown() so short-lived service instances (tests, tooling) don't leak a
  // listener onto the shared `process` object.
  function onProcessExit() {
    if (!registrySync) return;
    for (const pid of registrySync.listOwnedPids()) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }

  async function getRegistry() {
    if (!registryPromise) {
      registryPromise = (async () => {
        const sidecarPath = join(runtimeDir, "aaronnote-owned.json");
        await sweepOrphanKernels({ sidecarPath, stderr }).catch(() => {});
        const zmq = injectedZmq || (await import("zeromq"));
        const registry = createKernelRegistry({
          runtimeDir,
          cwd: workspace,
          zmq,
          stderr,
          kernelHost,
          baseEnvironment: toolEnvironment,
        });
        registrySync = registry;
        process.on("exit", onProcessExit);
        return registry;
      })();
    }
    return registryPromise;
  }

  function kernelSearchDirs() {
    return defaultKernelSearchDirs({ dataDir, useHomeKernels });
  }

  async function listKernelSpecs(file = "") {
    if (kernelHost && file) {
      return await kernelHost.listKernelSpecs(file);
    }
    return await findKernelSpecs({ searchDirs: kernelSearchDirs(), allowedNames });
  }

  function withMirrorLock(file, run) {
    // Serialize read-modify-write on a single output mirror so two cells sharing
    // one kernel/session file cannot clobber each other's saved outputs.
    const previous = mirrorLocks.get(file) || Promise.resolve();
    const result = previous.then(run, run);
    const guard = result.catch(() => {});
    mirrorLocks.set(file, guard);
    void guard.finally(() => {
      if (mirrorLocks.get(file) === guard) mirrorLocks.delete(file);
    });
    return result;
  }

  function withKernelExecutionQueue(key, run) {
    const previous = executionQueues.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(run);
    const guard = result.catch(() => {});
    executionQueues.set(key, guard);
    void guard.finally(() => {
      if (executionQueues.get(key) === guard) executionQueues.delete(key);
    });
    return result;
  }

  function executedRevisions(record) {
    if (!record) return new Map();
    if (!(record.executedCellRevisions instanceof Map)) {
      record.executedCellRevisions = new Map(Object.entries(record.executedCellRevisions || {}));
    }
    return record.executedCellRevisions;
  }

  function cancelCleanupTimer() {
    if (!cleanupTimer) return;
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }

  function scheduleCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setTimeout(() => {
      cleanupTimer = null;
      void cleanupIdle({ scheduled: true }).catch((err) => {
        stderr.write(`[aaronnote-jupyter] cleanup failed: ${err?.message || err}\n`);
      });
    }, Math.max(1000, cleanupIntervalMs));
    cleanupTimer.unref?.();
  }

  function kernelKey({ file, kernel }) {
    return `${jupyterLogicalPath(file)}\0${cleanToken(kernel, "python3")}`;
  }

  function safeNoteFile(raw) {
    const value = String(raw || "").trim();
    if (!value) throw error("Missing note file", 400);
    const file = jupyterLogicalPath(value);
    const ext = extname(file).toLowerCase();
    const markdownLike = ext === ".md" || ext === ".markdown" || ext === ".mdown" || ext === ".mkd";
    if (!remoteLogicalPath(file)
        && !inside(notes, file) && !inside(workspace, file) && !markdownLike) {
      throw error(`Note file is outside the allowed root: ${file}`, 403);
    }
    return file;
  }

  function runtimeForBody(body) {
    const noteFile = safeNoteFile(body?.file);
    const kernel = cleanToken(body?.kernel, "python3");
    const session = cleanToken(body?.session, "default");
    const language = languageForKernel(kernel, body?.language || body?.lang);
    const scriptFile = hiddenScriptPath(noteFile, session, language);
    return {
      noteFile,
      scriptFile,
      kernel,
      session,
      language,
      key: kernelKey({ file: scriptFile, kernel }),
    };
  }

  async function kernelRecordForBody(body) {
    const registry = await getRegistry();
    const explicitKey = String(body?.key || "").trim();
    if (explicitKey) {
      const record = registry.get(explicitKey);
      if (record) return { key: explicitKey, record };
    }
    const id = String(body?.id || body?.kernelId || "").trim();
    if (id) {
      const record = registry.list().find((item) => item.id === id);
      if (record) return { key: record.key, record };
    }
    const fileValue = String(body?.file || "").trim();
    if (!fileValue) return { key: "", record: undefined };
    const runtime = runtimeForBody(body);
    return { key: runtime.key, record: registry.get(runtime.key) };
  }

  function widgetRuntimeForRecord(record) {
    if (!record?.id) return null;
    return {
      id: record.id,
      name: record.kernelName,
      generation: Number(record.widgetGeneration || 1),
    };
  }

  function outputRuntimeStamp(output) {
    const stamp = output?.kernelRuntime && typeof output.kernelRuntime === "object"
      ? output.kernelRuntime
      : output?.widgetRuntime && typeof output.widgetRuntime === "object" ? output.widgetRuntime : null;
    if (!stamp?.id) return null;
    return {
      id: String(stamp.id || ""),
      generation: Number(stamp.generation || 1),
    };
  }

  async function attachLiveRuntimeToOutput(output, noteFile, kernel, session, language) {
    if (!output || typeof output !== "object") return output ?? null;
    const scriptFile = hiddenScriptPath(noteFile, session, language);
    const registry = await getRegistry();
    const record = registry.get(kernelKey({ file: scriptFile, kernel }));
    const runtime = widgetRuntimeForRecord(record);
    const stamp = outputRuntimeStamp(output);
    const live = Boolean(runtime && stamp && stamp.id === runtime.id && Number(stamp.generation || 1) === Number(runtime.generation || 1));
    const { widgetRuntime: _oldWidgetRuntime, ...rest } = output;
    return {
      ...rest,
      live,
      ...(live ? { widgetRuntime: runtime } : {}),
    };
  }

  function kernelTask(key, record) {
    const now = Date.now();
    const running = Math.max(0, Number(record?.running || 0));
    return {
      key,
      id: record?.id || "",
      kernel: record?.kernelName || "",
      status: record?.status === "dead" ? "dead" : (running > 0 ? "running" : (record?.lastStatus || "idle")),
      running,
      attached: Boolean(record?.attached),
      createdAt: record?.createdAt || 0,
      createdAtIso: isoTime(record?.createdAt),
      lastUsedAt: record?.lastActivity || 0,
      lastUsedAtIso: isoTime(record?.lastActivity),
      idleMs: Math.max(0, now - Number(record?.lastActivity || now)),
      totalRuns: Number(record?.totalRuns || 0),
      executionCount: record?.executionCount ?? null,
      lastCellId: record?.lastCellId || "",
      lastError: record?.lastError || "",
      executedCells: record?.executedCellRevisions instanceof Map ? record.executedCellRevisions.size : 0,
      widgetGeneration: Number(record?.widgetGeneration || 1),
      generation: Number(record?.hostGeneration || record?.widgetGeneration || 1),
      placement: record?.hosted ? "target" : "client",
      stateLost: Boolean(record?.stateLost),
      protected: running > 0,
      ttlMs: kernelIdleTtlMs,
    };
  }

  function isPythonFamilyKernel(kernel) {
    return /python|sage/i.test(kernel);
  }

  // Sage (and any kernel that does a startup `from X import *`) injects
  // thousands of names directly into globals() before any user code runs.
  // Snapshot that set once, right after a freshly-launched kernel comes up
  // and before any cell has executed on it, so variables() can exclude it and
  // show only names the user's own code introduced — the same approach real
  // Jupyter/VS Code variable explorers use (there is no reliable way to tell
  // "library global" from "user global" by inspection alone).
  async function captureVariableBaseline(record, kernel) {
    if (record.variableBaseline || !isPythonFamilyKernel(kernel)) return;
    const marker = `AARONNOTE_BASELINE_${randomUUID().replace(/-/g, "")}`;
    const code = `import json as _aaronnote_json\nprint('${marker}' + _aaronnote_json.dumps(list(globals().keys())))`;
    try {
      const result = await executeOnKernel(record.kernel, code, { storeHistory: false });
      const text = (result.outputs || [])
        .filter((item) => item.output_type === "stream")
        .map((item) => String(item.text || ""))
        .join("");
      const line = text.split(/\r?\n/).find((item) => item.startsWith(marker));
      const names = line ? JSON.parse(line.slice(marker.length)) : [];
      record.variableBaseline = new Set(Array.isArray(names) ? names : []);
    } catch {
      // Best-effort: if the snapshot fails, variables() just falls back to
      // its existing `_aaronnote_`/`__`-prefix filtering.
      record.variableBaseline = new Set();
    }
  }

  async function ensureKernel(body) {
    const { noteFile, scriptFile, kernel, session, language, key } = runtimeForBody(body || {});
    const registry = await getRegistry();
    let record;
    if (kernel.startsWith("attach:")) {
      const token = kernel.slice("attach:".length);
      const connectionFilePath = await resolveAttachToken(token, attachDirs);
      if (!connectionFilePath) throw error(`No attachable kernel connection file found for "${token}"`, 404);
      record = await registry.ensureAttached(key, kernel, connectionFilePath);
    } else {
      if (leanRuntimeP(language, kernel)) {
        throw error("Lean cells do not use a Jupyter kernel", 400);
      }
      const specs = await listKernelSpecs(noteFile);
      const specEntry = specs.find((item) => item.name === kernel);
      if (!specEntry) throw error(`Unknown Jupyter kernel: ${kernel}`, 404);
      record = await registry.ensure(key, { ...specEntry, sourceFile: noteFile });
    }
    await captureVariableBaseline(record, kernel);
    registry.touch(key);
    scheduleCleanup();
    return { id: record.id, file: scriptFile, sourceFile: noteFile, kernel, session, language, key, record };
  }

  async function kernels(body = {}) {
    const file = String(body?.file || "");
    const specs = await listKernelSpecs(file ? safeNoteFile(file) : "");
    const list = specs.map((entry) => ({
      name: entry.name,
      displayName: entry.spec.display_name || entry.name,
      language: entry.spec.language || "",
    }));
    if (!list.some((item) => item.name === "lean4")) {
      list.push({ name: "lean4", displayName: "Lean 4", language: "lean4" });
    }
    const attachable = await findAttachableConnectionFiles(attachDirs);
    return {
      ok: true,
      default: "python3",
      kernels: list.sort((a, b) => a.name.localeCompare(b.name)),
      attachable: attachable.map((item) => ({
        name: `attach:${item.token}`,
        displayName: `Attach: ${item.token}`,
        language: "",
      })),
    };
  }

  function summarizeError(outputs) {
    const err = (outputs || []).find((item) => item.output_type === "error");
    if (!err) return "";
    return `${err.ename || "Error"}: ${err.evalue || ""}`.trim();
  }

  async function runExecuteAttempt(kernelInfo, code, cellId, body) {
    const record = kernelInfo.record;
    const now = Date.now();
    record.running = Math.max(0, Number(record.running || 0)) + 1;
    record.totalRuns = Number(record.totalRuns || 0) + 1;
    record.lastActivity = now;
    record.lastCellId = cellId;
    record.lastStatus = "running";
    record.lastError = "";
    try {
      const streamLimit = durationFromEnv("AARONNOTE_JUPYTER_MAX_STREAM_BYTES", 1024 * 1024);
      const widgetMessageLimit = durationFromEnv("AARONNOTE_JUPYTER_MAX_WIDGET_MESSAGES", 512);
      const widgetMessageBytesLimit = durationFromEnv("AARONNOTE_JUPYTER_MAX_WIDGET_MESSAGE_BYTES", 8 * 1024 * 1024);
      let result;
      try {
        result = await executeOnKernel(record.kernel, code, {
          silent: Boolean(body?.silent),
          storeHistory: body?.storeHistory !== false,
          streamLimit,
          widgetMessageLimit,
          widgetMessageBytesLimit,
          execTimeoutMs,
        });
      } catch (err) {
        if (Number(err?.statusCode) === 504) {
          // Escalate a hung execution: interrupt, give it a grace period, then
          // surface the timeout while leaving the kernel process itself alive
          // for the next cell (a hard kill would lose all in-kernel state).
          const registry = await getRegistry();
          await registry.interrupt(kernelInfo.key).catch(() => {});
          await new Promise((resolveGrace) => setTimeout(resolveGrace, interruptGraceMs));
        }
        throw err;
      }
      record.executionCount = result.executionCount ?? record.executionCount;
      record.lastStatus = result.status;
      record.lastError = result.status === "error" ? summarizeError(result.outputs) : "";
      return {
        ok: true,
        cellId,
        kernel: kernelInfo.kernel,
        session: kernelInfo.session,
        status: result.status,
        executionCount: result.executionCount,
        outputs: result.outputs,
        widgetRuntime: {
          id: record.id,
          name: kernelInfo.kernel,
          generation: Number(record.widgetGeneration || 1),
        },
        stateLost: Boolean(record.stateLost),
        ...(result.widgetMessages ? { widgetMessages: result.widgetMessages, widgetMessagesTruncated: result.widgetMessagesTruncated } : {}),
        ...(result.widgetOutputs ? { widgetOutputs: result.widgetOutputs } : {}),
      };
    } catch (err) {
      record.lastStatus = "error";
      record.lastError = err?.message || String(err || "");
      throw err;
    } finally {
      record.running = Math.max(0, Number(record.running || 0) - 1);
      record.lastActivity = Date.now();
      scheduleCleanup();
    }
  }

  async function executePrepared(body, code, cellId, { queued = true } = {}) {
    const normalizedCode = normalizeCode(code);
    const normalizedCellId = String(cellId || body?.cellId || body?.id || "");
    const requestedKernel = cleanToken(body?.kernel, "python3");
    const requestedLanguage = languageForKernel(requestedKernel, body?.language || body?.lang);
    if (leanRuntimeP(requestedLanguage, requestedKernel)) {
      return {
        ok: true,
        cellId: normalizedCellId,
        kernel: requestedKernel,
        session: cleanToken(body?.session, "default"),
        status: "ok",
        executionCount: null,
        outputs: [],
        runtime: "lean4",
      };
    }
    if (!normalizedCode.trim()) return { ok: true, status: "ok", outputs: [], executionCount: null, cellId: normalizedCellId };
    const runtime = runtimeForBody({ ...(body || {}), kernel: requestedKernel });
    const run = async () => {
      const kernelInfo = await ensureKernel({
        ...(body || {}),
        file: runtime.noteFile,
        kernel: requestedKernel,
        session: runtime.session,
        language: runtime.language,
      });
      return await runExecuteAttempt(kernelInfo, normalizedCode, normalizedCellId, body);
    };
    return queued ? await withKernelExecutionQueue(runtime.key, run) : await run();
  }

  async function execute(body) {
    const code = normalizeCode(body?.code);
    const cellId = String(body?.cellId || body?.id || "");
    return await executePrepared(body || {}, code, cellId, { queued: true });
  }

  async function openScript(body) {
    const noteFile = safeNoteFile(body?.file);
    const kernel = cleanToken(body?.kernel, "python3");
    const session = cleanToken(body?.session, "default");
    const language = languageForKernel(kernel, body?.language || body?.lang);
    const targetCellId = markerId(body?.cellId || body?.id);
    const storage = cleanToken(body?.storage, "markdown") === "script" ? "script" : "markdown";
    const cells = Array.isArray(body?.cells) ? body.cells : [];
    if (!targetCellId) throw error("Missing Jupyter cell id", 400);
    if (cells.length === 0) throw error("No Jupyter cells to write", 400);
    const scriptFile = hiddenScriptPath(noteFile, session, language);
    const existingScript = await readExistingHiddenScript(scriptFile, "", files);
    const rendered = buildHiddenScript({
      noteFile,
      kernel,
      session,
      language,
      cells,
      targetCellId,
      storage,
      existingCells: existingScript.cells,
      existingOrder: existingScript.order,
    });
    await files.mkdir(dirname(scriptFile), { recursive: true });
    const changed = existingScript.text !== rendered.text;
    if (changed) await files.writeFile(scriptFile, rendered.text, "utf8");
    const info = await files.stat(scriptFile);
    const payload = { file: scriptFile, line: rendered.line, col: 0, nonce: randomUUID() };
    if (body?.open !== false) {
      if (typeof openFile === "function") {
        await openFile(payload);
      } else {
        stdout.write(`aaronote-event:open:${JSON.stringify(payload)}\n`);
      }
    }
    return {
      ok: true,
      ...payload,
      kernel,
      session,
      language,
      changed,
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
  }

  async function readScriptCell(body) {
    const noteFile = safeNoteFile(body?.file);
    const kernel = cleanToken(body?.kernel, "python3");
    const session = cleanToken(body?.session, "default");
    const language = languageForKernel(kernel, body?.language || body?.lang);
    const cellId = markerId(body?.cellId || body?.id);
    if (!cellId) throw error("Missing Jupyter cell id", 400);
    const scriptFile = hiddenScriptPath(noteFile, session, language);
    const outputFile = outputMirrorPath(noteFile, session, language);
    const cells = await readExistingHiddenCells(scriptFile, "", files);
    const outputs = await readOutputMirror(outputFile, "", files);
    const savedOutput = outputs?.cells?.[cellId] ?? null;
    let info = null;
    try { info = await files.stat(scriptFile); } catch {}
    return {
      ok: true,
      file: scriptFile,
      kernel,
      session,
      language,
      cellId,
      code: cells.get(cellId) ?? "",
      output: await attachLiveRuntimeToOutput(savedOutput, noteFile, kernel, session, language),
      exists: Boolean(info),
      mtimeMs: info?.mtimeMs ?? 0,
      size: info?.size ?? 0,
    };
  }

  async function persistScriptCellResult(noteFile, cell, result) {
    if (leanRuntimeP(cell.language, cell.kernel)) return;
    const outputFile = outputMirrorPath(noteFile, cell.session, cell.language);
    const { widgetRuntime, ...persistedResult } = result;
    await withMirrorLock(outputFile, async () => {
      const mirror = await readOutputMirror(outputFile, "", files);
      const cells = mirror.cells && typeof mirror.cells === "object" ? mirror.cells : {};
      const current = cells[cell.cellId] && typeof cells[cell.cellId] === "object" ? cells[cell.cellId] : {};
      const currentUi = current.ui && typeof current.ui === "object" ? current.ui : {};
      cells[cell.cellId] = {
        ...persistedResult,
        live: true,
        ...(widgetRuntime ? { kernelRuntime: widgetRuntime } : {}),
        ui: currentUi,
        savedAt: new Date().toISOString(),
        kernel: cell.kernel,
        session: cell.session,
        language: cell.language,
      };
      await writeOutputMirror(outputFile, {
        version: 1,
        source: noteFile,
        kernel: cell.kernel,
        session: cell.session,
        language: cell.language,
        cells,
      }, files);
    });
  }

  function normalizeContextCells(cells, hiddenCells, targetCellId, fallback) {
    const result = [];
    const seen = new Set();
    for (const raw of Array.isArray(cells) ? cells : []) {
      const id = markerId(raw?.cellId || raw?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push({
        cellId: id,
        id,
        kernel: fallback.kernel,
        session: cleanToken(raw?.session, fallback.session),
        language: languageForKernel(fallback.kernel, raw?.language || raw?.lang || fallback.language),
        code: hiddenCells.get(id) ?? normalizeCode(raw?.code),
      });
    }
    if (targetCellId && !seen.has(targetCellId)) {
      result.push({
        cellId: targetCellId,
        id: targetCellId,
        kernel: fallback.kernel,
        session: fallback.session,
        language: fallback.language,
        code: hiddenCells.get(targetCellId) ?? "",
      });
    }
    return result;
  }

  function selectedContextIds(body, targetCellId) {
    const values = Array.isArray(body?.cellIds) ? body.cellIds
      : Array.isArray(body?.selectedCellIds) ? body.selectedCellIds
      : [targetCellId];
    return new Set(values.map(markerId).filter(Boolean));
  }

  function planContextExecution({ mode, entries, targetCellId, record }) {
    const targetIndex = entries.findIndex((entry) => entry.cellId === targetCellId);
    if (targetIndex < 0) throw error("Target Jupyter cell is not in this session context", 400);
    if (mode === "selected") return entries.filter((entry) => entry.selected);
    const revisions = executedRevisions(record);
    const planned = [];
    let dirty = !record?.id;
    for (let index = 0; index <= targetIndex; index += 1) {
      const entry = entries[index];
      const revision = codeRevision(entry.code);
      const stale = dirty || revisions.get(entry.cellId) !== revision || entry.cellId === targetCellId;
      if (!stale) continue;
      planned.push(entry);
      dirty = true;
    }
    return planned;
  }

  async function executeScriptCellWithContext(body) {
    const noteFile = safeNoteFile(body?.file);
    const kernel = cleanToken(body?.kernel, "python3");
    const session = cleanToken(body?.session, "default");
    const language = languageForKernel(kernel, body?.language || body?.lang);
    const targetCellId = markerId(body?.cellId || body?.id);
    if (!targetCellId) throw error("Missing Jupyter cell id", 400);

    const runtime = runtimeForBody({ ...(body || {}), file: noteFile, kernel, session, language });
    return await withKernelExecutionQueue(runtime.key, async () => {
      await openScript({
        ...(body || {}),
        file: noteFile,
        cellId: targetCellId,
        kernel,
        session,
        language,
        storage: "script",
        open: false,
      });
      const scriptFile = hiddenScriptPath(noteFile, session, language);
      const hiddenCells = await readExistingHiddenCells(scriptFile, "", files);
      const selected = selectedContextIds(body, targetCellId);
      const entries = normalizeContextCells(body?.cells, hiddenCells, targetCellId, { kernel, session, language })
        .filter((entry) => entry.session === session && entry.language === language)
        .map((entry) => ({ ...entry, selected: selected.has(entry.cellId), revision: codeRevision(entry.code) }));
      const mode = String(body?.runMode || body?.executionMode || "dependencies") === "selected" ? "selected" : "dependencies";
      const registry = await getRegistry();
      const recordBefore = registry.get(runtime.key);
      const plan = planContextExecution({ mode, entries, targetCellId, record: recordBefore });
      if (plan.length === 0) {
        return { ok: true, cellId: targetCellId, kernel, session, status: "ok", executionCount: null, outputs: [], results: [], plan: [] };
      }
      const results = [];
      let targetResult = null;
      for (const entry of plan) {
        const result = await executePrepared({
          ...(body || {}),
          file: noteFile,
          kernel: entry.kernel,
          session: entry.session,
          language: entry.language,
          cellId: entry.cellId,
        }, entry.code, entry.cellId, { queued: false });
        const liveResult = { ...result, live: true, cellId: entry.cellId, kernel: entry.kernel, session: entry.session };
        await persistScriptCellResult(noteFile, entry, liveResult);
        results.push(liveResult);
        if (liveResult.status !== "error") {
          const record = registry.get(runtime.key);
          if (record) executedRevisions(record).set(entry.cellId, entry.revision);
        }
        if (entry.cellId === targetCellId) targetResult = liveResult;
        if (liveResult.status === "error") {
          if (entry.cellId === targetCellId) {
            targetResult = liveResult;
          } else {
            targetResult = {
              ok: false,
              cellId: targetCellId,
              kernel,
              session,
              status: "error",
              message: `Stopped at ${entry.cellId}`,
              outputs: liveResult.outputs || [],
              stoppedAt: entry.cellId,
              live: true,
            };
          }
          break;
        }
      }
      return {
        ...(targetResult || results[results.length - 1] || { ok: true, cellId: targetCellId, kernel, session, status: "ok", outputs: [] }),
        results,
        plan: plan.map((entry) => ({ cellId: entry.cellId, mode, selected: entry.selected })),
        autoRan: mode === "dependencies" && plan.some((entry) => entry.cellId !== targetCellId),
      };
    });
  }

  async function executeScriptCell(body) {
    if (Array.isArray(body?.cells) && body.cells.length > 0) {
      return await executeScriptCellWithContext(body || {});
    }
    const read = await readScriptCell(body || {});
    const noteFile = safeNoteFile(body?.file);
    const result = await execute({
      ...(body || {}),
      file: body?.file,
      kernel: read.kernel,
      session: read.session,
      cellId: read.cellId,
      code: read.code,
    });
    if (leanRuntimeP(read.language, read.kernel)) return result;
    await persistScriptCellResult(noteFile, read, result);
    return { ...result, live: true };
  }

  async function clearScriptCellOutput(body) {
    const noteFile = safeNoteFile(body?.file);
    const kernel = cleanToken(body?.kernel, "python3");
    const session = cleanToken(body?.session, "default");
    const language = languageForKernel(kernel, body?.language || body?.lang);
    const cellId = markerId(body?.cellId || body?.id);
    if (!cellId) throw error("Missing Jupyter cell id", 400);
    const outputFile = outputMirrorPath(noteFile, session, language);
    await withMirrorLock(outputFile, async () => {
      const mirror = await readOutputMirror(outputFile, "", files);
      const cells = mirror.cells && typeof mirror.cells === "object" ? mirror.cells : {};
      delete cells[cellId];
      await writeOutputMirror(outputFile, {
        version: 1,
        source: noteFile,
        kernel,
        session,
        language,
        cells,
      }, files);
    });
    return { ok: true, file: outputFile, cellId, kernel, session };
  }

  async function deleteScriptCell(body) {
    const noteFile = safeNoteFile(body?.file);
    const kernel = cleanToken(body?.kernel, "python3");
    const session = cleanToken(body?.session, "default");
    const language = languageForKernel(kernel, body?.language || body?.lang);
    const cellId = markerId(body?.cellId || body?.id);
    if (!cellId) throw error("Missing Jupyter cell id", 400);
    const scriptFile = hiddenScriptPath(noteFile, session, language);
    const outputFile = outputMirrorPath(noteFile, session, language);
    const existingScript = await readExistingHiddenScript(scriptFile, "", files);
    const remainingOrder = existingScript.order.filter((id) => id && id !== cellId);
    let removedScript = false;
    let changedScript = existingScript.order.includes(cellId);

    if (remainingOrder.length === 0) {
      await files.rm(scriptFile, { force: true });
      await files.rm(outputFile, { force: true });
      removedScript = true;
    } else if (changedScript) {
      const cells = remainingOrder.map((id) => ({
        cellId: id,
        id,
        code: existingScript.cells.get(id) ?? "",
      }));
      const rendered = buildHiddenScript({
        noteFile,
        kernel,
        session,
        language,
        cells,
        targetCellId: remainingOrder[0],
        storage: "script",
        existingCells: new Map(),
        existingOrder: [],
      });
      await files.mkdir(dirname(scriptFile), { recursive: true });
      await files.writeFile(scriptFile, rendered.text, "utf8");
      await withMirrorLock(outputFile, async () => {
        const mirror = await readOutputMirror(outputFile, "", files);
        const cellsMirror = mirror.cells && typeof mirror.cells === "object" ? mirror.cells : {};
        delete cellsMirror[cellId];
        if (Object.keys(cellsMirror).length === 0) {
          await files.rm(outputFile, { force: true });
        } else {
          await writeOutputMirror(outputFile, {
            version: 1,
            source: noteFile,
            kernel,
            session,
            language,
            cells: cellsMirror,
          }, files);
        }
      });
    } else {
      await withMirrorLock(outputFile, async () => {
        const mirror = await readOutputMirror(outputFile, "", files);
        const cellsMirror = mirror.cells && typeof mirror.cells === "object" ? mirror.cells : {};
        if (!Object.prototype.hasOwnProperty.call(cellsMirror, cellId)) return;
        delete cellsMirror[cellId];
        if (Object.keys(cellsMirror).length === 0) {
          await files.rm(outputFile, { force: true });
        } else {
          await writeOutputMirror(outputFile, {
            version: 1,
            source: noteFile,
            kernel,
            session,
            language,
            cells: cellsMirror,
          }, files);
        }
      });
    }
    return {
      ok: true,
      file: scriptFile,
      outputFile,
      cellId,
      kernel,
      session,
      language,
      changedScript,
      removedScript,
      remainingCells: remainingOrder.length,
    };
  }

  async function saveScriptCellOutputUi(body) {
    const noteFile = safeNoteFile(body?.file);
    const kernel = cleanToken(body?.kernel, "python3");
    const session = cleanToken(body?.session, "default");
    const language = languageForKernel(kernel, body?.language || body?.lang);
    const cellId = markerId(body?.cellId || body?.id);
    if (!cellId) throw error("Missing Jupyter cell id", 400);
    const outputFile = outputMirrorPath(noteFile, session, language);
    let savedCell = null;
    await withMirrorLock(outputFile, async () => {
      const mirror = await readOutputMirror(outputFile, "", files);
      const cells = mirror.cells && typeof mirror.cells === "object" ? mirror.cells : {};
      const current = cells[cellId] && typeof cells[cellId] === "object" ? cells[cellId] : { ok: true, status: "ok", outputs: [] };
      const currentUi = current.ui && typeof current.ui === "object" ? current.ui : {};
      const nextUi = {
        ...currentUi,
        outputFolded: body?.outputFolded === true,
        outputExpanded: body?.outputExpanded === true,
      };
      savedCell = {
        ...current,
        ui: nextUi,
        savedAt: current.savedAt || new Date().toISOString(),
        kernel,
        session,
        language,
      };
      cells[cellId] = savedCell;
      await writeOutputMirror(outputFile, {
        version: 1,
        source: noteFile,
        kernel,
        session,
        language,
        cells,
      }, files);
    });
    return { ok: true, file: outputFile, cellId, kernel, session, language, output: savedCell };
  }

  async function clearAllOutputs(body) {
    const noteFile = safeNoteFile(body?.file);
    const kernel = cleanToken(body?.kernel, "python3");
    const session = cleanToken(body?.session, "default");
    const language = languageForKernel(kernel, body?.language || body?.lang);
    const outputFile = outputMirrorPath(noteFile, session, language);
    await withMirrorLock(outputFile, () => writeOutputMirror(outputFile, {
      version: 1,
      source: noteFile,
      kernel,
      session,
      language,
      cells: {},
    }, files));
    return { ok: true, file: outputFile, kernel, session };
  }

  async function variables(body) {
    const kernel = cleanToken(body?.kernel, "python3");
    if (!/python|sage/i.test(kernel)) {
      return { ok: true, supported: false, kernel, variables: [] };
    }
    // Make sure the kernel is up and its startup-namespace baseline captured
    // (a no-op if this kernel is already live) *before* reading it, so a
    // Variables-panel open as someone's very first action on a fresh kernel
    // still excludes the startup namespace instead of embedding an empty set.
    const kernelInfo = await ensureKernel({ ...(body || {}), kernel });
    const baselineJson = JSON.stringify(Array.from(kernelInfo.record.variableBaseline || [])).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const marker = `AARONNOTE_VARIABLES_${randomUUID().replace(/-/g, "")}`;
    const code = [
      "import json as _aaronnote_json",
      "import re as _aaronnote_re",
      `_aaronnote_baseline = set(_aaronnote_json.loads('${baselineJson}'))`,
      // IPython's own execution bookkeeping (In/Out history, "_"/"_i" result
      // aliases) only appears *after* code has run, so it survives the
      // startup-namespace baseline exclusion above — filter it separately,
      // the same set real Jupyter/VS Code variable explorers hide.
      "_aaronnote_ipython_re = _aaronnote_re.compile(r'^_i{1,3}$|^_i\\d+$|^_\\d+$|^(In|Out|get_ipython|exit|quit)$')",
      "def _aaronnote_repr(value):",
      "    try:",
      "        text = repr(value)",
      "    except Exception:",
      "        text = '<unrepresentable>'",
      "    return text if len(text) <= 160 else text[:157] + '...'",
      "def _aaronnote_shape(value):",
      "    shape = getattr(value, 'shape', None)",
      "    try:",
      "        return list(shape) if shape is not None else None",
      "    except Exception:",
      "        return None",
      "_aaronnote_vars = []",
      "for _aaronnote_name, _aaronnote_value in sorted(globals().items()):",
      "    if _aaronnote_name.startswith('_aaronnote_') or _aaronnote_name.startswith('__'):",
      "        continue",
      "    if _aaronnote_name in _aaronnote_baseline:",
      "        continue",
      "    if _aaronnote_ipython_re.match(_aaronnote_name):",
      "        continue",
      "    try:",
      "        _aaronnote_vars.append({'name': _aaronnote_name, 'type': type(_aaronnote_value).__name__, 'summary': _aaronnote_repr(_aaronnote_value), 'shape': _aaronnote_shape(_aaronnote_value)})",
      "    except Exception:",
      "        pass",
      `print('${marker}' + _aaronnote_json.dumps(_aaronnote_vars, default=str))`,
    ].join("\n");
    const result = await execute({ ...(body || {}), kernel, code, cellId: "__aaronnote_variables__", storeHistory: false });
    const text = (result.outputs || [])
      .filter((item) => item.output_type === "stream")
      .map((item) => String(item.text || ""))
      .join("");
    const line = text.split(/\r?\n/).find((item) => item.startsWith(marker));
    let values = [];
    if (line) {
      try { values = JSON.parse(line.slice(marker.length)); } catch {}
    }
    return { ok: true, supported: true, kernel, session: cleanToken(body?.session, "default"), variables: values };
  }

  async function kernelStatus(body) {
    const { kernel, session, key } = runtimeForBody(body || {});
    const registry = await getRegistry();
    const existing = registry.get(key);
    return {
      ok: true,
      kernel,
      session,
      status: existing?.id ? (Number(existing.running || 0) > 0 ? "running" : (existing.lastStatus || "idle")) : "not-started",
      attached: Boolean(existing?.attached),
      id: existing?.id || "",
      key: existing?.id ? key : "",
    };
  }

  async function restart(body) {
    const kernelInfo = await ensureKernel(body || {});
    const registry = await getRegistry();
    try {
      await registry.restart(kernelInfo.key);
    } catch (err) {
      throw error(err?.message || String(err), 400);
    }
    return { ok: true, kernel: kernelInfo.kernel, session: kernelInfo.session };
  }

  async function interrupt(body) {
    // Interrupt the kernel actually running this cell. Going through ensureKernel
    // would spawn a fresh idle kernel when none exists (nothing to interrupt) and
    // could desync state — a source of the flaky interrupt behavior.
    const { key, record } = await kernelRecordForBody(body || {});
    if (!record?.id) {
      return {
        ok: true,
        status: "not-started",
        kernel: cleanToken(body?.kernel, "python3"),
        session: cleanToken(body?.session, "default"),
      };
    }
    const registry = await getRegistry();
    await registry.interrupt(key);
    return { ok: true, kernel: record.kernelName, session: record.session };
  }

  async function shutdownKernel(body) {
    const { key, record } = await kernelRecordForBody(body || {});
    if (!record?.id) return { ok: true, status: "not-started" };
    const registry = await getRegistry();
    await registry.shutdown(key);
    return { ok: true, status: "shutdown", kernel: record.kernelName, session: record.session, key };
  }

  async function listTasks() {
    const registry = await getRegistry();
    return {
      ok: true,
      cleanup: {
        kernelIdleTtlMs,
        cleanupIntervalMs,
        execTimeoutMs,
        interruptGraceMs,
      },
      kernels: registry.list().map((record) => kernelTask(record.key, record)),
    };
  }

  async function cleanupIdle({ force = false, scheduled = false } = {}) {
    if (cleanupRunning) return await listTasks();
    cleanupRunning = true;
    const removed = [];
    try {
      const registry = await getRegistry();
      const now = Date.now();
      for (const record of registry.list()) {
        if (record.attached) continue;
        const running = Number(record?.running || 0) > 0;
        const isDead = record.status === "dead";
        const idleMs = now - Number(record?.lastActivity || now);
        if (!force && !isDead && (running || idleMs < kernelIdleTtlMs)) continue;
        await registry.shutdown(record.key).catch(() => {});
        removed.push({ key: record.key, kernel: record.kernelName, reason: force ? "forced" : (isDead ? "dead" : "idle") });
      }
    } finally {
      cleanupRunning = false;
      if ((await getRegistry()).list().some((r) => !r.attached)) scheduleCleanup();
    }
    const snapshot = await listTasks();
    return { ...snapshot, scheduled, removed };
  }

  async function shutdown() {
    cancelCleanupTimer();
    if (registryPromise) {
      const registry = await registryPromise;
      await registry.shutdownAll();
      process.off("exit", onProcessExit);
      registrySync = null;
    }
  }

  /** Kernel connection info for a live kernel id, for the browser-facing WS bridge. Undefined if not live. */
  async function resolveConnectionInfoById(id) {
    const registry = await getRegistry();
    const record = registry.list().find((item) => item.id === id);
    return record && record.status !== "dead" ? record.connectionInfo : undefined;
  }

  /**
   * Serve a custom (non-core) ipywidgets RequireJS module asset requested at
   * `/jupyter/nbextensions/<relative>`. Scans the same search dirs kernelspecs
   * come from, each with `/nbextensions` instead of `/kernels` appended
   * (matching a real Jupyter server's nbextensions_path). Tries the path
   * as-is, then with a `.js` suffix (RequireJS module URLs omit it).
   */
  async function readNbextensionAsset(relativePath, runtimeId = "") {
    const clean = String(relativePath || "").replace(/^\/+/, "");
    if (!clean || clean.includes("..")) return undefined;
    if (kernelHost && runtimeId) {
      const remote = await kernelHost.readNbextension(runtimeId, clean);
      if (remote?.found) {
        return {
          data: Buffer.from(String(remote.content || ""), "utf8"),
          contentType: String(remote.contentType || "application/javascript; charset=utf-8"),
        };
      }
    }
    for (const dir of kernelSearchDirs()) {
      const base = join(dir, "nbextensions");
      for (const candidate of [join(base, clean), join(base, `${clean}.js`)]) {
        if (!inside(base, candidate)) continue;
        try {
          const data = await nativeReadFile(candidate);
          return { data, contentType: candidate.endsWith(".js") ? "application/javascript; charset=utf-8" : "application/octet-stream" };
        } catch {
          continue;
        }
      }
    }
    return undefined;
  }

  async function touchKernelById(id) {
    const registry = await getRegistry();
    const record = registry.list().find((item) => item.id === id);
    if (!record) return false;
    record.lastActivity = Date.now();
    return true;
  }

  return {
    execute,
    kernels,
    openScript,
    readScriptCell,
    executeScriptCell,
    clearScriptCellOutput,
    deleteScriptCell,
    saveScriptCellOutputUi,
    clearAllOutputs,
    variables,
    kernelStatus,
    restart,
    interrupt,
    shutdownKernel,
    resolveConnectionInfoById,
    readNbextensionAsset,
    touchKernelById,
    listTasks,
    cleanup: cleanupIdle,
    shutdown,
  };
}
