import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { sameNoteFile } from "../aaronnote/same-note-file.ts";

describe("same note file", () => {
  test("accepts the spellings one file is reported under", () => {
    expect(sameNoteFile("/vault/a/note.md", "/vault/a/note.md")).toBe(true);
    expect(sameNoteFile("/vault/a/note.md", "a/note.md")).toBe(true);
    expect(sameNoteFile("/private/tmp/vault/a/note.md", "/tmp/vault/a/note.md")).toBe(true);
    expect(sameNoteFile("file:///vault/a/note.md", "/vault/a/note.md")).toBe(true);
    expect(sameNoteFile("C:\\vault\\a\\note.md", "a/note.md")).toBe(true);
    expect(sameNoteFile("/vault/a/./b/../note.md", "/vault/a/note.md")).toBe(true);
    expect(sameNoteFile("note.md", "note.md")).toBe(true);
  });

  test("never identifies two notes by file name alone", () => {
    expect(sameNoteFile("/vault/public/README.md", "/vault/private/README.md")).toBe(false);
    expect(sameNoteFile("/vault/public/README.md", "README.md")).toBe(false);
    expect(sameNoteFile("/vault/a/index.md", "b/index.md")).toBe(false);
    expect(sameNoteFile("/vault/a/note.md", "/vault/a/other.md")).toBe(false);
    expect(sameNoteFile("", "/vault/a/note.md")).toBe(false);
    expect(sameNoteFile("/vault/a/note.md", "")).toBe(false);
  });
});
