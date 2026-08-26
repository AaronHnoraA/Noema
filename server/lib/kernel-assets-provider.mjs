import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { kernelMarkdownPath } from "./kernel-markdown-provider.mjs";

// Shared App/Emacs transport. Asset placement and collision handling belong to
// the Go kernel; Node keeps the established host channel and response shape.
export function createKernelAssetsProvider({ baseUrl, box, includePublic = false, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const notebook = String(box?.id || "");
  const root = String(box?.root || "");
  if (!base || !notebook || !root || typeof fetchImpl !== "function") {
    throw new Error("Kernel assets provider requires baseUrl, box.id, box.root, and fetch");
  }

  const pathFor = (file) => kernelMarkdownPath(root, file);
  const sourcePathFor = (input) => {
    const raw = String(input || "").trim();
    if (!raw) throw Object.assign(new Error("Missing asset source path"), { statusCode: 400 });
    return /^~(?:$|[\\/])/.test(raw)
      ? resolve(join(homedir(), raw.replace(/^~[\\/]?/, "")))
      : resolve(raw);
  };
  async function postPath(path, body) {
    const response = await fetchImpl(`${base}${path}`, {
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
    return payload.data;
  }
  const post = (endpoint, body) => postPath(`/api/noema/markdown/${endpoint}`, body);

  function requestBody(file, body = {}) {
    const path = pathFor(file);
    if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
    return {
      notebook,
      path,
      name: String(body.name || ""),
      type: String(body.type || ""),
    };
  }

  return {
    owns(file) {
      return Boolean(pathFor(file));
    },
    async store(body = {}) {
      return post("storeAsset", {
        ...requestBody(body.file, body),
        data: String(body.data || ""),
      });
    },
    async storeFromPath(body = {}) {
      const sourcePath = sourcePathFor(body.path || body.source || "");
      return post("storeAssetFromPath", {
        ...requestBody(body.file, body),
        sourcePath,
      });
    },
    async scan() {
      const data = await post("listUnusedAssets", { notebook, includePublic: includePublic === true });
      if (!Array.isArray(data?.assets)) {
        throw Object.assign(new Error("Kernel asset scan response is missing assets"), { statusCode: 502 });
      }
      return data.assets;
    },
    async inspect() {
      return post("inspectAssets", { notebook, includePublic: includePublic === true });
    },
    async rename(oldPath, newName) {
      return post("renameAsset", { notebook, oldPath: String(oldPath || ""), newName: String(newName || "") });
    },
    async searchContent(query, limit = 20) {
      return post("searchAssetContent", { notebook, query: String(query || ""), limit: Number(limit) || 20 });
    },
    async startObsidianAnalysis(localPath) {
      return postPath("/api/import/startObsidianVaultAnalysis", { localPath: sourcePathFor(localPath) });
    },
    async obsidianTask(taskID) {
      return postPath("/api/import/getObsidianVaultTask", { taskID: String(taskID || "") });
    },
    async startObsidianImport(taskID, destination) {
      return post("startObsidianVaultImport", { notebook, taskID: String(taskID || ""), destination: String(destination || "") });
    },
    async cancelObsidianTask(taskID) {
      return postPath("/api/import/cancelObsidianVaultTask", { taskID: String(taskID || "") });
    },
  };
}
