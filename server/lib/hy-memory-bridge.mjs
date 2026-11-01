// One bounded, best-effort bridge for Noema Run preparation.  The same Python
// bridge serves ordinary ACP sessions; Noema remains the authority for the
// reviewed status and evidence of research Findings.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = (() => {
  try { return fileURLToPath(new URL("../../scripts/noema-hy-memory.py", import.meta.url)); }
  catch { return path.resolve(process.cwd(), "scripts/noema-hy-memory.py"); }
})();
const python = () => process.env.NOEMA_HY_MEMORY_PYTHON
  || path.join(os.homedir(), ".local/share/noema/hy-memory-venv/bin/python");
const config = () => process.env.NOEMA_HY_MEMORY_CONFIG
  || path.join(os.homedir(), ".config/noema/hy-memory.env");
let disabledUntil = 0;

export function hyMemoryConfigured() {
  if (Date.now() < disabledUntil) return false;
  if (!existsSync(script) || !existsSync(python()) || !existsSync(config())) return false;
  try {
    const contents = readFileSync(config(), "utf8");
    return ["MEMORY_EMBEDDER_BASE_URL", "MEMORY_EMBEDDER_MODEL", "MEMORY_EMBEDDER_API_KEY"]
      .every((key) => new RegExp(`^${key}=\\S+`, "m").test(contents));
  } catch { return false; }
}

/** What a caller may report: being suspended is not the same as being absent. */
export function hyMemoryStatus() {
  if (Date.now() < disabledUntil) return { state: "suspended", retryAfterMillis: disabledUntil - Date.now() };
  return { state: hyMemoryConfigured() ? "ready" : "unconfigured" };
}

/** Ask the bridge once.  The outcome is `ok`, `unconfigured` or `failed`. */
function runSearch(root, query) {
  return new Promise((resolve) => {
    try {
      const child = spawn(python(), [script, "search"], { stdio: ["pipe", "pipe", "ignore"] });
      let output = "";
      let done = false;
      const finish = (outcome, items = []) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (outcome === "failed") disabledUntil = Date.now() + 60000;
        resolve({ outcome, items });
      };
      const timer = setTimeout(() => { child.kill(); finish("failed"); }, 3000);
      child.on("error", () => finish("failed"));
      child.stdin.on("error", () => finish("failed"));
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        if (output.length > 18000) { child.kill(); finish("failed"); }
      });
      child.on("close", (code) => {
        if (code !== 0) return finish("failed");
        try {
          const parsed = JSON.parse(output);
          if (parsed.configured === false) return finish("unconfigured");
          const items = parsed.items;
          if (!Array.isArray(items)) return finish("failed");
          finish("ok", items.filter((item) => typeof item?.content === "string").slice(0, 4));
        } catch { finish("failed"); }
      });
      child.stdin.end(JSON.stringify({ root, query: String(query).slice(0, 8192) }));
    } catch {
      disabledUntil = Date.now() + 60000;
      resolve({ outcome: "failed", items: [] });
    }
  });
}

const searchable = (root, query) => typeof root === "string" && path.isAbsolute(root) && String(query || "").trim();

/** Recall with its outcome, so a failed backend never reads as "nothing found". */
export async function searchHyMemory(root, query) {
  const status = hyMemoryStatus();
  if (status.state !== "ready") return { ...status, items: [] };
  if (!searchable(root, query)) return { state: "invalid", items: [] };
  const { outcome, items } = await runSearch(root, query);
  if (outcome === "ok") return { state: "ok", items };
  return { ...(outcome === "failed" ? hyMemoryStatus() : { state: outcome }), items: [] };
}

export async function recallHyMemory(root, query) {
  if (!hyMemoryConfigured() || !searchable(root, query)) return [];
  return (await runSearch(root, query)).items;
}
