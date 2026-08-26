import { resolve } from "node:path";
import { kernelMarkdownPath } from "./kernel-markdown-provider.mjs";

// Session persistence belongs to the kernel for files in the registered
// Markdown box. Node maps the existing absolute-file facade to portable
// notebook-relative paths; standalone/non-Markdown files keep their local
// compatibility state.
export function createKernelSessionProvider({ baseUrl, box, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const notebook = String(box?.id || "");
  const root = resolve(String(box?.root || ""));
  if (!base || !notebook || !box?.root || typeof fetchImpl !== "function") {
    throw new Error("Kernel session provider requires baseUrl, box.id, box.root, and fetch");
  }

  const pathFor = (file) => kernelMarkdownPath(root, file);
  const fileFor = (entry) => {
    if (String(entry?.notebook || "") !== notebook) {
      throw Object.assign(new Error("Kernel session response belongs to another notebook"), { statusCode: 502 });
    }
    const path = String(entry?.path || "");
    const file = resolve(root, path.replace(/^\/+/, ""));
    if (!path.startsWith("/") || pathFor(file) !== path) {
      throw Object.assign(new Error("Kernel session response contains an invalid Markdown path"), { statusCode: 502 });
    }
    return file;
  };

  async function post(endpoint, body) {
    const response = await fetchImpl(`${base}/api/noema/session/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code) !== 0 || !payload?.data) {
      const error = new Error(String(payload?.msg || `kernel request failed with HTTP ${response.status}`));
      error.statusCode = response.ok ? 502 : response.status;
      throw error;
    }
    if (payload.data.source !== "kernel-session") {
      throw Object.assign(new Error("Kernel session response has an invalid source"), { statusCode: 502 });
    }
    return payload.data;
  }

  function project(data) {
    if (!Array.isArray(data?.recent) || !Array.isArray(data?.positions)) {
      throw Object.assign(new Error("Kernel session response is incomplete"), { statusCode: 502 });
    }
    return {
      source: "kernel-session",
      recent: data.recent.map((entry) => ({ file: fileFor(entry), openedAt: Number(entry.openedAt) || 0 })),
      positions: data.positions.map((entry) => ({
        file: fileFor(entry),
        ...(String(entry.client || "") ? { client: String(entry.client) } : {}),
        mode: entry.mode === "source" ? "source" : "markdown",
        from: Number(entry.from) || 0,
        to: Number(entry.to) || 0,
        scrollY: Number(entry.scrollY) || 0,
        updatedAt: Number(entry.updatedAt) || 0,
      })),
    };
  }

  return {
    owns(file) {
      return Boolean(pathFor(file));
    },
    async read() {
      return project(await post("read", { notebook }));
    },
    async touchRecent(file, openedAt) {
      const path = pathFor(file);
      if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
      return project(await post("touchRecent", { notebook, path, openedAt: Number(openedAt) || Date.now() }));
    },
    async touchPosition(body = {}) {
      const path = pathFor(body.file);
      if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
      return project(await post("touchPosition", {
        notebook,
        path,
        client: String(body.client || ""),
        mode: body.mode === "source" ? "source" : "markdown",
        from: Number(body.from) || 0,
        to: Number(body.to) || 0,
        scrollY: Number(body.scrollY) || 0,
        updatedAt: Number(body.updatedAt) || Date.now(),
      }));
    },
  };
}
