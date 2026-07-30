import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
// @ts-ignore Shared ESM helper is consumed by both Node and the browser build.
import { parseNoteCodeLine } from "../shared/note-code.mjs";

describe("note-code syntax", () => {
  test("parses note-code line commands", () => {
    expect(parseNoteCodeLine("@@note-code(/Proofs/Sample.lean)[main]")).toEqual({
      commandFrom: 0,
      commandTo: 38,
      path: "/Proofs/Sample.lean",
      id: "main",
    });
  });

  test("requires a path and id", () => {
    expect(parseNoteCodeLine("@@note-code()[main]")).toBeNull();
    expect(parseNoteCodeLine("@@note-code(/Proofs/Sample.lean)[]")).toBeNull();
    expect(parseNoteCodeLine("x @@note-code(/Proofs/Sample.lean)[main]")).toBeNull();
  });
});
