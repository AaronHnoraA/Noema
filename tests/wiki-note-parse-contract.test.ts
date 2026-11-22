/**
 * The Wiki index's per-note parse is a contract: the Node indexer and, as it
 * takes over, the Go kernel must derive the same fields from the same text
 * (docs/noema/design/wiki-workspace.md "Index ownership"). The fixtures are
 * the shared answer; a Go test reads the same file.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
// @ts-ignore Node ESM module outside the TS app graph.
import { parseWikiNoteContent, persistWikiIndex, resolveWikiRelationships, wikiDatabaseFile } from "../server/lib/wiki-workspace.mjs";

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

describe("Wiki database contract", () => {
  test("Node writes the tables the kernel is held to (shared/wiki-db-fixtures.json)", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-db-contract-"));
    try {
      const text = readFileSync(resolve(process.cwd(), "shared/wiki-db-fixtures.json"), "utf8").split("$ROOT").join(root);
      const fixture = JSON.parse(text) as { index: Record<string, unknown>; tables: Record<string, unknown> };
      await persistWikiIndex({ ...fixture.index, root } as never, { mode: "full" });
      const db = new DatabaseSync(wikiDatabaseFile(root), { readOnly: true });
      try {
        const rows = (query: string) => (db.prepare(query).all() as Array<Record<string, unknown>>)
          .map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort())))
          .sort();
        const want = (table: string) => (fixture.tables[table] as Array<Record<string, unknown>>)
          .map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort())))
          .sort();
        for (const table of ["repositories", "files", "pages", "blocks", "aliases", "tags", "links", "dependencies", "diagnostics", "page_bigrams"]) {
          expect(rows(`SELECT * FROM ${table}`), table).toEqual(want(table));
        }
        expect(rows("SELECT page_key, title, aliases, tags, path, body FROM pages_fts")).toEqual(want("pages_fts"));
        expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(fixture.tables.user_version);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
