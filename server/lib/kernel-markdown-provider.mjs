import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const markdownExtensions = new Set([".md", ".markdown"]);

function canonicalExistingPath(path) {
  const resolved = resolve(String(path || ""));
  let probe = resolved;
  const missingParts = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return resolved;
    missingParts.unshift(basename(probe));
    probe = parent;
  }
  try {
    const real = realpathSync.native(probe);
    return missingParts.length ? join(real, ...missingParts) : real;
  } catch {
    return resolved;
  }
}

export function kernelMarkdownPath(root, file) {
  const canonicalRoot = canonicalExistingPath(root);
  const canonicalFile = canonicalExistingPath(file);
  const rel = relative(canonicalRoot, canonicalFile);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "";
  if (!markdownExtensions.has(extname(canonicalFile).toLowerCase())) return "";
  return `/${rel.split(sep).join("/")}`;
}

export function createKernelMarkdownProvider({ baseUrl, box, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const notebook = String(box?.id || "");
  const root = String(box?.root || "");
  if (!base || !notebook || !root || typeof fetchImpl !== "function") {
    throw new Error("Kernel Markdown provider requires baseUrl, box.id, box.root, and fetch");
  }

  function pathFor(file) {
    return kernelMarkdownPath(root, file);
  }

  async function post(path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code) !== 0 || !payload?.data) {
      const err = new Error(String(payload?.msg || `kernel request failed with HTTP ${response.status}`));
      err.statusCode = response.ok ? 502 : response.status;
      throw err;
    }
    return payload.data;
  }

  return {
    owns(file) {
      return Boolean(pathFor(file));
    },
    async read(file) {
      const path = pathFor(file);
      if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
      const data = await post("/api/noema/markdown/loadDoc", { notebook, path });
      if (typeof data.markdown !== "string") {
        throw Object.assign(new Error("Kernel load response is missing Markdown source"), { statusCode: 502 });
      }
      return { file: String(file), content: data.markdown, blocks: data.blocks || [] };
    },
    async write({ file, content }) {
      const path = pathFor(file);
      if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
      const source = String(content ?? "");
      const data = await post("/api/noema/markdown/saveDoc", { notebook, path, markdown: source });
      if (typeof data.markdown !== "string") {
        throw Object.assign(new Error("Kernel save response is missing Markdown source"), { statusCode: 502 });
      }
      const saved = data.markdown;
      if (saved !== source) {
        throw Object.assign(new Error("Kernel changed Markdown source bytes while saving"), { statusCode: 502 });
      }
      return { ok: true, file: String(file), content: saved, blocks: data.blocks || [] };
    },
  };
}
