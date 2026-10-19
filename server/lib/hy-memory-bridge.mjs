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

export async function recallHyMemory(root, query) {
  if (!hyMemoryConfigured() || typeof root !== "string" || !path.isAbsolute(root)
      || !String(query || "").trim()) return [];
  return new Promise((resolve) => {
    try {
      const child = spawn(python(), [script, "search"], { stdio: ["pipe", "pipe", "ignore"] });
      let output = "";
      let done = false;
      const finish = (items = [], failed = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (failed) disabledUntil = Date.now() + 60000;
        resolve(items);
      };
      const timer = setTimeout(() => { child.kill(); finish([], true); }, 3000);
      child.on("error", () => finish([], true));
      child.stdin.on("error", () => finish([], true));
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        if (output.length > 18000) { child.kill(); finish([], true); }
      });
      child.on("close", (code) => {
        if (code !== 0) return finish([], true);
        try {
          const items = JSON.parse(output).items;
          finish(Array.isArray(items) ? items.filter((item) => typeof item?.content === "string").slice(0, 4) : []);
        } catch { finish([], true); }
      });
      child.stdin.end(JSON.stringify({ root, query: String(query).slice(0, 8192) }));
    } catch {
      disabledUntil = Date.now() + 60000;
      resolve([]);
    }
  });
}
