import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import zhRendererSource from "../plugins/noema-zh-cn/renderer.js?raw";
import zhDictionary from "../plugins/noema-zh-cn/zh-CN.json";

type NativeDropEvent = {
  type: "enter" | "over" | "drop" | "leave";
  paths: string[];
  position?: { x: number; y: number };
};

const tauriRuntime = "__TAURI_INTERNALS__" in window;
const filePaths = new WeakMap<File, string>();

function desktopPlatform(): string {
  if (/Mac|iPhone|iPad/.test(navigator.platform)) return "darwin";
  if (/Win/.test(navigator.platform)) return "win32";
  return "linux";
}

if (tauriRuntime && !window.noemaDesktop) {
  window.noemaDesktop = {
    platform: desktopPlatform(),
    filePath(file) {
      return filePaths.get(file) || String((file as File & { path?: string }).path || "");
    },
    openFiles(paths) {
      void invoke("open_files", { paths });
    },
    closeWindow() {
      return invoke("close_window");
    },
    openTarget(target = {}) {
      return invoke<boolean>("open_target", { target });
    },
    updateWindowState(state = {}) {
      void invoke("update_window_state", { state });
    },
    showMenu(kind, point = { x: 0, y: 48 }) {
      return invoke<boolean>("show_menu", { kind, point });
    },
    revealPath(file) {
      return invoke<boolean>("reveal_path", { file });
    },
    openPath(file) {
      return invoke("open_path", { file });
    },
    openExternal(url) {
      return invoke("open_external", { url });
    },
    chooseSavePath(options = {}) {
      return invoke("choose_save_path", { options });
    },
    readClipboard() {
      return invoke("read_clipboard");
    },
    chooseDirectory(options) {
      return invoke("choose_directory", { options });
    },
    listPlugins() {
      return invoke("list_plugins");
    },
    setPluginEnabled(id, enabled) {
      return invoke("set_plugin_enabled", { id, enabled });
    },
    notifyAppConfigChanged(revision) {
      void invoke("broadcast_app_config", { revision });
    },
    onCommand(callback) {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void listen("noema:command", (event) => callback(event.payload)).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    onFileDrop(callback) {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "drop" || payload.type === "enter" || payload.type === "over") {
          callback({ type: payload.type, paths: payload.paths, position: payload.position });
        } else {
          callback({ type: "leave", paths: [] });
        }
      }).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    async readDroppedFiles(paths) {
      const entries = await invoke<Array<{ path: string; name: string; type: string; data: string }>>("read_dropped_files", { paths });
      return entries.map((entry) => {
        const bytes = Uint8Array.from(atob(entry.data), (value) => value.charCodeAt(0));
        const file = new File([bytes], entry.name, { type: entry.type });
        filePaths.set(file, entry.path);
        return file;
      });
    },
  };

  void listen("noema:app-config-changed", (event) => {
    window.dispatchEvent(new CustomEvent("aaronnote:command", { detail: event.payload }));
  });

  void window.noemaDesktop.listPlugins().then((plugins) => {
    if (!plugins.some((plugin) => plugin.id === "noema.zh-cn" && plugin.active)) return;
    try {
      const activate = (0, eval)(zhRendererSource) as (dictionary: unknown) => unknown;
      activate(zhDictionary);
    } catch (error) {
      console.error("[noema-plugin] noema.zh-cn renderer failed", error);
    }
  });
}

if (new URL(location.href).searchParams.get("desktopSmoke") === "1") {
  const reportSmoke = () => setTimeout(() => {
    const titlebar = document.querySelector<HTMLElement>("[data-desktop-titlebar]");
    const controls = Array.from(document.querySelectorAll<HTMLElement>("[data-desktop-command], [data-desktop-menu]"));
    const bounds = titlebar?.getBoundingClientRect();
    const report = {
      hostMode: document.body.dataset.hostMode || "",
      preload: Boolean(window.noemaDesktop),
      titlebarVisible: Boolean(titlebar && !titlebar.hidden && bounds && bounds.height > 0),
      titlebarHeight: bounds?.height || 0,
      controls: controls.map((control) => control.getAttribute("aria-label")),
    };
    if (tauriRuntime) void invoke("desktop_smoke_report", { report });
    void fetch("/api/desktop-smoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
  }, 250);
  if (document.readyState === "complete") reportSmoke();
  else window.addEventListener("load", reportSmoke, { once: true });
}

export type { NativeDropEvent };
