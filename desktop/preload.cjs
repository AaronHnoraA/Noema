const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("noemaDesktop", {
  platform: process.platform,
  filePath(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  openFiles(files) {
    ipcRenderer.send("noema:open-files", Array.isArray(files) ? files : []);
  },
  openTarget(target = {}) {
    return ipcRenderer.invoke("noema:open-target", target);
  },
  updateWindowState(state = {}) {
    ipcRenderer.send("noema:update-window-state", state);
  },
  showMenu(kind, point = {}) {
    return ipcRenderer.invoke("noema:show-menu", kind, point);
  },
  revealPath(file) {
    return ipcRenderer.invoke("noema:reveal-path", file);
  },
  openPath(file) {
    return ipcRenderer.invoke("noema:open-path", file);
  },
  openExternal(url) {
    return ipcRenderer.invoke("noema:open-external", url);
  },
  chooseSavePath(options = {}) {
    return ipcRenderer.invoke("noema:choose-save-path", options);
  },
  readClipboard() {
    return ipcRenderer.invoke("noema:read-clipboard");
  },
  chooseDirectory(options = {}) {
    return ipcRenderer.invoke("noema:choose-directory", options);
  },
  listPlugins() {
    return ipcRenderer.invoke("noema:list-plugins");
  },
  setPluginEnabled(id, enabled) {
    return ipcRenderer.invoke("noema:set-plugin-enabled", id, enabled === true);
  },
  onCommand(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, detail) => callback(detail);
    ipcRenderer.on("noema:command", listener);
    return () => ipcRenderer.removeListener("noema:command", listener);
  },
});
