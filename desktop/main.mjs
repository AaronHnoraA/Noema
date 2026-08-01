import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { getNoemaAppConfig } from "../server/lib/app-config.mjs";
import { noemaAppTheme } from "../shared/app-themes.mjs";
import { desktopOpenDecision, desktopWindowKind, desktopWindowRisk, sanitizeDesktopSession } from "../shared/desktop-shell.mjs";

const desktopDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(desktopDir, "..");
const appRoot = app.isPackaged ? app.getAppPath() : projectDir;
const defaultNoteRoot = join(homedir(), "Documents", "Noema");
const desktopSmoke = process.env.NOEMA_DESKTOP_SMOKE === "1";
if (desktopSmoke) app.setPath("userData", join(tmpdir(), `noema-desktop-smoke-${process.pid}`));
const stateRoot = join(app.getPath("userData"), "state");
const sessionFile = join(stateRoot, "desktop-session.json");

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
let pendingFile = process.argv.slice(1).find((arg) => /\.(?:md|markdown)$/i.test(arg)) || "";
let windowBackgroundColor = noemaAppTheme("").backgroundColor;

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
  const configuredRoot = String(appConfig?.config?.workspace?.root || "").trim();
  const expandedConfiguredRoot = configuredRoot === "~"
    ? homedir()
    : configuredRoot.startsWith("~/")
      ? join(homedir(), configuredRoot.slice(2))
      : configuredRoot;
  const noteRoot = resolve(process.env.NOEMA_ROOT || process.env.AARONNOTE_ROOT || expandedConfiguredRoot || defaultNoteRoot);
  const resourcesRoot = resolve(process.env.NOEMA_RESOURCES_ROOT || join(appRoot, "resources"));
  const tmpRoot = join(stateRoot, "tmp");
  mkdirSync(noteRoot, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    AARONNOTE_HOST_MODE: "desktop",
    AARONNOTE_WEB_HOST: "127.0.0.1",
    AARONNOTE_WEB_PORT: String(Math.max(0, Number(requestedPort) || 0)),
    AARONNOTE_WEB_DIR: join(appRoot, "dist", "aaronnote"),
    AARONNOTE_RUNTIME_ROOT: appRoot,
    AARONNOTE_ROOT: noteRoot,
    AARONNOTE_WORKSPACE_ROOT: noteRoot,
    NOEMA_WORKSPACE_LAYOUT: String(appConfig?.config?.workspace?.layout || "legacy"),
    AARONNOTE_STATE_DIR: stateRoot,
    AARONNOTE_TMP_DIR: tmpRoot,
    AARONNOTE_PUBLISH_JS_DIR: join(appRoot, "js"),
    AARONNOTE_SNIPPETS_ROOT: join(resourcesRoot, "snippets"),
    AARONNOTE_TEMPLATES_ROOT: join(resourcesRoot, "templates", "noema"),
    AARONNOTE_LATEX_TEMPLATES_ROOT: join(resourcesRoot, "templates"),
    AARONNOTE_KATEX_MACROS_DIR: join(resourcesRoot, "katex-macros"),
    AARONNOTE_PROSE_WORDS: join(resourcesRoot, "prose-accepted-words.txt"),
  };
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
      stdio: ["ignore", "pipe", "pipe"],
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

function urlForFile(file = "") {
  const url = new URL(hostUrl);
  if (!file) url.pathname = "/wiki";
  url.searchParams.set("host", "desktop");
  if (file) url.searchParams.set("file", resolve(file));
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
  return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
}

function sendEditorCommand(command, detail = {}, win = activeWindow()) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("noema:command", { command, ...detail });
}

function windowById(id) {
  const state = windowStates.get(Number(id));
  return state?.win && !state.win.isDestroyed() ? state.win : null;
}

function targetUrlFor({ file = "", url = "" } = {}) {
  if (file) return urlForFile(file);
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
    return existing;
  }
  if (decision.action === "replace") {
    const destination = windowById(decision.windowId) || sourceWin || activeWindow();
    if (destination) return loadTarget(destination, { ...target, file });
  }
  const created = createWindow(file, file ? "" : targetUrlFor(target), { show: true });
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
  const result = await dialog.showMessageBox(win, {
    type: "warning",
    title: "Close Noema window?",
    message: dirty ? "This document has changes that are not safely stored." : "A task is still running in this window.",
    detail: [state.file || state.title || "", state.conflict ? "A save conflict must be resolved." : "", state.busy ? "Closing will interrupt the active task." : ""].filter(Boolean).join("\n"),
    buttons: dirty ? ["Save & Close", "Cancel", "Close Without Saving"] : ["Cancel", "Close Anyway"],
    defaultId: 0,
    cancelId: dirty ? 1 : 0,
    noLink: true,
  });
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
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return;
  result.filePaths.forEach((file, index) => openFile(file, { source: index === 0 ? "dialog" : "drop" }));
}

function editorActionsTemplate() {
  return [
    commandItem("Search Knowledge…", "knowledge-search", "CmdOrCtrl+Shift+K"),
    commandItem("Focus Editor", "focus"),
    commandItem("Task Manager", "task-manager"),
    { type: "separator" },
    commandItem("Page Outline", "toggle-toc"),
    commandItem("Agenda", "toggle-agenda"),
    commandItem("Local Graph", "toggle-graph"),
    { label: "Workspace Graph", click: () => openTarget({ url: "/wiki?view=graph", source: "wiki" }) },
    commandItem("Tools", "toggle-tools"),
    commandItem("Jupyter Cells", "jupyter-panel"),
    { type: "separator" },
    commandItem("Toggle Source", "toggle-source", "CmdOrCtrl+/"),
    commandItem("Run Prose Check", "prose-check"),
    commandItem("Export LaTeX…", "export-latex"),
    { type: "separator" },
    commandItem("Open Source in VS Code", "open-source-editor"),
    commandItem("Reveal Note in Finder", "reveal-current-file"),
    commandItem("Save", "save", "CmdOrCtrl+S"),
    commandItem("Move Document to Trash", "trash-current-note"),
  ];
}

function windowActionsTemplate(win = activeWindow()) {
  return [
    { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
    { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => void chooseMarkdownFiles() },
    { label: "Split Right", accelerator: "CmdOrCtrl+\\", click: () => openTarget({ url: win?.webContents.getURL(), source: "window", disposition: "split-right" }, win || activeWindow()) },
    { label: "Split Below", accelerator: "Shift+CmdOrCtrl+\\", click: () => openTarget({ url: win?.webContents.getURL(), source: "window", disposition: "split-down" }, win || activeWindow()) },
    { type: "separator" },
    { label: "Minimize", role: "minimize" },
    { label: "Zoom", role: "zoom" },
    { label: "Toggle Full Screen", role: "togglefullscreen" },
    { type: "separator" },
    { label: "Close", accelerator: "CmdOrCtrl+W", click: () => closeWindowSafely(win || activeWindow()) },
  ];
}

function buildApplicationMenu() {
  return Menu.buildFromTemplate([
    {
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
    },
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
        commandItem("Open Source in VS Code", "open-source-editor", "CmdOrCtrl+Shift+O"),
        commandItem("Reveal Note in Finder", "reveal-current-file"),
        { type: "separator" },
        { label: "Close", accelerator: "CmdOrCtrl+W", click: () => closeWindowSafely(activeWindow()) },
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
        commandItem("Agenda", "toggle-agenda"),
        commandItem("Local Graph", "toggle-graph"),
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
        { role: "zoom" },
        { role: "front" },
      ],
    },
  ]);
}

function createWindow(file = "", targetUrl = "", restore = {}) {
  const isConfigurationWindow = (() => {
    try {
      return Boolean(targetUrl) && new URL(targetUrl).pathname === "/config";
    } catch {
      return false;
    }
  })();
  const win = new BrowserWindow({
    width: restore.bounds?.width || (isConfigurationWindow ? 960 : 1320),
    height: restore.bounds?.height || (isConfigurationWindow ? 760 : 920),
    ...(restore.bounds ? { x: restore.bounds.x, y: restore.bounds.y } : {}),
    minWidth: 720,
    minHeight: 560,
    show: restore.show !== false,
    title: isConfigurationWindow ? "Noema Configuration" : "Noema",
    backgroundColor: windowBackgroundColor,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 18, y: 18 },
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
  if (process.env.NOEMA_DESKTOP_SMOKE === "1") {
    win.webContents.once("did-finish-load", () => {
      void win.webContents.executeJavaScript(`(() => {
        const titlebar = document.querySelector("[data-desktop-titlebar]");
        const controls = Array.from(document.querySelectorAll("[data-desktop-command], [data-desktop-menu]"));
        const bounds = titlebar?.getBoundingClientRect();
        return {
          hostMode: document.body.dataset.hostMode || "",
          theme: document.documentElement.dataset.noemaTheme || "",
          preload: Boolean(window.noemaDesktop),
          titlebarVisible: Boolean(titlebar && !titlebar.hidden && bounds && bounds.height > 0),
          titlebarHeight: bounds?.height || 0,
          controls: controls.map((control) => control.getAttribute("aria-label")),
        };
      })()`).then((report) => {
        console.log(`[noema-desktop-smoke] ${JSON.stringify(report)}`);
        setTimeout(() => app.quit(), 100);
      }).catch((error) => {
        console.error("[noema-desktop-smoke]", error);
      });
    });
  }
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
  if (!hostUrl) {
    pendingFile = file;
    return;
  }
  openTarget({ file, source: options.source || "os", disposition: options.disposition || "" });
}

app.on("open-file", (event, file) => {
  event.preventDefault();
  openFile(file);
});

app.on("second-instance", (_event, argv) => {
  const file = argv.find((arg) => /\.(?:md|markdown)$/i.test(arg));
  if (file) openFile(file);
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
  Menu.buildFromTemplate(template).popup({
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
  const result = owner
    ? await dialog.showOpenDialog(owner, settings)
    : await dialog.showOpenDialog(settings);
  if (result.canceled || !result.filePaths[0]) return { canceled: true, path: "" };
  const selected = resolve(result.filePaths[0]);
  const rel = relative(root, selected);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { canceled: true, path: "", message: "Choose a folder inside the selected Wiki repository" };
  }
  return { canceled: false, path: selected, relativePath: rel === "." ? "" : rel };
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildApplicationMenu());
  try {
    const appConfig = await getNoemaAppConfig({ env: process.env });
    activeAppConfig = appConfig;
    windowBackgroundColor = appConfig.activeTheme.backgroundColor;
    await startHost(appConfig);
    if (pendingFile) {
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
  writeSession();
  quitting = true;
  if (hostRestartTimer) clearTimeout(hostRestartTimer);
  hostRestartTimer = null;
  if (hostProcess && !hostProcess.killed) {
    hostProcess.kill("SIGTERM");
  } else {
    app.exit(0);
    return;
  }
  if (quitFallbackTimer) clearTimeout(quitFallbackTimer);
  quitFallbackTimer = setTimeout(() => app.exit(0), 1_500);
  quitFallbackTimer.unref?.();
});
