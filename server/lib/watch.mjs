import { watch } from "node:fs";
import { relative } from "node:path";

/**
 * startNoteWatcher — singleton fs.watch wrapper for vault change detection.
 *
 * Uses the OS-native recursive watch (FSEvents on macOS, inotify on Linux).
 * No polling. Persistent: false and timer.unref() ensure the watcher never
 * prevents process exit.
 *
 * Events are coalesced into batches by a debounce window (default 250 ms).
 * Self-writes (identified by isSelfWrite) are silently dropped so the server's
 * own atomic saves don't trigger redundant index re-reads.
 *
 * Directory changes (null filename or extension-less rename) escalate to
 * onFullRescan() — these correspond to folder create/rename/delete and are
 * rare. File-level events go to onBatch(files: string[]) as absolute paths.
 *
 * Returns a handle with a single close() method. close() is idempotent.
 */
export function startNoteWatcher({
  root,
  debounceMs = 250,
  isRelevant,     // (relPath: string) => boolean
  isSelfWrite,    // (absPath: string) => boolean
  onBatch,        // (files: string[]) => void
  onFullRescan,   // () => void
}) {
  let closed = false;
  let watcher = null;
  let timer = null;
  const pending = new Set();

  function flush() {
    timer = null;
    if (closed) return;
    const batch = [...pending];
    pending.clear();
    if (batch.length > 0) onBatch(batch);
  }

  function scheduleFlush() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    // Don't let the debounce timer keep the process alive during shutdown.
    timer.unref?.();
  }

  function handleEvent(eventType, filename) {
    if (closed) return;

    // null filename: fs.watch overflow on some platforms — force full rescan.
    if (!filename) {
      if (timer) { clearTimeout(timer); timer = null; }
      pending.clear();
      onFullRescan();
      return;
    }

    const abs = `${root}/${filename}`.replace(/\\/g, "/");

    // Extension-less rename event = directory structural change (created/renamed/deleted).
    const slash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
    const basename = filename.slice(slash + 1);
    if (eventType === "rename" && basename.indexOf(".") === -1) {
      if (timer) { clearTimeout(timer); timer = null; }
      pending.clear();
      onFullRescan();
      return;
    }

    const relPath = relative(root, abs);
    if (!isRelevant(relPath)) return;
    if (isSelfWrite(abs)) return;

    pending.add(abs);
    scheduleFlush();
  }

  try {
    watcher = watch(root, { recursive: true, persistent: false }, handleEvent);
    watcher.on("error", (err) => {
      process.stderr.write(`[aaronnote-watch] watcher error: ${err.message}\n`);
    });
  } catch (err) {
    process.stderr.write(`[aaronnote-watch] could not watch ${root}: ${err.message}\n`);
    // Degrade gracefully: return a no-op handle; index stays manual-refresh only.
    return { close() {} };
  }

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      pending.clear();
      try { watcher?.close(); } catch {}
      watcher = null;
    },
  };
}
