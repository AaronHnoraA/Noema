import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  currentNoteFromIndex,
  openedNoteNeedsIndexReload,
  payloadUpdatesNoteIndex,
} from "../aaronnote/note-index.ts";
import type { NoteSummary } from "../aaronnote/types.ts";

function note(file: string, path: string, title: string): NoteSummary {
  return { file, path, title, id: title.toLocaleLowerCase().replaceAll(" ", "-") };
}

describe("current note index identity", () => {
  test("keeps save metadata and ordinary opens off the catalog refresh path", () => {
    expect(payloadUpdatesNoteIndex({})).toBe(false);
    expect(payloadUpdatesNoteIndex({ note: {} })).toBe(false);
    expect(payloadUpdatesNoteIndex({ note: { file: "/notes/a.md" } })).toBe(true);
    expect(payloadUpdatesNoteIndex({ notes: [] })).toBe(true);

    expect(openedNoteNeedsIndexReload({ notes: [] }, false)).toBe(false);
    expect(openedNoteNeedsIndexReload({}, true)).toBe(false);
    expect(openedNoteNeedsIndexReload({}, false)).toBe(true);
  });

  test("prefers exact file identity", () => {
    const exact = note("/vault/current.md", "current.md", "Current");
    const nested = note("/vault/nested/current.md", "nested/current.md", "Nested");
    expect(currentNoteFromIndex([nested, exact], exact.file || "")).toBe(exact);
  });

  test("resolves a unique portable path through a canonicalized root", () => {
    const target = note("/tmp/noema-smoke/target.md", "target.md", "Target");
    expect(currentNoteFromIndex([target], "/private/tmp/noema-smoke/target.md")).toBe(target);
  });

  test("fails closed when a relative suffix is ambiguous", () => {
    const one = note("/vault/one/note.md", "note.md", "One");
    const two = note("/vault/two/note.md", "note.md", "Two");
    expect(currentNoteFromIndex([one, two], "/canonical/vault/note.md")).toBeUndefined();
  });

  test("uses the open title only to disambiguate matching suffixes", () => {
    const one = note("/vault/one/note.md", "note.md", "One");
    const two = note("/vault/two/note.md", "note.md", "Two");
    expect(currentNoteFromIndex([one, two], "/canonical/vault/note.md", "Two")).toBe(two);
  });
});
