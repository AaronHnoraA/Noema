import { resolve } from "node:path";

/**
 * The Wiki index builder of a host whose Go kernel runs: the kernel scans the
 * vault, writes wiki.db and returns the index (POST /api/noema/wiki/refresh).
 * KERNEL() gives the current kernel state; while it is restarting a refresh
 * fails and says so, it is not done by the host instead.
 */
export function createKernelWikiIndexBuilder({ kernel, fetchImpl = globalThis.fetch, timeoutMs = 120_000 } = {}) {
  if (typeof kernel !== "function" || typeof fetchImpl !== "function") {
    throw new Error("The kernel Wiki index builder needs the kernel state and fetch");
  }
  return async function build(root, { full = false } = {}) {
    const state = kernel() || {};
    if (!state.ready || !state.baseUrl || !state.box?.id) {
      throw new Error("The Wiki index cannot be refreshed while the Noema kernel is not running");
    }
    if (state.box.root && resolve(String(state.box.root)) !== resolve(String(root))) {
      throw new Error(`The kernel indexes ${state.box.root}, not ${root}`);
    }
    const response = await fetchImpl(`${String(state.baseUrl).replace(/\/+$/, "")}/api/noema/wiki/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebook: state.box.id, full: Boolean(full), includeIndex: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) {
      throw new Error("This Noema kernel predates the Wiki index refresh; run `make kernel-build` in site-lisp/noema and restart Noema");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code) !== 0 || !payload?.data) {
      throw new Error(String(payload?.msg || `kernel Wiki refresh failed with HTTP ${response.status}`));
    }
    return payload.data;
  };
}
