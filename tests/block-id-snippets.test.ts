import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

const pairs: Record<string, string> = {
  algorithm: "algoo", assumption: "assumee", attention: "attt", axiom: "axiomm",
  claim: "claimm", conjecture: "conjj", convention: "convv", corollary: "corr",
  definition: "deff", example: "exx", exercise: "exercisee", info: "infoo",
  lemma: "lemm", notation: "notationn", note: "notee", observation: "obss",
  proof: "prooff", property: "propbb", proposition: "propp", question: "questionn",
  remark: "remarkk", solution: "solutionn", summary: "summ", theorem: "thmm", warning: "warnn",
};

describe("org-env block ID snippets", () => {
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
