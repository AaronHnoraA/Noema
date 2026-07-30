import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const desktopDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(desktopDir, "..");
const appRoot = app.isPackaged ? app.getAppPath() : projectDir;
const defaultNoteRoot = join(homedir(), "Documents", "Noema");
const stateRoot = join(app.getPath("userData"), "state");

let hostProcess = null;
let hostUrl = "";
let mainWindow = null;
let quitting = false;
let pendingFile = process.argv.slice(1).find((arg) => /\.(?:md|markdown)$/i.test(arg)) || "";

const singleInstance = app.requestSingleInstanceLock();
if (process.env.NOEMA_DESKTOP_SMOKE === "1") {
  console.log(`[noema-desktop-smoke] singleInstance=${singleInstance}`);
}
if (!singleInstance) app.quit();

function hostEnvironment() {
  const noteRoot = resolve(process.env.NOEMA_ROOT || process.env.AARONNOTE_ROOT || defaultNoteRoot);
  const resourcesRoot = resolve(process.env.NOEMA_RESOURCES_ROOT || join(appRoot, "resources"));
  const tmpRoot = join(stateRoot, "tmp");
  mkdirSync(noteRoot, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    AARONNOTE_HOST_MODE: "desktop",
    AARONNOTE_WEB_HOST: "127.0.0.1",
    AARONNOTE_WEB_PORT: "0",
    AARONNOTE_WEB_DIR: join(appRoot, "dist", "aaronnote"),
    AARONNOTE_RUNTIME_ROOT: appRoot,
    AARONNOTE_ROOT: noteRoot,
    AARONNOTE_WORKSPACE_ROOT: noteRoot,
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

function startHost() {
  return new Promise((resolveReady, rejectReady) => {
    const hostScript = join(appRoot, "web-host.mjs");
    let stderr = "";
    hostProcess = spawn(process.execPath, [hostScript], {
      env: hostEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const inspect = (chunk) => {
      const text = String(chunk);
      stderr = `${stderr}${text}`.slice(-16000);
      const match = text.match(/\[aaronnote-web\] (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !hostUrl) {
        hostUrl = match[1];
        resolveReady(hostUrl);
      }
    };
    hostProcess.stderr.on("data", inspect);
    hostProcess.stdout.on("data", (chunk) => process.stdout.write(chunk));
    hostProcess.once("error", rejectReady);
    hostProcess.once("exit", (code, signal) => {
      hostProcess = null;
      if (process.env.NOEMA_DESKTOP_SMOKE === "1") {
        console.log(`[noema-desktop-smoke] hostExit=${code ?? signal} quitting=${quitting}`);
      }
      if (!hostUrl && !quitting) {
        rejectReady(new Error(`Noema host exited (${code ?? signal}).\n${stderr}`));
      }
      if (!quitting) app.quit();
    });
  });
}

function urlForFile(file = "") {
  const url = new URL(hostUrl);
  url.searchParams.set("host", "desktop");
  if (file) url.searchParams.set("file", resolve(file));
  return url.toString();
}

function activeWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return null;
}

function sendEditorCommand(command, detail = {}, win = activeWindow()) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("noema:command", { command, ...detail });
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
  result.filePaths.forEach(openFile);
}

function editorActionsTemplate() {
  return [
    commandItem("Focus Editor", "focus"),
    commandItem("Task Manager", "task-manager"),
    { type: "separator" },
    commandItem("Page Outline", "toggle-toc"),
    commandItem("Agenda", "toggle-agenda"),
    commandItem("Local Graph", "toggle-graph"),
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
  ];
}

function windowActionsTemplate(win = activeWindow()) {
  return [
    { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
    { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => void chooseMarkdownFiles() },
    { type: "separator" },
    { label: "Minimize", role: "minimize" },
    { label: "Zoom", role: "zoom" },
    { label: "Toggle Full Screen", role: "togglefullscreen" },
    { type: "separator" },
    { label: "Close", accelerator: "CmdOrCtrl+W", click: () => (win || activeWindow())?.close() },
  ];
}

function buildApplicationMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Noema",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => void chooseMarkdownFiles() },
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { type: "separator" },
        commandItem("Save", "save", "CmdOrCtrl+S"),
        commandItem("Open Source in VS Code", "open-source-editor", "CmdOrCtrl+Shift+O"),
        commandItem("Reveal Note in Finder", "reveal-current-file"),
        { type: "separator" },
        { role: "close" },
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
        commandItem("Back", "back", "CmdOrCtrl+["),
        commandItem("Forward", "forward", "CmdOrCtrl+]"),
        commandItem("Refresh", "refresh", "CmdOrCtrl+R"),
        { type: "separator" },
        commandItem("Page Outline", "toggle-toc"),
        commandItem("Agenda", "toggle-agenda"),
        commandItem("Local Graph", "toggle-graph"),
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
        { role: "minimize" },
        { role: "zoom" },
        { role: "front" },
      ],
    },
  ]);
}

function createWindow(file = "", targetUrl = "") {
  const win = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 920,
    minHeight: 640,
    title: "Noema",
    backgroundColor: "#eeeae1",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(desktopDir, "preload.cjs"),
    },
  });
  mainWindow = win;
  win.on("focus", () => { mainWindow = win; });
  if (process.env.NOEMA_DESKTOP_SMOKE === "1") {
    win.on("closed", () => console.log("[noema-desktop-smoke] windowClosed=true"));
    win.webContents.on("render-process-gone", (_event, details) => {
      console.log(`[noema-desktop-smoke] rendererGone=${JSON.stringify(details)}`);
    });
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(hostUrl)) {
      createWindow("", url);
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
  if (process.env.NOEMA_DESKTOP_SMOKE === "1") {
    win.webContents.once("did-finish-load", () => {
      void win.webContents.executeJavaScript(`(() => {
        const titlebar = document.querySelector("[data-desktop-titlebar]");
        const controls = Array.from(document.querySelectorAll("[data-desktop-command], [data-desktop-menu]"));
        const bounds = titlebar?.getBoundingClientRect();
        return {
          hostMode: document.body.dataset.hostMode || "",
          preload: Boolean(window.noemaDesktop),
          titlebarVisible: Boolean(titlebar && !titlebar.hidden && bounds && bounds.height > 0),
          titlebarHeight: bounds?.height || 0,
          controls: controls.map((control) => control.getAttribute("aria-label")),
        };
      })()`).then((report) => {
        console.log(`[noema-desktop-smoke] ${JSON.stringify(report)}`);
      }).catch((error) => {
        console.error("[noema-desktop-smoke]", error);
      });
    });
  }
  void win.loadURL(targetUrl || urlForFile(file));
  return win;
}

function openFile(file) {
  if (!hostUrl) {
    pendingFile = file;
    return;
  }
  createWindow(file);
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
    .forEach(openFile);
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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildApplicationMenu());
  try {
    await startHost();
    createWindow(pendingFile);
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

app.on("before-quit", () => {
  if (process.env.NOEMA_DESKTOP_SMOKE === "1") {
    console.log("[noema-desktop-smoke] beforeQuit=true");
  }
  quitting = true;
  if (hostProcess && !hostProcess.killed) hostProcess.kill("SIGTERM");
});
