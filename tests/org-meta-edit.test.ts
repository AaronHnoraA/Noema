import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { editableMetaEntries, orgMetaSummarySourceRange } from "../src/org-meta.ts";
import { parseSimpleFrontmatter, simpleFrontmatterStrings } from "../src/simple-frontmatter.ts";

describe("native metadata editing model", () => {
  test("returns exact editable ranges while excluding summary prose", () => {
    const body = [
      "title :  Tensor note  ",
      "# preserved unknown line",
      "tags: math, coding",
      "#+begin summary Abstract",
      "reason: this is prose, not a property",
      "#+end summary",
    ].join("\n");
    const entries = editableMetaEntries(body);
    expect(entries.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "title", value: "Tensor note" },
      { key: "tags", value: "math, coding" },
    ]);
    const title = entries[0]!;
    expect(body.slice(title.keyFrom, title.keyTo)).toBe("title");
    expect(body.slice(title.valueFrom, title.valueTo)).toBe("Tensor note");
    const summary = orgMetaSummarySourceRange(body)!;
    expect(body.slice(summary.from, summary.to)).toContain("reason: this is prose");
  });

  test("accepts only flat Markdown frontmatter values and simple lists", () => {
    const parsed = parseSimpleFrontmatter([
      "---",
      "title: Simple note",
      "tags:",
      "  - math",
      "  - coding",
      "aliases: [Tensor, QI]",
      "nested:",
      "  child: source-only",
      "---",
      "Body",
    ].join("\n"))!;
    expect(parsed.fields.get("title")).toBe("Simple note");
    expect(simpleFrontmatterStrings(parsed, "tags")).toEqual(["math", "coding"]);
    expect(simpleFrontmatterStrings(parsed, "aliases")).toEqual(["Tensor", "QI"]);
    expect(parsed.unsupported).toBe(true);
  });
});
