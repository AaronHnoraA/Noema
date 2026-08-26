/**
 * Shared Noema backend for the Emacs/Appine and Tauri adapters.
 *
 * Noema owns the editable CodeMirror document in the browser.  Emacs only
 * starts this host, opens the local URL in its system webview, and receives
 * coarse adapter events such as "open this file in Emacs". There is intentionally no
 * per-keystroke Emacs -> browser preview stream here.
 */

import { createServer } from "node:http";
import { existsSync, mkdirSync, statSync, watch } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import WebSocket from "ws";

import {
  bootstrapNote,
  readNote,
  slidesMirror,
  notesIndexPayload,
  roamNotesIndexPayload,
  graphPayload,
  wantedPages,
  scanRoamNotes,
  scanNotes,
  tagIndexPayload,
  pathSuggestionsForFile,
  latexExportDefaults,
  latexExportAgentStatus,
  setLatexExportAgent,
  listLatexTemplates,
  chooseLatexOutputPath,
  exportLatex,
  bibliographyCompletions,
  bibliographyForDocument,
  readNoteCodeRegion,
  scanSnippets,
  scanTemplates,
  renameRoamTag,
  deleteRoamTag,
  roamTagOverlapReport,
  rewriteMarkdownPathReferences,
  getTodos,
  updateTodoStatus,
  buildAgenda,
  resolveBlockReference,
  buildEmbedQuery,
  buildAttributeView,
  patchAttributeViewCell,
  createTodo,
  patchTodo,
  ensureTodoId,
  clockIn,
  clockOut,
  todoRefCompletions,
  runtimeDebugSnapshot,
  loadRuntimeKatexMacros,
} from "./server/lib/index.mjs";
import {
  bibliographyPathWatchRelevant,
  bibliographyVersion,
  clearBibliographyCache,
  configure,
  configureExternalFileProvider,
  configureMarkdownFileProvider,
  configurePlanningProvider,
  configureKatexMacrosProvider,
  configureLatexProvider,
  configureAssetProvider,
  configureSessionProvider,
  configureBibliographyProvider,
  markNotesDirty,
  notesIndexVersionValue,
  noteSelfWriteRecently,
  notePathWatchRelevant,
} from "./server/lib/state.mjs";
import { createKernelMarkdownProvider } from "./server/lib/kernel-markdown-provider.mjs";
import { createKernelPlanningProvider } from "./server/lib/kernel-planning-provider.mjs";
import { createKernelKatexMacrosProvider } from "./server/lib/kernel-katex-macros-provider.mjs";
import { createKernelLatexProvider } from "./server/lib/kernel-latex-provider.mjs";
import { createKernelAssetsProvider } from "./server/lib/kernel-assets-provider.mjs";
import { createKernelSessionProvider } from "./server/lib/kernel-session-provider.mjs";
import { createKernelBibliographyProvider } from "./server/lib/kernel-bibliography-provider.mjs";
import { createKernelVaultGitProvider } from "./server/lib/kernel-vaultgit-provider.mjs";
import {
  createKernelKnowledgeSearch,
  kernelLexicalSearchEligible,
} from "./server/lib/kernel-knowledge-search.mjs";
import { createKernelRelationshipOverlay } from "./server/lib/kernel-relationships.mjs";
import { createKernelSupervisor } from "./server/lib/kernel-supervisor.mjs";
import { startNoteWatcher } from "./server/lib/watch.mjs";
import { coreTasks } from "./server/lib/task-core.mjs";
import { saveNote } from "./server/lib/save.mjs";
import {
  storeAsset,
  storeAssetFromPath,
  renderTikzAsset,
  scanUnusedAssets,
  trashUnusedAssets,
  inspectAssets,
  renameAsset,
  searchAssetContent,
  startObsidianAnalysis,
  readObsidianTask,
  startObsidianImport,
  cancelObsidianTask,
} from "./server/lib/assets.mjs";
import {
  createNode,
  createFolder,
  deleteNote,
  renameManagedPath,
  moveManagedPath,
  duplicateManagedFile,
  trashManagedPath,
} from "./server/lib/fs-ops.mjs";
import { updateCurrentNoteMeta } from "./server/lib/meta.mjs";
import { resolveContentFile, resolveMediaFile, fileContentType } from "./server/lib/media.mjs";
import {
  readRecentNotes,
  touchRecentNote,
  readCursorPositions,
  touchCursorPosition,
} from "./server/lib/session.mjs";
import {
  configureCopilotBridgeRequest,
  handleCopilotRequest,
  shutdownCopilot,
} from "./server/lib/copilot.mjs";
import {
  acceptProseWord,
  cancelExternalProseCheck,
  cancelAllExternalProseChecks,
  cancelExternalProseChecksForClient,
  probeLanguageTool,
  runExternalProseChecks,
} from "./server/lib/prose-check.mjs";
import {
  getLanguageToolSettings,
  languageToolSettingsDefaults,
  languageToolSettingsRevision,
  updateLanguageToolSettings,
} from "./server/lib/languagetool-config.mjs";
import {
  ensureNoemaAppConfig,
  getNoemaAppConfig,
  noemaAppConfigDir,
  updateNoemaAppConfig,
} from "./server/lib/app-config.mjs";
import {
  adoptWikiRepository,
  buildWikiIndex,
  cloneWikiRepository,
  copyWikiPage,
  createWikiPage,
  deleteWikiPage,
  discoverWikiRepositories,
  exportWiki,
  initWikiRepository,
  initWikiWorkspace,
  mergeWikiPages,
  moveWikiPage,
  resolveWikiLink,
  searchWikiDatabase,
  runWikiGitAction,
  updateWikiTag,
  updateWikiNamespace,
  wikiTagIndex,
  wikiDatabaseFile,
  wikiIndexStatus,
  wikiLayout,
  wikiPageDiff,
  wikiPageHistory,
  wikiRepositoryStatus,
  restoreWikiPageVersion,
  configureWikiGitProvider,
} from "./server/lib/wiki-workspace.mjs";
import {
  abortWikiConflict,
  checkpointWikiRepository,
  configureWikiSyncGitProvider,
  defaultWikiSyncIntervalMs,
  readWikiConflict,
  readWikiSyncState,
  resolveWikiConflict,
  syncWikiRepository,
} from "./server/lib/wiki-sync.mjs";
import { createWikiAutoSync } from "./server/lib/wiki-auto-sync.mjs";
import {
  coalesceWikiRefreshMode,
  wikiFullRefreshProbability,
  wikiMutationFiles,
  wikiSyncIndexRefreshPlan,
} from "./server/lib/wiki-index-refresh.mjs";
import { openWikiGitUi, stopAllWikiGitUis } from "./server/lib/wiki-git-ui.mjs";
import { knowledgeSearchResponse } from "./server/lib/knowledge-search.mjs";
import { virtualReferencesPayload } from "./server/lib/virtual-references.mjs";
import { createImeSwitcher } from "./server/lib/ime.mjs";
import { ApiRouter } from "./server/infrastructure/api-router.mjs";
import { readJson, readText } from "./server/infrastructure/http-body.mjs";
import { createAssetsApiHandlers } from "./server/Features/Assets/api.mjs";
import { createEmacsApiHandlers } from "./server/Features/Emacs/api.mjs";
import { openInVSCode } from "./server/lib/external-editor.mjs";
import { createFilesystemApiHandlers } from "./server/Features/Filesystem/api.mjs";
import { createJupyterApiHandlers } from "./server/Features/Jupyter/api.mjs";
import { createProseApiHandlers } from "./server/Features/Prose/api.mjs";
import { createSessionApiHandlers } from "./server/Features/Session/api.mjs";
import { createTasksApiHandlers } from "./server/Features/Tasks/api.mjs";

const ime = createImeSwitcher();
import { runtimeMkdtemp, sweepRuntimeTmp } from "./server/lib/tmp.mjs";
import { createJupyterCellService, readPersistedScriptCell } from "./server/lib/jupyter-cell.mjs";
import { authorizedWorkspaceEnvironment } from "./server/lib/workspace-env.mjs";
import { jupyterDefaultsFromEnv } from "./server/lib/jupyter-defaults.mjs";
import { sweepGlobalOrphanKernels } from "./server/jupyter/kernel-registry.mjs";
import { installJupyterKernelWebSocket } from "./server/lib/jupyter-kernel-ws.mjs";
import { readServerRuntimeConfig } from "./server/lib/server-config.mjs";
import {
  readServerRepositoryState,
  syncServerRepositories,
} from "./server/lib/server-repositories.mjs";
import {
  buildServerPublicCatalog,
  publicOpenedNote,
} from "./server/lib/server-public-catalog.mjs";
import {
  assertServerApiChannel,
  serverApiCompatibilityResult,
} from "./server/lib/server-policy.mjs";
import {
  NOEMA_APP_THEMES,
  noemaAppTheme,
} from "./shared/app-themes.mjs";
import * as zmq from "zeromq";

const execFileAsync = promisify(execFile);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const requestedHostMode = String(process.env.AARONNOTE_HOST_MODE || "emacs").trim().toLowerCase();
const hostMode = requestedHostMode === "desktop" || requestedHostMode === "server"
  ? requestedHostMode
  : "emacs";
const serverConfig = hostMode === "server"
  ? await readServerRuntimeConfig(process.env.NOEMA_SERVER_CONFIG)
  : null;
const webDir = resolve(process.env.AARONNOTE_WEB_DIR || join(scriptDir, "dist", "aaronnote"));
const runtimeRoot = resolve(process.env.AARONNOTE_RUNTIME_ROOT || scriptDir);
const workspaceRoot = serverConfig?.noteRoot
  || resolve(process.env.NOEMA_WORKSPACE_ROOT || process.env.AARONNOTE_WORKSPACE_ROOT || resolve(scriptDir, "..", "..", ".."));
const noteRoot = serverConfig?.noteRoot
  || resolve(process.env.NOEMA_ROOT || process.env.AARONNOTE_ROOT || join(workspaceRoot, ".roam"));
const workspaceLayout = serverConfig ? "wiki" : wikiLayout(process.env.NOEMA_WORKSPACE_LAYOUT);
const publishJsDir = resolve(process.env.AARONNOTE_PUBLISH_JS_DIR || join(runtimeRoot, "js"));
const stateRoot = serverConfig
  ? resolve(serverConfig.stateRoot, "runtime")
  : resolve(process.env.AARONNOTE_STATE_DIR || join(workspaceRoot, "var", "aaronnote"));
const tmpRoot = resolve(process.env.AARONNOTE_TMP_DIR || join(stateRoot, "tmp"));
const snippetsRoot = resolve(process.env.AARONNOTE_SNIPPETS_ROOT || (serverConfig ? join(runtimeRoot, "resources", "snippets") : join(workspaceRoot, "snippets")));
const templatesRoot = resolve(process.env.AARONNOTE_TEMPLATES_ROOT || (serverConfig ? join(runtimeRoot, "resources", "templates", "noema") : join(workspaceRoot, "templates", "noema")));
const katexMacrosDir = resolve(process.env.AARONNOTE_KATEX_MACROS_DIR || (serverConfig ? join(runtimeRoot, "resources", "katex-macros") : join(workspaceRoot, "etc", "katex-macros")));
const bindHost = serverConfig?.listen.host || process.env.AARONNOTE_WEB_HOST || "127.0.0.1";
const bindPort = serverConfig?.listen.port || Number(process.env.AARONNOTE_WEB_PORT || 0);
let noemaKernel = Object.freeze({
  state: "unavailable",
  baseUrl: "",
  box: null,
  owned: false,
  reason: "not started",
});
let kernelSupervisor = null;
const gatewayUrl = String(process.env.AARONNOTE_EMACS_GATEWAY_URL || "").trim();
const gatewayBinding = String(process.env.AARONNOTE_EMACS_GATEWAY_BINDING || "").trim();
const gatewayClientId = String(process.env.AARONNOTE_EMACS_GATEWAY_CLIENT_ID || "aaronnote").trim();
const jupyterDefaults = jupyterDefaultsFromEnv(process.env);
const liuGongQuanFontCandidates = [
  process.env.AARONNOTE_LIUGONGQUAN_FONT,
  join(homedir(), "Library", "Fonts", "方正柳公权楷书 简繁.TTF"),
  join(homedir(), "Library", "Fonts", "FZLiuGongQuanKaiShuJF.ttf"),
].filter(Boolean);

mkdirSync(noteRoot, { recursive: true });
mkdirSync(tmpRoot, { recursive: true });

const serverTheme = serverConfig ? noemaAppTheme(serverConfig.appearance.theme) : null;
const serverAppConfig = serverConfig ? {
  ok: true,
  configFile: "",
  config: {
    schemaVersion: 2,
    appearance: { theme: serverTheme.id },
    workspace: { root: "", layout: "wiki" },
    wiki: { creation: { activeProfile: "", profiles: [] } },
  },
  defaults: {
    schemaVersion: 2,
    appearance: { theme: serverTheme.id },
    workspace: { root: "", layout: "wiki" },
    wiki: { creation: { activeProfile: "", profiles: [] } },
  },
  themes: NOEMA_APP_THEMES,
  activeTheme: serverTheme,
  revision: `server-${serverTheme.id}`,
  diagnostics: [],
} : null;
const initialAppConfig = serverAppConfig || await ensureNoemaAppConfig({ env: process.env });
async function currentAppConfigPayload() {
  return serverAppConfig || await getNoemaAppConfig({ env: process.env });
}
const workspaceEnvironment = hostMode === "server"
  ? { active: false, authorized: false, root: noteRoot, variables: [], message: "Server reader mode", environment: process.env }
  : await authorizedWorkspaceEnvironment(noteRoot, process.env);

let wikiIndexCache = null;
let wikiIndexBuildPromise = null;
let wikiIndexDirty = true;
const wikiIndexPendingFiles = new Set();
let wikiIndexActive = null;
let wikiIndexLastError = "";

function invalidateWikiIndex(files = []) {
  wikiIndexDirty = true;
  for (const file of files) if (file) wikiIndexPendingFiles.add(resolve(file));
}

async function wikiIndexPayload({ force = false, mode = "auto", changedFiles = [], refresh = false } = {}) {
  const requestedMode = force ? "full" : (["auto", "incremental", "full"].includes(mode) ? mode : "auto");
  if (changedFiles.length > 0) invalidateWikiIndex(changedFiles);
  if (force || refresh || requestedMode !== "auto") wikiIndexDirty = true;
  if (!refresh && !force && requestedMode === "auto" && !wikiIndexDirty && wikiIndexCache) return wikiIndexCache;
  if (wikiIndexBuildPromise) {
    const current = await wikiIndexBuildPromise;
    if (!force && !wikiIndexDirty && wikiIndexPendingFiles.size === 0) return current;
  }
  const pendingFiles = [...wikiIndexPendingFiles];
  wikiIndexPendingFiles.clear();
  wikiIndexDirty = false;
  wikiIndexActive = { mode: requestedMode, startedAt: new Date().toISOString(), changedFiles: pendingFiles };
  wikiIndexBuildPromise = buildWikiIndex(noteRoot, {
    layout: workspaceLayout,
    mode: requestedMode,
    changedFiles: pendingFiles,
  })
    .then((index) => ({
      ...index,
      dbFile: wikiDatabaseFile(noteRoot),
      environment: {
        active: workspaceEnvironment.active,
        authorized: workspaceEnvironment.authorized,
        variables: workspaceEnvironment.variables,
        message: workspaceEnvironment.message,
      },
    }))
    .then((payload) => {
      wikiIndexCache = payload;
      wikiIndexLastError = "";
      return payload;
    })
    .catch((error) => {
      wikiIndexDirty = true;
      wikiIndexLastError = error?.message || String(error);
      throw error;
    })
    .finally(() => {
      wikiIndexBuildPromise = null;
      wikiIndexActive = null;
    });
  return await wikiIndexBuildPromise;
}

function wikiIndexStatusPayload() {
  const persisted = wikiIndexStatus(noteRoot);
  return {
    ...persisted,
    inFlight: Boolean(wikiIndexBuildPromise),
    active: wikiIndexActive,
    queued: wikiIndexPendingFiles.size,
    dirty: wikiIndexDirty,
    lastError: wikiIndexLastError || persisted.lastError || "",
  };
}

async function wikiCreatePage(body = {}) {
  const config = (await currentAppConfigPayload()).config;
  const profiles = config?.wiki?.creation?.profiles || [];
  const profile = profiles.find((item) => item.id === config?.wiki?.creation?.activeProfile) || profiles[0] || {};
  const repositoryId = String(body.repositoryId || (
    profile.repository ? `${profile.partition || "private"}/${profile.repository}` : ""
  ));
  return await createWikiPage(noteRoot, workspaceLayout, {
    ...body,
    directory: String(body.directory || profile.directory || ""),
    filenamePattern: String(body.filenamePattern || profile.filenamePattern || "{slug}.md"),
    kind: String(body.kind || profile.kind || "page"),
    repositoryId,
  });
}

configure({
  root: noteRoot,
  workspaceRoot,
  publishJsDir,
  stateRoot,
  tmpRoot,
  snippetsRoot,
  templatesRoot,
  toolEnvironment: workspaceEnvironment.environment,
  workspaceLayout,
});

let kernelKnowledgeSearch = null;
let kernelRelationshipOverlay = null;

function applyKernelState(next) {
  noemaKernel = next;
  const ready = next?.state === "listening" && next.box;
  configureMarkdownFileProvider(ready
    ? createKernelMarkdownProvider({ baseUrl: next.baseUrl, box: next.box })
    : null);
  configurePlanningProvider(ready
    ? createKernelPlanningProvider({ baseUrl: next.baseUrl, box: next.box })
    : null);
  configureKatexMacrosProvider(ready
    ? createKernelKatexMacrosProvider({ baseUrl: next.baseUrl })
    : null);
  configureLatexProvider(ready
    ? createKernelLatexProvider({ baseUrl: next.baseUrl })
    : null);
  configureAssetProvider(ready
    ? createKernelAssetsProvider({
      baseUrl: next.baseUrl,
      box: next.box,
      includePublic: workspaceLayout === "wiki",
    })
    : null);
  configureSessionProvider(ready
    ? createKernelSessionProvider({ baseUrl: next.baseUrl, box: next.box })
    : null);
  configureBibliographyProvider(ready
    ? createKernelBibliographyProvider({ baseUrl: next.baseUrl, box: next.box })
    : null);
  const vaultGitProvider = ready
    ? createKernelVaultGitProvider({ baseUrl: next.baseUrl, box: next.box })
    : null;
  configureWikiGitProvider(vaultGitProvider);
  configureWikiSyncGitProvider(vaultGitProvider);
  kernelKnowledgeSearch = ready
    ? createKernelKnowledgeSearch({ baseUrl: next.baseUrl, box: next.box })
    : null;
  kernelRelationshipOverlay = ready
    ? createKernelRelationshipOverlay({ baseUrl: next.baseUrl, box: next.box })
    : null;
}

kernelSupervisor = createKernelSupervisor({
  enabled: hostMode !== "server",
  env: process.env,
  runtimeRoot,
  stateRoot,
  noteRoot,
  stderr: process.stderr,
  onState: applyKernelState,
});
applyKernelState(kernelSupervisor.status());
void kernelSupervisor.start().catch((error) => {
  process.stderr.write(`[aaronnote-web] kernel supervisor failed: ${error?.stack || error}\n`);
});

async function productionWikiIndexPayload(options = {}) {
  const index = await wikiIndexPayload(options);
  return kernelRelationshipOverlay ? kernelRelationshipOverlay(index) : index;
}

async function knowledgeSearchPayload(body = {}) {
  const index = await productionWikiIndexPayload();
  const lexical = kernelKnowledgeSearch && kernelLexicalSearchEligible(body)
    ? await kernelKnowledgeSearch(index, body)
    : searchWikiDatabase(noteRoot, body);
  return knowledgeSearchResponse(index, body, lexical);
}

async function knowledgeVirtualReferencesPayload(body = {}) {
  const index = hostMode === "server" ? currentServerCatalog().index : await productionWikiIndexPayload();
  return virtualReferencesPayload(index, body);
}

let serverRepositoryState = serverConfig
  ? await syncServerRepositories(serverConfig)
  : null;
let serverPublicCatalog = serverConfig
  ? await buildServerPublicCatalog(await wikiIndexPayload({ force: true }), serverConfig)
  : null;

async function rebuildServerPublicCatalog({ sync = false } = {}) {
  if (!serverConfig) return null;
  if (sync) {
    serverRepositoryState = await syncServerRepositories(serverConfig, {
      previousState: serverRepositoryState,
    });
    if (serverRepositoryState.contentChanged === false && serverPublicCatalog) {
      return serverPublicCatalog;
    }
  }
  invalidateWikiIndex();
  serverPublicCatalog = await buildServerPublicCatalog(
    await wikiIndexPayload({ force: true }),
    serverConfig,
  );
  broadcast("command", {
    command: "wiki-index-changed",
    generation: serverPublicCatalog.index.generation,
  });
  return serverPublicCatalog;
}

/**
 * Remote Jupyter servers for standalone (non-Emacs) host modes, from
 * `AARONNOTE_JUPYTER_SERVERS`: a JSON array of
 * `{ id, displayName, url, kind, auth, token, password, user,
 *    allowUnauthorized, serverName }`.
 *
 * There is no Remote framework here, so every server must already be
 * reachable from this machine; `target` is accepted and ignored so one config
 * can be shared with Emacs host mode.
 */
function standaloneJupyterServerHost() {
  const raw = String(process.env.AARONNOTE_JUPYTER_SERVERS || "").trim();
  if (!raw) return undefined;
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (ex) {
    process.stderr.write(`[aaronnote-jupyter] AARONNOTE_JUPYTER_SERVERS is not valid JSON: ${ex?.message || ex}\n`);
    return undefined;
  }
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const byId = new Map(entries.filter((entry) => entry?.id).map((entry) => [String(entry.id), entry]));
  return {
    async listServers() {
      return Array.from(byId.values()).map((entry) => ({
        id: String(entry.id),
        displayName: String(entry.displayName || entry.id),
        url: String(entry.url || ""),
        kind: String(entry.kind || "server"),
        target: "local",
      }));
    },
    async resolveServer(serverId) {
      return byId.get(String(serverId));
    },
    async releaseServer() {},
  };
}

const projectedJupyterCell = hostMode === "server" ? null : createJupyterCellService({
  runtimeRoot,
  ...(hostMode === "desktop" ? { stateRoot } : {}),
  noteRoot,
  workspaceRoot,
  stdout: process.stdout,
  stderr: process.stderr,
  zmq,
  openFile: ({ file, line, col }) => apiOpenInEmacs(file, line, col),
  toolEnvironment: workspaceEnvironment.environment,
  // Live output and session changes ride the same SSE stream.  Session
  // snapshots are also forwarded to Emacs so both UIs consume one Noema-owned
  // document/session authority.
  publish: (event, payload) => {
    broadcast(event, payload);
    if (event === "jupyter-session") {
      gatewayNotify("aaronnote.event", { type: "jupyter-session", payload });
    }
  },
  fileHost: hostMode === "emacs" ? {
    async readFile(file) {
      const result = await gatewayRequest(
        "aaronnote.jupyter.file.read", { sourceFile: file, file }, 30_000,
      );
      if (!result?.exists) throw Object.assign(new Error(`No such file: ${file}`), { code: "ENOENT" });
      return String(result.content ?? "");
    },
    async writeFile(file, data) {
      return await gatewayRequest(
        "aaronnote.jupyter.file.write",
        { sourceFile: file, file, content: String(data ?? "") },
        30_000,
      );
    },
    async mkdir() {},
    async rename(from, to) {
      return await gatewayRequest(
        "aaronnote.jupyter.file.rename", { sourceFile: to, from, file: to }, 30_000,
      );
    },
    async rm(file) {
      return await gatewayRequest(
        "aaronnote.jupyter.file.delete", { sourceFile: file, file }, 30_000,
      );
    },
    async stat(file) {
      const result = await gatewayRequest(
        "aaronnote.jupyter.file.stat", { sourceFile: file, file }, 30_000,
      );
      if (!result?.exists) throw Object.assign(new Error(`No such file: ${file}`), { code: "ENOENT" });
      return result;
    },
  } : undefined,
  // Emacs may place a kernel process on a local/Remote target, but it never
  // connects to the kernel.  Noema's registry owns all Jupyter protocol and
  // ZMQ traffic using the returned connection information.
  kernelHost: hostMode === "emacs" ? {
    async listKernelSpecs(file) {
      const result = await gatewayRequest(
        "aaronnote.jupyter.kernels", { file }, 30_000,
      );
      return Array.isArray(result?.specs) ? result.specs : [];
    },
    async launch(body) {
      return await gatewayRequest("aaronnote.jupyter.launch", body, 60_000);
    },
    async status(runtimeId) {
      return await gatewayRequest(
        "aaronnote.jupyter.status", { runtimeId }, 30_000,
      );
    },
    async interrupt(runtimeId) {
      return await gatewayRequest(
        "aaronnote.jupyter.interrupt", { runtimeId }, 30_000,
      );
    },
    async restart(runtimeId) {
      // The broker relaunches on the target and returns a fresh runtime with
      // its own forward group; the registry rebinds to it rather than
      // shutting down and launching separately.
      return await gatewayRequest(
        "aaronnote.jupyter.restart", { runtimeId }, 60_000,
      );
    },
    async shutdown(runtimeId) {
      return await gatewayRequest(
        "aaronnote.jupyter.shutdown", { runtimeId }, 30_000,
      );
    },
    async readNbextension(runtimeId, relativePath) {
      return await gatewayRequest(
        "aaronnote.jupyter.read-nbextension",
        { runtimeId, relativePath },
        30_000,
      );
    },
  } : undefined,
  // Remote Jupyter servers. In Emacs host mode the broker only resolves the
  // configured endpoint, auth-source secret, and Remote route. Noema owns the
  // server sessions and kernel registry. Standalone desktop mode reads the
  // same shape from the environment so the two hosts do not diverge.
  serverHost: hostMode === "emacs" ? {
    async listServers() {
      const result = await gatewayRequest("aaronnote.jupyter.server.list", {}, 30_000);
      return Array.isArray(result?.servers) ? result.servers : [];
    },
    async resolveServer(serverId) {
      // Generous timeout: this may spawn a JupyterHub server or open an SSH
      // forward to the owning target.
      return await gatewayRequest("aaronnote.jupyter.server.resolve", { serverId }, 180_000);
    },
    async releaseServer(serverId) {
      return await gatewayRequest("aaronnote.jupyter.server.release", { serverId }, 30_000);
    },
  } : standaloneJupyterServerHost(),
});

function displayOnlyJupyterService(projection) {
  const unavailable = async () => {
    throw Object.assign(new Error("Jupyter execution is unavailable in reader mode"), {
      code: "JUPYTER_READER_MODE",
      statusCode: 503,
    });
  };
  return {
    kernels: async () => ({ ok: true, default: "", kernels: [], backendAvailable: false }),
    readScriptCell: (body) => projection.readScriptCell(body || {}),
    openScript: unavailable,
    execute: unavailable,
    executeScriptCell: unavailable,
    clearScriptCellOutput: unavailable,
    deleteScriptCell: unavailable,
    saveScriptCellOutputUi: unavailable,
    clearAllOutputs: unavailable,
    variables: unavailable,
    inputReply: unavailable,
    complete: unavailable,
    inspect: unavailable,
    isComplete: unavailable,
    history: unavailable,
    commInfo: unavailable,
    kernelStatus: async () => ({ ok: true, status: "unavailable", backendAvailable: false }),
    restart: unavailable,
    interrupt: unavailable,
    shutdownKernel: unavailable,
    serverList: (body) => projection.serverList(body || {}),
    serverRead: (body) => projection.serverRead(body || {}),
    serverWrite: unavailable,
    listTasks: async () => ({ ok: true, server: { status: "unavailable", owned: false }, kernels: [] }),
    cleanup: unavailable,
    documentSnapshot: unavailable,
    documentMutate: unavailable,
    documentExecute: unavailable,
    managerSnapshot: async () => ({
      ok: true,
      server: { status: "unavailable", owned: false },
      kernels: [],
      sessions: [],
      tasks: [],
    }),
    scriptAction: unavailable,
    sessionSelect: unavailable,
    kernelControl: unavailable,
    openBoard: unavailable,
    readNbextensionAsset: async () => undefined,
    resolveKernelChannelById: () => undefined,
    touchKernelById: () => false,
    shutdown: () => projection.shutdown(),
  };
}

const serverJupyterProjection = hostMode === "server" ? {
  async readScriptCell(body = {}) {
    const publicRef = String(body.file || "").replace(/^\/+/, "");
    const noteFile = currentServerCatalog().note(publicRef);
    if (!noteFile) {
      throw Object.assign(new Error("Page not found"), { statusCode: 404 });
    }
    return await readPersistedScriptCell({ ...body, file: noteFile });
  },
  async serverList() { return { ok: true, servers: [] }; },
  async serverRead() { throw Object.assign(new Error("Unavailable in Server reader mode"), { statusCode: 403 }); },
  async shutdown() {},
} : null;

// Desktop and Emacs-hosted Noema use the same native JS Jupyter service.
// Emacs may broker filesystem/process placement, but it is never a kernel
// client and never owns protocol state.
const jupyterCell = projectedJupyterCell
  || (serverJupyterProjection
    ? displayOnlyJupyterService(serverJupyterProjection)
    : null);
let jupyterKernelWs = null;
let gatewaySocket = null;
let gatewayRetryTimer = null;
let gatewayRequestId = 0;
let gatewayEndpointPort = 0;
const gatewayPending = new Map();

function gatewaySend(message) {
  if (gatewaySocket?.readyState === WebSocket.OPEN) {
    gatewaySocket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function gatewayNotify(method, params = {}) {
  return gatewaySend({ jsonrpc: "2.0", method, params });
}

function gatewayRequest(method, params = {}, timeoutMs = 30_000) {
  if (gatewaySocket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Emacs gateway is not connected"));
  }
  const id = `aaronnote-${++gatewayRequestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      gatewayPending.delete(id);
      reject(new Error(`Emacs gateway request timed out: ${method}`));
    }, timeoutMs);
    gatewayPending.set(id, { resolve, reject, timer });
    gatewaySend({ jsonrpc: "2.0", id, method, params });
  });
}

configureExternalFileProvider({
  owns(file) {
    const value = String(file || "");
    return value.startsWith("/fs:") || value.startsWith("fs://");
  },
  read(file) {
    return gatewayRequest(
      "aaronnote.file.read",
      { file: String(file) },
      30_000,
    );
  },
  write(body) {
    return gatewayRequest(
      "aaronnote.file.write",
      body && typeof body === "object" ? body : {},
      30_000,
    );
  },
});

configureCopilotBridgeRequest(hostMode === "emacs"
  ? (method, params) => gatewayRequest(method, params, 30_000)
  : null);

// One-shot orphan sweep: remove staging/clipboard/db temp files older than 24h.
void sweepRuntimeTmp().then(({ removed }) => {
  if (removed > 0) process.stderr.write(`[aaronnote-web] swept ${removed} orphaned tmp file(s)\n`);
}).catch(() => {});

// One-shot orphan sweep: kernels left by a dead ephemeral harness (e.g. a
// diagnostics run that used its own throwaway runtimeDir), invisible to the
// per-runtimeDir sidecar sweep inside createJupyterCellService.
void sweepGlobalOrphanKernels({ stderr: process.stderr }).then(({ reaped }) => {
  if (reaped > 0) process.stderr.write(`[aaronnote-web] swept ${reaped} orphaned kernel process(es)\n`);
}).catch(() => {});

// Vault file watcher: marks the note index dirty on external changes (Emacs
// saves, git pull, dired renames, etc.) and broadcasts a notes-index-changed
// SSE event so connected pages can refresh their notes array without polling.
// Self-writes (the server's own atomic saves/renames) are suppressed within a
// 2-second window to avoid redundant index re-reads.
// Set AARONNOTE_WATCH=0 to disable (useful in test environments).
let wikiRefreshTimer = null;
let wikiRefreshRequestedMode = "auto";
function scheduleWikiRefresh(files = [], { mode = files.length ? "incremental" : "auto" } = {}) {
  invalidateWikiIndex(files);
  wikiRefreshRequestedMode = coalesceWikiRefreshMode(wikiRefreshRequestedMode, mode);
  if (wikiRefreshTimer) clearTimeout(wikiRefreshTimer);
  wikiRefreshTimer = setTimeout(() => {
    wikiRefreshTimer = null;
    const requestedMode = wikiRefreshRequestedMode;
    wikiRefreshRequestedMode = "auto";
    void wikiIndexPayload({ mode: requestedMode })
      .then((payload) => broadcast("command", { command: "wiki-index-changed", noteCount: payload.notes.length }))
      .catch((error) => process.stderr.write(`[noema-wiki] refresh failed: ${error?.message || error}\n`));
  }, 350);
  wikiRefreshTimer.unref?.();
}

const wikiIgnoredWatchParts = new Set([
  ".git", ".noema", ".direnv", ".lake", ".mypy_cache", ".pytest_cache",
  ".ruff_cache", ".sage", ".venv", "__pycache__", ".ipynb_checkpoints", "node_modules",
]);
function wikiRepositoryIdForFile(file) {
  const absoluteFile = isAbsolute(file) ? resolve(file) : resolve(noteRoot, file);
  const rel = relative(noteRoot, absoluteFile).split(sep);
  if (!["public", "private"].includes(rel[0]) || !rel[1]) return "";
  if (rel.slice(2).some((part) => wikiIgnoredWatchParts.has(part))) return "";
  return `${rel[0]}/${rel[1]}`;
}

const wikiAutoSyncEnabled = hostMode !== "server"
  && workspaceLayout === "wiki"
  && process.env.NOEMA_WIKI_AUTO_SYNC !== "0";
const wikiFullRefreshChance = wikiFullRefreshProbability(
  process.env.NOEMA_WIKI_FULL_REFRESH_PROBABILITY,
);

function applyWikiMutationResult(result, options = {}) {
  if (result?.changed === false || result?.rendered === false) return result;
  const files = wikiMutationFiles(result, options.files || []);
  if (options.full || files.length > 0) {
    if (options.full) markNotesDirty();
    else for (const file of files) markNotesDirty(file);
    broadcast("command", { command: "notes-index-changed", version: notesIndexVersionValue() });
    scheduleWikiRefresh(files, { mode: options.full ? "full" : "incremental" });
  }
  if (options.markGit !== false) {
    for (const file of files) markWikiRepositoryDirty(file);
    const repositoryId = String(result?.repository?.id || result?.repositoryId || "");
    if (repositoryId && options.full) wikiAutoSync?.mark(repositoryId);
  }
  return result;
}

function withWikiMutationHooks(handlers, { full = [], only = null } = {}) {
  const fullChannels = new Set(full);
  const selectedChannels = only ? new Set(only) : null;
  return Object.fromEntries(Object.entries(handlers).map(([channel, handler]) => [
    channel,
    selectedChannels && !selectedChannels.has(channel)
      ? handler
      : async (...args) => applyWikiMutationResult(
          await handler(...args),
          { full: fullChannels.has(channel) },
        ),
  ]));
}

function applyWikiSyncResult(repositoryId, result, { notifyError = true } = {}) {
  broadcast("command", {
    command: "wiki-sync-state-changed",
    repositoryId,
    ...result,
    notifyError,
  });
  const refresh = wikiSyncIndexRefreshPlan(result, {
    fullProbability: wikiFullRefreshChance,
  });
  if (refresh) {
    markNotesDirty();
    broadcast("command", { command: "notes-index-changed", version: notesIndexVersionValue() });
    scheduleWikiRefresh(refresh.changedFiles, { mode: refresh.mode });
  }
  return result;
}

function wikiAutoSyncFailureMessage(failures) {
  const repositories = [...new Set(failures.map((failure) => String(failure.repositoryId || "")).filter(Boolean))];
  const noun = repositories.length === 1 ? "repository" : "repositories";
  const reasons = [...new Set(failures.map((failure) => String(failure.error || "").trim()).filter(Boolean))];
  const reason = reasons.length === 1 ? ` Reason: ${reasons[0].slice(0, 240)}.` : "";
  return `Git sync needs attention for ${repositories.length} ${noun}: ${repositories.join(", ")}.${reason} Recovery and retry details are available in Wiki repositories.`;
}

const wikiAutoSync = wikiAutoSyncEnabled
  ? createWikiAutoSync({
      debounceMs: defaultWikiSyncIntervalMs(),
      periodicMs: defaultWikiSyncIntervalMs(),
      periodicJitterMs: 10 * 60 * 1000,
      startupMs: 2_000,
      maxConcurrency: 2,
      sync: (repositoryId) => syncWikiRepository(noteRoot, repositoryId),
      flush: (repositoryId) => checkpointWikiRepository(noteRoot, repositoryId, {
        message: "noema: session checkpoint",
      }),
      onResult: (repositoryId, result) => applyWikiSyncResult(repositoryId, result, { notifyError: false }),
      onError(repositoryId, error) {
        const message = String(error?.message || error);
        process.stderr.write(`[noema-wiki] automatic sync failed for ${repositoryId}: ${message}\n`);
        broadcast("command", {
          command: "wiki-sync-state-changed",
          repositoryId,
          phase: "error",
          error: message,
          notifyError: false,
        });
      },
      onBatchError(failures) {
        broadcast("command", {
          command: "wiki-sync-batch-failed",
          failures,
          message: wikiAutoSyncFailureMessage(failures),
        });
      },
    })
  : null;

function markWikiRepositoryDirty(file) {
  const repositoryId = wikiRepositoryIdForFile(file);
  if (repositoryId) wikiAutoSync?.mark(repositoryId);
  return repositoryId;
}

async function checkpointWikiRepositoryFromApi(body = {}) {
  const repositoryId = String(body.repositoryId || "");
  const result = await checkpointWikiRepository(noteRoot, repositoryId, body);
  wikiAutoSync?.mark(repositoryId);
  return { ...result, automatic: wikiAutoSyncEnabled };
}

async function syncWikiRepositoryFromApi(body = {}) {
  const repositoryId = String(body.repositoryId || "");
  const result = wikiAutoSync
    ? await wikiAutoSync.syncNow(repositoryId)
    : await syncWikiRepository(noteRoot, repositoryId, body);
  return {
    ...(wikiAutoSync ? result : applyWikiSyncResult(repositoryId, result)),
    automatic: wikiAutoSyncEnabled,
  };
}

function reconcileWikiAutoSyncSchedule(repositoryId, result) {
  if (!wikiAutoSync || !repositoryId) return;
  if (result?.phase === "conflicted" || (result?.phase === "error" && result?.retryable === false)) {
    wikiAutoSync.pause(repositoryId);
  } else if (result?.retryable === true) {
    wikiAutoSync.retry(repositoryId, result.retryAfterMs);
  } else if (result?.phase === "idle") {
    wikiAutoSync.resume(repositoryId, { immediate: false });
  }
}

if (wikiAutoSync) {
  void discoverWikiRepositories(noteRoot)
    .then((discovered) => wikiAutoSync.start(discovered.repositories.map((repository) => repository.id)))
    .catch((error) => process.stderr.write(`[noema-wiki] automatic sync startup failed: ${error?.message || error}\n`));
}

// Server mirrors are disposable read-only checkouts and refresh on the
// configured cadence. Recursive timeouts schedule the next pull only after
// the previous one has settled, so a slow/offline sync cannot overlap itself.
function scheduleNextServerRepositorySync() {
  if (!serverConfig) return null;
  const timer = setTimeout(async () => {
    try {
      await rebuildServerPublicCatalog({ sync: true });
    } catch (error) {
      process.stderr.write(`[noema-server] repository sync failed: ${error?.message || error}\n`);
    } finally {
      serverRepositorySyncTimer = scheduleNextServerRepositorySync();
    }
  }, serverConfig.pullIntervalMinutes * 60 * 1000);
  timer.unref?.();
  return timer;
}
let serverRepositorySyncTimer = scheduleNextServerRepositorySync();

const noteWatcher = hostMode !== "server" && process.env.AARONNOTE_WATCH !== "0"
  ? startNoteWatcher({
      root: noteRoot,
      isRelevant: (file) =>
        notePathWatchRelevant(file)
        || bibliographyPathWatchRelevant(file)
        || (workspaceLayout === "wiki" && Boolean(wikiRepositoryIdForFile(file))),
      isDirectoryRelevant: (file) =>
        notePathWatchRelevant(file)
        || bibliographyPathWatchRelevant(file)
        || (workspaceLayout === "wiki" && Boolean(wikiRepositoryIdForFile(file))),
      isSelfWrite: (file) => noteSelfWriteRecently(file),
      onBatch(files) {
        const noteFiles = files.filter((file) => notePathWatchRelevant(file));
        const bibFiles = files.filter((file) => bibliographyPathWatchRelevant(file));
        for (const file of noteFiles) markNotesDirty(file);
        if (noteFiles.length > 0) {
          broadcast("command", { command: "notes-index-changed", version: notesIndexVersionValue() });
        }
        if (files.length > 0) {
          scheduleWikiRefresh(files);
          for (const file of files) markWikiRepositoryDirty(file);
        }
        if (bibFiles.length > 0) {
          clearBibliographyCache();
          broadcast("command", { command: "bibliography-index-changed", version: bibliographyVersion() });
        }
      },
      onFullRescan() {
        markNotesDirty();
        clearBibliographyCache();
        broadcast("command", { command: "notes-index-changed", version: notesIndexVersionValue() });
        broadcast("command", { command: "bibliography-index-changed", version: bibliographyVersion() });
        scheduleWikiRefresh();
      },
    })
  : { close() {} };

const wikiMaintenanceTimer = hostMode !== "server" ? setInterval(() => {
  if (wikiIndexBuildPromise) return;
  const status = wikiIndexStatus(noteRoot);
  const lastFull = Date.parse(status.lastFullAt || "");
  if (!Number.isFinite(lastFull) || Date.now() - lastFull >= 7 * 24 * 60 * 60 * 1000) {
    void wikiIndexPayload({ mode: "auto", refresh: true })
      .catch((error) => process.stderr.write(`[noema-wiki] weekly self-heal failed: ${error?.message || error}\n`));
  }
}, 6 * 60 * 60 * 1000) : null;
wikiMaintenanceTimer?.unref?.();

if (!existsSync(webDir)) {
  process.stderr.write(
    `[aaronnote-web] FATAL: web app directory not found: ${webDir}\n` +
    `[aaronnote-web] Run "npm run build" in ${runtimeRoot} to build first.\n`
  );
  process.exit(1);
}

const eventClients = new Set();
const editorClients = new Map();
let shuttingDown = false;
let shutdownPromise = null;
let fatalReported = false;
let appConfigSignature = JSON.stringify({
  revision: initialAppConfig.revision,
  diagnostics: initialAppConfig.diagnostics,
});
let appConfigWatchTimer = null;
const appConfigWatcher = hostMode === "server" ? { close() {} } : watch(noemaAppConfigDir({ env: process.env }), (_event, filename) => {
  if (filename && String(filename) !== "config.json") return;
  if (appConfigWatchTimer) clearTimeout(appConfigWatchTimer);
  appConfigWatchTimer = setTimeout(() => {
    appConfigWatchTimer = null;
    void getNoemaAppConfig({ env: process.env }).then((payload) => {
      const signature = JSON.stringify({
        revision: payload.revision,
        diagnostics: payload.diagnostics,
      });
      if (signature === appConfigSignature) return;
      appConfigSignature = signature;
      broadcast("command", {
        command: "app-config-changed",
        revision: payload.revision,
      });
    }).catch((error) => reportServerError("app-config-watch", error));
  }, 80);
});

// SSE keepalive heartbeat — prevents hung-client memory leak and keeps
// connections alive through idle-timeout proxies.
const sseHeartbeatInterval = setInterval(() => {
  const dead = [];
  for (const res of eventClients) {
    try { res.write(": keepalive\n\n"); } catch { dead.push(res); }
  }
  dead.forEach((res) => eventClients.delete(res));
}, 25000);
sseHeartbeatInterval.unref();

// Keep the process alive on unexpected errors (forcing exit would drop any
// unsaved editor state), but do not let the failure be silent: surface a
// bounded diagnostic on the SSE stream so the editor / Emacs can react instead
// of the server wedging in a half-broken state unnoticed.
let rejectionReported = false;

function reportServerError(kind, detail, { fatal = true } = {}) {
  const text = detail?.stack || String(detail ?? "");
  if (!fatal) {
    // A rejected promise is a bug in one code path, not evidence that the
    // process is unsound. Tearing the server down here would take every
    // running kernel with it (process.on("exit") SIGKILLs the owned process
    // groups), losing in-kernel state over an unrelated failure.
    process.stderr.write(`[aaronnote-web] ${kind}: ${text}\n`);
    if (!rejectionReported) {
      rejectionReported = true;
      try {
        broadcast("command", {
          command: "server-error",
          kind,
          message: hostMode === "server"
            ? "Server reader unavailable"
            : (detail instanceof Error ? detail.message : String(detail ?? "")).slice(0, 500),
          at: Date.now(),
        });
      } catch {
        // Never let diagnostic broadcasting trigger another failure.
      }
    }
    return;
  }
  if (fatalReported) return;
  fatalReported = true;
  process.stderr.write(`[aaronnote-web] ${kind}: ${text}\n`);
  try {
    broadcast("command", {
      command: "server-error",
      kind,
      message: hostMode === "server"
        ? "Server reader unavailable"
        : (detail instanceof Error ? detail.message : String(detail ?? "")).slice(0, 500),
      at: Date.now(),
    });
  } catch {
    // Never let diagnostic broadcasting trigger another uncaughtException.
  }
  void beginShutdown({ reason: kind, exitCode: 1 });
}

// An uncaught exception can leave the process in an undefined state, so it
// still shuts down. An unhandled rejection does not, and is not worth every
// kernel's memory.
process.on("uncaughtException", (err) => reportServerError("uncaughtException", err));
process.on("unhandledRejection", (reason) =>
  reportServerError("unhandledRejection", reason, { fatal: false }),
);

function closeHttpServer() {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
      setTimeout(() => {
        try { server.closeIdleConnections?.(); } catch {}
      }, 1000).unref();
    } catch {
      resolve();
    }
  });
}

async function beginShutdown({ reason = "shutdown", exitCode = 0, deadlineMs = 3000 } = {}) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  process.stderr.write(`[aaronnote-web] shutting down: ${reason}\n`);
  shutdownPromise = (async () => {
    const deadline = setTimeout(() => {
      process.stderr.write(`[aaronnote-web] shutdown deadline reached: ${reason}\n`);
      process.exit(exitCode);
    }, deadlineMs);
    deadline.unref();
    try {
      clearInterval(sseHeartbeatInterval);
      if (wikiMaintenanceTimer) clearInterval(wikiMaintenanceTimer);
      if (wikiRefreshTimer) clearTimeout(wikiRefreshTimer);
      if (serverRepositorySyncTimer) clearTimeout(serverRepositorySyncTimer);
      broadcast("command", { command: "server-shutdown", reason, at: Date.now() });
      for (const res of eventClients) {
        try { res.end(); } catch {}
      }
      eventClients.clear();
      cancelAllExternalProseChecks("server-shutdown");
      await Promise.allSettled([
        closeHttpServer(),
        Promise.resolve().then(() => appConfigWatcher.close()),
        Promise.resolve().then(() => noteWatcher.close()),
        wikiAutoSync?.close({ flush: true }),
        Promise.resolve().then(() => jupyterKernelWs?.close()),
        jupyterCell?.shutdown(),
        kernelSupervisor?.close(),
        shutdownCopilot(),
        stopAllWikiGitUis(),
      ]);
    } finally {
      clearTimeout(deadline);
      process.exit(exitCode);
    }
  })();
  return shutdownPromise;
}
process.on("SIGTERM", () => beginShutdown({ reason: "SIGTERM", exitCode: 0, deadlineMs: 30_000 }));
process.on("SIGINT", () => beginShutdown({ reason: "SIGINT", exitCode: 0 }));
process.on("exit", () => kernelSupervisor?.forceCloseSync());

// Tauri's shell sidecar API does not provide a portable SIGTERM operation.
// The desktop adapter therefore requests the same graceful path over the
// sidecar's private stdin pipe and only force-kills after its own watchdog.
if (hostMode === "desktop") {
  let desktopControlBuffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    desktopControlBuffer = `${desktopControlBuffer}${chunk}`.slice(-1024);
    for (;;) {
      const newline = desktopControlBuffer.indexOf("\n");
      if (newline < 0) break;
      const command = desktopControlBuffer.slice(0, newline).trim();
      desktopControlBuffer = desktopControlBuffer.slice(newline + 1);
      if (command === "shutdown") {
        void beginShutdown({ reason: "desktop-shutdown", exitCode: 0, deadlineMs: 30_000 });
      }
    }
  });
  process.stdin.resume();
}

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function mimeFor(file) {
  return MIME[extname(file).toLowerCase()] || fileContentType(file) || "application/octet-stream";
}

function isWithin(root, file) {
  const rel = relative(resolve(root), resolve(file));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function sendText(res, status, value, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(value);
}

function sendHtmlNoStore(res, value) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(value);
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of eventClients) {
    try {
      sendSse(res, event, data);
    } catch {
      eventClients.delete(res);
    }
  }
}

function noteEditorClient(file, client, detail = {}) {
  if (!client) return;
  editorClients.set(client, {
    file: String(file || ""),
    updatedAt: Date.now(),
    ...detail,
  });
}

function closeEditorClient(body = {}) {
  const client = String((body && typeof body === "object" ? body.client || body.clientId : "") || "").trim();
  if (!client) return { ok: true, closed: false };
  const file = String((body && typeof body === "object" ? body.file : "") || "").trim();
  const existed = editorClients.delete(client);
  void handleCopilotRequest("close", {
    ...(body && typeof body === "object" ? body : {}),
    clientId: client,
    client,
    file,
  }).catch(() => {});
  broadcast("command", {
    command: "client-closed",
    client,
    file,
    existed,
  });
  return { ok: true, closed: existed, client, file, activeClients: editorClients.size };
}

function errorPayload(err) {
  return {
    type: "error",
    ok: false,
    message: err instanceof Error ? err.message : String(err),
  };
}

function assetProxyPath(raw) {
  return `/aaronnote-asset?url=${encodeURIComponent(String(raw || ""))}`;
}

function transformJavaScript(text) {
  if (!text.includes("aaronnote-asset://")) return text;
  return text
    .replaceAll("aaronnote-asset://roam-tools", assetProxyPath("aaronnote-asset://roam-tools"))
    .replaceAll("aaronnote-asset://kinds/", assetProxyPath("aaronnote-asset://kinds/"))
    .replaceAll(
      "aaronnote-asset://font/FZLiuGongQuanKaiShuJF.ttf",
      assetProxyPath("aaronnote-asset://font/FZLiuGongQuanKaiShuJF.ttf"),
    );
}

function cleanStatusCode(err, fallback = 500) {
  const code = Number(err?.statusCode || err?.status);
  return Number.isFinite(code) && code >= 400 && code < 600 ? code : fallback;
}

async function notesListPayload(force = false) {
  if (workspaceLayout === "wiki") {
    const index = await productionWikiIndexPayload({ force });
    return {
      type: "notes",
      notes: index.notes,
      directories: index.directories,
      files: index.files,
      root: noteRoot,
      generation: index.generation,
    };
  }
  if (force) markNotesDirty();
  const payload = { type: "notes", ...await notesIndexPayload(), root: noteRoot };
  return kernelRelationshipOverlay ? kernelRelationshipOverlay(payload) : payload;
}

async function bootstrapNotePayload(file) {
  const opened = await bootstrapNote(file || undefined);
  if (workspaceLayout !== "wiki") {
    return kernelRelationshipOverlay ? kernelRelationshipOverlay(opened) : opened;
  }
  const index = await productionWikiIndexPayload();
  return {
    ...opened,
    notes: index.notes,
    directories: index.directories,
    files: index.files,
    generation: index.generation,
  };
}

let cachedCompletionTags = null;
let cachedCompletionTagsVersion = -1;
async function getCachedCompletionTags() {
  if (workspaceLayout === "wiki") {
    const index = await wikiIndexPayload();
    const names = [...new Set(index.notes.flatMap((note) => note.tags || []))].sort((a, b) => a.localeCompare(b));
    return { names, lowerNames: names.map((name) => name.toLowerCase()) };
  }
  const version = notesIndexVersionValue();
  if (cachedCompletionTags && cachedCompletionTagsVersion === version) return cachedCompletionTags;
  const payload = tagIndexPayload(await scanNotes());
  const names = payload.tags.map((tag) => tag.name);
  cachedCompletionTags = {
    names,
    lowerNames: names.map((name) => name.toLowerCase()),
  };
  cachedCompletionTagsVersion = version;
  return cachedCompletionTags;
}

let cachedCompletionRoamNotes = null;
let cachedCompletionRoamVersion = -1;
async function getCachedCompletionRoamNotes() {
  if (workspaceLayout === "wiki") {
    const index = await wikiIndexPayload();
    return index.notes.map((note) => ({
      id: note.id || note.key || "",
      key: note.key || note.id || "",
      title: note.title || "",
      path: note.path || note.file || "",
      search: [note.id, note.key, note.title, ...(note.aliases || [])]
        .map((value) => String(value || "").toLowerCase())
        .join(" "),
    }));
  }
  const version = notesIndexVersionValue();
  if (cachedCompletionRoamNotes && cachedCompletionRoamVersion === version) return cachedCompletionRoamNotes;
  cachedCompletionRoamNotes = (await scanRoamNotes())
    .filter((note) => note.roam && (note.id || note.key || note.title))
    .map((note) => ({
      id: note.id || note.key || "",
      key: note.key || note.id || "",
      title: note.title || "",
      path: note.path || note.file || "",
      search: [note.id, note.key, note.title, ...(note.aliases || [])]
        .map((value) => String(value || "").toLowerCase())
        .join(" "),
    }));
  cachedCompletionRoamVersion = version;
  return cachedCompletionRoamNotes;
}

function roamSyncStats(index) {
  const noteList = index.notes || [];
  return {
    noteCount: noteList.length,
    linkCount: noteList.reduce((sum, n) => sum + (n.refs?.length || 0), 0),
    tagCount: new Set(noteList.flatMap(n => n.tags || [])).size,
    dirCount: (index.directories || []).length,
  };
}

async function roamSyncPayload(reload = false) {
  const index = await wikiIndexPayload({ mode: reload ? "full" : "auto", refresh: true });
  return { type: "notes", ...index, stats: roamSyncStats(index), root: noteRoot, db: wikiDatabaseFile(noteRoot) };
}

async function roamSyncFullPayload() {
  markNotesDirty();
  const index = await wikiIndexPayload({ mode: "full", refresh: true });
  return { type: "notes", ...index, stats: roamSyncStats(index), root: noteRoot, db: wikiDatabaseFile(noteRoot) };
}

async function templatesPayload(force = false) {
  return { type: "templates", templates: await scanTemplates({ force }) };
}

async function snippetsPayload(force = false) {
  return { type: "snippets", snippets: await scanSnippets({ force }) };
}

function resolveShellPath(file) {
  const raw = String(file || "").trim();
  if (!raw || raw === "Root") return noteRoot;
  return resolve(isAbsolute(raw) ? raw : join(noteRoot, raw));
}

function openTargetProtocol(value) {
  return String(value || "").match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase() || "";
}

function resolveSystemOpenTarget(target, base = "") {
  const value = String(target || "").trim();
  const protocol = openTargetProtocol(value);
  if (protocol && protocol !== "file") return value;
  return resolveContentFile(value, base);
}

function resolveShellDirectoryPath(path, base = "") {
  const raw = String(path || "").trim();
  const baseFile = String(base || "").trim() ? resolveShellPath(base) : "";
  const baseDir = baseFile && !isWithin(noteRoot, baseFile) ? dirname(baseFile) : noteRoot;
  const target = !raw || raw === "Root" ? baseDir : resolve(isAbsolute(raw) ? raw : join(baseDir, raw));
  try {
    return existsSync(target) && statSync(target).isDirectory() ? target : dirname(target);
  } catch {
    return target;
  }
}

async function macOpen(args) {
  if (process.platform !== "darwin") return { ok: false, message: "Native open is only available on macOS in this host" };
  try {
    await execFileAsync("open", args);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function showInFolder(file) {
  const target = resolveShellPath(file);
  const safeTarget = isWithin(noteRoot, target) ? target : noteRoot;
  const result = await macOpen(["-R", safeTarget]);
  return { ...result, file: safeTarget };
}

async function openPath(file) {
  const target = resolveShellPath(file);
  const safeTarget = isWithin(noteRoot, target) ? target : noteRoot;
  const result = await macOpen([safeTarget]);
  return { ...result, file: safeTarget };
}

async function openDirectory(body) {
  const target = resolveShellDirectoryPath(body?.path ?? body, body?.base ?? "");
  const result = await macOpen([target]);
  return { ...result, file: target };
}

async function apiOpenInEmacs(file, line = 1, col = 0, tag = "") {
  const target = resolveShellPath(file);
  if (hostMode === "desktop") {
    const result = await openInVSCode({ file: target, line, col, tag });
    if (!result.ok) {
      const error = new Error(result.message || "Open in VS Code failed");
      error.statusCode = 500;
      throw error;
    }
    return result;
  }
  const payload = { file: target, line, col };
  if (tag) payload.tag = String(tag);
  gatewayNotify("aaronnote.event", { type: "open", payload });
  return { ok: true, ...payload };
}

async function apiCurrentFile(body) {
  const raw = String((body && typeof body === "object" ? body.file : body) || "").trim();
  const client = String((body && typeof body === "object" ? body.client : "") || "").trim();
  const target = raw ? resolveShellPath(raw) : "";
  const payload = { file: target };
  if (client) payload.client = client;
  if (client) noteEditorClient(target, client, { source: "current-file" });
  gatewayNotify("aaronnote.event", { type: "current-file", payload });
  return { ok: true, ...payload };
}

async function apiEmacsUiState(body) {
  const payload = body && typeof body === "object" ? body : {};
  gatewayNotify("aaronnote.event", { type: "ui-state", payload });
  return { ok: true };
}

async function apiEmacsKey(body) {
  const k = String((body && typeof body === "object" ? body.key : body) || "").trim();
  const client = String((body && typeof body === "object" ? body.client : "") || "").trim();
  if (!k || k.length > 32) return { ok: false, message: "Invalid key" };
  const payload = { key: k };
  if (client) payload.client = client;
  gatewayNotify("aaronnote.event", { type: "key", payload });
  return { ok: true };
}

async function apiSystemOpen(body) {
  const value = String((body && typeof body === "object" ? body.target : body) || "").trim();
  const base = String((body && typeof body === "object" ? body.base : "") || "");
  if (!value) {
    const err = new Error("system-open: empty target");
    err.statusCode = 400;
    throw err;
  }
  const resolved = resolveSystemOpenTarget(value, base);
  gatewayNotify("aaronnote.event", {
    type: "system-open",
    payload: { target: resolved },
  });
  return { ok: true, target: resolved };
}

async function apiEmacsZotero(body, eventName = "zotero") {
  const source = body && typeof body === "object" ? body : {};
  const payload = {};
  for (const key of ["uri", "key", "doi", "title", "bibFile", "namespace", "currentFile", "targetFile", "query", "client"]) {
    const value = String(source[key] || "").trim();
    if (value) payload[key] = value.slice(0, key === "title" || key === "query" ? 2000 : 8192);
  }
  gatewayNotify("aaronnote.event", { type: eventName, payload });
  return { ok: true, queued: true };
}

async function apiChooseNotePath(body = {}) {
  if (hostMode !== "emacs") {
    return { ok: false, canceled: true, path: "", relativePath: "", message: "Emacs path chooser is unavailable" };
  }
  const result = await gatewayRequest("aaronnote.note.choose-path", {
    root: String(body.root || noteRoot),
    defaultPath: String(body.defaultPath || body.root || noteRoot),
    title: String(body.title || "Choose note path"),
    kind: body.kind === "file" ? "file" : "directory",
  }, 120_000);
  return { ok: true, ...result };
}

function currentServerCatalog() {
  if (!serverPublicCatalog) {
    throw Object.assign(new Error("Public catalog is unavailable"), { statusCode: 503 });
  }
  return serverPublicCatalog;
}

async function serverOpenedPayload(file, includeIndex = false) {
  const catalog = currentServerCatalog();
  const indexPayload = includeIndex ? {
    notes: catalog.index.notes,
    files: catalog.index.files,
    directories: catalog.index.directories,
    repositories: catalog.index.repositories,
    reports: catalog.index.reports,
    generation: catalog.index.generation,
    root: "",
  } : {};
  if (!file) {
    return {
      type: "open",
      file: "",
      title: "Noema",
      mode: "markdown",
      content: "# Noema\n\nChoose a public page from the Wiki.",
      kind: "page",
      remote: true,
      ...indexPayload,
    };
  }
  const opened = await publicOpenedNote(catalog, file);
  return includeIndex ? { ...opened, ...indexPayload } : opened;
}

const apiRouter = new ApiRouter().register({
  "aaronnote:api:wiki:bootstrap": () => hostMode === "server" ? currentServerCatalog().index : productionWikiIndexPayload(),
  "aaronnote:api:wiki:environment": () => ({
    ok: true,
    active: workspaceEnvironment.active,
    authorized: workspaceEnvironment.authorized,
    root: hostMode === "server" ? "" : workspaceEnvironment.root,
    variables: hostMode === "server" ? [] : workspaceEnvironment.variables,
    message: workspaceEnvironment.message,
  }),
  "aaronnote:api:wiki:refresh": (body) => hostMode === "server"
    ? currentServerCatalog().index
    : productionWikiIndexPayload({ mode: body?.mode || "auto", refresh: true }),
  "aaronnote:api:wiki:index-status": () => hostMode === "server"
    ? { ok: true, mode: "server", generation: currentServerCatalog().index.generation, inFlight: false, queued: 0 }
    : wikiIndexStatusPayload(),
  "aaronnote:api:wiki:search": async (body) => hostMode === "server"
    ? currentServerCatalog().search(body || {})
    : knowledgeSearchPayload(body || {}),
  "aaronnote:api:knowledge:search": async (body) => hostMode === "server"
    ? currentServerCatalog().search(body || {})
    : knowledgeSearchPayload(body || {}),
  "aaronnote:api:knowledge:virtual-references": (body) => knowledgeVirtualReferencesPayload(body || {}),
  "aaronnote:api:wiki:resolve-link": async (body) => hostMode === "server"
    ? currentServerCatalog().resolveLink(body?.target ?? body, body?.sourceFile || "")
    : resolveWikiLink(await wikiIndexPayload(), body?.target ?? body, { sourceFile: body?.sourceFile || "" }),
  "aaronnote:api:wiki:init-workspace": async () => applyWikiMutationResult(
    await initWikiWorkspace(noteRoot), { full: true, markGit: false },
  ),
  "aaronnote:api:wiki:init-repository": async (body) => applyWikiMutationResult(
    await initWikiRepository(noteRoot, body?.partition, body?.name), { full: true },
  ),
  "aaronnote:api:wiki:clone-repository": async (body) => applyWikiMutationResult(
    await cloneWikiRepository(noteRoot, body || {}), { full: true },
  ),
  "aaronnote:api:wiki:adopt-repository": async (body) => applyWikiMutationResult(
    await adoptWikiRepository(noteRoot, body?.repositoryId), { full: true },
  ),
  "aaronnote:api:wiki:repository-status": (body) => wikiRepositoryStatus(noteRoot, body?.repositoryId ?? body),
  "aaronnote:api:wiki:git": async (body) => {
    const repositoryId = String(body?.repositoryId || "");
    const result = await runWikiGitAction(noteRoot, body?.action, body || {});
    return body?.action === "pull" ? applyWikiSyncResult(repositoryId, result) : result;
  },
  "aaronnote:api:wiki:create-page": async (body) => applyWikiMutationResult(await wikiCreatePage(body || {})),
  "aaronnote:api:wiki:move-page": async (body) => applyWikiMutationResult(await moveWikiPage(noteRoot, body || {})),
  "aaronnote:api:wiki:delete-page": async (body) => applyWikiMutationResult(await deleteWikiPage(noteRoot, body || {})),
  "aaronnote:api:wiki:copy-page": async (body) => applyWikiMutationResult(await copyWikiPage(noteRoot, body || {})),
  "aaronnote:api:wiki:merge-pages": async (body) => applyWikiMutationResult(await mergeWikiPages(noteRoot, body || {})),
  "aaronnote:api:wiki:tags": async () => ({
    ok: true,
    type: "wiki-tags",
    tags: wikiTagIndex(hostMode === "server" ? currentServerCatalog().index : await wikiIndexPayload()),
  }),
  "aaronnote:api:wiki:update-tag": async (body) => applyWikiMutationResult(await updateWikiTag(noteRoot, body || {})),
  "aaronnote:api:wiki:update-namespace": async (body) => applyWikiMutationResult(await updateWikiNamespace(noteRoot, body || {})),
  "aaronnote:api:wiki:export": (body) => exportWiki(noteRoot, body || {}),
  "aaronnote:api:wiki:page-history": (body) => wikiPageHistory(noteRoot, body || {}),
  "aaronnote:api:wiki:page-diff": (body) => wikiPageDiff(noteRoot, body || {}),
  "aaronnote:api:wiki:restore-page": async (body) => {
    const result = await restoreWikiPageVersion(noteRoot, body || {});
    return applyWikiMutationResult(result);
  },
  "aaronnote:api:wiki:sync-status": async (body) => ({
    ...await readWikiSyncState(noteRoot, body?.repositoryId || ""),
    automatic: wikiAutoSyncEnabled,
  }),
  "aaronnote:api:wiki:checkpoint": (body) => checkpointWikiRepositoryFromApi(body || {}),
  "aaronnote:api:wiki:sync": (body) => syncWikiRepositoryFromApi(body || {}),
  "aaronnote:api:wiki:conflict": (body) => readWikiConflict(noteRoot, body || {}),
  "aaronnote:api:wiki:resolve-conflict": async (body) => {
    const repositoryId = String(body?.repositoryId || "");
    const result = await resolveWikiConflict(noteRoot, body || {});
    reconcileWikiAutoSyncSchedule(repositoryId, result);
    return applyWikiSyncResult(repositoryId, result);
  },
  "aaronnote:api:wiki:abort-conflict": async (body) => {
    const repositoryId = String(body?.repositoryId || "");
    const result = await abortWikiConflict(noteRoot, repositoryId);
    reconcileWikiAutoSyncSchedule(repositoryId, result);
    broadcast("command", { command: "wiki-sync-state-changed", repositoryId, ...result });
    return result;
  },
  "aaronnote:api:wiki:git-ui": (body) => openWikiGitUi(noteRoot, body?.repositoryId),
  "aaronnote:api:notes:bootstrap": (file) => hostMode === "server" ? serverOpenedPayload(file, true) : bootstrapNotePayload(file),
  "aaronnote:api:notes:open": (file) => hostMode === "server" ? serverOpenedPayload(file, false) : readNote(file),
  "aaronnote:api:notes:list": (force) => hostMode === "server" ? currentServerCatalog().index : notesListPayload(force === true),
  "aaronnote:api:notes:save": async (body) => {
    const result = await saveNote(body || {});
    if (result?.ok && !result?.conflict && !result?.stale && result?.file) {
      gatewayNotify("aaronnote.event", {
        type: "saved",
        payload: { file: String(result.file) },
      });
      broadcast("command", {
        command: "note-saved",
        file: String(result.file),
        mtimeMs: Number(result.mtimeMs) || 0,
        clientId: String((body && typeof body === "object" ? body.clientId : "") || ""),
      });
      applyWikiMutationResult(result);
    }
    return result;
  },
  "aaronnote:api:notes:create-node": async (draft) => applyWikiMutationResult(await createNode(draft || {})),
  "aaronnote:api:notes:delete": async (file) => applyWikiMutationResult(await deleteNote({ file })),
  "aaronnote:api:notes:delete-node": async (file) => applyWikiMutationResult(await deleteNote({ file })),
  "aaronnote:api:notes:create-folder": async (path) => applyWikiMutationResult(
    await createFolder({ path }), { full: true },
  ),
  "aaronnote:api:notes:path-suggestions": async (body) => {
    const file = typeof body === "string" ? body : body?.file;
    const prefix = typeof body === "string" ? "./" : body?.prefix;
    return { type: "path-suggestions", paths: await pathSuggestionsForFile(file || "", prefix || "./") };
  },
  "aaronnote:api:completions:tags": async (body) => {
    const prefix = String(body?.prefix || "").toLowerCase();
    const { names, lowerNames } = await getCachedCompletionTags();
    const filtered = prefix ? names.filter((_, index) => lowerNames[index].includes(prefix)) : names;
    return { type: "completion-tags", tags: filtered.slice(0, 50) };
  },
  "aaronnote:api:completions:roam": async (body) => {
    const prefix = String(body?.prefix || "").toLowerCase();
    const roamNotes = await getCachedCompletionRoamNotes();
    const matches = prefix ? roamNotes.filter((note) => note.search.includes(prefix)) : roamNotes;
    return {
      type: "completion-roam",
      notes: matches.slice(0, 20).map((note) => ({
        id: note.id,
        key: note.key,
        title: note.title,
        path: note.path,
      })),
    };
  },
  "aaronnote:api:completions:todo-refs": async (body) => {
    return await todoRefCompletions(body || {});
  },
  "aaronnote:api:completions:bibliography": async (body) => {
    return await bibliographyCompletions(body || {});
  },
  "aaronnote:api:bibliography:document": async (body) => {
    return await bibliographyForDocument(body || {});
  },
  "aaronnote:api:notes:todos": async (body) => {
    return await getTodos(typeof body === "string" ? body : body || {});
  },
  "aaronnote:api:notes:update-todo": async (body) => {
    const result = await updateTodoStatus(body || {});
    broadcast("command", { command: "agenda-changed", version: notesIndexVersionValue() });
    return result.changed === false ? result : applyWikiMutationResult(result);
  },
  "aaronnote:api:notes:agenda": (body) => buildAgenda(body || {}),
  "aaronnote:api:notes:resolve-block": (body) => resolveBlockReference(body || {}),
  "aaronnote:api:notes:embed-query": (body) => buildEmbedQuery(body || {}),
  "aaronnote:api:notes:attribute-view": (body) => buildAttributeView(body || {}),
  "aaronnote:api:notes:attribute-view-cell-patch": async (body) => {
    const result = await patchAttributeViewCell(body || {});
    broadcast("command", { command: "agenda-changed", version: notesIndexVersionValue() });
    return result.changed === false ? result : applyWikiMutationResult(result);
  },
  "aaronnote:api:notes:create-todo": async (body) => {
    const result = await createTodo(body || {});
    broadcast("command", { command: "agenda-changed", version: notesIndexVersionValue() });
    return applyWikiMutationResult(result);
  },
  "aaronnote:api:notes:patch-todo": async (body) => {
    const result = await patchTodo(body || {});
    broadcast("command", { command: "agenda-changed", version: notesIndexVersionValue() });
    return result.changed === false ? result : applyWikiMutationResult(result);
  },
  "aaronnote:api:notes:clock-in": async (body) => {
    const result = await clockIn(body || {});
    broadcast("command", { command: "agenda-changed", version: notesIndexVersionValue() });
    return applyWikiMutationResult(result);
  },
  "aaronnote:api:notes:clock-out": async (body) => {
    const result = await clockOut(body || {});
    broadcast("command", { command: "agenda-changed", version: notesIndexVersionValue() });
    return applyWikiMutationResult(result);
  },
  "aaronnote:api:notes:todo-dep-ref": async (body) => {
    const targetId = String(body?.targetId || "");
    if (!targetId) {
      const err = new Error("targetId is required");
      err.statusCode = 400;
      throw err;
    }
    if (targetId.startsWith("#")) {
      return { type: "todo-dep-ref", ref: targetId };
    }
    const { todos } = await getTodos("");
    const target = todos.find((todo) => todo.id === targetId);
    if (!target) {
      const err = new Error("Todo not found");
      err.statusCode = 404;
      throw err;
    }
    // The dependency picker is an explicit action, so it's worth minting a
    // stable id for the target (if it doesn't have one yet) rather than
    // writing a fragile text reference — the ref then survives the target's
    // title being edited later.
    const idResult = await ensureTodoId({ file: target.file, index: target.index, source: target.source, id: target.id, text: target.text });
    if (idResult.changed) {
      broadcast("command", { command: "agenda-changed", version: notesIndexVersionValue() });
      applyWikiMutationResult(idResult);
    }
    return { type: "todo-dep-ref", ref: idResult.id };
  },
  "aaronnote:api:notes:index": async () => {
    if (hostMode === "server") return { type: "notes", ...currentServerCatalog().index, root: "" };
    const payload = { type: "notes", ...await notesIndexPayload(), root: noteRoot };
    return kernelRelationshipOverlay ? kernelRelationshipOverlay(payload) : payload;
  },
  "aaronnote:api:notes:graph": async () => {
    const wikiGraph = hostMode === "server" || workspaceLayout === "wiki";
    const graphIndex = wikiGraph
      ? (hostMode === "server" ? currentServerCatalog().index : await productionWikiIndexPayload())
      : null;
    const legacyNotes = graphIndex ? null : await scanRoamNotes();
    const relationshipIndex = legacyNotes && kernelRelationshipOverlay
      ? await kernelRelationshipOverlay({ notes: legacyNotes })
      : null;
    const payload = graphPayload(
      graphIndex ? graphIndex.notes : relationshipIndex?.notes || legacyNotes,
      {
        scope: hostMode === "server" ? "server" : wikiGraph ? "wiki" : "legacy",
        generation: graphIndex?.generation || "",
      },
    );
    return {
      ...payload,
      indexVersion: notesIndexVersionValue(),
      relationshipSource: graphIndex?.relationshipSource || relationshipIndex?.relationshipSource || "node",
    };
  },
  "aaronnote:api:notes:roam-index": async () => {
    const payload = { type: "notes", ...await roamNotesIndexPayload(), root: noteRoot };
    return kernelRelationshipOverlay ? kernelRelationshipOverlay(payload) : payload;
  },
  "aaronnote:api:runtime:debug": async () => ({ type: "runtime-debug", ...runtimeDebugSnapshot() }),
  "aaronnote:api:note-code:read-region": (body) => readNoteCodeRegion(body || {}),
  "aaronnote:api:slides:mirror": async (body) => applyWikiMutationResult(await slidesMirror(body || {})),
  ...(jupyterCell ? withWikiMutationHooks(createJupyterApiHandlers(jupyterCell), {
    only: [
      "aaronnote:api:jupyter-cell:open-script",
      "aaronnote:api:jupyter-cell:execute-script-cell",
      "aaronnote:api:jupyter-cell:clear-script-cell-output",
      "aaronnote:api:jupyter-cell:delete-script-cell",
      "aaronnote:api:jupyter-cell:save-script-cell-output-ui",
      "aaronnote:api:jupyter-cell:clear-all-outputs",
    ],
  }) : {}),
  "aaronnote:api:notes:wanted": async () => {
    const notes = await scanRoamNotes();
    return wantedPages(notes);
  },
  "aaronnote:api:notes:roam-sync": (reload) => roamSyncPayload(reload === true),
  "aaronnote:api:notes:roam-sync-full": () => roamSyncFullPayload(),
  "aaronnote:api:notes:templates": (force) => templatesPayload(force === true),
  "aaronnote:api:notes:snippets": () => snippetsPayload(true),
  "aaronnote:api:latex:defaults": (body) => latexExportDefaults(body || {}),
  "aaronnote:api:latex:agent-status": () => latexExportAgentStatus(),
  "aaronnote:api:latex:set-agent": (body) => setLatexExportAgent(body || {}),
  "aaronnote:api:latex:templates": () => listLatexTemplates(),
  "aaronnote:api:latex:choose-output-path": (body) => chooseLatexOutputPath(body || {}),
  "aaronnote:api:latex:export": (body) => {
    const request = { ...(body || {}) };
    const file = String(request.file || request.sourceFile || "");
    const outputPath = String(request.outputPath || "");
    const duplicate = coreTasks.list({ kind: "latex-export", activeOnly: true })
      .find((active) => outputPath && String(active.metadata?.outputPath || "") === outputPath);
    if (duplicate) {
      const error = new Error("A LaTeX export is already active for this output path");
      error.statusCode = 409;
      throw error;
    }
    const task = coreTasks.start({
      kind: "latex-export",
      title: `Export ${basename(file || outputPath || "document")}`,
      description: `Convert ${String(request.scope || "note")} Markdown to LaTeX and compile PDF`,
      metadata: {
        file,
        outputPath,
        scope: String(request.scope || "note"),
        templatePath: String(request.templatePath || ""),
        engine: String(request.engine || ""),
      },
      run: ({ signal, progress }) => exportLatex({ ...request, signal, onProgress: progress }),
      restartable: true,
      exclusiveKey: outputPath ? `latex-export:${outputPath}` : "",
    });
    return { type: "core-task-started", ok: true, task };
  },
  ...createTasksApiHandlers(coreTasks),
  "aaronnote:api:notes:meta-add": async (body) => applyWikiMutationResult(
    await updateCurrentNoteMeta(body || {}, "add"),
  ),

  "aaronnote:api:roam-tools:rename-tag": async (body) => applyWikiMutationResult(await renameRoamTag(body || {})),
  "aaronnote:api:roam-tools:delete-tag": async (body) => applyWikiMutationResult(await deleteRoamTag(body || {})),
  "aaronnote:api:roam-tools:tag-overlap": () => roamTagOverlapReport(),
  "aaronnote:api:roam-tools:rewrite-path-refs": async (body) => {
    const result = await rewriteMarkdownPathReferences(body || {});
    return result.dryRun ? result : applyWikiMutationResult(result);
  },

  ...withWikiMutationHooks(createAssetsApiHandlers({
    noteRoot,
    storeAsset,
    storeAssetFromPath,
    renderTikzAsset,
    scanUnusedAssets,
    trashUnusedAssets,
    inspectAssets,
    renameAsset,
    searchAssetContent,
    startObsidianAnalysis,
    readObsidianTask,
    startObsidianImport,
    cancelObsidianTask,
    readSystemClipboard,
  }), { full: ["aaronnote:api:assets:trash-orphans"] }),
  ...createSessionApiHandlers({
    readRecentNotes,
    touchRecentNote,
    readCursorPositions,
    touchCursorPosition,
    closeEditorClient,
    cancelExternalProseChecksForClient,
  }),
  ...withWikiMutationHooks(createFilesystemApiHandlers({
    renameManagedPath,
    moveManagedPath,
    duplicateManagedFile,
    trashManagedPath,
    updateCurrentNoteMeta,
  }), {
    full: [
      "aaronnote:api:fs:rename",
      "aaronnote:api:fs:move",
      "aaronnote:api:fs:trash",
    ],
  }),

  "aaronnote:api:copilot:request": (action, body) => handleCopilotRequest(String(action || ""), body || {}),

  ...createProseApiHandlers({
    runExternalProseChecks,
    acceptProseWord,
    cancelExternalProseCheck,
    getLanguageToolSettings,
    languageToolSettingsRevision,
    languageToolSettingsDefaults,
    updateLanguageToolSettings,
    probeLanguageTool,
    broadcast,
  }),
  "aaronnote:api:ime:vim-mode": (body) => ime.vimMode(String(body?.mode || "")),
  "aaronnote:api:shell:show-in-folder": (file) => showInFolder(file),
  "aaronnote:api:shell:open-path": (file) => openPath(file),
  "aaronnote:api:shell:open-directory": (body) => openDirectory(body),
  "aaronnote:api:shell:open-directory-in-kitty": () => ({ ok: false, message: "Kitty integration is not available in the Emacs web host yet" }),
  "aaronnote:api:shell:show-attachment-menu": (file) => openPath(file),
  "aaronnote:api:shell:show-editor-context-menu": () => ({ ok: true }),
  ...createEmacsApiHandlers({
    apiOpenInEmacs,
    apiCurrentFile,
    apiEmacsUiState,
    apiEmacsKey,
    apiSystemOpen,
    apiEmacsZotero,
    apiChooseNotePath,
  }),
  "aaronnote:api:config:katex-macros": async () => {
    const payload = await katexMacrosPayload();
    return hostMode === "server" ? { ...payload, dir: "" } : payload;
  },
  "aaronnote:api:config:app": () => currentAppConfigPayload(),
  "aaronnote:api:config:update-app": async (body) => {
    const payload = await updateNoemaAppConfig(body || {}, {
      env: process.env,
      expectedRevision: String(body?.revision || ""),
    });
    appConfigSignature = JSON.stringify({
      revision: payload.revision,
      diagnostics: payload.diagnostics,
    });
    broadcast("command", {
      command: "app-config-changed",
      revision: payload.revision,
    });
    return payload;
  },
}, "web-host");

// Read + parse the global KaTeX macro folder on every request (few small files),
// so editing macros only needs a browser refresh to take effect.
async function katexMacrosPayload() {
  const { dir, macros, errors, source } = await loadRuntimeKatexMacros(katexMacrosDir);
  return { type: "katex-macros", dir, macros, errors, source };
}

async function readSystemClipboard(body) {
  const file = String(body.file || "");
  let tempDir = "";
  try {
    tempDir = await runtimeMkdtemp("clipboard", file || "clipboard.png");
    const target = join(tempDir, "clipboard.png");
    await execFileAsync("pngpaste", [target]);
    if (await isFile(target)) {
      const asset = await storeAssetFromPath({
        file,
        path: target,
        name: "clipboard.png",
        type: "image/png",
      });
      return { kind: "asset", asset };
    }
  } catch (_) {
    // No image on the clipboard, pngpaste unavailable, or asset storage failed.
  } finally {
    if (tempDir) {
      try { await rm(tempDir, { recursive: true, force: true }); } catch {}
    }
  }

  try {
    const { stdout } = await execFileAsync("pbpaste");
    return stdout ? { kind: "text", text: stdout } : { kind: "empty" };
  } catch (_) {
    return { kind: "empty" };
  }
}

async function callApi(channel, args = []) {
  if (hostMode === "server") {
    assertServerApiChannel(channel);
    const compatibility = serverApiCompatibilityResult(channel);
    if (compatibility !== undefined) return compatibility;
  }
  return await apiRouter.call(channel, args);
}

async function handleEmacsCommand(body = {}) {
  if (body.type === "command" || body.command) {
    const detail = {
      ...(body.detail && typeof body.detail === "object" ? body.detail : {}),
      command: String(body.command || ""),
    };
    if (body.client) detail.client = String(body.client);
    broadcast("command", detail);
    return { ok: true };
  }
  if (body.type === "client-close") {
    cancelExternalProseChecksForClient(body.clientId || body.client);
    return closeEditorClient(body);
  }
  if (body.type === "open" || body.file) {
    const file = resolveShellPath(body.file);
    broadcast("open-file", { file });
    return { ok: true, file };
  }
  throw Object.assign(new Error("Unknown command type"), { code: -32602 });
}

async function handleGatewayRequest(message) {
  const hasId = Object.prototype.hasOwnProperty.call(message || {}, "id");
  try {
    let result;
    if (message.method === "aaronnote.command") {
      result = await handleEmacsCommand(message.params || {});
    } else if (message.method === "aaronnote.api") {
      result = await callApi(
        String(message.params?.channel || ""),
        message.params?.args || [],
      );
    } else if (message.method === "aaronnote.jupyter.publish") {
      broadcast("jupyter-cell", message.params || {});
      result = { ok: true };
    } else {
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    }
    if (hasId) gatewaySend({ jsonrpc: "2.0", id: message.id, result: result ?? null });
  } catch (error) {
    if (hasId) {
      gatewaySend({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: Number(error?.code) || -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

function handleGatewayMessage(raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (message?.method) {
    void handleGatewayRequest(message);
    return;
  }
  if (message?.id === "register") {
    if (message.error) {
      process.stderr.write(
        `[aaronnote-web] gateway registration failed: ${message.error.message}\n`,
      );
    } else {
      gatewayNotify("aaronnote.event", {
        type: "ready",
        payload: { port: gatewayEndpointPort },
      });
    }
    return;
  }
  const pending = gatewayPending.get(message?.id);
  if (!pending) return;
  gatewayPending.delete(message.id);
  clearTimeout(pending.timer);
  if (message.error) {
    pending.reject(new Error(
      `Emacs gateway error ${message.error.code}: ${message.error.message}`,
    ));
  } else {
    pending.resolve(message.result);
  }
}

function connectGateway(port) {
  if (!gatewayUrl || !gatewayBinding) {
    process.stderr.write("[aaronnote-web] Emacs gateway configuration missing\n");
    return;
  }
  clearTimeout(gatewayRetryTimer);
  gatewayEndpointPort = port;
  gatewaySocket = new WebSocket(gatewayUrl);
  gatewaySocket.on("open", () => {
    gatewaySend({
      jsonrpc: "2.0",
      id: "register",
      method: "gateway.register",
      params: {
        bindingId: gatewayBinding,
        clientId: gatewayClientId,
        instanceId: `aaronnote-${process.pid}`,
        provides: ["aaronnote.command", "aaronnote.api"],
        endpoint: {
          host: bindHost,
          port,
          url: `http://${bindHost}:${port}`,
        },
      },
    });
  });
  gatewaySocket.on("message", handleGatewayMessage);
  gatewaySocket.on("error", (error) => {
    process.stderr.write(`[aaronnote-web] gateway error: ${error.message}\n`);
  });
  gatewaySocket.on("close", () => {
    gatewaySocket = null;
    for (const { reject, timer } of gatewayPending.values()) {
      clearTimeout(timer);
      reject(new Error("Emacs gateway disconnected"));
    }
    gatewayPending.clear();
    gatewayRetryTimer = setTimeout(() => connectGateway(port), 1000);
    gatewayRetryTimer.unref?.();
  });
}

function adapterScript(origin, appConfigPayload = initialAppConfig) {
  const appConfigJson = JSON.stringify(appConfigPayload).replace(/</g, "\\u003c");
  const serverReaderJson = JSON.stringify(serverConfig?.reader || null);
  const fallbackThemeId = String(
    appConfigPayload?.defaults?.appearance?.theme
      || appConfigPayload?.themes?.[0]?.id
      || "",
  );
  return `<script>
(function() {
  var APP_CONFIG = ${appConfigJson};
  window.__noemaAppConfig = APP_CONFIG;
  document.documentElement.dataset.noemaTheme =
    String(APP_CONFIG && APP_CONFIG.config && APP_CONFIG.config.appearance && APP_CONFIG.config.appearance.theme || ${JSON.stringify(fallbackThemeId)});
  var BASE = ${JSON.stringify(hostMode === "server" ? "" : origin)};
  window.__aaronnoteNotesRoot = ${JSON.stringify(hostMode === "server" ? "" : noteRoot)};
  window.__aaronnoteJupyterDefaults = ${JSON.stringify(hostMode === "server" ? {} : jupyterDefaults)};
  window.__aaronnoteHostMode = ${JSON.stringify(hostMode)};
  window.__noemaKernelBase = ${JSON.stringify(noemaKernel.baseUrl)};
  window.__noemaKernel = ${JSON.stringify(noemaKernel)};
  window.__noemaServerReadOnly = ${JSON.stringify(hostMode === "server")};
  window.__noemaServerReader = ${serverReaderJson};
  function call(channel, args) {
    return fetch(BASE + "/api", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({channel: channel, args: args || []})
    }).then(function(res) { return res.json(); });
  }
  function callKeepalive(channel, args) {
    try {
      fetch(BASE + "/api", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({channel: channel, args: args || []}),
        keepalive: true
      }).catch(function() {});
    } catch (_) {}
  }
  function assetProxy(raw) {
    return BASE + "/aaronnote-asset?url=" + encodeURIComponent(String(raw || ""));
  }
  function noteAssetProxy(raw) {
    var url = BASE + "/note-asset?src=" + encodeURIComponent(String(raw || ""));
    var base = currentFile();
    if (base) url += "&base=" + encodeURIComponent(base);
    return url;
  }
  function proxiedUrl(raw) {
    var value = String(raw || "");
    if (!value) return value;
    if (value.indexOf("aaronnote-asset:") === 0) return assetProxy(value);
    if (value.indexOf("file:") === 0) return noteAssetProxy(value);
    return value;
  }
  function installUrlPropertyProxy(proto, prop) {
    if (!proto) return;
    var desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || typeof desc.set !== "function" || typeof desc.get !== "function") return;
    try {
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: function() { return desc.get.call(this); },
        set: function(value) { desc.set.call(this, proxiedUrl(value)); }
      });
    } catch (_) {}
  }
  function currentFile() {
    try { return window.AaronnoteCurrentFile && window.AaronnoteCurrentFile() || ""; }
    catch (_) { return ""; }
  }
  installUrlPropertyProxy(window.HTMLImageElement && HTMLImageElement.prototype, "src");
  installUrlPropertyProxy(window.HTMLIFrameElement && HTMLIFrameElement.prototype, "src");
  installUrlPropertyProxy(window.HTMLScriptElement && HTMLScriptElement.prototype, "src");
  installUrlPropertyProxy(window.HTMLMediaElement && HTMLMediaElement.prototype, "src");
  installUrlPropertyProxy(window.HTMLSourceElement && HTMLSourceElement.prototype, "src");
  installUrlPropertyProxy(window.HTMLLinkElement && HTMLLinkElement.prototype, "href");
  var originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    var key = String(name || "").toLowerCase();
    return originalSetAttribute.call(this, name, key === "src" || key === "href" ? proxiedUrl(value) : value);
  };
  var eventSource = null;
  var eventConnectionState = "disconnected";
  var eventConnectionStartedAt = 0;
  var eventConnectionPromise = null;
  var eventConnectionResolve = null;
  function dispatchConnectionStatus(status, reason) {
    eventConnectionState = status;
    try {
      window.dispatchEvent(new CustomEvent("aaronnote:connection", {
        detail: {status: status, reason: String(reason || "")}
      }));
    } catch (_) {}
  }
  function currentConnectionStatus() {
    // Some WebKit builds can leave EventSource in CONNECTING forever after a
    // process suspension. Treat it as disconnected lazily when the next user
    // action asks; no timer or background probe is needed.
    if (eventConnectionState === "connecting"
        && Date.now() - eventConnectionStartedAt >= 5000) {
      return "disconnected";
    }
    return eventConnectionState;
  }
  function finishConnectionAttempt(connected) {
    var resolveAttempt = eventConnectionResolve;
    eventConnectionResolve = null;
    eventConnectionPromise = null;
    if (resolveAttempt) resolveAttempt(connected === true);
  }
  function handleCommandEvent(event) {
    try {
      window.dispatchEvent(new CustomEvent("aaronnote:command", {detail: JSON.parse(event.data)}));
    } catch (err) {
      console.error("[aaronnote-host] command event failed", err);
    }
  }
  function handleOpenFileEvent(event) {
    try {
      window.dispatchEvent(new CustomEvent("aaronnote:open-file", {detail: JSON.parse(event.data)}));
    } catch (err) {
      console.error("[aaronnote-host] open-file event failed", err);
    }
  }
  function handleJupyterCellEvent(event) {
    try {
      window.dispatchEvent(new CustomEvent("aaronnote:jupyter-cell", {detail: JSON.parse(event.data)}));
    } catch (err) {
      console.error("[aaronnote-host] jupyter-cell event failed", err);
    }
  }
  function handleJupyterSessionEvent(event) {
    try {
      window.dispatchEvent(new CustomEvent("aaronnote:jupyter-session", {detail: JSON.parse(event.data)}));
    } catch (err) {
      console.error("[aaronnote-host] jupyter-session event failed", err);
    }
  }
  function connectEventStream(reason, force) {
    var status = currentConnectionStatus();
    if (status === "connected") return Promise.resolve(true);
    if (!force && status === "connecting" && eventConnectionPromise) {
      return eventConnectionPromise;
    }
    if (eventSource) {
      try { eventSource.close(); } catch (_) {}
      eventSource = null;
    }
    finishConnectionAttempt(false);
    eventConnectionStartedAt = Date.now();
    dispatchConnectionStatus("connecting", reason);
    var source;
    try {
      source = new EventSource(BASE + "/events");
    } catch (_) {
      dispatchConnectionStatus("disconnected", reason);
      return Promise.resolve(false);
    }
    eventSource = source;
    source.addEventListener("command", handleCommandEvent);
    source.addEventListener("open-file", handleOpenFileEvent);
    source.addEventListener("jupyter-cell", handleJupyterCellEvent);
    source.addEventListener("jupyter-session", handleJupyterSessionEvent);
    eventConnectionPromise = new Promise(function(resolve) {
      eventConnectionResolve = resolve;
    });
    source.addEventListener("open", function() {
      if (eventSource !== source) return;
      dispatchConnectionStatus("connected", reason);
      finishConnectionAttempt(true);
    });
    source.addEventListener("error", function() {
      if (eventSource !== source) return;
      // close() disables EventSource's implicit idle retry. Noema retries
      // only when focus, pointer, or keyboard activity calls reconnect().
      try { source.close(); } catch (_) {}
      eventSource = null;
      dispatchConnectionStatus("disconnected", reason);
      finishConnectionAttempt(false);
    });
    return eventConnectionPromise;
  }
  void connectEventStream("initial", false);
  var assetResolver = function(source) {
    var raw = String(source || "").trim();
    if (!raw || /^(?:data:|https?:|blob:|#)/i.test(raw)) return raw;
    if (raw.indexOf("aaronnote-asset:") === 0 || raw.indexOf("file:") === 0) return proxiedUrl(raw);
    var url = new URL("aaronnote-asset://media");
    url.searchParams.set("file", raw);
    var base = currentFile();
    if (base) url.searchParams.set("base", base);
    return assetProxy(url.toString());
  };
  Object.defineProperty(window, "AaronnoteResolveAssetUrl", {
    configurable: true,
    get: function() { return assetResolver; },
    set: function(next) {
      if (typeof next !== "function") return;
      assetResolver = function(source) { return proxiedUrl(next(source)); };
    }
  });
  var originalFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    if (typeof input === "string" && input.indexOf("aaronnote-asset:") === 0) {
      return originalFetch(proxiedUrl(input), init);
    }
    if (typeof input === "string" && input.indexOf("file:") === 0) {
      return originalFetch(proxiedUrl(input), init);
    }
    if (input instanceof Request && input.url.indexOf("aaronnote-asset:") === 0) {
      return originalFetch(proxiedUrl(input.url), init);
    }
    if (input instanceof Request && input.url.indexOf("file:") === 0) {
      return originalFetch(proxiedUrl(input.url), init);
    }
    return originalFetch(input, init);
  };
  window.AaronnoteDesktop = {
    chooseNotePath: function(options) { return call("aaronnote:api:emacs:choose-note-path", [options || {}]); },
    trashNote: function(file) { return call("aaronnote:api:notes:delete", [String(file || "")]); },
    exportPdf: function() { return Promise.resolve({ok: false, canceled: true, message: "PDF export is not available in the Emacs web host yet"}); },
    ready: function() {},
    onOpenFile: function(handler) {
      if (typeof handler !== "function") return function() {};
      var listener = function(event) { handler(String(event.detail && event.detail.file || "")); };
      window.addEventListener("aaronnote:open-file", listener);
      return function() { window.removeEventListener("aaronnote:open-file", listener); };
    }
  };
  window.aaronnoteApi = {
    connection: {
      status: function() { return currentConnectionStatus(); },
      reconnect: function(reason) {
        return connectEventStream(String(reason || "activity"), true);
      }
    },
    notes: {
      bootstrap: function(file) { return call("aaronnote:api:notes:bootstrap", [String(file || "")]); },
      open: function(file) { return call("aaronnote:api:notes:open", [String(file || "")]); },
      list: function(force) { return call("aaronnote:api:notes:list", [force === true]); },
      save: function(body) { return call("aaronnote:api:notes:save", [body || {}]); },
      saveKeepalive: function(body) { callKeepalive("aaronnote:api:notes:save", [body || {}]); },
      createNode: function(draft) { return call("aaronnote:api:notes:create-node", [draft || {}]); },
      deleteNode: function(file) { return call("aaronnote:api:notes:delete-node", [String(file || "")]); },
      deleteNote: function(file) { return call("aaronnote:api:notes:delete", [String(file || "")]); },
      createFolder: function(path) { return call("aaronnote:api:notes:create-folder", [String(path || "")]); },
      pathSuggestions: function(file, prefix) {
        return call("aaronnote:api:notes:path-suggestions", [{ file: String(file || ""), prefix: String(prefix || "./") }]);
      },
      roamSync: function(reload) { return call("aaronnote:api:notes:roam-sync", [reload === true]); },
      roamSyncFull: function() { return call("aaronnote:api:notes:roam-sync-full", []); },
      templates: function(force) { return call("aaronnote:api:notes:templates", [force === true]); },
      snippets: function() { return call("aaronnote:api:notes:snippets", []); },
      metaAdd: function(body) { return call("aaronnote:api:notes:meta-add", [body || {}]); },
      notesIndex: function() { return call("aaronnote:api:notes:index", []); },
      graph: function() { return call("aaronnote:api:notes:graph", []); },
      todos: function(file) { return call("aaronnote:api:notes:todos", [{ file: String(file || "") }]); },
      updateTodo: function(body) { return call("aaronnote:api:notes:update-todo", [body || {}]); },
      agenda: function(body) { return call("aaronnote:api:notes:agenda", [body || {}]); },
      resolveBlock: function(id) { return call("aaronnote:api:notes:resolve-block", [{ id: String(id || "") }]); },
      embedQuery: function(body) { return call("aaronnote:api:notes:embed-query", [body || {}]); },
      attributeView: function(body) { return call("aaronnote:api:notes:attribute-view", [body || {}]); },
      attributeViewCellPatch: function(body) { return call("aaronnote:api:notes:attribute-view-cell-patch", [body || {}]); },
      createTodo: function(body) { return call("aaronnote:api:notes:create-todo", [body || {}]); },
      patchTodo: function(body) { return call("aaronnote:api:notes:patch-todo", [body || {}]); },
      clockIn: function(body) { return call("aaronnote:api:notes:clock-in", [body || {}]); },
      clockOut: function(body) { return call("aaronnote:api:notes:clock-out", [body || {}]); },
      todoDepRef: function(body) { return call("aaronnote:api:notes:todo-dep-ref", [body || {}]); }
    },
    completions: {
      tags: function(prefix) { return call("aaronnote:api:completions:tags", [{ prefix: String(prefix || "") }]); },
      roam: function(prefix) { return call("aaronnote:api:completions:roam", [{ prefix: String(prefix || "") }]); },
      todoRefs: function(body) { return call("aaronnote:api:completions:todo-refs", [body || {}]); },
      bibliography: function(body) { return call("aaronnote:api:completions:bibliography", [body || {}]); },
    },
    bibliography: {
      document: function(body) { return call("aaronnote:api:bibliography:document", [body || {}]); },
    },
    noteCode: {
      readRegion: function(body) { return call("aaronnote:api:note-code:read-region", [body || {}]); }
    },
    slides: {
      mirror: function(body) { return call("aaronnote:api:slides:mirror", [body || {}]); }
    },
    jupyterCell: {
      kernels: function(body) { return call("aaronnote:api:jupyter-cell:kernels", [body || {}]); },
      documentSnapshot: function(body) { return call("aaronnote:api:jupyter:document-snapshot", [body || {}]); },
      documentMutate: function(body) { return call("aaronnote:api:jupyter:document-mutate", [body || {}]); },
      documentExecute: function(body) { return call("aaronnote:api:jupyter:document-execute", [body || {}]); },
      managerSnapshot: function() { return call("aaronnote:api:jupyter:manager-snapshot", []); },
      scriptSnapshot: function(body) { return call("aaronnote:api:jupyter:script-snapshot", [body || {}]); },
      scriptAction: function(body) { return call("aaronnote:api:jupyter:script-action", [body || {}]); },
      sessionSelect: function(body) { return call("aaronnote:api:jupyter:session-select", [body || {}]); },
      kernelControl: function(body) { return call("aaronnote:api:jupyter:kernel-control", [body || {}]); },
      openBoard: function() { return call("aaronnote:api:jupyter:board-open", []); },
      execute: function(body) { return call("aaronnote:api:jupyter-cell:execute", [body || {}]); },
      openScript: function(body) { return call("aaronnote:api:jupyter-cell:open-script", [body || {}]); },
      readScriptCell: function(body) { return call("aaronnote:api:jupyter-cell:read-script-cell", [body || {}]); },
      executeScriptCell: function(body) { return call("aaronnote:api:jupyter-cell:execute-script-cell", [body || {}]); },
      clearScriptCellOutput: function(body) { return call("aaronnote:api:jupyter-cell:clear-script-cell-output", [body || {}]); },
      deleteScriptCell: function(body) { return call("aaronnote:api:jupyter-cell:delete-script-cell", [body || {}]); },
      saveScriptCellOutputUi: function(body) { return call("aaronnote:api:jupyter-cell:save-script-cell-output-ui", [body || {}]); },
      clearAllOutputs: function(body) { return call("aaronnote:api:jupyter-cell:clear-all-outputs", [body || {}]); },
      variables: function(body) { return call("aaronnote:api:jupyter-cell:variables", [body || {}]); },
      inputReply: function(body) { return call("aaronnote:api:jupyter-cell:input-reply", [body || {}]); },
      complete: function(body) { return call("aaronnote:api:jupyter-cell:complete", [body || {}]); },
      inspect: function(body) { return call("aaronnote:api:jupyter-cell:inspect", [body || {}]); },
      isComplete: function(body) { return call("aaronnote:api:jupyter-cell:is-complete", [body || {}]); },
      history: function(body) { return call("aaronnote:api:jupyter-cell:history", [body || {}]); },
      commInfo: function(body) { return call("aaronnote:api:jupyter-cell:comm-info", [body || {}]); },
      kernelStatus: function(body) { return call("aaronnote:api:jupyter-cell:kernel-status", [body || {}]); },
      restart: function(body) { return call("aaronnote:api:jupyter-cell:restart", [body || {}]); },
      interrupt: function(body) { return call("aaronnote:api:jupyter-cell:interrupt", [body || {}]); },
      shutdown: function(body) { return call("aaronnote:api:jupyter-cell:shutdown", [body || {}]); },
      serverList: function(body) { return call("aaronnote:api:jupyter-cell:server-list", [body || {}]); },
      serverRead: function(body) { return call("aaronnote:api:jupyter-cell:server-read", [body || {}]); },
      serverWrite: function(body) { return call("aaronnote:api:jupyter-cell:server-write", [body || {}]); },
      tasks: function() { return call("aaronnote:api:jupyter-cell:tasks", []); },
      cleanup: function(body) { return call("aaronnote:api:jupyter-cell:cleanup", [body || {}]); }
    },
    latex: {
      defaults: function(body) { return call("aaronnote:api:latex:defaults", [body || {}]); },
      agentStatus: function() { return call("aaronnote:api:latex:agent-status", []); },
      setAgent: function(body) { return call("aaronnote:api:latex:set-agent", [body || {}]); },
      templates: function() { return call("aaronnote:api:latex:templates", []); },
      chooseOutputPath: function(body) { return call("aaronnote:api:latex:choose-output-path", [body || {}]); },
      export: function(body) { return call("aaronnote:api:latex:export", [body || {}]); }
    },
    tasks: {
      list: function(body) { return call("aaronnote:api:tasks:list", [body || {}]); },
      get: function(body) { return call("aaronnote:api:tasks:get", [body || {}]); },
      cancel: function(body) { return call("aaronnote:api:tasks:cancel", [body || {}]); },
      retry: function(body) { return call("aaronnote:api:tasks:retry", [body || {}]); },
      close: function(body) { return call("aaronnote:api:tasks:close", [body || {}]); }
    },
    roamTools: {
      renameTag: function(body) { return call("aaronnote:api:roam-tools:rename-tag", [body || {}]); },
      deleteTag: function(body) { return call("aaronnote:api:roam-tools:delete-tag", [body || {}]); },
      tagOverlap: function() { return call("aaronnote:api:roam-tools:tag-overlap", []); },
      rewritePathRefs: function(body) { return call("aaronnote:api:roam-tools:rewrite-path-refs", [body || {}]); }
    },
    assets: {
      upload: function(body) { return call("aaronnote:api:assets:upload", [body || {}]); },
      storeFromPath: function(body) { return call("aaronnote:api:assets:store-from-path", [body || {}]); },
      renderTikz: function(body) { return call("aaronnote:api:assets:render-tikz", [body || {}]); },
      scanOrphans: function() { return call("aaronnote:api:assets:scan-orphans", []); },
      trashOrphans: function(files) { return call("aaronnote:api:assets:trash-orphans", [files || []]); },
      inspect: function() { return call("aaronnote:api:assets:inspect", []); },
      rename: function(body) { return call("aaronnote:api:assets:rename", [body || {}]); },
      searchContent: function(body) { return call("aaronnote:api:assets:search-content", [body || {}]); }
    },
    imports: {
      obsidianAnalyze: function(body) { return call("aaronnote:api:imports:obsidian-analyze", [body || {}]); },
      obsidianTask: function(body) { return call("aaronnote:api:imports:obsidian-task", [body || {}]); },
      obsidianStart: function(body) { return call("aaronnote:api:imports:obsidian-start", [body || {}]); },
      obsidianCancel: function(body) { return call("aaronnote:api:imports:obsidian-cancel", [body || {}]); }
    },
    clipboard: {
      read: function(body) { return call("aaronnote:api:clipboard:read", [body || {}]); }
    },
    session: {
      getRecent: function() { return call("aaronnote:api:session:recent", []); },
      touchRecent: function(file, openedAt) { return call("aaronnote:api:session:touch-recent", [String(file || ""), Number(openedAt) || Date.now()]); },
      getPositions: function() { return call("aaronnote:api:session:positions", []); },
      savePosition: function(position) { return call("aaronnote:api:session:save-position", [position || {}]); },
      savePositionKeepalive: function(position) { callKeepalive("aaronnote:api:session:save-position", [position || {}]); },
      closeClient: function(body) { return call("aaronnote:api:session:client-close", [body || {}]); },
      closeClientKeepalive: function(body) { callKeepalive("aaronnote:api:session:client-close", [body || {}]); }
    },
    fs: {
      rename: function(body) { return call("aaronnote:api:fs:rename", [body || {}]); },
      move: function(body) { return call("aaronnote:api:fs:move", [body || {}]); },
      duplicate: function(body) { return call("aaronnote:api:fs:duplicate", [body || {}]); },
      trash: function(body) { return call("aaronnote:api:fs:trash", [body || {}]); }
    },
    meta: {
      add: function(body) { return call("aaronnote:api:meta:add", [body || {}]); },
      remove: function(body) { return call("aaronnote:api:meta:remove", [body || {}]); },
      tag: function(body) { return call("aaronnote:api:meta:tag", [body || {}]); },
      hideRoam: function(body) { return call("aaronnote:api:meta:hide-roam", [body || {}]); },
      activateRoam: function(body) { return call("aaronnote:api:meta:activate-roam", [body || {}]); }
    },
    emacs: {
      open: function(body) { return call("aaronnote:api:emacs:open", [body || {}]); },
      currentFile: function(file) {
        return call("aaronnote:api:emacs:current-file", [
          file && typeof file === "object" ? file : String(file || "")
        ]);
      },
      uiState: function(body) { return call("aaronnote:api:emacs:ui-state", [body || {}]); },
      key: function(k) {
        return call("aaronnote:api:emacs:key", [
          k && typeof k === "object" ? k : String(k || "")
        ]);
      },
      systemOpen: function(target, base) {
        return call("aaronnote:api:emacs:system-open", [
          base ? {target: String(target || ""), base: String(base || "")} : String(target || "")
        ]);
      },
      zotero: function(body) { return call("aaronnote:api:emacs:zotero", [body || {}]); },
      zoteroImport: function(body) { return call("aaronnote:api:emacs:zotero-import", [body || {}]); },
      chooseNotePath: function(body) { return call("aaronnote:api:emacs:choose-note-path", [body || {}]); }
    },
    shell: {
      showInFolder: function(file) { return call("aaronnote:api:shell:show-in-folder", [String(file || "")]); },
      openPath: function(file) { return call("aaronnote:api:shell:open-path", [String(file || "")]); },
      openDirectory: function(path, base) { return call("aaronnote:api:shell:open-directory", [{path: String(path || ""), base: String(base || "")}]); },
      openDirectoryInKitty: function(path, base) { return call("aaronnote:api:shell:open-directory-in-kitty", [{path: String(path || ""), base: String(base || "")}]); },
      showAttachmentMenu: function(file, base, options) { return call("aaronnote:api:shell:show-attachment-menu", [String(file || ""), String(base || ""), options || {}]); },
      showEditorContextMenu: function(options) { return call("aaronnote:api:shell:show-editor-context-menu", [options || {}]); }
    },
    proseCheck: {
      run: function(body) { return call("aaronnote:api:prose-check:run", [body || {}]); },
      acceptWord: function(word) { return call("aaronnote:api:prose-check:accept-word", [String(word || "")]); },
      cancel: function(requestId) { return call("aaronnote:api:prose-check:cancel", [String(requestId || "")]); },
      cancelKeepalive: function(requestId) { callKeepalive("aaronnote:api:prose-check:cancel", [String(requestId || "")]); },
      settings: function() { return call("aaronnote:api:prose-check:settings", []); },
      updateSettings: function(body) { return call("aaronnote:api:prose-check:update-settings", [body || {}]); },
      probe: function(body) { return call("aaronnote:api:prose-check:probe", [body || {}]); },
      browserSpellcheck: function(words) {
        return Array.isArray(words) ? words.map(function(word) {
          return {word: String(word || ""), misspelled: false, suggestions: []};
        }) : [];
      }
    },
    copilot: {
      request: function(action, body) { return call("aaronnote:api:copilot:request", [String(action || ""), body || {}]); }
    },
    ime: {
      vimMode: function(mode) { return call("aaronnote:api:ime:vim-mode", [{ mode: String(mode || "") }]); }
    },
    config: {
      katexMacros: function() { return call("aaronnote:api:config:katex-macros", []); },
      app: function() { return call("aaronnote:api:config:app", []); },
      updateApp: function(body) { return call("aaronnote:api:config:update-app", [body || {}]); }
    },
    wiki: {
      bootstrap: function() { return call("aaronnote:api:wiki:bootstrap", []); },
      environment: function() { return call("aaronnote:api:wiki:environment", []); },
      refresh: function(body) { return call("aaronnote:api:wiki:refresh", [body || {}]); },
      indexStatus: function() { return call("aaronnote:api:wiki:index-status", []); },
      search: function(body) { return call("aaronnote:api:wiki:search", [body || {}]); },
      resolveLink: function(body) { return call("aaronnote:api:wiki:resolve-link", [body || {}]); },
      initWorkspace: function() { return call("aaronnote:api:wiki:init-workspace", []); },
      initRepository: function(body) { return call("aaronnote:api:wiki:init-repository", [body || {}]); },
      cloneRepository: function(body) { return call("aaronnote:api:wiki:clone-repository", [body || {}]); },
      adoptRepository: function(body) { return call("aaronnote:api:wiki:adopt-repository", [body || {}]); },
      repositoryStatus: function(body) { return call("aaronnote:api:wiki:repository-status", [body || {}]); },
      git: function(body) { return call("aaronnote:api:wiki:git", [body || {}]); },
      createPage: function(body) { return call("aaronnote:api:wiki:create-page", [body || {}]); },
      movePage: function(body) { return call("aaronnote:api:wiki:move-page", [body || {}]); },
      deletePage: function(body) { return call("aaronnote:api:wiki:delete-page", [body || {}]); },
      copyPage: function(body) { return call("aaronnote:api:wiki:copy-page", [body || {}]); },
      mergePages: function(body) { return call("aaronnote:api:wiki:merge-pages", [body || {}]); },
      tags: function() { return call("aaronnote:api:wiki:tags", []); },
      updateTag: function(body) { return call("aaronnote:api:wiki:update-tag", [body || {}]); },
      updateNamespace: function(body) { return call("aaronnote:api:wiki:update-namespace", [body || {}]); },
      export: function(body) { return call("aaronnote:api:wiki:export", [body || {}]); },
      syncStatus: function(body) { return call("aaronnote:api:wiki:sync-status", [body || {}]); },
      checkpoint: function(body) { return call("aaronnote:api:wiki:checkpoint", [body || {}]); },
      sync: function(body) { return call("aaronnote:api:wiki:sync", [body || {}]); },
      conflict: function(body) { return call("aaronnote:api:wiki:conflict", [body || {}]); },
      resolveConflict: function(body) { return call("aaronnote:api:wiki:resolve-conflict", [body || {}]); },
      abortConflict: function(body) { return call("aaronnote:api:wiki:abort-conflict", [body || {}]); },
      gitUi: function(body) { return call("aaronnote:api:wiki:git-ui", [body || {}]); }
    },
    knowledge: {
      search: function(body) { return call("aaronnote:api:knowledge:search", [body || {}]); },
      virtualReferences: function(body) { return call("aaronnote:api:knowledge:virtual-references", [body || {}]); }
    }
  };
}());
</script>`;
}

function cleanAssetSource(source) {
  let value = String(source || "").trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  if (/^file:/i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return "";
    }
  }
  return value.split(/[?#]/, 1)[0] || "";
}

function visualFrameBaseStyle() {
  return [
    "html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff;color:#1f2937;",
    "font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
    "body{position:relative}",
    "iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}",
    ".status{position:absolute;inset:0;z-index:2;box-sizing:border-box;display:grid;place-items:center;padding:18px;text-align:center;color:#6b7280;background:#fff}",
    ".status.error{color:#9f1239;background:#fff7f7}",
  ].join("");
}

function htmlEscape(value) {
  return String(value || "").replace(/[&<>"]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
  }[ch]));
}

function visualFrameErrorHTML(message) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${visualFrameBaseStyle()}</style></head>
<body><div class="status error">${htmlEscape(message || "Visual attachment failed")}</div></body>
</html>`;
}

function scriptString(value) {
  return JSON.stringify(String(value ?? ""))
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function drawioFrameHTML(xml) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${visualFrameBaseStyle()}</style></head>
<body>
<iframe id="drawio-frame" title="draw.io diagram" allow="fullscreen; clipboard-read; clipboard-write" src="https://embed.diagrams.net/?embed=1&proto=json&spin=1&ui=min&libraries=1&noSaveBtn=1&noExitBtn=1"></iframe>
<script>
(function () {
  var xml = ${scriptString(xml)};
  var frame = document.getElementById("drawio-frame");
  function sendLoad() {
    frame.contentWindow.postMessage(JSON.stringify({
      action: "load",
      autosave: 0,
      modified: 0,
      title: "draw.io diagram",
      xml: xml
    }), "*");
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    try {
      if (typeof data === "string" && data.charAt(0) === "{") data = JSON.parse(data);
    } catch (err) {}
    if (data === "ready" || data && data.event === "init") sendLoad();
  });
}());
</script>
</body>
</html>`;
}

function resolveAssetFile(rawUrl) {
  const parsed = new URL(String(rawUrl || ""));
  if (parsed.protocol !== "aaronnote-asset:") throw new Error(`Unsupported asset URL: ${rawUrl}`);
  const host = parsed.hostname;
  if (host === "media") {
    return resolveMediaFile(parsed.searchParams.get("file"), parsed.searchParams.get("base"));
  }
  if (host === "font") {
    const requested = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (requested && requested !== "FZLiuGongQuanKaiShuJF.ttf") throw new Error(`Unknown font: ${requested}`);
    const fontFile = liuGongQuanFontCandidates.map((file) => resolve(String(file))).find((file) => existsSync(file));
    if (!fontFile) throw new Error("FZLiuGongQuanKaiShuJF font not found");
    return fontFile;
  }
  if (host === "kinds") {
    const root = resolve(workspaceRoot, "kinds");
    const requested = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    const file = resolve(root, requested);
    if (!isWithin(root, file)) throw new Error(`Kind asset is outside kinds root: ${file}`);
    return file;
  }
  if (host === "roam-tools") {
    const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (name !== "knowledge.js" && name !== "graph.js") throw new Error(`Unknown roam tool: ${name}`);
    return resolve(publishJsDir, name);
  }
  throw new Error(`Unknown Noema asset host: ${host}`);
}

function visualFrameSourceFile(src) {
  const raw = String(src || "");
  if (!raw) throw new Error("Missing visual attachment source");
  const parsed = new URL(raw);
  if (parsed.protocol !== "aaronnote-asset:" || parsed.hostname !== "media") {
    throw new Error(`Unsupported visual attachment source: ${raw}`);
  }
  return resolveAssetFile(raw);
}

async function serveVisualFrame(rawUrl, res) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    const kind = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    const file = visualFrameSourceFile(parsed.searchParams.get("src"));
    if (kind === "drawio") {
      sendHtmlNoStore(res, drawioFrameHTML(await readFile(file, "utf8")));
      return;
    }
    throw new Error(`Unknown visual attachment kind: ${kind}`);
  } catch (err) {
    sendHtmlNoStore(res, visualFrameErrorHTML(err instanceof Error ? err.message : String(err)));
  }
}

async function serveAaronnoteAsset(url, res) {
  const raw = url.searchParams.get("url") || "";
  let parsedRaw = null;
  try {
    parsedRaw = new URL(raw);
  } catch {}
  if (hostMode === "server") {
    if (parsedRaw?.hostname !== "media") {
      sendText(res, 404, "Asset not found");
      return;
    }
    const file = currentServerCatalog().asset(
      parsedRaw.searchParams.get("file") || "",
      parsedRaw.searchParams.get("base") || "",
    );
    if (!file || !(await isFile(file))) {
      sendText(res, 404, "Asset not found");
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": mimeFor(file), "Cache-Control": "public, max-age=300" });
    res.end(data);
    return;
  }
  if (parsedRaw?.hostname === "visual-frame") {
    await serveVisualFrame(raw, res);
    return;
  }
  const file = resolveAssetFile(raw);
  if (!file || !(await isFile(file))) {
    sendText(res, 404, "Asset not found");
    return;
  }
  const data = await readFile(file);
  res.writeHead(200, {
    "Content-Type": mimeFor(file),
    "Cache-Control": "no-cache",
  });
  res.end(data);
}

async function serveNoteAsset(url, res) {
  const source = cleanAssetSource(url.searchParams.get("src"));
  const base = url.searchParams.get("base") || "";
  if (hostMode === "server") {
    const file = currentServerCatalog().asset(source, base);
    if (!file || !(await isFile(file))) {
      sendText(res, 404, "Asset not found");
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": mimeFor(file), "Cache-Control": "public, max-age=300" });
    res.end(data);
    return;
  }
  const assetUrl = new URL("aaronnote-asset://media");
  assetUrl.searchParams.set("file", source);
  if (base) assetUrl.searchParams.set("base", base);
  const file = resolveAssetFile(assetUrl.toString());
  if (!file || !(await isFile(file))) {
    sendText(res, 404, "Asset not found");
    return;
  }
  const data = await readFile(file);
  res.writeHead(200, {
    "Content-Type": mimeFor(file),
    "Cache-Control": "no-cache",
  });
  res.end(data);
}

async function serveStatic(urlPath, res, origin) {
  const requested = decodeURIComponent(urlPath).replace(/^\/+/, "") || "index.html";
  if (hostMode === "server" && ["agenda.html", "config.html", "jupyter.html"].includes(requested)) {
    sendText(res, 404, "Not found");
    return;
  }
  const file = resolve(webDir, requested);
  if (!isWithin(webDir, file) || !(await isFile(file))) {
    sendText(res, 404, "Not found");
    return;
  }
  const data = await readFile(file);
  if (file.endsWith(".js")) {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(transformJavaScript(data.toString("utf8")));
    return;
  }
  if (["index.html", "agenda.html", "config.html", "jupyter.html", "slides.html", "wiki.html", "markdown-box-lab.html"].some((name) => file.endsWith(name))) {
    const appConfig = await currentAppConfigPayload();
    const html = data.toString("utf8").replace("</head>", `${adapterScript(origin, appConfig)}\n</head>`);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(html);
    return;
  }
  res.writeHead(200, {
    "Content-Type": mimeFor(file),
    "Cache-Control": "public, max-age=86400",
  });
  res.end(data);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const origin = `http://${bindHost}:${server.address()?.port}`;

    if (shuttingDown && url.pathname !== "/events") {
      sendJson(res, 503, { ok: false, message: "Noema host is shutting down" });
      return;
    }

    if (url.pathname.startsWith("/jupyter/nbextensions/")) {
      if (hostMode === "server" || !jupyterCell) {
        sendText(res, 404, "Not found");
        return;
      }
      const relative = url.pathname.slice("/jupyter/nbextensions/".length);
      const runtimeId = String(url.searchParams.get("runtime") || "");
      const asset = req.method === "GET" || req.method === "HEAD"
        ? await jupyterCell.readNbextensionAsset(relative, runtimeId)
        : undefined;
      if (!asset) {
        sendText(res, 404, "Jupyter widget resource not found");
        return;
      }
      res.writeHead(200, { "Content-Type": asset.contentType, "Cache-Control": "public, max-age=3600" });
      if (req.method === "HEAD") res.end();
      else res.end(asset.data);
      return;
    }
    if (url.pathname.startsWith("/jupyter/")) {
      sendText(res, 404, "Jupyter widget resource not found");
      return;
    }

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("retry: 2000\n\n");
      res.write(`event: command\ndata: ${JSON.stringify({ command: "server-ready", at: Date.now() })}\n\n`);
      eventClients.add(res);
      req.on("close", () => eventClients.delete(res));
      return;
    }

    if (url.pathname === "/api/clipboard") {
      if (hostMode === "server") {
        sendText(res, 404, "Not found");
        return;
      }
      if (req.method === "GET") {
        try {
          const { stdout } = await execFileAsync("pbpaste");
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(stdout);
        } catch (_) {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("");
        }
        return;
      }
      if (req.method === "POST") {
        try {
          const text = await readText(req);
          await new Promise((resolve) => {
            const proc = spawn("pbcopy");
            proc.stdin.write(text, "utf8");
            proc.stdin.end();
            proc.on("close", resolve);
            proc.on("error", resolve);
          });
        } catch (_) {}
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (url.pathname === "/api/desktop-smoke" && req.method === "POST") {
      if (hostMode !== "desktop" || process.env.NOEMA_DESKTOP_SMOKE !== "1") {
        sendText(res, 404, "Not found");
        return;
      }
      const report = await readJson(req, 64 * 1024);
      process.stdout.write(`[noema-desktop-smoke] ${JSON.stringify(report)}\n`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api" && req.method === "POST") {
      const body = await readJson(req);
      const result = await callApi(String(body.channel || ""), body.args);
      sendJson(res, 200, result ?? { ok: true });
      return;
    }

    if (url.pathname === "/emacs/event" && req.method === "POST") {
      if (hostMode === "server") {
        sendText(res, 404, "Not found");
        return;
      }
      const body = await readJson(req, 1024 * 1024);
      if (body.type === "open" || body.type === "goto") {
        sendJson(res, 200, await apiOpenInEmacs(body.file, body.line, body.col, body.tag));
        return;
      }
      if (body.type === "current-file") {
        sendJson(res, 200, await apiCurrentFile(body.file));
        return;
      }
      if (body.type === "jupyter-cell") {
        const payload = {
          scriptFile: String(body.scriptFile || ""),
          cellId: String(body.cellId || ""),
        };
        if (!payload.scriptFile || !payload.cellId) {
          sendJson(res, 400, { ok: false, message: "Missing Jupyter scriptFile or cellId" });
          return;
        }
        gatewayNotify("aaronnote.event", { type: "jupyter-cell-select", payload });
        sendJson(res, 200, { ok: true, ...payload });
        return;
      }
      sendJson(res, 400, { ok: false, message: "Unknown event type" });
      return;
    }

    if (url.pathname === "/aaronnote-asset") {
      await serveAaronnoteAsset(url, res);
      return;
    }

    if (url.pathname === "/note-asset") {
      await serveNoteAsset(url, res);
      return;
    }

    // Serve roam-pub JS files (D3, knowledge.js, graph.js) via plain HTTP
    if (url.pathname.startsWith("/roam-pub/")) {
      const name = url.pathname.slice("/roam-pub/".length);
      let filePath;
      if (name === "d3.min.js") filePath = resolve(runtimeRoot, "node_modules/d3/dist/d3.min.js");
      else if (name === "knowledge.js" || name === "graph.js") filePath = resolve(publishJsDir, name);
      else { sendText(res, 404, "Not found"); return; }
      if (!(await isFile(filePath))) { sendText(res, 404, "Not found"); return; }
      const data = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(data);
      return;
    }

    if (url.pathname === "/agenda") {
      if (hostMode === "server") { sendText(res, 404, "Not found"); return; }
      await serveStatic("/agenda.html", res, origin);
      return;
    }

    if (url.pathname === "/config") {
      if (hostMode === "server") { sendText(res, 404, "Not found"); return; }
      await serveStatic("/config.html", res, origin);
      return;
    }

    if (url.pathname === "/wiki") {
      await serveStatic("/wiki.html", res, origin);
      return;
    }

    if (url.pathname === "/slides") {
      await serveStatic("/slides.html", res, origin);
      return;
    }

    if (url.pathname === "/graph") {
      res.writeHead(302, { Location: "/wiki?view=graph", "Cache-Control": "no-store" });
      res.end();
      return;
      /* Legacy graph document retained below temporarily for published asset compatibility.
      const notes = hostMode === "server" ? currentServerCatalog().index.notes : await scanRoamNotes();
      const raw = graphPayload(notes);
      // Build SITE_DATA in the format knowledge.js expects:
      // { notes: [{ key, title, link, path, tags, aliases, refs, backlinks, groupKey, groupLabel }] }
      const backlinksMap = {};
      for (const edge of raw.edges ?? []) {
        if (!backlinksMap[edge.target]) backlinksMap[edge.target] = [];
        backlinksMap[edge.target].push(edge.source);
      }
      const siteData = {
        notes: raw.nodes.map((n) => ({
          key: n.key,
          id: n.id || n.key,
          title: n.title,
          link: n.link || n.path,
          path: n.path,
          groupKey: n.groupKey || "Root",
          groupLabel: n.groupLabel || n.groupKey || "Root",
          tags: n.tags ?? [],
          aliases: n.aliases ?? [],
          refs: (raw.edges ?? []).filter((e) => e.source === n.key).map((e) => e.target),
          backlinks: backlinksMap[n.key] ?? [],
        })),
      };
      const appConfig = await currentAppConfigPayload();
      sendHtmlNoStore(res, `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${adapterScript(origin, appConfig)}
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;width:100vw;height:100vh;overflow:hidden;display:flex}
#graph-container{flex:1;width:0;height:100vh;position:relative}
#graph-focus{width:280px;min-width:280px;height:100vh;overflow-y:auto;border-left:1px solid #d8d0c2;background:color-mix(in srgb,#fffaf0,white 12%)}
#graph-focus:empty,#graph-focus.empty{display:none}
</style>
<script>var SITE_DATA=${JSON.stringify(siteData).replace(/</g,"\\u003c")};</script>
<script src="${origin}/roam-pub/knowledge.js"></script>
<script>window.__GRAPH_NO_AUTO_INIT__=true;</script>
</head>
<body>
<div id="graph-container" data-graph-toolbar="true"></div>
<div id="graph-focus" class="graph-focus"></div>
<script src="${origin}/roam-pub/d3.min.js"></script>
<script src="${origin}/roam-pub/graph.js"></script>
<script>
document.addEventListener("DOMContentLoaded", function () {
  var root = window.__aaronnoteNotesRoot || "";
  window.initKnowledgeGraph({
    onNoteOpen: function (note) {
      var path = (note && (note.path || note.link)) || "";
      if (!path) return;
      if (window.__aaronnoteHostMode === "server") {
        window.open("/?file=" + encodeURIComponent(path), "_blank", "noopener");
        return;
      }
      var abs = path;
      if (root) {
        var r = root;
        while (r.length && r.charAt(r.length - 1) === "/") r = r.slice(0, -1);
        var p = path;
        while (p.length && p.charAt(0) === "/") p = p.slice(1);
        abs = r + "/" + p;
      }
      var api = window.aaronnoteApi;
      if (api && api.emacs && api.emacs.open) {
        api.emacs.open({ file: abs }).catch(function () {});
      }
    }
  });
});
</script>
</body>
</html>`);
      */
      return;
    }

    if (url.pathname === "/health") {
      if (hostMode === "server") {
        const repositoryState = serverRepositoryState || await readServerRepositoryState(serverConfig);
        sendJson(res, serverPublicCatalog ? 200 : 503, {
          ok: Boolean(serverPublicCatalog),
          hostMode,
          generation: serverPublicCatalog?.index.generation || "",
          lastPullAt: repositoryState.updatedAt || "",
          degraded: Boolean(repositoryState.degraded),
        });
      } else {
        sendJson(res, 200, {
          ok: true,
          hostMode,
          root: noteRoot,
          web: webDir,
          runtime: runtimeRoot,
          state: stateRoot,
          tmp: tmpRoot,
          snippets: snippetsRoot,
          templates: templatesRoot,
          kernel: noemaKernel,
        });
      }
      return;
    }

    if (hostMode === "server" && url.pathname === "/" && !url.searchParams.get("file")) {
      res.writeHead(302, { Location: "/wiki" });
      res.end();
      return;
    }

    await serveStatic(url.pathname, res, origin);
  } catch (err) {
    const status = cleanStatusCode(err);
    if (req.url?.startsWith("/api")) sendJson(res, status, errorPayload(err));
    else sendText(res, status, err instanceof Error ? err.message : String(err));
  }
});

jupyterKernelWs = jupyterCell ? installJupyterKernelWebSocket({
  server,
  resolveKernelChannel: (id) => jupyterCell.resolveKernelChannelById(id),
  touchKernel: (id) => jupyterCell.touchKernelById(id),
  zmq,
  stderr: process.stderr,
}) : null;

server.on("error", (err) => {
  process.stderr.write(`[aaronnote-web] Failed to start server: ${err.message}\n`);
  process.exit(1);
});
server.listen(bindPort, bindHost, () => {
  const port = server.address().port;
  process.stderr.write(`[aaronnote-web] http://${bindHost}:${port}\n`);
  if (hostMode === "emacs") connectGateway(port);
});
