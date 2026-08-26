import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// @ts-ignore Server ESM module lives outside the renderer TypeScript graph.
import { academicLatexPostprocess, preprocessAaronnoteForPandoc } from "../server/lib/latex-export-pandoc.mjs";

type Fixture = {
  cases: Array<{
    name: string;
    markdown: string;
    options?: Record<string, unknown>;
    expected: Record<string, unknown>;
  }>;
  errorCases: Array<{ name: string; markdown: string; message: string }>;
  postprocess: { input: string; expected: string };
};

describe("shared Go/JavaScript LaTeX transform contract", () => {
  test("keeps deterministic Pandoc preprocessing byte-identical", async () => {
    const fixture = JSON.parse(await readFile(join(process.cwd(), "shared", "latex-transform-fixtures.json"), "utf8")) as Fixture;
    for (const entry of fixture.cases) {
      expect(preprocessAaronnoteForPandoc(entry.markdown, entry.options || {}), entry.name).toEqual(entry.expected);
    }
    for (const entry of fixture.errorCases) {
      expect(() => preprocessAaronnoteForPandoc(entry.markdown), entry.name).toThrow(entry.message);
    }
    expect(academicLatexPostprocess(fixture.postprocess.input)).toBe(fixture.postprocess.expected);
  });
});
