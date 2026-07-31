import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RESERVED_KEYS = new Set([
  "AARONNOTE_ROOT", "AARONNOTE_WORKSPACE_ROOT", "NOEMA_ROOT", "NOEMA_WORKSPACE_ROOT",
  "NOEMA_WORKSPACE_LAYOUT", "AARONNOTE_HOST_MODE", "AARONNOTE_WEB_HOST", "AARONNOTE_WEB_PORT",
]);

export async function authorizedWorkspaceEnvironment(rootValue, base = process.env) {
  const root = resolve(String(rootValue));
  if (!existsSync(join(root, ".envrc"))) {
    return { active: false, authorized: false, root, environment: { ...base }, variables: [], message: "No .envrc" };
  }
  try {
    const { stdout } = await execFileAsync("direnv", ["export", "json"], {
      cwd: root,
      env: { ...base },
      timeout: 10_000,
      maxBuffer: 1024 * 1024 * 4,
    });
    const exported = JSON.parse(stdout || "{}");
    const overlay = {};
    for (const [key, value] of Object.entries(exported)) {
      if (RESERVED_KEYS.has(key) || value === null || value === undefined) continue;
      overlay[key] = String(value);
    }
    return {
      active: true,
      authorized: true,
      root,
      environment: { ...base, ...overlay },
      variables: Object.keys(overlay).sort(),
      message: "Authorized root direnv environment is available to tool subprocesses",
    };
  } catch (error) {
    return {
      active: false,
      authorized: false,
      root,
      environment: { ...base },
      variables: [],
      message: String(error?.stderr || error?.message || "direnv environment is unavailable").trim(),
    };
  }
}
