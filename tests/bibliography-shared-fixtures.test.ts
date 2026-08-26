import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore The server module is Node ESM outside the TS application graph.
import { parseBibTeX } from "../server/lib/bibliography.mjs";

type Fixture = {
  name: string;
  source: string;
  expectedEntries: Array<{ type: string; key: string; fields: Record<string, string> }>;
  expectedDiagnostics?: string[];
  diagnosticsContain?: string[];
  diagnosticsPrefix?: string[];
};

const fixtures = JSON.parse(await readFile(join(process.cwd(), "shared", "bibliography-fixtures.json"), "utf8")) as Fixture[];

describe("shared bibliography fixtures", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const result = parseBibTeX(fixture.source);
      expect(result.entries.map(({ type, key, fields }: Fixture["expectedEntries"][number]) => ({ type, key, fields })))
        .toEqual(fixture.expectedEntries);
      if (fixture.expectedDiagnostics) expect(result.diagnostics).toEqual(fixture.expectedDiagnostics);
      for (const diagnostic of fixture.diagnosticsContain || []) expect(result.diagnostics).toContain(diagnostic);
      for (const prefix of fixture.diagnosticsPrefix || []) {
        expect(result.diagnostics.some((diagnostic: string) => diagnostic.startsWith(prefix))).toBe(true);
      }
    });
  }
});
