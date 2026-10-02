/**
 * CodeMirror keeps "\n" line breaks; a CRLF file must not be patched with
 * those offsets, and must be written back with the line ending it had.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { sourceLineEnding, sourceWithLineEnding } from "../aaronnote/editor-save-changes.ts";

describe("note line endings", () => {
  test("LF files keep incremental saves", () => {
    expect(sourceLineEnding("# a\nb\n")).toEqual({ eol: "lf", patchable: true });
  });

  test("CRLF files save whole and keep CRLF", () => {
    const opened = "# a\r\nb\r\n";
    const mode = sourceLineEnding(opened);
    expect(mode).toEqual({ eol: "crlf", patchable: false });
    const edited = "# a\nb!\n";
    expect(sourceWithLineEnding(edited, mode.eol)).toBe("# a\r\nb!\r\n");
  });

  test("mixed endings settle on the majority and never patch", () => {
    expect(sourceLineEnding("a\r\nb\nc\n")).toEqual({ eol: "lf", patchable: false });
    expect(sourceLineEnding("a\r\nb\r\nc\n")).toEqual({ eol: "crlf", patchable: false });
  });

  test("an already-CRLF string is not doubled", () => {
    expect(sourceWithLineEnding("a\r\nb\n", "crlf")).toBe("a\r\nb\r\n");
  });
});
