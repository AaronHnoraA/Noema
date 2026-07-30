import { app, BrowserWindow, Menu, shell } from "electron";
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

function createWindow(file = "", targetUrl = "") {
  const win = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 920,
    minHeight: 640,
    title: "Noema",
    backgroundColor: "#eeeae1",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
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
    { label: "File", submenu: [{ label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() }, { role: "close" }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] },
  ]));
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
  quitting = true;
  if (hostProcess && !hostProcess.killed) hostProcess.kill("SIGTERM");
});
