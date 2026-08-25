import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Shared ESM contract lives outside the TS app graph.
import { parseEmbedQuerySpec } from "../shared/embed-query.mjs";

describe("portable embed query source", () => {
  test("parses a named fenced SQL body and identity options", () => {
    expect(parseEmbedQuerySpec(
      'Recent claims {#0198fc34-7b32-7a11-8cb4-6c40e3b33d73 heading=2 breadcrumb=false}',
      "sql: SELECT * FROM blocks WHERE type = 'p'",
    )).toEqual({
      title: "Recent claims",
      statement: "SELECT * FROM blocks WHERE type = 'p'",
      blockId: "0198fc34-7b32-7a11-8cb4-6c40e3b33d73",
      headingMode: 2,
      breadcrumb: false,
      diagnostics: [],
    });
  });

  test("keeps the migration-plan inline :sql spelling", () => {
    expect(parseEmbedQuerySpec(":sql SELECT * FROM blocks LIMIT 3", "")).toMatchObject({
      title: "Embedded query",
      statement: "SELECT * FROM blocks LIMIT 3",
      diagnostics: [],
    });
  });

  test("fails closed on ambiguity, missing queries, and write statements", () => {
    expect(parseEmbedQuerySpec(":sql SELECT 1", "SELECT 2").diagnostics[0]?.kind).toBe("ambiguous-query");
    expect(parseEmbedQuerySpec("Empty", "").diagnostics[0]?.kind).toBe("missing-query");
    expect(parseEmbedQuerySpec("Unsafe", "DELETE FROM blocks")).toMatchObject({
      statement: "",
      diagnostics: [{ kind: "invalid-query" }],
    });
  });
});
