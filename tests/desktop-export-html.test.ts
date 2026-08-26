import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  MAX_STANDALONE_HTML_BYTES,
  normalizeExportHtmlRequest,
  normalizeHtmlOutputPath,
  safeHtmlTitle,
  writeStandaloneHtml,
} from "../desktop/export-html.mjs";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop standalone HTML writer", () => {
  test("normalizes titles, extensions and bounded requests", () => {
    expect(safeHtmlTitle("Unsafe:/\u0000 title")).toBe("Unsafe- title");
    expect(normalizeHtmlOutputPath("/tmp/note")).toBe("/tmp/note.html");
    expect(normalizeHtmlOutputPath("/tmp/note.htm")).toBe("/tmp/note.htm");
    expect(normalizeExportHtmlRequest({ html: "<!doctype html>", title: "Note" })).toMatchObject({
      title: "Note",
      bytes: 15,
    });
    expect(() => normalizeExportHtmlRequest({ html: "\u0000" })).toThrow("NUL");
    expect(() => normalizeExportHtmlRequest({ html: "x".repeat(MAX_STANDALONE_HTML_BYTES + 1) })).toThrow("exceeds");
  });

  test("atomically writes a private file with an HTML extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-html-export-"));
    temporaryRoots.push(root);
    const result = writeStandaloneHtml(join(root, "nested", "note"), "<!doctype html><title>Note</title>");
    expect(result.path).toBe(join(root, "nested", "note.html"));
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf8")).toContain("<title>Note</title>");
    expect(existsSync(join(root, "nested", ".note.html.tmp"))).toBe(false);
  });
});
