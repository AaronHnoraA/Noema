import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { expandSnippetBody, snippetBrowserCompatibility } from "../aaronnote/snippets.ts";

const pairs: Record<string, string> = {
  algorithm: "algoo", assumption: "assumee", attention: "attt", axiom: "axiomm",
  claim: "claimm", conjecture: "conjj", convention: "convv", corollary: "corr",
  definition: "deff", example: "exx", exercise: "exercisee", info: "infoo",
  lemma: "lemm", notation: "notationn", note: "notee", observation: "obss",
  proof: "prooff", property: "propbb", proposition: "propp", question: "questionn",
  remark: "remarkk", solution: "solutionn", summary: "summ", theorem: "thmm", warning: "warnn",
};

describe("org-env block ID snippets", () => {
  test("TikZ snippet generates its own ID in the browser", async () => {
    const file = await readFile(join(process.cwd(), "resources", "snippets", "markdown-mode", "tikz"), "utf8");
    const body = file.split(/^# --\s*$/m)[1]?.trimStart() || "";
    expect(snippetBrowserCompatibility(body).compatible).toBe(true);
    const expanded = expandSnippetBody({ key: "tikz", name: "TikZ", mode: "markdown-mode", body }, {
      newId: () => "0198fbac-0780-7c99-85e6-333333333333",
    });
    expect(expanded.text).toMatch(/^#\+ begin tikz 0198fbac-0780-7c99-85e6-333333333333\n/);
    expect(expanded.text).toContain("#+ end tikz");
  });

  test("keeps ordinary snippets ID-free and provides repeated-final-letter variants", async () => {
    const root = join(process.cwd(), "resources", "snippets", "markdown-mode");
    for (const [name, idKey] of Object.entries(pairs)) {
      const ordinary = await readFile(join(root, name), "utf8");
      const identified = await readFile(join(root, `${name}-id`), "utf8");
      expect(ordinary).not.toContain('my/noema-new-id "block"');
      expect(identified).toContain(`# key: ${idKey}`);
      expect(identified).toContain('{#`(my/noema-new-id "block")`}');
    }
  });
});
