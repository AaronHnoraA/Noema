export function isMarkdownFilePath(file) {
  return /\.(?:md|markdown)$/i.test(String(file || "").trim());
}

export function desktopPlatformLabels(platform = "") {
  if (platform === "win32") {
    return {
      primaryModifier: "Ctrl",
      alternateModifier: "Alt",
      fileManager: "File Explorer",
      trash: "Recycle Bin",
    };
  }
  return {
    primaryModifier: "⌘",
    alternateModifier: "Option",
    fileManager: platform === "darwin" ? "Finder" : "file manager",
    trash: "Trash",
  };
}

export function desktopTitleBarOverlay(platform, theme = {}) {
  if (platform !== "win32") return undefined;
  return {
    color: String(theme.backgroundColor || "#111318"),
    symbolColor: theme.colorScheme === "light" ? "#20242b" : "#f4f6fb",
    height: 54,
  };
}

export function desktopDropDisposition(files, forceAttachment = false) {
  const paths = Array.from(files || [])
    .map((file) => String(file || "").trim())
    .filter(Boolean);
  if (!forceAttachment && paths.length > 0 && paths.every(isMarkdownFilePath)) {
    return { type: "open", paths };
  }
  return { type: "insert", paths };
}

export function desktopWindowKind(urlValue = "", file = "") {
  if (file) return "note";
  try {
    const url = new URL(urlValue, "http://127.0.0.1");
    if (url.pathname === "/config") return "config";
    if (url.pathname === "/wiki" && url.searchParams.get("view") === "graph") return "graph";
    if (url.pathname === "/wiki") return "wiki";
    if (url.searchParams.get("file")) return "note";
  } catch {}
  return "wiki";
}

export function desktopOpenDecision({ source = "dialog", file = "", windows = [], explicit = "" } = {}) {
  if (explicit === "new" || explicit === "split-right" || explicit === "split-down" || source === "drop") {
    return { action: explicit.startsWith("split-") ? explicit : "new" };
  }
  const normalized = String(file || "");
  const existing = normalized && windows.find((item) => item.kind === "note" && item.file === normalized && !item.destroyed);
  if (existing) return { action: "focus", windowId: existing.id };
  if (source === "note-link" || source === "wiki" || source === "graph") return { action: "replace" };
  const reusable = windows.find((item) => item.kind === "wiki" && !item.dirty && !item.busy && !item.destroyed);
  return reusable ? { action: "replace", windowId: reusable.id } : { action: "new" };
}

export function desktopWindowRisk(state = {}) {
  return Boolean(state.dirty || state.saveInFlight || state.conflict || state.busy);
}

export function sanitizeDesktopSession(value, limit = 20) {
  const windows = Array.isArray(value?.windows) ? value.windows : [];
  return {
    version: 1,
    windows: windows.filter((item) => item && ["wiki", "graph", "note"].includes(item.kind))
      .slice(-Math.max(1, limit))
      .map((item) => ({
        kind: item.kind,
        client: typeof item.client === "string" ? item.client.trim().slice(0, 256) : "",
        file: item.kind === "note" ? String(item.file || "") : "",
        route: item.kind === "note" ? "" : String(item.route || "/wiki"),
        bounds: item.bounds && Number.isFinite(item.bounds.x) && Number.isFinite(item.bounds.y)
          ? { x: item.bounds.x, y: item.bounds.y, width: Math.max(720, item.bounds.width || 1320), height: Math.max(560, item.bounds.height || 920) }
          : undefined,
        maximized: item.maximized === true,
        fullScreen: item.fullScreen === true,
      })),
  };
}
