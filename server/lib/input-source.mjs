import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Keeps the keyboard Latin outside Vim Insert (docs/noema/guide/vim.md,
 * "Input methods"). The page reports its Vim state; Normal/Visual select a
 * Latin keyboard layout (remembering the input method in use) and Insert or
 * leaving the pane restores it, the way VSCodeVim's autoSwitchInputMethod and
 * Emacs `sis` do. The work is done by `build/apple/noema-input-source`, one
 * long-lived helper reading commands on stdin; it exits with the host when
 * its stdin closes. Without the helper (not macOS, not built) every call is a
 * no-op and the page keeps dropping keys an input method takes.
 */
export function createInputSourceSwitcher({ helper, platform = process.platform, spawnImpl = spawn } = {}) {
  let child = null;
  let broken = false;

  function ensure() {
    if (broken || platform !== "darwin" || !helper || !existsSync(helper)) return null;
    if (child && child.exitCode === null && !child.killed) return child;
    const started = spawnImpl(helper, [], { stdio: ["pipe", "ignore", "ignore"] });
    started.on("error", () => {
      broken = true;
      if (child === started) child = null;
    });
    started.on("exit", () => {
      if (child === started) child = null;
    });
    started.stdin?.on("error", () => {});
    child = started;
    return child;
  }

  return {
    /** "normal" selects a Latin layout; anything else restores the remembered input method. */
    set(mode) {
      const command = mode === "normal" ? "normal" : "restore";
      const running = ensure();
      if (!running?.stdin?.writable) return { ok: true, available: false };
      running.stdin.write(`${command}\n`);
      return { ok: true, available: true, command };
    },
    close() {
      const running = child;
      child = null;
      running?.stdin?.end();
      running?.kill();
    },
  };
}
