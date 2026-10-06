import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startNoteWatcher } from "../server/lib/watch.mjs";
// @ts-ignore Headless host module.
import { noteSelfWrite, noteSelfWriteRecently } from "../server/lib/runtime.mjs";

describe("note watcher", () => {
  test("keeps agent edits visible immediately after a host save", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-watch-self-write-"));
    const file = join(root, "note.md");
    const replacement = join(root, "replacement.md");
    try {
      await writeFile(file, "host");
      noteSelfWrite(file);
      expect(noteSelfWriteRecently(file)).toBe(true);

      // A same-size edit must be distinguished by more than size or seconds.
      await writeFile(file, "edit");
      expect(noteSelfWriteRecently(file)).toBe(false);

      noteSelfWrite(file);
      expect(noteSelfWriteRecently(file)).toBe(true);
      await writeFile(replacement, "next");
      await rename(replacement, file);
      expect(noteSelfWriteRecently(file)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores extensionless Git ref renames before requesting a full rescan", () => {
    let handleEvent: ((eventType: string, filename: string | null) => void) | undefined;
    let fullRescans = 0;
    const watcher = startNoteWatcher({
      root: "/notes",
      isRelevant: (file: string) => !file.split("/").includes(".git"),
      isDirectoryRelevant: (file: string) => !file.split("/").includes(".git"),
      isSelfWrite: () => false,
      onBatch: () => {},
      onFullRescan: () => { fullRescans += 1; },
      watchImplementation: (_root: string, _options: object, callback: typeof handleEvent) => {
        handleEvent = callback;
        return { on() {}, close() {} };
      },
    });

    handleEvent?.("rename", "private/QC/.git/refs/heads/noema/device");
    expect(fullRescans).toBe(0);

    handleEvent?.("rename", "private/QC/new-folder");
    expect(fullRescans).toBe(1);
    watcher.close();
  });
});
