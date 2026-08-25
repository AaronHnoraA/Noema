// Shared App/Emacs transport for the Go-owned KaTeX macro loader. The Node fallback
// remains available to Emacs/Server and for a transient kernel outage.
export function createKernelKatexMacrosProvider({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base || typeof fetchImpl !== "function") {
    throw new Error("Kernel KaTeX macros provider requires baseUrl and fetch");
  }
  return {
    async load(dir = "") {
      const response = await fetchImpl(`${base}/api/noema/config/katexMacros`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: String(dir || "") }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || Number(payload?.code) !== 0 || !payload?.data) {
        const error = new Error(String(payload?.msg || `kernel request failed with HTTP ${response.status}`));
        error.statusCode = response.ok ? 502 : response.status;
        throw error;
      }
      return {
        dir: String(payload.data.dir || dir || ""),
        macros: payload.data.macros && typeof payload.data.macros === "object" ? payload.data.macros : {},
        errors: Array.isArray(payload.data.errors) ? payload.data.errors : [],
      };
    },
  };
}
