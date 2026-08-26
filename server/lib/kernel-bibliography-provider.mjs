import { kernelMarkdownPath } from "./kernel-markdown-provider.mjs";

export function createKernelBibliographyProvider({ baseUrl, box, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const notebook = String(box?.id || "");
  const root = String(box?.root || "");
  if (!base || !notebook || !root || typeof fetchImpl !== "function") {
    throw new Error("Kernel bibliography provider requires baseUrl, box.id, box.root, and fetch");
  }
  const pathFor = (file) => kernelMarkdownPath(root, file);
  return {
    owns(file) {
      return Boolean(pathFor(file));
    },
    async load({ file, metadataContent = "" } = {}) {
      const path = pathFor(file);
      if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
      const response = await fetchImpl(`${base}/api/noema/markdown/loadBibliography`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebook, path, metadata: String(metadataContent || "") }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || Number(payload?.code) !== 0 || !payload?.data) {
        const error = new Error(String(payload?.msg || `kernel request failed with HTTP ${response.status}`));
        error.statusCode = response.ok ? 502 : response.status;
        throw error;
      }
      if (!Array.isArray(payload.data.files) || !Array.isArray(payload.data.diagnostics)) {
        throw Object.assign(new Error("Kernel bibliography response has an invalid shape"), { statusCode: 502 });
      }
      return payload.data;
    },
  };
}
