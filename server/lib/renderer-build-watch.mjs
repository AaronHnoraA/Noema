import { watch as watchFileSystem } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

export async function readRendererBuildGeneration(receiptFile) {
  try {
    const parsed = JSON.parse(await readFile(receiptFile, "utf8"));
    return typeof parsed?.generation === "string" ? parsed.generation.trim() : "";
  } catch {
    return "";
  }
}

export async function createRendererBuildWatcher({
  receiptFile,
  onBuild,
  debounceMs = 120,
  watchImpl = watchFileSystem,
}) {
  let generation = await readRendererBuildGeneration(receiptFile);
  let timer = null;
  let closed = false;
  const receiptName = basename(receiptFile);
  const watcher = watchImpl(dirname(receiptFile), { persistent: false }, (_event, filename) => {
    if (closed || (filename && String(filename) !== receiptName)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void readRendererBuildGeneration(receiptFile).then((next) => {
        if (closed || !next || next === generation) return;
        const previous = generation;
        generation = next;
        onBuild?.({ generation: next, previous });
      });
    }, debounceMs);
    timer.unref?.();
  });

  return {
    get generation() {
      return generation;
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher.close();
    },
  };
}
