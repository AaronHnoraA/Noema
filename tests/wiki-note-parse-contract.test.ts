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
import { parseWikiNoteContent, resolveWikiRelationships } from "../server/lib/wiki-workspace.mjs";

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

const relationships = JSON.parse(readFileSync(resolve(process.cwd(), "shared/wiki-relationship-fixtures.json"), "utf8")) as {
  cases: Array<{ name: string; pages: Array<Record<string, unknown>>; expected: Record<string, unknown> }>;
};

describe("Wiki relationship contract", () => {
  test.each(relationships.cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const pages = structuredClone(entry.pages);
    const { notes, reports } = resolveWikiRelationships(pages);
    const { similar: _similar, ...rest } = reports;
    expect({
      pages: notes.map((note: { refs: string[]; backlinks: string[]; unresolvedLinks: string[] }) => ({
        refs: note.refs, backlinks: note.backlinks, unresolvedLinks: note.unresolvedLinks,
      })),
      reports: rest,
    }).toEqual(entry.expected);
  });
});
