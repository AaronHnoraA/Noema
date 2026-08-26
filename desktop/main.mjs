import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, screen, session, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { getNoemaAppConfig } from "../server/lib/app-config.mjs";
import { noemaAppTheme } from "../shared/app-themes.mjs";
import { createDesktopPluginHost } from "./plugin-host.mjs";
import {
  normalizePrintPdfRequest,
  printHtmlToPdf,
} from "./print-pdf.mjs";
import {
  NOEMA_PROTOCOL_SCHEME,
  noemaProtocolUrlFromArgv,
  parseNoemaProtocolUrl,
  verifyNoemaProtocolTarget,
} from "./protocol-url.mjs";
import {
  desktopOpenDecision,
  desktopPlatformLabels,
  desktopTitleBarOverlay,
  desktopWindowKind,
  desktopWindowRisk,
  isMarkdownFilePath,
  sanitizeDesktopSession,
} from "../shared/desktop-shell.mjs";

/**
 * Noema's Electron system adapter is derived from SiYuan's
 * app/electron/main.js window, menu, single-instance and native-dialog
 * implementation.  No SiYuan workspace/kernel/cloud lifecycle lives here:
 * both Electron and Emacs enter the same Node web-host, which supervises Go.
 */

const desktopDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(desktopDir, "..");
const appRoot = app.isPackaged ? app.getAppPath() : projectDir;
app.setName("Noema");
const desktopPlatform = process.platform;
const platformLabels = desktopPlatformLabels(desktopPlatform);
const desktopSmoke = process.env.NOEMA_DESKTOP_SMOKE === "1";
const desktopPrintProbe = desktopSmoke
  ? String(process.env.NOEMA_DESKTOP_PRINT_PROBE || "").trim()
  : "";
const desktopProtocolProbe = desktopSmoke
  ? String(process.env.NOEMA_DESKTOP_PROTOCOL_PROBE || "").trim()
  : "";
if (desktopSmoke) {
  for (const entry of readdirSync(tmpdir())) {
    const match = /^noema-desktop-smoke-(\d+)$/.exec(entry);
    if (!match || Number(match[1]) === process.pid) continue;
    try {
      process.kill(Number(match[1]), 0);
      continue;
    } catch {}
    try { rmSync(join(tmpdir(), entry), { recursive: true, force: true }); } catch {}
  }
}
const desktopSmokeUserData = desktopSmoke ? join(tmpdir(), `noema-desktop-smoke-${process.pid}`) : "";
let desktopSmokeCleanupScheduled = false;

function scheduleDesktopSmokeCleanup() {
  if (!desktopSmokeUserData || desktopSmokeCleanupScheduled) return;
  desktopSmokeCleanupScheduled = true;
  const cleanupScript = String.raw`
    const { existsSync, rmSync } = require("node:fs");
    const target = process.argv[1];
    const parentPid = Number(process.argv[2]);
    const deadline = Date.now() + 20000;
    let parentGoneAt = 0;
    const clean = () => {
      let parentAlive = false;
      try { process.kill(parentPid, 0); parentAlive = true; } catch {}
      if (!parentAlive && parentGoneAt === 0) parentGoneAt = Date.now();
      const drained = parentGoneAt > 0 && Date.now() - parentGoneAt >= 750;
      if (Date.now() >= deadline) return;
      if (drained) {
        try { rmSync(target, { recursive: true, force: true }); } catch {}
        if (!existsSync(target) && parentGoneAt > 0 && Date.now() - parentGoneAt >= 5000) return;
      }
      setTimeout(clean, 100);
    };
    clean();
  `;
  try {
    const cleaner = spawn(process.execPath, ["-e", cleanupScript, desktopSmokeUserData, String(process.pid)], {
      detached: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore",
      windowsHide: true,
    });
    cleaner.unref();
  } catch {}
}
const desktopCacheRoot = desktopSmokeUserData || (
  desktopPlatform === "darwin"
    ? join(homedir(), "Library", "Caches", "com.noema.desktop")
    : desktopPlatform === "win32"
      ? join(process.env.LOCALAPPDATA || app.getPath("appData"), "Noema", "Cache")
      : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "noema")
);
// Reuse the historical desktop identifier instead of letting Electron create a
// second ~/Library/Application Support/Noema tree beside the existing state.
app.setPath(
  "userData",
  desktopSmokeUserData || join(app.getPath("appData"), "com.noema.desktop"),
);
// Chromium's HTTP/code caches are disposable and can be large. Keep session
// storage under the OS cache tree instead of growing the canonical app state.
app.setPath("sessionData", join(desktopCacheRoot, "electron-session"));
const defaultNoteRoot = join(app.getPath("documents"), "Noema");
const desktopConfigDir = process.env.NOEMA_CONFIG_DIR
  || (desktopPlatform === "win32" ? join(app.getPath("userData"), "config") : "");
const stateRoot = join(app.getPath("userData"), "state");
const sessionFile = join(stateRoot, "desktop-session.json");
const desktopPlugins = createDesktopPluginHost({
  app,
  session,
  net,
  appRoot,
  userData: app.getPath("userData"),
});

let hostProcess = null;
let hostUrl = "";
let mainWindow = null;
let quitting = false;
let quitApproved = false;
let quitPrompt = null;
let configurationWindow = null;
let sessionTimer = null;
let activeAppConfig = null;
let hostRestartTimer = null;
let hostRestartAttempts = 0;
let quitFallbackTimer = null;
const windowStates = new Map();
const bypassClose = new Set();
const launchArguments = process.argv.slice(1);
let pendingFile = launchArguments.find((arg) => !/^noema:/i.test(String(arg || "")) && isMarkdownFilePath(arg)) || "";
const pendingProtocolUrls = [];
const initialProtocolUrl = noemaProtocolUrlFromArgv(launchArguments);
if (initialProtocolUrl) pendingProtocolUrls.push({ url: initialProtocolUrl, source: "argv" });
let windowBackgroundColor = noemaAppTheme("").backgroundColor;
let windowColorScheme = noemaAppTheme("").colorScheme;

function kernelPlatform() {
  const goos = desktopPlatform === "win32" ? "windows" : desktopPlatform;
  const goarch = process.arch === "x64" ? "amd64" : process.arch;
  return { goos, goarch, extension: desktopPlatform === "win32" ? ".exe" : "" };
}

function kernelBinaryPath() {
  const explicit = String(process.env.NOEMA_KERNEL_BIN || "").trim();
  if (explicit) return resolve(explicit);
  const { goos, goarch, extension } = kernelPlatform();
  const candidates = [
    join(process.resourcesPath, "bin", `noema-kernel${extension}`),
    join(appRoot, "build", "kernel", `${goos}-${goarch}`, `noema-kernel${extension}`),
    join(dirname(process.execPath), `noema-kernel${extension}`),
  ];
  return candidates.find(existsSync) || candidates[0];
}

function expandedWorkspaceRoot(appConfig = null) {
  const configuredRoot = String(appConfig?.config?.workspace?.root || "").trim();
  if (desktopPlatform === "win32" && (!configuredRoot || configuredRoot === "~/Documents/Noema")) {
    return defaultNoteRoot;
  }
  if (configuredRoot === "~") return homedir();
  if (/^~[\\/]/.test(configuredRoot)) return join(homedir(), configuredRoot.slice(2));
  return configuredRoot;
}

function routeFromUrl(urlValue = "") {
  try {
    const url = new URL(urlValue, hostUrl || "http://127.0.0.1");
    return `${url.pathname}${url.searchParams.size ? `?${url.searchParams}` : ""}`;
  } catch { return "/wiki"; }
}

function windowStateList() {
  return [...windowStates.values()].map((state) => ({ ...state, destroyed: !state.win || state.win.isDestroyed() }));
}

function updateWindowState(win, patch = {}) {
  if (!win || win.isDestroyed()) return;
  const prior = windowStates.get(win.id) || { id: win.id, win, kind: "wiki", file: "", route: "/wiki", dirty: false, busy: false };
  const next = { ...prior, ...patch, id: win.id, win };
  windowStates.set(win.id, next);
  if (typeof next.dirty === "boolean" && process.platform === "darwin") win.setDocumentEdited(next.dirty);
  scheduleSessionWrite();
}

function sessionSnapshot() {
  return sanitizeDesktopSession({ windows: [...windowStates.values()].filter((state) => state.win && !state.win.isDestroyed()).map((state) => ({
    ...state,
    bounds: state.win.getBounds(),
    maximized: state.win.isMaximized(),
    fullScreen: state.win.isFullScreen(),
  })) });
}

function writeSession() {
  sessionTimer = null;
  try {
    mkdirSync(stateRoot, { recursive: true });
    const temp = `${sessionFile}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(sessionSnapshot(), null, 2)}\n`, "utf8");
    renameSync(temp, sessionFile);
  } catch (error) {
    console.error("[noema-desktop] session write failed", error);
  }
}

function scheduleSessionWrite() {
  if (desktopSmoke || quitting) return;
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(writeSession, 180);
}

function readSession() {
  try { return sanitizeDesktopSession(JSON.parse(readFileSync(sessionFile, "utf8"))); }
  catch { return { version: 1, windows: [] }; }
}

const singleInstance = app.requestSingleInstanceLock();
if (desktopSmoke) {
  console.log(`[noema-desktop-smoke] singleInstance=${singleInstance}`);
}
if (!singleInstance) app.quit();

function hostEnvironment(appConfig = null, requestedPort = 0) {
  const expandedConfiguredRoot = expandedWorkspaceRoot(appConfig);
  const noteRoot = resolve(process.env.NOEMA_ROOT || process.env.AARONNOTE_ROOT || expandedConfiguredRoot || defaultNoteRoot);
  const resourcesRoot = resolve(process.env.NOEMA_RESOURCES_ROOT || join(appRoot, "resources"));
  const tmpRoot = join(stateRoot, "tmp");
  mkdirSync(noteRoot, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
  const windowsToolDirs = desktopPlatform === "win32" ? [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "bin"),
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "cmd"),
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft VS Code", "bin"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git", "cmd"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "bin"),
  ].filter((path) => path && existsSync(path)) : [];
  return desktopPlugins.transformHostEnvironment({
    ...process.env,
    PATH: [...windowsToolDirs, ...String(process.env.PATH || "").split(delimiter).filter(Boolean)].join(delimiter),
    ELECTRON_RUN_AS_NODE: "1",
    AARONNOTE_HOST_MODE: "desktop",
    AARONNOTE_WEB_HOST: "127.0.0.1",
    AARONNOTE_WEB_PORT: String(Math.max(0, Number(requestedPort) || 0)),
    AARONNOTE_WEB_DIR: join(appRoot, "dist", "aaronnote"),
    AARONNOTE_RUNTIME_ROOT: appRoot,
    AARONNOTE_ROOT: noteRoot,
    AARONNOTE_WORKSPACE_ROOT: noteRoot,
    NOEMA_WORKSPACE_LAYOUT: String(appConfig?.config?.workspace?.layout || "legacy"),
    ...(desktopConfigDir ? { NOEMA_CONFIG_DIR: desktopConfigDir } : {}),
    AARONNOTE_STATE_DIR: stateRoot,
    AARONNOTE_TMP_DIR: tmpRoot,
    AARONNOTE_PUBLISH_JS_DIR: join(appRoot, "js"),
    AARONNOTE_SNIPPETS_ROOT: join(resourcesRoot, "snippets"),
    AARONNOTE_TEMPLATES_ROOT: join(resourcesRoot, "templates", "noema"),
    AARONNOTE_LATEX_TEMPLATES_ROOT: join(resourcesRoot, "templates"),
    AARONNOTE_KATEX_MACROS_DIR: join(resourcesRoot, "katex-macros"),
    AARONNOTE_PROSE_WORDS: join(resourcesRoot, "prose-accepted-words.txt"),
    NOEMA_KERNEL_BIN: kernelBinaryPath(),
    NOEMA_KERNEL_WORKSPACE: join(app.getPath("userData"), "kernel-workspace"),
    NOEMA_KERNEL_WD: join(appRoot, "app"),
  }, { hostMode: "desktop" });
}

function hostPort() {
  try { return Number(new URL(hostUrl).port) || 0; }
  catch { return 0; }
}

function scheduleHostRestart() {
  if (quitting || hostRestartTimer) return;
  const requestedPort = hostPort();
  const delay = Math.min(4_000, 250 * 2 ** hostRestartAttempts);
  hostRestartTimer = setTimeout(() => {
    hostRestartTimer = null;
    if (quitting) return;
    hostRestartAttempts += 1;
    startHost(activeAppConfig, requestedPort).then(() => {
      hostRestartAttempts = 0;
      for (const state of windowStates.values()) sendEditorCommand("server-ready", {}, state.win);
    }).catch(async (error) => {
      console.error("[noema-desktop] host restart failed", error);
      if (hostRestartAttempts < 3) {
        scheduleHostRestart();
        return;
      }
      const result = await showMessageBoxForActive({
        type: "error",
        title: "Noema core stopped",
        message: "The local Noema core could not be restarted.",
        detail: String(error?.message || error),
        buttons: ["Try Again", "Quit Noema"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response === 0) {
        hostRestartAttempts = 0;
        scheduleHostRestart();
      } else {
        app.quit();
      }
    });
  }, delay);
}

function startHost(appConfig = null, requestedPort = 0) {
  return new Promise((resolveReady, rejectReady) => {
    const hostScript = join(appRoot, "web-host.mjs");
    let stderr = "";
    let ready = false;
    const processRef = spawn(process.execPath, [hostScript], {
      env: hostEnvironment(appConfig, requestedPort),
      cwd: appRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    hostProcess = processRef;
    const inspect = (chunk) => {
      const text = String(chunk);
      stderr = `${stderr}${text}`.slice(-16000);
      const match = text.match(/\[aaronnote-web\] (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !ready) {
        ready = true;
        hostUrl = match[1];
        resolveReady(hostUrl);
      }
    };
    processRef.stderr.on("data", inspect);
    processRef.stdout.on("data", (chunk) => process.stdout.write(chunk));
    processRef.once("error", (error) => {
      if (!ready) rejectReady(error);
    });
    processRef.once("exit", (code, signal) => {
      if (hostProcess === processRef) hostProcess = null;
      if (process.env.NOEMA_DESKTOP_SMOKE === "1") {
        console.log(`[noema-desktop-smoke] hostExit=${code ?? signal} quitting=${quitting}`);
      }
      if (quitting) {
        app.exit(0);
        return;
      }
      if (!ready) {
        rejectReady(new Error(`Noema host exited (${code ?? signal}).\n${stderr}`));
        return;
      }
      scheduleHostRestart();
    });
  });
}

function urlForFile(file = "", target = {}) {
  const url = new URL(hostUrl);
  if (!file) url.pathname = desktopSmoke ? "/" : "/wiki";
  url.searchParams.set("host", "desktop");
  if (desktopSmoke) url.searchParams.set("desktopSmoke", "1");
  if (desktopPrintProbe) url.searchParams.set("desktopPrintProbe", "1");
  if (desktopProtocolProbe) url.searchParams.set("desktopProtocolProbe", desktopProtocolProbe);
  if (file) url.searchParams.set("file", resolve(file));
  if (target.hash) url.searchParams.set("hash", String(target.hash));
  if (target.dom) url.searchParams.set("dom", String(target.dom));
  return url.toString();
}

function activeWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) || null;
}

function showMessageBoxForActive(options) {
  const owner = activeWindow();
  const localized = desktopPlugins.transformDialogOptions("messageBox", options);
  return owner ? dialog.showMessageBox(owner, localized) : dialog.showMessageBox(localized);
}

function sendEditorCommand(command, detail = {}, win = activeWindow()) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("noema:command", { command, ...detail });
}

function windowById(id) {
  const state = windowStates.get(Number(id));
  return state?.win && !state.win.isDestroyed() ? state.win : null;
}

function targetUrlFor(target = {}) {
  const { file = "", url = "" } = target;
  if (file) return urlForFile(file, target);
  if (!url) return urlForFile();
  try {
    const target = new URL(url, hostUrl);
    if (target.origin !== new URL(hostUrl).origin) return "";
    if (!target.searchParams.has("host")) target.searchParams.set("host", "desktop");
    return target.toString();
  } catch { return ""; }
}

function loadTarget(win, target) {
  const url = targetUrlFor(target);
  if (!url || !win || win.isDestroyed()) return null;
  const file = target.file ? resolve(target.file) : "";
  updateWindowState(win, {
    kind: desktopWindowKind(url, file),
    file,
    route: routeFromUrl(url),
    dirty: false,
    busy: false,
  });
  void win.loadURL(url);
  win.show();
  win.focus();
  return win;
}

function tileSplit(source, target, direction) {
  if (!source || source.isDestroyed() || !target || target.isDestroyed()) return;
  try {
    const workArea = screen.getDisplayMatching(source.getBounds()).workArea;
    if (direction === "split-down" && workArea.height >= 1120) {
      const height = Math.floor(workArea.height / 2);
      source.setBounds({ x: workArea.x, y: workArea.y, width: workArea.width, height });
      target.setBounds({ x: workArea.x, y: workArea.y + height, width: workArea.width, height: workArea.height - height });
    } else if (workArea.width >= 1440) {
      const width = Math.floor(workArea.width / 2);
      source.setBounds({ x: workArea.x, y: workArea.y, width, height: workArea.height });
      target.setBounds({ x: workArea.x + width, y: workArea.y, width: workArea.width - width, height: workArea.height });
    } else {
      const bounds = source.getBounds();
      target.setBounds({ ...bounds, x: bounds.x + 36, y: bounds.y + 36 });
    }
  } catch {}
}

function openTarget(target = {}, sourceWin = activeWindow()) {
  const file = target.file ? resolve(String(target.file)) : "";
  const explicit = String(target.disposition || "");
  const decision = desktopOpenDecision({
    source: String(target.source || "dialog"),
    file,
    windows: windowStateList(),
    explicit,
  });
  if (decision.action === "focus") {
    const existing = windowById(decision.windowId);
    existing?.show();
    existing?.focus();
    if (existing && (target.hash || target.dom)) {
      sendEditorCommand("open-location", {
        file,
        hash: String(target.hash || ""),
        dom: String(target.dom || ""),
      }, existing);
    }
    return existing;
  }
  if (decision.action === "replace") {
    const destination = windowById(decision.windowId) || sourceWin || activeWindow();
    if (destination) return loadTarget(destination, { ...target, file });
  }
  const created = createWindow(file, targetUrlFor({ ...target, file }), { show: true });
  if (decision.action === "split-right" || decision.action === "split-down") tileSplit(sourceWin, created, decision.action);
  return created;
}

async function waitForSafeWindows(windows, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (windows.every((win) => !desktopWindowRisk(windowStates.get(win.id) || {}))) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  return windows.every((win) => !desktopWindowRisk(windowStates.get(win.id) || {}));
}

async function confirmWindowClose(win) {
  const state = windowStates.get(win.id) || {};
  if (!desktopWindowRisk(state)) return true;
  const dirty = Boolean(state.dirty || state.saveInFlight || state.conflict);
  const result = await dialog.showMessageBox(win, desktopPlugins.transformDialogOptions("messageBox", {
    type: "warning",
    title: "Close Noema window?",
    message: dirty ? "This document has changes that are not safely stored." : "A task is still running in this window.",
    detail: [state.file || state.title || "", state.conflict ? "A save conflict must be resolved." : "", state.busy ? "Closing will interrupt the active task." : ""].filter(Boolean).join("\n"),
    buttons: dirty ? ["Save & Close", "Cancel", "Close Without Saving"] : ["Cancel", "Close Anyway"],
    defaultId: 0,
    cancelId: dirty ? 1 : 0,
    noLink: true,
  }));
  if (dirty && result.response === 0) {
    sendEditorCommand("save", {}, win);
    return await waitForSafeWindows([win]);
  }
  return dirty ? result.response === 2 : result.response === 1;
}

function closeWindowSafely(win) {
  if (!win || win.isDestroyed()) return;
  void confirmWindowClose(win).then((approved) => {
    if (!approved || win.isDestroyed()) return;
    bypassClose.add(win.id);
    win.close();
  });
}

function commandItem(label, command, accelerator = undefined) {
  return {
    label,
    ...(accelerator ? { accelerator } : {}),
    click: (_item, win) => sendEditorCommand(command, {}, win || activeWindow()),
  };
}

async function chooseMarkdownFiles() {
  const options = {
    title: "Open in Noema",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Markdown", extensions: ["md", "markdown"] },
      { name: "All Files", extensions: ["*"] },
    ],
  };
  const owner = activeWindow();
  const localized = desktopPlugins.transformDialogOptions("openDialog", options);
  const result = owner
    ? await dialog.showOpenDialog(owner, localized)
    : await dialog.showOpenDialog(localized);
  if (result.canceled) return;
  result.filePaths.forEach((file, index) => openFile(file, { source: index === 0 ? "dialog" : "drop" }));
}

async function exportPdfFromWindow(win, input = {}, explicitOutputPath = "") {
  if (!win || win.isDestroyed()) return { canceled: true, path: "" };
  const request = normalizePrintPdfRequest(input);
  let outputPath = String(explicitOutputPath || "").trim();
  if (!outputPath) {
    const settings = {
      title: `Export ${request.title} as PDF`,
      defaultPath: request.defaultPath || join(app.getPath("documents"), `${request.title}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    };
    const localized = desktopPlugins.transformDialogOptions("saveDialog", settings);
    const result = await dialog.showSaveDialog(win, localized);
    if (result.canceled || !result.filePath) return { canceled: true, path: "" };
    outputPath = result.filePath;
  }
  return printHtmlToPdf({
    BrowserWindow,
    html: request.html,
    outputPath,
    parent: win,
    tempRoot: join(stateRoot, "tmp", "print"),
  });
}

function editorActionsTemplate() {
  return [
    commandItem("Search Knowledge…", "knowledge-search", "CmdOrCtrl+Shift+K"),
    commandItem("Focus Editor", "focus"),
    commandItem("Task Manager", "task-manager"),
    { type: "separator" },
    commandItem("Page Outline", "toggle-toc"),
    commandItem("Backlinks", "knowledge-backlinks"),
    commandItem("Tags", "knowledge-tags"),
    commandItem("Agenda", "toggle-agenda"),
    commandItem("Knowledge Graph", "toggle-graph"),
    { label: "Workspace Graph", click: () => openTarget({ url: "/wiki?view=graph", source: "wiki" }) },
    commandItem("Tools", "toggle-tools"),
    commandItem("Jupyter Cells", "jupyter-panel"),
    { type: "separator" },
    commandItem("Toggle Source", "toggle-source", "CmdOrCtrl+/"),
    commandItem("Run Prose Check", "prose-check"),
    commandItem("Export PDF…", "export-pdf"),
    commandItem("Export LaTeX…", "export-latex"),
    { type: "separator" },
    commandItem("Open Source in VS Code", "open-source-editor"),
    commandItem(`Reveal Note in ${platformLabels.fileManager}`, "reveal-current-file"),
    commandItem("Save", "save", "CmdOrCtrl+S"),
    commandItem(`Move Document to ${platformLabels.trash}`, "trash-current-note"),
  ];
}

function windowActionsTemplate(win = activeWindow()) {
  const zoomItem = desktopPlatform === "win32"
    ? {
      label: win?.isMaximized() ? "Restore" : "Maximize",
      click: () => {
        if (!win || win.isDestroyed()) return;
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
      },
    }
    : { label: "Zoom", role: "zoom" };
  return [
    { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
    { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => void chooseMarkdownFiles() },
    { label: "Split Right", accelerator: "CmdOrCtrl+\\", click: () => openTarget({ url: win?.webContents.getURL(), source: "window", disposition: "split-right" }, win || activeWindow()) },
    { label: "Split Below", accelerator: "Shift+CmdOrCtrl+\\", click: () => openTarget({ url: win?.webContents.getURL(), source: "window", disposition: "split-down" }, win || activeWindow()) },
    { type: "separator" },
    { label: "Minimize", role: "minimize" },
    zoomItem,
    { label: "Toggle Full Screen", role: "togglefullscreen" },
    { type: "separator" },
    { label: "Close", accelerator: "CmdOrCtrl+W", click: () => closeWindowSafely(win || activeWindow()) },
  ];
}

function buildApplicationMenu() {
  const appMenu = desktopPlatform === "darwin" ? {
    label: "Noema",
    submenu: [
      { role: "about" },
      { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => openConfigurationWindow() },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { label: "Quit Noema", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
    ],
  } : null;
  const template = [
    {
      label: "File",
      submenu: [
        { label: "Wiki Home", accelerator: "CmdOrCtrl+Shift+H", click: () => openTarget({ url: "/wiki", source: "wiki" }) },
        { label: "Knowledge Graph", accelerator: "CmdOrCtrl+Shift+G", click: () => openTarget({ url: "/wiki?view=graph", source: "wiki" }) },
        { label: "New Wiki Page…", accelerator: "CmdOrCtrl+N", click: () => openTarget({ url: "/wiki?new=1", source: "wiki", disposition: "new" }) },
        { type: "separator" },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => void chooseMarkdownFiles() },
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { type: "separator" },
        commandItem("Save", "save", "CmdOrCtrl+S"),
        commandItem("Export PDF…", "export-pdf"),
        commandItem("Open Source in VS Code", "open-source-editor", "CmdOrCtrl+Shift+O"),
        commandItem(`Reveal Note in ${platformLabels.fileManager}`, "reveal-current-file"),
        { type: "separator" },
        ...(desktopPlatform === "win32" ? [
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => openConfigurationWindow() },
          { type: "separator" },
        ] : []),
        { label: "Close", accelerator: "CmdOrCtrl+W", click: () => closeWindowSafely(activeWindow()) },
        ...(desktopPlatform === "win32" ? [
          { type: "separator" },
          { label: "Exit", role: "quit" },
        ] : []),
      ],
    },
    {
      label: "Edit",
      submenu: [
        commandItem("Undo", "undo", "CmdOrCtrl+Z"),
        commandItem("Redo", "redo", "Shift+CmdOrCtrl+Z"),
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        commandItem("Find…", "find", "CmdOrCtrl+F"),
        commandItem("Find Next", "find-next", "CmdOrCtrl+G"),
        commandItem("Find Previous", "find-previous", "Shift+CmdOrCtrl+G"),
      ],
    },
    {
      label: "Format",
      submenu: [
        commandItem("Bold", "bold", "CmdOrCtrl+B"),
        commandItem("Italic", "italic", "CmdOrCtrl+I"),
        commandItem("Inline Code", "code", "CmdOrCtrl+`"),
        commandItem("Highlight", "highlight"),
        commandItem("Strikethrough", "strike", "Shift+CmdOrCtrl+X"),
        { type: "separator" },
        commandItem("Blockquote", "blockquote"),
        commandItem("Bullet List", "bullet-list"),
        commandItem("Ordered List", "ordered-list"),
        commandItem("Task List", "task-list"),
        commandItem("Code Block", "code-block"),
        { type: "separator" },
        commandItem("Heading / Paragraph…", "paragraph-menu"),
        commandItem("Insert Table", "insert-table"),
        commandItem("Insert Math Block", "insert-math-block"),
        commandItem("Insert TOC", "insert-toc"),
        commandItem("Edit Properties…", "edit-properties"),
      ],
    },
    {
      label: "Navigate",
      submenu: [
        commandItem("Search Knowledge…", "knowledge-search", "CmdOrCtrl+Shift+K"),
        { type: "separator" },
        commandItem("Back", "back", "CmdOrCtrl+["),
        commandItem("Forward", "forward", "CmdOrCtrl+]"),
        commandItem("Refresh", "refresh", "CmdOrCtrl+R"),
        { type: "separator" },
        commandItem("Page Outline", "toggle-toc"),
        commandItem("Backlinks", "knowledge-backlinks"),
        commandItem("Tags", "knowledge-tags"),
        commandItem("Agenda", "toggle-agenda"),
        commandItem("Knowledge Graph", "toggle-graph"),
        { label: "Workspace Graph", click: () => openTarget({ url: "/wiki?view=graph", source: "wiki" }) },
        commandItem("Tools", "toggle-tools"),
        commandItem("Jupyter Cells", "jupyter-panel"),
        commandItem("Task Manager", "task-manager"),
      ],
    },
    {
      label: "View",
      submenu: [
        commandItem("Toggle Source", "toggle-source", "CmdOrCtrl+/"),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { label: "Split Right", accelerator: "CmdOrCtrl+\\", click: () => openTarget({ url: activeWindow()?.webContents.getURL(), source: "window", disposition: "split-right" }) },
        { label: "Split Below", accelerator: "Shift+CmdOrCtrl+\\", click: () => openTarget({ url: activeWindow()?.webContents.getURL(), source: "window", disposition: "split-down" }) },
        { type: "separator" },
        { role: "minimize" },
        ...(desktopPlatform === "darwin"
          ? [{ role: "zoom" }, { role: "front" }]
          : [{ label: "Maximize or Restore", click: () => {
            const win = activeWindow();
            if (!win) return;
            if (win.isMaximized()) win.unmaximize();
            else win.maximize();
          } }]),
      ],
    },
    ...(desktopPlatform === "win32" ? [{
      label: "Help",
      submenu: [{ role: "about" }],
    }] : []),
  ];
  if (appMenu) template.unshift(appMenu);
  return Menu.buildFromTemplate(desktopPlugins.transformMenuTemplate(template, { kind: "application" }));
}

function createWindow(file = "", targetUrl = "", restore = {}) {
  const isConfigurationWindow = (() => {
    try {
      return Boolean(targetUrl) && new URL(targetUrl).pathname === "/config";
    } catch {
      return false;
    }
  })();
  const titleBarOverlay = desktopTitleBarOverlay(desktopPlatform, {
    backgroundColor: windowBackgroundColor,
    colorScheme: windowColorScheme,
  });
  const win = new BrowserWindow({
    width: restore.bounds?.width || (isConfigurationWindow ? 960 : 1320),
    height: restore.bounds?.height || (isConfigurationWindow ? 760 : 920),
    ...(restore.bounds ? { x: restore.bounds.x, y: restore.bounds.y } : {}),
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: isConfigurationWindow ? "Noema Configuration" : "Noema",
    backgroundColor: windowBackgroundColor,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(titleBarOverlay ? { titleBarOverlay } : {}),
    autoHideMenuBar: desktopPlatform === "win32",
    ...(desktopPlatform === "darwin" ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(desktopDir, "preload.cjs"),
    },
  });
  if (isConfigurationWindow) configurationWindow = win;
  mainWindow = win;
  win.on("focus", () => { mainWindow = win; });
  const initialUrl = targetUrl || urlForFile(file);
  updateWindowState(win, {
    kind: desktopWindowKind(initialUrl, file),
    file: file ? resolve(file) : "",
    route: routeFromUrl(initialUrl),
    dirty: false,
    busy: false,
  });
  win.on("close", (event) => {
    if (bypassClose.has(win.id) || quitApproved || !desktopWindowRisk(windowStates.get(win.id) || {})) return;
    event.preventDefault();
    closeWindowSafely(win);
  });
  win.on("closed", () => {
    windowStates.delete(win.id);
    bypassClose.delete(win.id);
    if (configurationWindow === win) configurationWindow = null;
    scheduleSessionWrite();
  });
  win.on("move", scheduleSessionWrite);
  win.on("resize", scheduleSessionWrite);
  win.on("maximize", scheduleSessionWrite);
  win.on("unmaximize", scheduleSessionWrite);
  win.on("enter-full-screen", scheduleSessionWrite);
  win.on("leave-full-screen", scheduleSessionWrite);
  if (process.env.NOEMA_DESKTOP_SMOKE === "1") {
    win.on("closed", () => console.log("[noema-desktop-smoke] windowClosed=true"));
    win.webContents.on("render-process-gone", (_event, details) => {
      console.log(`[noema-desktop-smoke] rendererGone=${JSON.stringify(details)}`);
    });
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(hostUrl)) {
      openTarget({ url, source: "note-link", disposition: "new" }, win);
    } else {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(hostUrl)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  win.webContents.on("did-navigate", (_event, url) => {
    updateWindowState(win, {
      kind: desktopWindowKind(url),
      file: (() => { try { return new URL(url).searchParams.get("file") || ""; } catch { return ""; } })(),
      route: routeFromUrl(url),
    });
  });
  win.once("ready-to-show", () => {
    if (restore.show !== false && !win.isDestroyed()) win.show();
  });
  void win.loadURL(initialUrl).then(() => {
    if (restore.maximized) win.maximize();
    if (restore.fullScreen) win.setFullScreen(true);
  });
  return win;
}

function openConfigurationWindow() {
  if (!hostUrl) return;
  if (configurationWindow && !configurationWindow.isDestroyed()) {
    configurationWindow.show();
    configurationWindow.focus();
    return;
  }
  createWindow("", new URL("/config", hostUrl).toString());
}

function openFile(file, options = {}) {
  const requested = String(file || "").trim();
  if (!isMarkdownFilePath(requested)) return false;
  const target = resolve(requested);
  try {
    if (!statSync(target).isFile()) return false;
  } catch {
    return false;
  }
  if (!hostUrl) {
    pendingFile = target;
    return true;
  }
  openTarget({ file: target, source: options.source || "os", disposition: options.disposition || "" });
  return true;
}

function protocolWorkspaceRoot() {
  return resolve(
    process.env.NOEMA_ROOT
      || process.env.AARONNOTE_ROOT
      || expandedWorkspaceRoot(activeAppConfig)
      || defaultNoteRoot,
  );
}

function verifiedProtocolTarget(value) {
  return verifyNoemaProtocolTarget(parseNoemaProtocolUrl(value, {
    workspaceRoot: protocolWorkspaceRoot(),
    platform: desktopPlatform,
  }), { platform: desktopPlatform });
}

function dispatchProtocolUrl(value, source = "os") {
  const target = verifiedProtocolTarget(value);
  const opened = target.action === "open-route"
    ? openTarget({ url: target.route, source: "protocol", disposition: target.disposition })
    : openTarget({
        file: target.file,
        hash: target.hash,
        dom: target.dom,
        source: "protocol",
        disposition: target.disposition,
      });
  if (!opened) throw new Error("Noema could not open the protocol target");
  if (desktopSmoke) {
    process.stdout.write(`[noema-desktop-protocol-smoke] ${JSON.stringify({
      ok: true,
      source,
      action: target.action,
      file: target.action === "open-note" ? target.file : "",
      route: target.action === "open-route" ? target.route : "",
    })}\n`);
  }
  return true;
}

function acceptProtocolUrl(value, source = "os") {
  const url = String(value || "").trim();
  if (!url) return false;
  if (!hostUrl) {
    if (!pendingProtocolUrls.some((item) => item.url === url)) pendingProtocolUrls.push({ url, source });
    return true;
  }
  try {
    return dispatchProtocolUrl(url, source);
  } catch (error) {
    console.error("[noema-desktop] protocol URL rejected", error);
    if (desktopSmoke) {
      process.stdout.write(`[noema-desktop-protocol-smoke] ${JSON.stringify({
        ok: false,
        source,
        message: String(error?.message || error),
      })}\n`);
    }
    return false;
  }
}

function drainPendingProtocolUrls() {
  const queued = pendingProtocolUrls.splice(0);
  let opened = false;
  for (const item of queued) opened = acceptProtocolUrl(item.url, item.source) || opened;
  return opened;
}

app.on("open-file", (event, file) => {
  event.preventDefault();
  openFile(file);
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  acceptProtocolUrl(url, "open-url");
});

app.on("second-instance", (_event, argv) => {
  const protocolUrl = noemaProtocolUrlFromArgv(argv);
  const file = argv.find(isMarkdownFilePath);
  if (protocolUrl) acceptProtocolUrl(protocolUrl, "second-instance");
  else if (file) openFile(file);
  else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

ipcMain.on("noema:open-files", (_event, files) => {
  const paths = Array.isArray(files) ? files : [];
  paths
    .map((file) => String(file || "").trim())
    .filter((file) => /\.(?:md|markdown)$/i.test(file))
    .forEach((file) => openFile(file, { source: "drop", disposition: "new" }));
});

ipcMain.handle("noema:close-window", (event) => {
  closeWindowSafely(BrowserWindow.fromWebContents(event.sender));
});

ipcMain.on("noema:broadcast-app-config", (_event, revision) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) sendEditorCommand("app-config-changed", { revision: String(revision || "") }, win);
  }
});

ipcMain.handle("noema:desktop-smoke-report", async (event, report = {}) => {
  if (!desktopSmoke) return false;
  if (desktopPrintProbe) {
    try {
      const printable = report?.printDocument;
      if (!printable || typeof printable !== "object") {
        throw new Error("renderer did not provide a printable PDF document");
      }
      const result = await exportPdfFromWindow(
        BrowserWindow.fromWebContents(event.sender),
        printable,
        desktopPrintProbe,
      );
      process.stdout.write(`[noema-desktop-print-smoke] ${JSON.stringify({ ok: true, ...result })}\n`);
    } catch (error) {
      process.stdout.write(`[noema-desktop-print-smoke] ${JSON.stringify({
        ok: false,
        message: String(error?.message || error),
      })}\n`);
    }
  }
  quitApproved = true;
  setTimeout(() => app.quit(), 100);
  return true;
});

ipcMain.handle("noema:open-target", (event, target = {}) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  return Boolean(openTarget(target, source));
});

ipcMain.on("noema:update-window-state", (event, state = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  updateWindowState(win, {
    title: String(state.title || ""),
    file: String(state.file || ""),
    kind: String(state.kind || desktopWindowKind(win.webContents.getURL(), state.file)),
    route: routeFromUrl(win.webContents.getURL()),
    dirty: state.dirty === true,
    saveInFlight: state.saveInFlight === true,
    conflict: state.conflict === true,
    busy: state.busy === true,
  });
});

ipcMain.handle("noema:show-menu", (event, kind, point = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  const template = kind === "window"
    ? windowActionsTemplate(win)
    : editorActionsTemplate();
  Menu.buildFromTemplate(desktopPlugins.transformMenuTemplate(template, { kind })).popup({
    window: win,
    x: Math.max(0, Math.floor(Number(point?.x) || 0)),
    y: Math.max(0, Math.floor(Number(point?.y) || 48)),
  });
  return true;
});

ipcMain.handle("noema:reveal-path", (_event, file) => {
  const target = String(file || "").trim();
  if (!target) return false;
  shell.showItemInFolder(resolve(target));
  return true;
});

ipcMain.handle("noema:open-path", async (_event, file) => {
  const target = String(file || "").trim();
  if (!target) return { ok: false, message: "Missing path" };
  const message = await shell.openPath(resolve(target));
  return { ok: !message, message };
});

ipcMain.handle("noema:open-external", async (_event, value) => {
  const target = String(value || "").trim();
  let protocol = "";
  try { protocol = new URL(target).protocol.toLowerCase(); } catch {}
  if (!new Set(["http:", "https:", "mailto:", "zotero:", "marginnote:", "marginnote3:"]).has(protocol)) {
    return { ok: false, message: `Unsupported external protocol: ${protocol || "unknown"}` };
  }
  await shell.openExternal(target);
  return { ok: true };
});

ipcMain.handle("noema:choose-save-path", async (event, options = {}) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const defaultPath = String(options.defaultPath || "").trim();
  const extension = String(options.extension || "").replace(/^\.+/, "").replace(/[^A-Za-z0-9]/g, "");
  const settings = {
    title: String(options.title || "Save from Noema"),
    ...(defaultPath ? { defaultPath: resolve(defaultPath) } : {}),
    ...(extension ? { filters: [{ name: extension.toUpperCase(), extensions: [extension] }] } : {}),
  };
  const localized = desktopPlugins.transformDialogOptions("saveDialog", settings);
  const result = owner
    ? await dialog.showSaveDialog(owner, localized)
    : await dialog.showSaveDialog(localized);
  return { canceled: result.canceled, path: result.filePath || "" };
});

ipcMain.handle("noema:export-pdf", async (event, options = {}) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return exportPdfFromWindow(owner, options);
});

ipcMain.handle("noema:read-clipboard", () => {
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    return { kind: "image", type: "image/png", data: image.toPNG().toString("base64") };
  }
  const text = clipboard.readText();
  const html = clipboard.readHTML();
  return text || html ? { kind: "text", text, html } : { kind: "empty" };
});

ipcMain.handle("noema:list-plugins", () => desktopPlugins.availablePlugins());

ipcMain.handle("noema:set-plugin-enabled", (_event, id, enabled) =>
  desktopPlugins.setPluginEnabled(String(id || ""), enabled === true));

ipcMain.handle("noema:choose-directory", async (event, options = {}) => {
  const root = resolve(String(options.root || defaultNoteRoot));
  const requested = resolve(String(options.defaultPath || root));
  const initial = (() => {
    const rel = relative(root, requested);
    return !rel.startsWith("..") && !isAbsolute(rel) ? requested : root;
  })();
  const owner = BrowserWindow.fromWebContents(event.sender);
  const settings = {
    title: String(options.title || "Choose Wiki folder"),
    defaultPath: initial,
    properties: ["openDirectory", "createDirectory"],
  };
  const localized = desktopPlugins.transformDialogOptions("openDialog", settings);
  const result = owner
    ? await dialog.showOpenDialog(owner, localized)
    : await dialog.showOpenDialog(localized);
  if (result.canceled || !result.filePaths[0]) return { canceled: true, path: "" };
  const selected = resolve(result.filePaths[0]);
  const rel = relative(root, selected);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { canceled: true, path: "", message: "Choose a folder inside the selected Wiki repository" };
  }
  return { canceled: false, path: selected, relativePath: rel === "." ? "" : rel };
});

app.whenReady().then(async () => {
  try {
    // Noema's installed development build is a standalone app shell whose
    // Resources/app entry intentionally links to the canonical source tree.
    // Electron therefore reports app.isPackaged=false even though LaunchServices
    // sees the installed Noema bundle and its CFBundleURLTypes declaration.
    const protocolRegistered = app.setAsDefaultProtocolClient(NOEMA_PROTOCOL_SCHEME);
    if (desktopSmoke) console.log(`[noema-desktop-smoke] protocolRegistered=${protocolRegistered}`);
    await desktopPlugins.load();
    Menu.setApplicationMenu(buildApplicationMenu());
    const configEnvironment = desktopConfigDir
      ? { ...process.env, NOEMA_CONFIG_DIR: desktopConfigDir }
      : process.env;
    const appConfig = await getNoemaAppConfig({ env: configEnvironment });
    activeAppConfig = appConfig;
    windowBackgroundColor = appConfig.activeTheme.backgroundColor;
    windowColorScheme = appConfig.activeTheme.colorScheme;
    await startHost(appConfig);
    const protocolOpened = drainPendingProtocolUrls();
    if (protocolOpened) {
      // A deep link is the explicit launch intent; do not restore unrelated
      // session windows on top of it.
    } else if (pendingFile) {
      createWindow(pendingFile);
    } else {
      const restored = readSession().windows.filter((item) => item.kind !== "note" || (item.file && existsSync(item.file)));
      if (restored.length > 0) {
        for (const item of restored) {
          createWindow(item.file || "", item.file ? "" : new URL(item.route || "/wiki", hostUrl).toString(), item);
        }
      } else {
        createWindow();
      }
    }
    pendingFile = "";
  } catch (error) {
    console.error(error);
    app.quit();
  }
}).catch((error) => {
  console.error("[noema-desktop] Electron adapter boot failed", error);
  app.exit(1);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && hostUrl) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (process.env.NOEMA_DESKTOP_SMOKE === "1") {
    console.log("[noema-desktop-smoke] beforeQuit=true");
  }
  if (!quitApproved) {
    event.preventDefault();
    if (quitPrompt) return;
    quitPrompt = (async () => {
      const windows = [...windowStates.values()]
        .filter((state) => state.win && !state.win.isDestroyed() && desktopWindowRisk(state));
      if (windows.length === 0) {
        quitApproved = true;
        app.quit();
        return;
      }
      const dirty = windows.some((state) => state.dirty || state.saveInFlight || state.conflict);
      const result = await showMessageBoxForActive({
        type: "warning",
        title: "Quit Noema?",
        message: dirty ? `${windows.length} window${windows.length === 1 ? " has" : "s have"} unsaved or conflicted work.` : "Noema is still running background work.",
        detail: windows.map((state) => state.file || state.title || state.kind).join("\n"),
        buttons: dirty ? ["Save All & Quit", "Cancel", "Quit Anyway"] : ["Cancel", "Quit Anyway"],
        defaultId: 0,
        cancelId: dirty ? 1 : 0,
        noLink: true,
      });
      if (dirty && result.response === 0) {
        for (const state of windows) if (state.dirty || state.saveInFlight) sendEditorCommand("save", {}, state.win);
        if (!await waitForSafeWindows(windows.map((state) => state.win))) return;
        quitApproved = true;
        app.quit();
      } else if ((dirty && result.response === 2) || (!dirty && result.response === 1)) {
        quitApproved = true;
        app.quit();
      }
    })().finally(() => { quitPrompt = null; });
    return;
  }
  scheduleDesktopSmokeCleanup();
  writeSession();
  quitting = true;
  if (hostRestartTimer) clearTimeout(hostRestartTimer);
  hostRestartTimer = null;
  if (hostProcess && !hostProcess.killed) {
    try { hostProcess.stdin?.write("shutdown\n"); } catch {}
    setTimeout(() => {
      if (hostProcess && !hostProcess.killed) hostProcess.kill("SIGTERM");
    }, 4_000).unref?.();
  } else {
    app.exit(0);
    return;
  }
  if (quitFallbackTimer) clearTimeout(quitFallbackTimer);
  quitFallbackTimer = setTimeout(() => app.exit(0), 8_000);
  quitFallbackTimer.unref?.();
});

app.once("will-quit", scheduleDesktopSmokeCleanup);
process.once("exit", () => {
  scheduleDesktopSmokeCleanup();
});
