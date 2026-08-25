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
  async function post(endpoint, body) {
    const response = await fetchImpl(`${base}/api/noema/markdown/${endpoint}`, {
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
  };
}
