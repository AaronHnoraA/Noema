import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { ChangeSet } from "@codemirror/state";

import {
  EditorSaveChangeTracker,
  markdownChangeSetPayload,
} from "../aaronnote/editor-save-changes.ts";

describe("incremental editor save changes", () => {
  test("composes sequential CM6 edits against the saved base", () => {
    const tracker = new EditorSaveChangeTracker();
    expect(tracker.hasPending()).toBe(false);
    tracker.record(ChangeSet.of({ from: 1, to: 2, insert: "X" }, 6));
    tracker.record(ChangeSet.of({ from: 4, to: 6, insert: "Y" }, 6));

    expect(tracker.hasPending()).toBe(true);

    expect(tracker.capture()?.payload).toEqual({
      length: 6,
      newLength: 5,
      changes: [
        { from: 1, to: 2, insert: "X" },
        { from: 4, to: 6, insert: "Y" },
      ],
    });
    expect(tracker.hasPending()).toBe(false);
  });

  test("restores an in-flight prefix before edits typed during a failed save", () => {
    const tracker = new EditorSaveChangeTracker();
    tracker.record(ChangeSet.of({ from: 1, to: 1, insert: "A" }, 3));
    const inFlight = tracker.capture();
    expect(inFlight).not.toBeNull();
    tracker.record(ChangeSet.of({ from: 4, to: 4, insert: "B" }, 4));
    expect(tracker.restore(inFlight!)).toBe(true);

    const restored = tracker.capture();
    expect(markdownChangeSetPayload(restored!.changeSet)).toEqual({
      length: 3,
      newLength: 5,
      changes: [
        { from: 1, to: 1, insert: "A" },
        { from: 3, to: 3, insert: "B" },
      ],
    });
  });
});
