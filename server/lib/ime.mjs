/**
 * IME input source switcher for Vim mode (macOS only).
 *
 * Requires macism or im-select installed (brew install macism).
 * Feature silently disables if neither tool is found.
 *
 * Usage: createImeSwitcher() → { vimMode(mode), status() }
 */

import { access, constants } from "node:fs/promises";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(_execFile);

const CANDIDATE_PATHS = [
  "/opt/homebrew/bin/macism",
  "/usr/local/bin/macism",
  "/opt/homebrew/bin/im-select",
  "/usr/local/bin/im-select",
];

const DEFAULT_NORMAL_IM = "com.apple.keylayout.ABC";

async function detectTool() {
  for (const p of CANDIDATE_PATHS) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch (_) { /* try next */ }
  }
  // Fallback: try `which`
  for (const name of ["macism", "im-select"]) {
    try {
      const { stdout } = await execFileAsync("which", [name]);
      const path = stdout.trim();
      if (path) return path;
    } catch (_) { /* try next */ }
  }
  return null;
}

async function readCurrentIM(toolPath) {
  try {
    const { stdout } = await execFileAsync(toolPath, []);
    return stdout.trim();
  } catch (_) {
    return null;
  }
}

async function setIM(toolPath, im) {
  try {
    await execFileAsync(toolPath, [im]);
  } catch (_) { /* ignore */ }
}

export function createImeSwitcher({ normalIm } = {}) {
  const normal = normalIm ?? process.env.AARONNOTE_IME_NORMAL ?? DEFAULT_NORMAL_IM;

  // Lazy detection
  let toolPath = undefined; // undefined = not yet detected; null = disabled
  let toolDetectPromise = null;

  async function getToolPath() {
    if (toolPath !== undefined) return toolPath;
    if (toolDetectPromise) return toolDetectPromise;
    toolDetectPromise = detectTool().then((p) => {
      toolPath = p ?? null;
      return toolPath;
    });
    return toolDetectPromise;
  }

  // Latest-wins coalescing: only one exec in flight
  let lastInsertIM = null;
  let latestMode = null;
  let running = false;

  async function applyMode(mode, tool) {
    if (mode === "normal") {
      const current = await readCurrentIM(tool);
      if (current) lastInsertIM = current;
      if (current && current !== normal) await setIM(tool, normal);
    } else {
      if (lastInsertIM && lastInsertIM !== normal) await setIM(tool, lastInsertIM);
    }
  }

  async function runLoop() {
    if (running) return;
    running = true;
    try {
      while (latestMode !== null) {
        const mode = latestMode;
        latestMode = null;
        const tool = await getToolPath();
        if (!tool) { running = false; return; }
        await applyMode(mode, tool);
      }
    } finally {
      running = false;
    }
  }

  async function vimMode(mode) {
    const tool = await getToolPath();
    if (tool === null) return { enabled: false };
    const effective = mode === "insert" ? "insert" : "normal";
    latestMode = effective;
    void runLoop();
    return { enabled: true };
  }

  function status() {
    return { toolPath: toolPath ?? "pending", lastInsertIM, normalIM: normal };
  }

  return { vimMode, status };
}
