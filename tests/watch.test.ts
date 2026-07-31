import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { startNoteWatcher } from "../server/lib/watch.mjs";

describe("note watcher", () => {
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
