import { createHash, randomUUID } from "node:crypto";
import {
  mkdir as nativeMkdir,
  readFile as nativeReadFile,
  rename as nativeRename,
  rm as nativeRm,
  stat as nativeStat,
  writeFile as nativeWriteFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createKernelRegistry, sweepOrphanKernels } from "../jupyter/kernel-registry.mjs";
import { createServerRegistry } from "../jupyter/server-registry.mjs";
import { defaultKernelSearchDirs, findKernelSpecs, findAttachableConnectionFiles, resolveAttachToken } from "../jupyter/kernel-finder.mjs";
import { executeOnKernel, jupyterWidgetCommOpenP } from "../jupyter/execution-message-handler.mjs";
import {
  commInfoOnKernel,
  completeOnKernel,
  historyOnKernel,
  inspectOnKernel,
  isCompleteOnKernel,
} from "../jupyter/kernel-requests.mjs";
import {
  applyOutputMirror,
  buildNotebook,
  createNotebook,
  notebookCellId,
  notebookCodeMap,
  notebookCodeOrder,
  notebookOutput,
  notebookOutputMirror,
  notebookSource,
  parseNotebook,
  serializeNotebook,
} from "./jupyter-notebook-format.mjs";

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
  const text = String(value || "").trim();
  return text ? notebookCellId(text) : "";
}

function languageForKernel(kernel, requested = "") {
  const explicit = String(requested || "").trim().toLowerCase();
  const value = String(kernel || "").toLowerCase();
  if (value.includes("lean") || explicit === "lean" || explicit === "lean4") return "lean4";
  if (["bash", "sh", "shell", "zsh"].includes(explicit)) return "bash";
  // Sage is a Python kernel, not a notebook language.  Kernel identity lives
  // in kernelspec metadata; filenames and language_info use Python.
  if (["sage", "sagemath", "py", "python3"].includes(explicit)) return "python";
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

function cellStoreDir(noteFile) {
  return join(dirname(noteFile), ".cell");
}

function hiddenScriptPath(noteFile, session, language) {
  const noteExt = extname(noteFile);
  const noteBase = safeSlug(basename(noteFile, noteExt), "note");
  const safeLanguage = safeSlug(language, "python");
  const safeSession = safeSlug(session, "default");
  return join(cellStoreDir(noteFile), `${noteBase}.${safeLanguage}.${safeSession}.ipynb`);
}

function legacyHiddenScriptPath(noteFile, session, language, kernel) {
  return language === "python" && /sage/i.test(String(kernel || ""))
    ? hiddenScriptPath(noteFile, session, "sage")
    : "";
}

function outputMirrorPath(noteFile, session, language) {
  return hiddenScriptPath(noteFile, session, language);
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
  return notebookCodeMap(parseNotebook(text));
}

/**
 * Read a Cell projection without creating a kernel registry.  Server reader
 * mode uses this after resolving `file` through its public catalog, so merely
 * viewing saved source/output can never discover, attach to, or sweep a
 * kernel process.
 */
export async function readPersistedScriptCell(body = {}) {
  const noteFile = resolve(String(body.noteFile || body.file || ""));
  const kernel = cleanToken(body.kernel, "python3");
  const session = cleanToken(body.session, "default");
  const language = languageForKernel(kernel, body.language || body.lang);
  const cellId = markerId(body.cellId || body.id);
  if (!noteFile) throw error("Missing note file", 400);
  if (!cellId) throw error("Missing Jupyter cell id", 400);
  const scriptFile = hiddenScriptPath(noteFile, session, language);
  let notebook = createNotebook({ sourceFile: noteFile, kernel, session, language });
  let info = null;
  try {
    notebook = parseNotebook(await nativeReadFile(scriptFile, "utf8"), {
      sourceFile: noteFile, kernel, session, language,
    });
    info = await nativeStat(scriptFile);
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
  }
  const cell = (notebook.cells || []).find((entry) => entry?.cell_type === "code" && entry.id === cellId);
  return {
    ok: true,
    kernel,
    session,
    language,
    cellId,
    code: normalizeCode(cell?.source),
    output: notebookOutput(cell, { passive: true }),
    exists: Boolean(info),
    mtimeMs: info?.mtimeMs ?? 0,
    size: info?.size ?? 0,
  };
}

function hiddenScriptCellOrder(text) {
  return notebookCodeOrder(parseNotebook(text));
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
    return notebookOutputMirror(parseNotebook(await files.readFile(file, "utf8")));
  } catch (err) {
    if (err?.code === "ENOENT") {
      if (fallbackFile && fallbackFile !== file) {
        try {
          return notebookOutputMirror(parseNotebook(await files.readFile(fallbackFile, "utf8")));
        } catch (fallbackErr) {
          if (fallbackErr?.code !== "ENOENT") throw fallbackErr;
        }
      }
      return {};
    }
    if (err instanceof SyntaxError) {
      process.stderr.write(`[aaronnote-jupyter] invalid notebook: ${file}\n`);
    }
    throw err;
  }
}

async function writeNotebookFile(file, serialized, files) {
  await files.mkdir(dirname(file), { recursive: true });
  if (files.atomicWriteP(file)) {
    await files.writeFile(file, serialized, "utf8");
    return;
  }
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await files.writeFile(tmp, serialized, "utf8");
    await files.rename(tmp, file);
  } catch (err) {
    try { await files.rm(tmp, { force: true }); } catch {}
    throw err;
  }
}

async function writeOutputMirror(file, value, files) {
  let notebook;
  try {
    notebook = parseNotebook(await files.readFile(file, "utf8"), {
      sourceFile: value?.source,
      kernel: value?.kernel,
      session: value?.session,
      language: value?.language,
    });
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    notebook = createNotebook({
      sourceFile: value?.source,
      kernel: value?.kernel,
      session: value?.session,
      language: value?.language,
    });
  }
  const serialized = serializeNotebook(applyOutputMirror(notebook, value));
  await writeNotebookFile(file, serialized, files);
}

async function readExistingHiddenScript(scriptFile, fallbackFile = "", files) {
  try {
    const text = await files.readFile(scriptFile, "utf8");
    const notebook = parseNotebook(text);
    return {
      text,
      notebook,
      cells: notebookCodeMap(notebook),
      order: notebookCodeOrder(notebook),
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      if (fallbackFile && fallbackFile !== scriptFile) {
        try {
          const text = await files.readFile(fallbackFile, "utf8");
          const notebook = parseNotebook(text);
          return {
            text: "",
            notebook,
            cells: notebookCodeMap(notebook),
            order: notebookCodeOrder(notebook),
          };
        } catch (fallbackErr) {
          if (fallbackErr?.code !== "ENOENT") throw fallbackErr;
        }
      }
      return { text: "", notebook: null, cells: new Map(), order: [] };
    }
    throw err;
  }
}

function buildHiddenScript({ noteFile, kernel, session, language, cells, targetCellId, storage = "ipynb", existingNotebook = null, dropCellIds = [] }) {
  return buildNotebook({
    existing: existingNotebook,
    noteFile,
    kernel,
    session,
    language,
    cells,
    targetCellId,
    storage,
    dropCellIds,
  });
}

export function createJupyterCellService({
  runtimeRoot,
  stateRoot,
  noteRoot,
  workspaceRoot,
  stdout = process.stdout,
  stderr = process.stderr,
  publish,
  zmq: injectedZmq,
  fileHost,
  kernelHost,
  serverHost,
  openFile,
  toolEnvironment,
} = {}) {
  const root = resolve(runtimeRoot || process.cwd());
  const notes = resolve(noteRoot || root);
  const workspace = resolve(workspaceRoot || notes);
  const jupyterRoot = join(root, "jupyter");
  const dataDir = join(jupyterRoot, ".jupyter", "data");
  const bundledKernelTemplates = join(jupyterRoot, "kernel-templates");
  const jupyterStateRoot = stateRoot
    ? join(resolve(stateRoot), "jupyter")
    : join(jupyterRoot, ".jupyter");
  const runtimeDir = join(jupyterStateRoot, "runtime");
  const kernelIdleTtlMs = durationFromEnv("AARONNOTE_JUPYTER_KERNEL_IDLE_TTL_MS", 10 * 60 * 1000);
  const cleanupIntervalMs = durationFromEnv("AARONNOTE_JUPYTER_CLEANUP_INTERVAL_MS", 30 * 1000);
  const execTimeoutMs = durationFromEnv("AARONNOTE_JUPYTER_EXEC_TIMEOUT_MS", 0);
  const interruptGraceMs = durationFromEnv("AARONNOTE_JUPYTER_INTERRUPT_GRACE_MS", 5000);
  const shutdownGraceMs = durationFromEnv("AARONNOTE_JUPYTER_SHUTDOWN_GRACE_MS", 2000);
  const introspectTimeoutMs = durationFromEnv("AARONNOTE_JUPYTER_INTROSPECT_TIMEOUT_MS", 3000);
  const liveFlushMs = durationFromEnv("AARONNOTE_JUPYTER_LIVE_FLUSH_MS", 80);
  // Jupyter itself waits for stdin indefinitely. We put a ceiling on it
  // because a prompt nobody answers also blocks every other cell sharing the
  // kernel; 0 restores the upstream behaviour.
  const stdinTimeoutMs = durationFromEnv("AARONNOTE_JUPYTER_STDIN_TIMEOUT_MS", 5 * 60 * 1000);
  const kernelspecCacheTtlMs = durationFromEnv("AARONNOTE_JUPYTER_KERNELSPEC_CACHE_TTL_MS", 15 * 1000);
  const useHomeKernels = process.env.AARONNOTE_JUPYTER_USE_HOME_KERNELS !== "0";
  const allowedKernelsRaw = String(process.env.AARONNOTE_JUPYTER_ALLOWED_KERNELS || "").trim();
  const allowedNames = allowedKernelsRaw ? allowedKernelsRaw.split(",").map((v) => v.trim()).filter(Boolean) : undefined;
  const attachDirs = [
    runtimeDir,
    ...(process.env.AARONNOTE_JUPYTER_ATTACH_DIRS ? process.env.AARONNOTE_JUPYTER_ATTACH_DIRS.split(delimiter).filter(Boolean) : []),
  ];
  const kernelspecCache = new Map();
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

  // Remote Jupyter servers. `serverHost` answers "what is server X?" — in
  // Emacs host mode the broker resolves it against the note's Remote target
  // and may open a channel first, handing back a client-reachable URL.
  const servers = serverHost
    ? createServerRegistry({
        resolveServer: (serverId) => serverHost.resolveServer(serverId),
        releaseServer: (serverId) => serverHost.releaseServer?.(serverId),
        stderr,
      })
    : null;

  let cleanupTimer = null;
  let cleanupRunning = false;
  let registryPromise = null;
  let registrySync = null;
  const mirrorLocks = new Map();
  const executionQueues = new Map();
  // UI session selection belongs to Noema.  It is deliberately separate from
  // notebook metadata: choosing "No Kernel" is live manager state, while the
  // notebook keeps its last portable kernelspec.
  const documentSessions = new Map();
  const documentSessionLimit = durationFromEnv("AARONNOTE_JUPYTER_MAX_DOCUMENT_SESSIONS", 512);

  /**
   * Record a document's live session, keeping the map bounded.
   *
   * Every field here except `detached` is recomputed from the notebook on the
   * next `managedDocument`, so the map is a cache -- but it never dropped an
   * entry, so it grew once per notebook ever opened. `detached` is the
   * exception: it is the user's explicit "no kernel" choice and is stored
   * nowhere else, so evicting it would silently re-attach a kernel they
   * turned off. Those entries stay.
   */
  function rememberDocumentSession(scriptFile, value) {
    documentSessions.set(scriptFile, value);
    if (documentSessions.size <= documentSessionLimit) return;
    for (const [key, session] of documentSessions) {
      if (documentSessions.size <= documentSessionLimit) break;
      if (key === scriptFile || session?.detached === true) continue;
      documentSessions.delete(key);
    }
  }
  /** Outstanding `input_request`s, keyed by runId, awaiting an answer from the UI. */
  const pendingStdin = new Map();

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
        // Packaged desktop state starts empty. The connection file and owned
        // kernel sidecar are the first Jupyter writes, so the registry cannot
        // assume its runtime directory was created by an earlier bootstrap.
        await nativeMkdir(runtimeDir, { recursive: true });
        const sidecarPath = join(runtimeDir, "aaronnote-owned.json");
        await sweepOrphanKernels({ sidecarPath, stderr }).catch(() => {});
        const zmq = injectedZmq || (await import("zeromq"));
        const registry = createKernelRegistry({
          runtimeDir,
          cwd: workspace,
          zmq,
          serverRegistry: servers,
          shutdownGraceMs,
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
    const key = String(file || "local");
    const cached = kernelspecCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = kernelHost && file
      ? await kernelHost.listKernelSpecs(file)
      : await findKernelSpecs({
          searchDirs: kernelSearchDirs(),
          allowedNames,
          fallbackKernelDirs: [bundledKernelTemplates],
          templateVariables: {
            AARONNOTE_JUPYTER_ROOT: jupyterRoot,
            AARONNOTE_JUPYTER_STATE_ROOT: jupyterStateRoot,
            NOEMA_USER_HOME: homedir(),
            SAGE_VERSION: String(process.env.AARONNOTE_SAGE_VERSION || "current"),
          },
        });
    kernelspecCache.set(key, { value, expiresAt: Date.now() + kernelspecCacheTtlMs });
    return value;
  }

  function withMirrorLock(file, run) {
    // Serialize read-modify-write on one notebook so two cells sharing a
    // kernel/session cannot clobber source or each other's saved outputs.
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
    const scriptFile = String(body?.scriptFile || "").trim()
      ? managedScriptFile(body)
      : hiddenScriptPath(noteFile, session, language);
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
    const scriptValue = String(body?.scriptFile || "").trim();
    if (scriptValue) {
      const scriptFile = managedScriptFile(body);
      const liveKernel = cleanToken(
        documentSessions.get(scriptFile)?.kernel || body?.kernel,
        "python3",
      );
      const key = kernelKey({ file: scriptFile, kernel: liveKernel });
      const record = registry.get(key);
      if (record) return { key, record };
      // The caller's cached kernel name may lag a socket event.  scriptFile
      // is the document identity, so prefer its most recently active private
      // runtime rather than incorrectly reporting that no kernel is running.
      const candidates = registry.list()
        .filter((item) => item.scriptFile === scriptFile)
        .sort((left, right) => Number(right.lastActivity || 0) - Number(left.lastActivity || 0));
      if (candidates[0]) return { key: candidates[0].key, record: candidates[0] };
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

  function attachLiveRuntimeFromRecord(output, record) {
    if (!output || typeof output !== "object") return output ?? null;
    const runtime = widgetRuntimeForRecord(record);
    const stamp = outputRuntimeStamp(output);
    const live = Boolean(
      runtime && stamp
      && stamp.id === runtime.id
      && Number(stamp.generation || 1) === Number(runtime.generation || 1)
    );
    const {
      widgetRuntime: _oldWidgetRuntime,
      kernelRuntime: _privateRuntimeStamp,
      ...rest
    } = output;
    return {
      ...rest,
      live,
      ...(live ? { widgetRuntime: runtime } : {}),
    };
  }

  async function attachLiveRuntimeToOutput(output, noteFile, kernel, session, language, explicitScriptFile = "") {
    if (!output || typeof output !== "object") return output ?? null;
    const scriptFile = explicitScriptFile || hiddenScriptPath(noteFile, session, language);
    const registry = await getRegistry();
    const record = registry.get(kernelKey({ file: scriptFile, kernel }));
    return attachLiveRuntimeFromRecord(output, record);
  }

  function kernelTask(key, record) {
    const now = Date.now();
    const running = Math.max(0, Number(record?.running || 0));
    const lastUsedAt = Number(record?.lastActivity || now);
    return {
      key,
      id: record?.id || "",
      file: record?.scriptFile || "",
      sourceFile: record?.sourceFile || "",
      kernel: record?.kernelName || "",
      session: record?.session || "default",
      language: record?.language || record?.kernelSpec?.language || "",
      status: record?.status === "dead" ? "dead" : (running > 0 ? "running" : (record?.lastStatus || "idle")),
      running,
      owned: Boolean(record?.owned),
      attached: Boolean(record?.attached),
      hostRuntimeId: record?.hostRuntimeId || "",
      createdAt: record?.createdAt || 0,
      createdAtIso: isoTime(record?.createdAt),
      lastUsedAt,
      lastUsedAtIso: isoTime(record?.lastActivity),
      lastActivityAt: lastUsedAt,
      lastActivityAtIso: isoTime(lastUsedAt),
      idleMs: running > 0 ? 0 : Math.max(0, now - lastUsedAt),
      runningMs: running > 0 ? Math.max(0, now - lastUsedAt) : 0,
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

  /**
   * Parse a remote-server kernel name.
   *
   *   server:<serverId>:<kernelspec>        start a new kernel there
   *   server:<serverId>:kernel:<kernelId>   adopt one already running there
   *
   * Returns undefined for any other name, so local kernelspec and `attach:`
   * names fall through unchanged.
   */
  function parseServerKernelName(kernel) {
    const value = String(kernel || "");
    if (!value.startsWith("server:")) return undefined;
    const rest = value.slice("server:".length);
    const split = rest.indexOf(":");
    if (split <= 0) return undefined;
    const serverId = rest.slice(0, split);
    const target = rest.slice(split + 1);
    if (target.startsWith("kernel:")) {
      const kernelId = target.slice("kernel:".length);
      return kernelId ? { serverId, kernelId } : undefined;
    }
    return target ? { serverId, kernelSpecName: target } : undefined;
  }

  async function ensureKernel(body) {
    const { noteFile, scriptFile, kernel, session, language, key } = runtimeForBody(body || {});
    const registry = await getRegistry();
    let record;
    const serverTarget = parseServerKernelName(kernel);
    if (serverTarget) {
      if (!servers) throw error("No Jupyter servers are configured", 400);
      record = await registry.ensureServer(key, kernel, {
        ...serverTarget,
        // The session path is what the server shows in its own UI and what
        // sets the kernel's working directory. Only the note's base name is
        // used: the server has its own filesystem, and a client-side path
        // would point at a directory that does not exist there.
        path: `${basename(noteFile).replace(/\.[^.]*$/, "")}.ipynb`,
        name: basename(noteFile),
      });
    } else if (kernel.startsWith("attach:")) {
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
    Object.assign(record, { sourceFile: noteFile, scriptFile, session, language });
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
    const attachableChoices = attachable.map((item) => ({
      name: `attach:${item.token}`,
      displayName: `Attach: ${item.token}`,
      language: "",
    }));
    const serverGroups = await listServerKernels();
    // This is the one canonical start/adopt list consumed by both the Web
    // workspace and the Emacs header.  Keep the older grouped fields for API
    // compatibility, but do not make either UI reconstruct policy itself.
    const choices = [
      ...list.map((item) => ({ ...item, kind: "start", group: "Kernel Specs" })),
      ...attachableChoices.map((item) => ({ ...item, kind: "start", group: "Attach" })),
      ...serverGroups.flatMap((server) => [
        ...(server.kernels || []).map((item) => ({
          ...item, kind: "start", group: `Server: ${server.displayName}`,
        })),
        ...(server.running || []).map((item) => ({
          ...item, kind: "start", group: `Server Running: ${server.displayName}`,
        })),
      ]),
    ];
    const scriptFile = String(body?.scriptFile || "").trim()
      ? managedScriptFile(body) : "";
    const registry = await getRegistry();
    const selections = [
      {
        kind: "none", value: "", name: "", displayName: "No Kernel",
        group: "Session", label: "No Kernel",
      },
      ...choices.map((item) => ({
        ...item,
        value: item.name,
        label: `Start · ${item.group} · ${item.displayName || item.name}  [${item.name}]`,
      })),
      ...registry.list()
        .filter((record) => scriptFile && record.scriptFile === scriptFile && record.id)
        .sort((left, right) => Number(right.lastActivity || 0) - Number(left.lastActivity || 0))
        .map((record) => {
          const status = Number(record.running || 0) > 0
            ? "running" : (record.lastStatus || record.status || "idle");
          return {
            kind: "connect",
            value: record.id,
            name: record.kernelName,
            displayName: record.kernelName,
            language: record.language || record.kernelSpec?.language || "",
            group: "Running Kernel",
            label: `Connect · Running Kernel · ${record.kernelName} · ${status}  [${record.id}]`,
          };
        }),
    ];
    return {
      ok: true,
      default: "python3",
      kernels: list.sort((a, b) => a.name.localeCompare(b.name)),
      attachable: attachableChoices,
      servers: serverGroups,
      choices,
      selections,
    };
  }

  /**
   * Kernels available on each configured remote Jupyter server: its
   * kernelspecs (start a new one) and the kernels already running there
   * (adopt one). A server that is unreachable reports its error rather than
   * disappearing from the list — silently omitting it would look like a
   * configuration problem.
   */
  async function listServerKernels() {
    if (!servers || typeof serverHost?.listServers !== "function") return [];
    let configured = [];
    try {
      configured = await serverHost.listServers();
    } catch (err) {
      stderr.write(`[aaronnote-jupyter] failed to list Jupyter servers: ${err?.message || err}\n`);
      return [];
    }
    return await Promise.all((configured || []).map(async (entry) => {
      const serverId = String(entry?.id || "");
      const base = {
        id: serverId,
        displayName: String(entry?.displayName || entry?.name || serverId),
        url: String(entry?.url || ""),
        kind: String(entry?.kind || "server"),
        target: String(entry?.target || "local"),
      };
      try {
        const [specs, running] = await Promise.all([
          servers.listKernelSpecs(serverId),
          servers.listRunning(serverId).catch(() => []),
        ]);
        return {
          ...base,
          kernels: specs.map((spec) => ({
            name: `server:${serverId}:${spec.name}`,
            displayName: String(spec.spec?.display_name || spec.name),
            language: String(spec.spec?.language || ""),
          })),
          running: running.map((model) => ({
            name: `server:${serverId}:kernel:${model.id}`,
            displayName: `${model.name} (${String(model.id).slice(0, 8)})`,
            language: "",
            lastActivity: model.last_activity || "",
            connections: Number(model.connections || 0),
            executionState: String(model.execution_state || ""),
          })),
        };
      } catch (err) {
        return { ...base, kernels: [], running: [], error: String(err?.message || err) };
      }
    }));
  }

  /**
   * The interesting half of `kernel_info_reply`. `language_info` is the only
   * authoritative source for the file extension, CodeMirror mode, and Pygments
   * lexer of a kernel's language — a kernelspec name is a guess.
   */
  function describeKernelInfo(info) {
    const language = info?.language_info || {};
    return {
      implementation: String(info?.implementation || ""),
      implementationVersion: String(info?.implementation_version || ""),
      protocolVersion: String(info?.protocol_version || ""),
      banner: String(info?.banner || ""),
      helpLinks: Array.isArray(info?.help_links) ? info.help_links : [],
      language: {
        name: String(language.name || ""),
        version: String(language.version || ""),
        mimetype: String(language.mimetype || ""),
        fileExtension: String(language.file_extension || ""),
        pygmentsLexer: String(language.pygments_lexer || ""),
        codemirrorMode: language.codemirror_mode ?? null,
      },
    };
  }

  function summarizeError(outputs) {
    const err = (outputs || []).find((item) => item.output_type === "error");
    if (!err) return "";
    return `${err.ename || "Error"}: ${err.evalue || ""}`.trim();
  }

  /**
   * Batches an execution's live output events and publishes them to the UI.
   *
   * Two things are deliberate here. Events are coalesced on a short timer
   * rather than sent per message, because a `for i in range(100000): print(i)`
   * loop emits far more iopub traffic than a UI can usefully paint, and one
   * SSE frame per line would starve everything else on that connection.
   * Consecutive appends to the same output are merged for the same reason.
   *
   * Nothing here is load-bearing for correctness: the execute RPC still
   * returns the complete outputs array, and the client reconciles against it,
   * so a dropped or coalesced-away frame only costs smoothness.
   */
  function createLiveOutputStream(kernelInfo, cellId, runId) {
    const identity = {
      key: kernelInfo.key,
      runId,
      cellId,
      file: kernelInfo.sourceFile,
      kernel: kernelInfo.kernel,
      session: kernelInfo.session,
    };
    if (typeof publish !== "function") {
      return { identity, push() {}, start() {}, finish() {} };
    }
    let pending = [];
    let timer = null;

    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending.length === 0) return;
      const events = pending;
      pending = [];
      try {
        publish("jupyter-cell", { ...identity, phase: "events", events });
      } catch {
        /* a broken event transport must never fail the execution */
      }
    };

    return {
      identity,
      start() {
        try {
          publish("jupyter-cell", { ...identity, phase: "start" });
        } catch { /* ignore */ }
      },
      push(event) {
        const last = pending[pending.length - 1];
        if (event.kind === "append" && last?.kind === "append" && last.index === event.index) {
          last.text += event.text;
        } else {
          pending.push(event);
        }
        if (!timer) {
          timer = setTimeout(flush, Math.max(0, liveFlushMs));
          timer.unref?.();
        }
      },
      finish(summary) {
        flush();
        try {
          publish("jupyter-cell", { ...identity, phase: "end", ...summary });
        } catch { /* ignore */ }
      },
    };
  }

  /**
   * Ask the UI to answer a kernel `input_request` and resolve with what the
   * user typed.
   *
   * The prompt is published on the same live channel as cell output, and the
   * answer comes back through `inputReply` below. Rejecting (cancel, timeout,
   * or shutdown) makes executeOnKernel send EOF, so the cell ends with a
   * normal EOFError rather than leaving the kernel blocked on a read.
   */
  function requestStdin(identity, request) {
    if (typeof publish !== "function") return Promise.reject(new Error("No UI to answer stdin"));
    const runId = identity.runId;
    return new Promise((resolve, reject) => {
      let timer = null;
      const settle = (fn, value) => {
        if (!pendingStdin.has(runId)) return;
        pendingStdin.delete(runId);
        if (timer) clearTimeout(timer);
        try {
          publish("jupyter-cell", { ...identity, phase: "stdin-done" });
        } catch { /* ignore */ }
        fn(value);
      };
      pendingStdin.set(runId, {
        resolve: (value) => settle(resolve, value),
        reject: (err) => settle(reject, err),
      });
      if (stdinTimeoutMs > 0) {
        timer = setTimeout(
          () => settle(reject, new Error("Timed out waiting for input")),
          stdinTimeoutMs,
        );
        timer.unref?.();
      }
      try {
        publish("jupyter-cell", { ...identity, phase: "stdin", ...request });
      } catch (ex) {
        settle(reject, ex instanceof Error ? ex : new Error(String(ex)));
      }
    });
  }

  /**
   * Answer (or cancel) an outstanding `input_request`. Cancelling is not a
   * failure: it resolves the execution with EOFError, which is what
   * interrupting a blocked `input()` does in a terminal.
   */
  async function inputReply(body) {
    const runId = String(body?.runId || "");
    const waiting = pendingStdin.get(runId);
    if (!waiting) return { ok: true, delivered: false };
    if (body?.cancel) waiting.reject(new Error("Input cancelled"));
    else waiting.resolve(String(body?.value ?? ""));
    return { ok: true, delivered: true };
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
    const runId = randomUUID();
    const live = createLiveOutputStream(kernelInfo, cellId, runId);
    live.start();
    try {
      const streamLimit = durationFromEnv("AARONNOTE_JUPYTER_MAX_STREAM_BYTES", 1024 * 1024);
      const outputLimit = durationFromEnv("AARONNOTE_JUPYTER_MAX_OUTPUTS", 4096);
      const widgetMessageLimit = durationFromEnv("AARONNOTE_JUPYTER_MAX_WIDGET_MESSAGES", 512);
      const widgetMessageBytesLimit = durationFromEnv("AARONNOTE_JUPYTER_MAX_WIDGET_MESSAGE_BYTES", 8 * 1024 * 1024);
      let result;
      try {
        result = await executeOnKernel(record.kernel, code, {
          silent: Boolean(body?.silent),
          storeHistory: body?.storeHistory !== false,
          // Jupyter's own semantics: a run-all/run-above sequence aborts the
          // remaining queued cells once one raises. A single explicit run
          // stays permissive so an error doesn't tear down a batch the user
          // didn't ask for.
          stopOnError: Boolean(body?.stopOnError),
          streamLimit,
          outputLimit,
          widgetMessageLimit,
          widgetMessageBytesLimit,
          execTimeoutMs,
          onStdin: typeof publish === "function"
            ? (request) => requestStdin(live.identity, request)
            : undefined,
          onEvent: (event) => {
            // The kernel's own busy/idle, kept separate from `lastStatus`
            // (which is the last execute_reply status): a cell can be idle
            // between two runs while its last result was an error.
            if (event.kind === "status" && event.state) record.kernelState = event.state;
            live.push(event);
          },
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
        // `execute_reply` payloads (see applyReplyPayloads): `%load` wants to
        // rewrite the cell source, `exit` wants the kernel gone. `page` was
        // already folded into `outputs`.
        ...(result.setNextInput ? { setNextInput: result.setNextInput } : {}),
        ...(result.askExit ? { askExit: result.askExit } : {}),
        ...(result.widgetMessages ? { widgetMessages: result.widgetMessages, widgetMessagesTruncated: result.widgetMessagesTruncated } : {}),
        ...(result.widgetOutputs ? { widgetOutputs: result.widgetOutputs } : {}),
      };
    } catch (err) {
      record.lastStatus = "error";
      record.lastError = err?.message || String(err || "");
      throw err;
    } finally {
      live.finish({
        status: record.lastStatus,
        executionCount: record.executionCount ?? null,
      });
      record.running = Math.max(0, Number(record.running || 0) - 1);
      record.lastActivity = Date.now();
      scheduleCleanup();
    }
  }

  /**
   * `exit`/`quit` in a cell produces an `ask_exit` payload. Honour it after
   * the response has been assembled (and outside the execution queue slot) so
   * the caller still receives the run's own output.
   */
  async function honourAskExit(key, result) {
    if (!result?.askExit || result.askExit.keepKernel) return;
    const registry = await getRegistry();
    await registry.shutdown(key).catch(() => {});
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
      const result = await runExecuteAttempt(kernelInfo, normalizedCode, normalizedCellId, body);
      await honourAskExit(kernelInfo.key, result);
      return result;
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
    const requestedKernel = cleanToken(body?.kernel, "python3");
    const session = cleanToken(body?.session, "default");
    const requestedLanguage = languageForKernel(
      requestedKernel, body?.language || body?.lang,
    );
    const targetCellId = markerId(body?.cellId || body?.id);
    const storage = "ipynb";
    const cells = Array.isArray(body?.cells) ? body.cells : [];
    if (!targetCellId) throw error("Missing Jupyter cell id", 400);
    if (cells.length === 0) throw error("No Jupyter cells to write", 400);
    const scriptFile = String(body?.scriptFile || "").trim()
      ? managedScriptFile(body)
      : hiddenScriptPath(noteFile, session, requestedLanguage);
    const legacyScriptFile = String(body?.scriptFile || "").trim()
      ? ""
      : legacyHiddenScriptPath(
        noteFile, session, requestedLanguage, requestedKernel,
      );
    let kernel = requestedKernel;
    let language = requestedLanguage;
    let rendered;
    let changed = false;
    let migratedFrom = "";
    await withMirrorLock(scriptFile, async () => {
      const existingScript = await readExistingHiddenScript(
        scriptFile, legacyScriptFile, files,
      );
      const usedLegacy = Boolean(
        legacyScriptFile && existingScript.notebook && !existingScript.text,
      );
      if (existingScript.notebook) {
        const liveSession = documentSessions.get(scriptFile) || {};
        const storedKernel = existingScript.notebook.metadata?.kernelspec?.name;
        const storedLanguage = existingScript.notebook.metadata?.language_info?.name
          || existingScript.notebook.metadata?.kernelspec?.language;
        kernel = cleanToken(liveSession.kernel || storedKernel, requestedKernel);
        language = languageForKernel(
          kernel, liveSession.language || storedLanguage || requestedLanguage,
        );
      }
      rendered = buildHiddenScript({
        noteFile,
        kernel,
        session,
        language,
        cells,
        targetCellId,
        storage,
        existingNotebook: existingScript.notebook,
      });
      changed = existingScript.text !== rendered.text;
      if (changed) await writeNotebookFile(scriptFile, rendered.text, files);
      if (usedLegacy) {
        await files.rm(legacyScriptFile, { force: true });
        migratedFrom = legacyScriptFile;
      }
    });
    const info = await files.stat(scriptFile);
    let kernelSpec = null;
    let kernelSpecError = "";
    if (!kernel.startsWith("attach:") && !kernel.startsWith("server:")) {
      try {
        kernelSpec = (await listKernelSpecs(noteFile)).find((entry) => entry?.name === kernel) || null;
      } catch (err) {
        // Editing the generated source remains useful even when discovery is
        // temporarily unavailable.  Emacs exposes this as an explicit LSP
        // fallback reason instead of failing the open operation.
        kernelSpecError = String(err?.message || err || "Kernelspec discovery failed");
      }
    }
    const payload = {
      file: scriptFile,
      line: rendered.line,
      col: 0,
      nonce: randomUUID(),
      sourceFile: noteFile,
      kernel,
      session,
      language,
      storage,
      kernelSpec,
      kernelSpecError,
    };
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
      changed,
      ...(migratedFrom ? { migratedFrom } : {}),
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
  }

  async function readScriptCell(body) {
    const noteFile = safeNoteFile(body?.file);
    const requestedKernel = cleanToken(body?.kernel, "python3");
    let session = cleanToken(body?.session, "default");
    const requestedLanguage = languageForKernel(
      requestedKernel, body?.language || body?.lang,
    );
    const cellId = markerId(body?.cellId || body?.id);
    if (!cellId) throw error("Missing Jupyter cell id", 400);
    const scriptFile = String(body?.scriptFile || "").trim()
      ? managedScriptFile(body)
      : hiddenScriptPath(noteFile, session, requestedLanguage);
    const outputFile = scriptFile;
    const existing = await readExistingHiddenScript(scriptFile, "", files);
    const liveSession = documentSessions.get(scriptFile) || {};
    const noema = notebookPrivateMetadata(existing.notebook);
    const storedKernel = existing.notebook?.metadata?.kernelspec?.name;
    const storedLanguage = noema.language
      || existing.notebook?.metadata?.language_info?.name
      || existing.notebook?.metadata?.kernelspec?.language;
    const kernel = cleanToken(liveSession.kernel || storedKernel, requestedKernel);
    session = cleanToken(liveSession.session || noema.session, session);
    const language = languageForKernel(
      kernel, liveSession.language || storedLanguage || requestedLanguage,
    );
    const savedCell = (existing.notebook.cells || []).find(
      (entry) => entry?.cell_type === "code" && entry.id === cellId,
    );
    const savedOutput = notebookOutput(savedCell, { includeRuntimeStamp: true });
    let info = null;
    try { info = await files.stat(scriptFile); } catch {}
    return {
      ok: true,
      file: scriptFile,
      kernel,
      session,
      language,
      cellId,
      code: existing.cells.get(cellId) ?? "",
      output: await attachLiveRuntimeToOutput(savedOutput, noteFile, kernel, session, language, scriptFile),
      exists: Boolean(info),
      mtimeMs: info?.mtimeMs ?? 0,
      size: info?.size ?? 0,
    };
  }

  async function persistScriptCellResult(noteFile, cell, result) {
    if (leanRuntimeP(cell.language, cell.kernel)) return;
    const outputFile = cell.file || outputMirrorPath(noteFile, cell.session, cell.language);
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
    const requestedKernel = cleanToken(body?.kernel, "python3");
    const session = cleanToken(body?.session, "default");
    const requestedLanguage = languageForKernel(
      requestedKernel, body?.language || body?.lang,
    );
    const targetCellId = markerId(body?.cellId || body?.id);
    if (!targetCellId) throw error("Missing Jupyter cell id", 400);

    const opened = await openScript({
      ...(body || {}),
      file: noteFile,
      cellId: targetCellId,
      kernel: requestedKernel,
      session,
      language: requestedLanguage,
      storage: "ipynb",
      open: false,
    });
    const kernel = cleanToken(opened.kernel, requestedKernel);
    const language = languageForKernel(
      kernel, opened.language || requestedLanguage,
    );
    const scriptFile = opened.file;
    const outputFile = opened.file;
    const runtime = runtimeForBody({
      ...(body || {}), file: noteFile, scriptFile, kernel, session, language,
    });
    return await withKernelExecutionQueue(runtime.key, async () => {
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
        return { ok: true, changed: opened.changed, file: scriptFile, outputFile, cellId: targetCellId, kernel, session, status: "ok", executionCount: null, outputs: [], results: [], plan: [] };
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
        file: scriptFile,
        outputFile,
        changed: true,
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
    if (leanRuntimeP(read.language, read.kernel)) {
      return {
        ...result,
        changed: false,
      };
    }
    await persistScriptCellResult(noteFile, read, result);
    return {
      ...result,
      live: true,
      file: read.file,
      outputFile: read.file,
    };
  }

  async function clearScriptCellOutput(body) {
    const noteFile = safeNoteFile(body?.file);
    const kernel = cleanToken(body?.kernel, "python3");
    const session = cleanToken(body?.session, "default");
    const language = languageForKernel(kernel, body?.language || body?.lang);
    const cellId = markerId(body?.cellId || body?.id);
    if (!cellId) throw error("Missing Jupyter cell id", 400);
    const outputFile = String(body?.scriptFile || "").trim()
      ? managedScriptFile(body)
      : outputMirrorPath(noteFile, session, language);
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
    const scriptFile = String(body?.scriptFile || "").trim()
      ? managedScriptFile(body)
      : hiddenScriptPath(noteFile, session, language);
    const outputFile = String(body?.scriptFile || "").trim()
      ? managedScriptFile(body)
      : outputMirrorPath(noteFile, session, language);
    let remainingOrder = [];
    let removedScript = false;
    let changedScript = false;
    await withMirrorLock(scriptFile, async () => {
      const existingScript = await readExistingHiddenScript(scriptFile, "", files);
      remainingOrder = existingScript.order.filter((id) => id && id !== cellId);
      changedScript = existingScript.order.includes(cellId);
      if (!changedScript) return;
      if (remainingOrder.length === 0) {
        await files.rm(scriptFile, { force: true });
        removedScript = true;
        return;
      }
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
        storage: "ipynb",
        existingNotebook: existingScript.notebook,
        dropCellIds: [cellId],
      });
      await writeNotebookFile(scriptFile, rendered.text, files);
    });
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
    const outputFile = String(body?.scriptFile || "").trim()
      ? managedScriptFile(body)
      : outputMirrorPath(noteFile, session, language);
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
    const outputFile = String(body?.scriptFile || "").trim()
      ? managedScriptFile(body)
      : outputMirrorPath(noteFile, session, language);
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

  /**
   * Shell-channel introspection (complete/inspect/is_complete/history/
   * comm_info) against the kernel this cell already belongs to.
   *
   * These deliberately do NOT go through ensureKernel: typing in a cell must
   * never launch a kernel process as a side effect, and they must not enter
   * the execution queue — they are not executions, and queueing them behind a
   * running cell would make the completion popup wait for it. The kernel's own
   * shell channel already serializes them; kernel-requests.mjs bounds the wait.
   */
  async function withLiveKernel(body, run, absent) {
    const { record } = await kernelRecordForBody(body || {});
    if (!record?.id || record.status === "dead") {
      return { ok: true, supported: false, ...absent };
    }
    const registry = await getRegistry();
    registry.touch(record.key);
    return { ok: true, supported: true, ...(await run(record)) };
  }

  async function complete(body) {
    return await withLiveKernel(
      body,
      async (record) => await completeOnKernel(record.kernel, {
        code: String(body?.code || ""),
        cursorPos: Number(body?.cursorPos ?? body?.cursor_pos ?? 0),
        timeoutMs: introspectTimeoutMs,
      }),
      { matches: [], items: [], cursorStart: 0, cursorEnd: 0 },
    );
  }

  async function inspect(body) {
    return await withLiveKernel(
      body,
      async (record) => await inspectOnKernel(record.kernel, {
        code: String(body?.code || ""),
        cursorPos: Number(body?.cursorPos ?? body?.cursor_pos ?? 0),
        detailLevel: Number(body?.detailLevel ?? body?.detail_level ?? 0) === 1 ? 1 : 0,
        timeoutMs: introspectTimeoutMs * 2,
      }),
      { found: false, data: {}, metadata: {} },
    );
  }

  async function isComplete(body) {
    return await withLiveKernel(
      body,
      async (record) => await isCompleteOnKernel(record.kernel, {
        code: String(body?.code || ""),
        timeoutMs: introspectTimeoutMs,
      }),
      { status: "unknown", indent: "" },
    );
  }

  async function history(body) {
    return await withLiveKernel(
      body,
      async (record) => await historyOnKernel(record.kernel, {
        pattern: String(body?.pattern || ""),
        count: Number(body?.count ?? 100),
        output: Boolean(body?.output),
        timeoutMs: introspectTimeoutMs * 2,
      }),
      { history: [] },
    );
  }

  async function commInfo(body) {
    return await withLiveKernel(
      body,
      async (record) => await commInfoOnKernel(record.kernel, {
        targetName: String(body?.targetName || body?.target_name || ""),
        timeoutMs: introspectTimeoutMs * 2,
      }),
      { comms: {} },
    );
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
      kind: existing?.kind || "",
      kernelState: existing?.kernelState || "",
      id: existing?.id || "",
      key: existing?.id ? key : "",
      ...(existing?.kernelInfo ? { kernelInfo: describeKernelInfo(existing.kernelInfo) } : {}),
    };
  }

  async function restart(body) {
    const registry = await getRegistry();
    const existing = await kernelRecordForBody(body || {});
    let key = existing.key;
    let record = existing.record;
    if (!record?.id) {
      const kernelInfo = await ensureKernel(body || {});
      key = kernelInfo.key;
      record = kernelInfo.record;
    }
    try {
      record = await registry.restart(key);
    } catch (err) {
      throw error(err?.message || String(err), 400);
    }
    return {
      ok: true,
      key,
      id: record?.id || "",
      kernel: record?.kernelName || cleanToken(body?.kernel, "python3"),
      session: record?.session || cleanToken(body?.session, "default"),
    };
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
        removed.push({
          key: record.key,
          kernel: record.kernelName,
          scriptFile: record.scriptFile || "",
          reason: force ? "forced" : (isDead ? "dead" : "idle"),
        });
      }
      // The TTL only decided freshness; nothing ever removed an entry, so the
      // map grew once per distinct note file for the life of the process.
      for (const [key, entry] of kernelspecCache) {
        if (entry.expiresAt <= now) kernelspecCache.delete(key);
      }
    } finally {
      cleanupRunning = false;
      if ((await getRegistry()).list().some((r) => !r.attached)) scheduleCleanup();
    }
    for (const scriptFile of new Set(removed.map((item) => item.scriptFile).filter(Boolean))) {
      await publishDocumentSession(scriptFile).catch(() => {});
    }
    const snapshot = await listTasks();
    return { ...snapshot, scheduled, removed };
  }

  // --- Noema-owned document manager -----------------------------------
  // These methods back jupyter.html and the Emacs toolbar.  They are adapters
  // over this service's registry/notebook functions; no protocol request is
  // delegated to Emacs.

  function managedScriptFile(body = {}) {
    const raw = String(body?.scriptFile || "").trim();
    if (!raw) throw error("Missing Jupyter scriptFile", 400);
    const scriptFile = jupyterLogicalPath(raw);
    if (!/\.ipynb$/i.test(scriptFile)) {
      throw error(`Invalid Jupyter scriptFile: ${scriptFile}`, 400);
    }
    if (!remoteLogicalPath(scriptFile)
        && !inside(notes, scriptFile) && !inside(workspace, scriptFile)) {
      throw error(`Notebook is outside the allowed root: ${scriptFile}`, 403);
    }
    return scriptFile;
  }

  function notebookPrivateMetadata(notebook) {
    const metadata = notebook?.metadata && typeof notebook.metadata === "object" ? notebook.metadata : {};
    return metadata.noema && typeof metadata.noema === "object" ? metadata.noema : {};
  }

  async function managedDocument(body = {}) {
    const scriptFile = managedScriptFile(body);
    const existing = await readExistingHiddenScript(scriptFile, "", files);
    if (!existing.notebook) throw error(`Jupyter notebook not found: ${scriptFile}`, 404);
    const notebook = existing.notebook;
    const noema = notebookPrivateMetadata(notebook);
    const kernelspec = notebook.metadata?.kernelspec || {};
    const languageInfo = notebook.metadata?.language_info || {};
    const noteFile = safeNoteFile(noema.source_file || body?.sourceFile || scriptFile);
    const portableKernel = cleanToken(kernelspec.name || body?.kernel, "python3");
    const liveSession = documentSessions.get(scriptFile) || {};
    const kernel = cleanToken(liveSession.kernel || portableKernel, portableKernel);
    const session = cleanToken(noema.session || body?.session, "default");
    const language = languageForKernel(kernel, noema.language || languageInfo.name || body?.language);
    const sessionId = `session-${createHash("sha256").update(scriptFile).digest("hex").slice(0, 24)}`;
    const value = {
      scriptFile, noteFile, notebook, text: existing.text, kernel, portableKernel,
      session, language, sessionId, detached: liveSession.detached === true,
    };
    rememberDocumentSession(scriptFile, {
      ...liveSession,
      scriptFile,
      sourceFile: noteFile,
      kernel,
      session,
      language,
      sessionId,
    });
    return value;
  }

  async function writeManagedNotebook(context) {
    const text = serializeNotebook(context.notebook);
    await withMirrorLock(context.scriptFile, () => writeNotebookFile(context.scriptFile, text, files));
    context.text = text;
    return context;
  }

  function managedBody(context, extra = {}) {
    return {
      file: context.noteFile,
      scriptFile: context.scriptFile,
      sourceFile: context.noteFile,
      kernel: context.kernel,
      session: context.session,
      language: context.language,
      ...extra,
    };
  }

  async function documentSnapshot(body = {}) {
    const context = await managedDocument(body);
    const registry = await getRegistry();
    const key = kernelKey({ file: context.scriptFile, kernel: context.kernel });
    const record = context.detached ? undefined : registry.get(key);
    const revisions = executedRevisions(record);
    let line = 1;
    const cells = [];
    for (const cell of context.notebook.cells || []) {
      if (cell?.cell_type !== "code") continue;
      const code = notebookSource(cell.source);
      const revision = codeRevision(code);
      // Notebook metadata persists only a kernelRuntime stamp.  Reattach the
      // live runtime when the same kernel generation still exists so the
      // standalone Jupyter workspace can restore ipywidget comms just like
      // Noema's in-editor Cell renderer does.
      const saved = attachLiveRuntimeFromRecord(
        notebookOutput(cell, { includeRuntimeStamp: true }) || {},
        record,
      );
      cells.push({
        id: cell.id,
        index: cells.length,
        line,
        revision,
        code,
        stale: !record?.id || revisions.get(cell.id) !== revision,
        status: String(saved.status || (record?.lastCellId === cell.id ? record.lastStatus : "idle") || "idle"),
        executionCount: cell.execution_count ?? null,
        outputs: Array.isArray(cell.outputs) ? cell.outputs : [],
        widgetMessages: Array.isArray(saved.widgetMessages) ? saved.widgetMessages : [],
        widgetOutputs: saved.widgetOutputs && typeof saved.widgetOutputs === "object" ? saved.widgetOutputs : {},
        ...(saved.widgetRuntime ? { widgetRuntime: saved.widgetRuntime } : {}),
        outputUi: saved.ui && typeof saved.ui === "object" ? saved.ui : {},
        ...(saved.stdin ? { stdin: saved.stdin } : {}),
      });
      line += code.split("\n").length + 2;
    }
    return {
      ok: true,
      documentRevision: codeRevision(context.text),
      document: {
        scriptFile: context.scriptFile,
        sourceFile: context.noteFile,
        language: context.language,
        kernel: context.detached ? "" : context.kernel,
        session: context.session,
        kernelSpecName: context.detached ? "" : context.kernel,
        kernelId: record?.id || "",
        sessionName: context.session,
        sessionId: context.sessionId,
      },
      kernelStatus: context.detached ? "no-kernel"
        : record?.id ? (Number(record.running || 0) > 0 ? "busy" : (record.lastStatus || "idle"))
          : "not-started",
      cells,
    };
  }

  async function publishDocumentSession(scriptFile) {
    const snapshot = await documentSnapshot({ scriptFile });
    if (typeof publish === "function") {
      try { publish("jupyter-session", snapshot); } catch { /* transport is best effort */ }
    }
    return snapshot;
  }

  async function managerSnapshot() {
    const registry = await getRegistry();
    const records = registry.list();
    const sessions = Array.from(documentSessions.values()).map((session) => {
      const record = session.detached ? undefined
        : records.find((item) => item.scriptFile === session.scriptFile
          && item.kernelName === session.kernel);
      return {
        id: session.sessionId,
        sessionId: session.sessionId,
        scriptFile: session.scriptFile,
        sourceFile: session.sourceFile,
        sessionName: session.session,
        language: session.language,
        kernelSpecName: session.kernel,
        kernelId: record?.id || "",
        running: Number(record?.running || 0),
      };
    });
    const kernels = records.map((record) => {
      const task = kernelTask(record.key, record);
      return {
        ...task,
        kernelId: record.id,
        kernelSpecName: record.kernelName,
        targetId: record.hosted ? "broker" : "local",
        sessionIds: sessions
          .filter((session) => session.kernelId === record.id)
          .map((session) => session.sessionId),
      };
    });
    let configuredServers = [];
    try {
      configuredServers = typeof serverHost?.listServers === "function"
        ? await serverHost.listServers() : [];
    } catch {}
    return {
      ok: true,
      server: { status: "ready", owned: true, owner: "noema" },
      servers: configuredServers,
      kernels,
      sessions,
      tasks: kernels.filter((kernel) => kernel.running > 0).map((kernel) => ({
        id: `task-${kernel.kernelId}`,
        taskId: `task-${kernel.kernelId}`,
        kernelId: kernel.kernelId,
        scriptFile: kernel.file,
        cellId: kernel.lastCellId,
        status: kernel.status,
        error: kernel.lastError,
      })),
    };
  }

  async function sessionSelect(body = {}) {
    const context = await managedDocument(body);
    const kind = String(body?.kind || "none");
    if (kind === "none") {
      documentSessions.set(context.scriptFile, {
        ...documentSessions.get(context.scriptFile), detached: true,
      });
      return await publishDocumentSession(context.scriptFile);
    }
    let kernel = "";
    if (kind === "start") {
      kernel = cleanToken(body?.kernelSpecName || body?.kernel, context.portableKernel);
    } else if (kind === "connect") {
      const registry = await getRegistry();
      const record = registry.list().find((item) => item.id === String(body?.kernelId || ""));
      if (!record) throw error(`Unknown Noema Jupyter kernel: ${body?.kernelId || ""}`, 404);
      if (record.scriptFile && record.scriptFile !== context.scriptFile) {
        throw error("A Noema document cannot adopt another document's private kernel", 400);
      }
      kernel = record.kernelName;
    } else {
      throw error(`Unsupported Jupyter session selection: ${kind}`, 400);
    }
    context.kernel = kernel;
    context.language = languageForKernel(kernel, context.language);
    context.notebook.metadata.kernelspec = {
      ...(context.notebook.metadata.kernelspec || {}),
      display_name: kernel,
      language: context.language,
      name: kernel,
    };
    context.notebook.metadata.language_info = {
      ...(context.notebook.metadata.language_info || {}),
      name: context.language,
    };
    context.notebook.metadata.noema = {
      ...notebookPrivateMetadata(context.notebook),
      language: context.language,
      session: context.session,
      storage: "ipynb",
    };
    await writeManagedNotebook(context);
    documentSessions.set(context.scriptFile, {
      ...documentSessions.get(context.scriptFile),
      kernel,
      language: context.language,
      detached: false,
    });
    await ensureKernel(managedBody(context));
    return await publishDocumentSession(context.scriptFile);
  }

  async function kernelControl(body = {}) {
    const { key, record } = await kernelRecordForBody(body);
    if (!record?.id) return { ok: true, status: "not-started" };
    const registry = await getRegistry();
    const action = String(body?.action || "");
    try {
      if (action === "interrupt") await registry.interrupt(key);
      else if (action === "restart") await registry.restart(key);
      else if (action === "shutdown") await registry.shutdown(key);
      else throw error(`Unsupported Jupyter kernel action: ${action}`, 400);
      return { ok: true, kernelId: record.id, action };
    } finally {
      if (record.scriptFile) {
        await publishDocumentSession(record.scriptFile).catch(() => {});
      }
    }
  }

  function managedCellType(value) {
    const type = String(value || "code").toLowerCase();
    if (!["code", "markdown", "raw"].includes(type)) {
      throw error(`Unsupported Jupyter cell type: ${type}`, 400);
    }
    return type;
  }

  function freshManagedCell(source = "", requestedType = "code") {
    const cellType = managedCellType(requestedType);
    const cell = {
      cell_type: cellType,
      id: notebookCellId(`cell-${randomUUID()}`),
      metadata: {},
      source,
    };
    if (cellType === "code") {
      cell.execution_count = null;
      cell.outputs = [];
    }
    return cell;
  }

  function clearManagedCellRuntime(cell) {
    if (cell?.cell_type === "code") {
      cell.execution_count = null;
      cell.outputs = [];
    } else {
      delete cell.execution_count;
      delete cell.outputs;
    }
    return cell;
  }

  function joinManagedCellSource(first, second) {
    const before = notebookSource(first);
    const after = notebookSource(second);
    if (!before || !after || before.endsWith("\n")) return `${before}${after}`;
    return `${before}\n${after}`;
  }

  async function mutateManagedDocument(context, cellId, action, body = {}) {
    const cells = context.notebook.cells || [];
    const index = cells.findIndex((cell) => cell?.id === cellId);
    if (index < 0) throw error(`Unknown Jupyter cell: ${cellId}`, 404);
    let activeCellId = cellId;
    if (action === "insertAbove" || action === "insertBelow") {
      const cell = freshManagedCell("", body?.cellType);
      cells.splice(index + (action === "insertBelow" ? 1 : 0), 0, cell);
      activeCellId = cell.id;
    } else if (action === "duplicate") {
      const original = cells[index];
      const cell = {
        ...original,
        id: notebookCellId(`cell-${randomUUID()}`),
        metadata: { ...(original.metadata || {}) },
      };
      clearManagedCellRuntime(cell);
      cells.splice(index + 1, 0, cell);
      activeCellId = cell.id;
    } else if (action === "moveUp" && index > 0) {
      [cells[index - 1], cells[index]] = [cells[index], cells[index - 1]];
    } else if (action === "moveDown" && index < cells.length - 1) {
      [cells[index], cells[index + 1]] = [cells[index + 1], cells[index]];
    } else if (action === "delete") {
      cells.splice(index, 1);
      activeCellId = cells[Math.min(index, cells.length - 1)]?.id || "";
    } else if (action === "split") {
      const original = cells[index];
      const source = Array.from(notebookSource(original.source));
      const offset = Math.max(0, Math.min(source.length, Number(body?.offset || 0)));
      original.source = source.slice(0, offset).join("");
      clearManagedCellRuntime(original);
      const cell = freshManagedCell(
        source.slice(offset).join(""), original.cell_type,
      );
      cells.splice(index + 1, 0, cell);
      activeCellId = cell.id;
    } else if (action === "mergeAbove" && index > 0) {
      const target = cells[index - 1];
      const current = cells[index];
      if (target.cell_type !== current.cell_type) {
        throw error("Cannot merge Jupyter cells with different types", 400);
      }
      target.source = joinManagedCellSource(target.source, current.source);
      clearManagedCellRuntime(target);
      cells.splice(index, 1);
      activeCellId = target.id;
    } else if (action === "mergeBelow" && index < cells.length - 1) {
      const target = cells[index];
      const next = cells[index + 1];
      if (target.cell_type !== next.cell_type) {
        throw error("Cannot merge Jupyter cells with different types", 400);
      }
      target.source = joinManagedCellSource(target.source, next.source);
      clearManagedCellRuntime(target);
      cells.splice(index + 1, 1);
      activeCellId = target.id;
    } else if (!((action === "moveUp" && index === 0)
                 || (action === "moveDown" && index === cells.length - 1)
                 || (action === "mergeAbove" && index === 0)
                 || (action === "mergeBelow" && index === cells.length - 1))) {
      throw error(`Unsupported Jupyter document action: ${action}`, 400);
    }
    context.notebook.cells = cells;
    await writeManagedNotebook(context);
    return { ok: true, activeCellId, action };
  }

  async function scriptAction(body = {}) {
    const context = await managedDocument(body);
    try {
      const action = String(body?.action || "");
      const cellId = markerId(body?.cellId || body?.id);
      if (["insertAbove", "insertBelow", "duplicate", "moveUp", "moveDown", "delete", "split", "mergeAbove", "mergeBelow"].includes(action)) {
        return await mutateManagedDocument(context, cellId, action, body);
      }
      const request = managedBody(context, { cellId });
      if (action === "clear-output") return await clearScriptCellOutput(request);
      if (action === "clear-all-outputs") return await clearAllOutputs(request);
      if (action === "interrupt") return await interrupt(request);
      if (action === "restart") return await restart(request);
      if (action === "shutdown") return await shutdownKernel(request);
      if (action === "restart-run-all") await restart(request);
      if (!action.startsWith("run-") && action !== "restart-run-all") {
        throw error(`Unsupported Jupyter script action: ${action}`, 400);
      }
      if (context.detached) throw error("This Noema document has no selected kernel", 400);
      const codeCells = (context.notebook.cells || []).filter((cell) => cell?.cell_type === "code");
      const target = codeCells.findIndex((cell) => cell.id === cellId);
      let plan;
      const mode = action === "restart-run-all" ? "all" : action.slice(4);
      if (mode === "all") plan = codeCells;
      else if (mode === "above") plan = codeCells.slice(0, target + 1);
      else if (mode === "below") plan = codeCells.slice(Math.max(0, target));
      else if (mode === "selected") {
        const selected = new Set((body?.cellIds || body?.selectedCellIds || []).map(markerId));
        plan = codeCells.filter((cell) => selected.has(cell.id));
      } else {
        if (target < 0) throw error(`Unknown Jupyter cell: ${cellId}`, 404);
        plan = [codeCells[target]];
      }
      const results = [];
      for (const cell of plan) {
        const result = await executeScriptCell(managedBody(context, { cellId: cell.id }));
        results.push(result);
        if (result?.status === "error" || result?.ok === false) break;
      }
      return { ok: results.every((result) => result?.ok !== false), action, results };
    } finally {
      await publishDocumentSession(context.scriptFile).catch(() => {});
    }
  }

  async function documentMutate(body = {}) {
    return await scriptAction({ ...body, action: body?.op });
  }

  async function documentExecute(body = {}) {
    return await scriptAction({ ...body, action: `run-${String(body?.mode || "current")}` });
  }

  async function managedVariables(body = {}) {
    const context = body?.scriptFile ? await managedDocument(body) : null;
    return await variables(context ? managedBody(context) : body);
  }

  async function shutdown() {
    cancelCleanupTimer();
    // Release anything blocked on a prompt first: shutdownAll() sends
    // shutdown_request and waits, and a kernel parked in raw_input() will not
    // service it until stdin is answered.
    for (const waiting of Array.from(pendingStdin.values())) {
      waiting.reject(new Error("Jupyter cell service is shutting down"));
    }
    if (registryPromise) {
      const registry = await registryPromise;
      await registry.shutdownAll();
      await servers?.forgetAll().catch(() => {});
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
   * Where the browser's kernel-channels WebSocket should be bridged for a live
   * kernel id: raw ZMQ for a local/attached kernel, or the remote server's own
   * `/api/kernels/<id>/channels` for a server kernel.
   */
  async function resolveKernelChannelById(id) {
    const registry = await getRegistry();
    const record = registry.list().find((item) => item.id === id);
    if (!record || record.status === "dead") return undefined;
    if (record.kind === "server") {
      if (!servers) return undefined;
      return { kind: "server", upstream: await servers.kernelChannelTarget(record.serverId, record.serverKernelId) };
    }
    return record.connectionInfo ? { kind: "zmq", connectionInfo: record.connectionInfo } : undefined;
  }

  // --- Remote server contents -------------------------------------------
  // Browse and open files that live on a Jupyter server rather than on this
  // machine or a Remote target. This is deliberately a *small* surface — list,
  // read, save — scoped to the Jupyter feature. It is not a second general
  // file framework, and nothing outside these three calls should reach for it.

  function serverContentsPath(body) {
    const serverId = String(body?.serverId || "").trim();
    if (!serverId) throw error("Missing Jupyter server id", 400);
    const path = String(body?.path ?? "").replace(/^\/+/, "");
    if (/(?:^|\/)\.\.(?:\/|$)/.test(path)) throw error("Invalid Jupyter server path", 400);
    return { serverId, path };
  }

  async function serverList(body) {
    const { serverId, path } = serverContentsPath(body);
    if (!servers) throw error("No Jupyter servers are configured", 400);
    const contents = await servers.contents(serverId);
    const model = await contents.get(path, { content: true });
    return {
      ok: true,
      serverId,
      path: String(model.path ?? path),
      type: String(model.type || "directory"),
      entries: (Array.isArray(model.content) ? model.content : []).map((entry) => ({
        name: String(entry.name || ""),
        path: String(entry.path || ""),
        type: String(entry.type || "file"),
        size: Number(entry.size || 0),
        lastModified: String(entry.last_modified || ""),
      })),
    };
  }

  async function serverRead(body) {
    const { serverId, path } = serverContentsPath(body);
    if (!servers) throw error("No Jupyter servers are configured", 400);
    const contents = await servers.contents(serverId);
    const model = await contents.get(path, { content: true, type: "file", format: "text" });
    return {
      ok: true,
      serverId,
      path: String(model.path ?? path),
      format: String(model.format || "text"),
      content: typeof model.content === "string" ? model.content : JSON.stringify(model.content ?? ""),
      lastModified: String(model.last_modified || ""),
    };
  }

  async function serverWrite(body) {
    const { serverId, path } = serverContentsPath(body);
    if (!servers) throw error("No Jupyter servers are configured", 400);
    const contents = await servers.contents(serverId);
    const model = await contents.save(path, {
      type: "file",
      format: "text",
      content: String(body?.content ?? ""),
    });
    return { ok: true, serverId, path: String(model.path ?? path), lastModified: String(model.last_modified || "") };
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
    documentSnapshot,
    documentMutate,
    documentExecute,
    managerSnapshot,
    scriptAction,
    sessionSelect,
    kernelControl,
    openBoard: managerSnapshot,
    openScript,
    readScriptCell,
    executeScriptCell,
    clearScriptCellOutput,
    deleteScriptCell,
    saveScriptCellOutputUi,
    clearAllOutputs,
    variables: managedVariables,
    inputReply,
    complete,
    inspect,
    isComplete,
    history,
    commInfo,
    kernelStatus,
    restart,
    interrupt,
    shutdownKernel,
    serverList,
    serverRead,
    serverWrite,
    resolveConnectionInfoById,
    resolveKernelChannelById,
    readNbextensionAsset,
    touchKernelById,
    listTasks,
    cleanup: cleanupIdle,
    shutdown,
  };
}
