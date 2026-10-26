import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { missingOpenNoteFiles, startNoteWatcher } from "../server/lib/watch.mjs";
// @ts-ignore Headless host module.
import { noteSelfWrite, noteSelfWriteRecently } from "../server/lib/runtime.mjs";

describe("note watcher", () => {
  test("checks only open Markdown paths and includes descendants after a directory move", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-watch-open-"));
    const oldDir = join(root, "topic");
    const oldNote = join(oldDir, "note.md");
    const other = join(root, "other.md");
    const outside = join(tmpdir(), "unrelated.md");
    try {
      await mkdir(oldDir);
      await writeFile(oldNote, "note");
      await writeFile(other, "other");
      await rename(oldDir, join(root, "renamed"));
      const open = [oldNote, oldNote, other, outside, join(root, "draft.txt")];
      expect(missingOpenNoteFiles(open, root, [other])).toEqual([]);
      expect(missingOpenNoteFiles(open, root, [oldNote])).toEqual([oldNote]);
      expect(missingOpenNoteFiles(open, root)).toEqual([oldNote]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  test("checks queued events again after a host save completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-watch-save-race-"));
    const file = join(root, "note.md");
    let handleEvent: ((eventType: string, filename: string | null) => void) | undefined;
    const batches: string[][] = [];
    const watcher = startNoteWatcher({
      root,
      debounceMs: 100,
      isRelevant: () => true,
      isSelfWrite: noteSelfWriteRecently,
      onBatch: (files: string[]) => batches.push(files),
      onFullRescan: () => {},
      watchImplementation: (_root: string, _options: object, callback: typeof handleEvent) => {
        handleEvent = callback;
        return { on() {}, close() {} };
      },
    });
    try {
      await writeFile(file, "saved by Noema");
      handleEvent?.("change", "note.md"); // Go has written, host has not recorded it yet.
      noteSelfWrite(file);
      await new Promise((resolve) => setTimeout(resolve, 130));
      expect(batches).toEqual([]);

      await writeFile(file, "saved by Noema again");
      handleEvent?.("change", "note.md");
      noteSelfWrite(file);
      await writeFile(file, "external edit"); // A different writer changes the signature before flush.
      handleEvent?.("change", "note.md");
      await new Promise((resolve) => setTimeout(resolve, 130));
      expect(batches).toEqual([[file]]);
    } finally {
      watcher.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("holds a write event past the debounce until the host write is classified", async () => {
    let handleEvent: ((eventType: string, filename: string | null) => void) | undefined;
    let state: boolean | "pending" = "pending";
    const batches: string[][] = [];
    const watcher = startNoteWatcher({
      root: "/notes",
      debounceMs: 15,
      isRelevant: () => true,
      // The JS watcher accepts this sentinel; its inferred TS callback type
      // only sees the boolean branch of the implementation.
      isSelfWrite: () => state as boolean,
      onBatch: (files: string[]) => batches.push(files),
      onFullRescan: () => {},
      watchImplementation: (_root: string, _options: object, callback: typeof handleEvent) => {
        handleEvent = callback;
        return { on() {}, close() {} };
      },
    });
    try {
      handleEvent?.("change", "note.md");
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(batches).toEqual([]);
      state = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(batches).toEqual([]);

      state = "pending";
      handleEvent?.("change", "note.md");
      await new Promise((resolve) => setTimeout(resolve, 40));
      state = false;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(batches).toEqual([["/notes/note.md"]]);
    } finally {
      watcher.close();
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
