const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("noemaDesktop", {
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
  showMenu(kind, point = {}) {
    return ipcRenderer.invoke("noema:show-menu", kind, point);
  },
  revealPath(file) {
    return ipcRenderer.invoke("noema:reveal-path", file);
  },
  onCommand(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, detail) => callback(detail);
    ipcRenderer.on("noema:command", listener);
    return () => ipcRenderer.removeListener("noema:command", listener);
  },
});
