/**
 * The Wiki index's per-note parse is a contract: the Node indexer and, as it
 * takes over, the Go kernel must derive the same fields from the same text
 * (docs/noema/design/wiki-workspace.md "Index ownership"). The fixtures are
 * the shared answer; a Go test reads the same file.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
// @ts-ignore Node ESM module outside the TS app graph.
import { parseWikiNoteContent } from "../server/lib/wiki-workspace.mjs";

const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), "shared/wiki-note-parse-fixtures.json"), "utf8")) as {
  version: number;
  cases: Array<{ name: string; file: string; content: string; expected: Record<string, unknown> }>;
};

describe("Wiki note parse contract", () => {
  test.each(fixtures.cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const { approvedContent: _approved, meta: _meta, ...fields } = parseWikiNoteContent(entry.content, entry.file);
    expect(fields).toEqual(entry.expected);
  });
});
