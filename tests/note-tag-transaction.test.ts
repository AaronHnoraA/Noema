import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  metadataTagsFromMarkdown,
  planMarkdownMetadataChanges,
  planMarkdownTagChanges,
} from "../aaronnote/note-tag-transaction.ts";
import { wikiPageMetadata } from "../server/lib/wiki-workspace.mjs";

function apply(markdown: string, edit: { changed: boolean; from: number; to: number; insert: string }): string {
  return edit.changed ? markdown.slice(0, edit.from) + edit.insert + markdown.slice(edit.to) : markdown;
}

describe("the metadata block the tag editor writes to", () => {
  // The index accepts a meta block anywhere in the opening lines. The editor
  // has to edit that same block, or the index reads a block it never wrote.
  for (const [name, prefix] of [
    ["a leading blank line", "\n"],
    ["several blank lines", "\n\n\n"],
    ["a comment line", "<!-- draft -->\n"],
  ] as const) {
    test(`edits the existing block after ${name}`, () => {
      const source = `${prefix}#+begin meta\nid: 0190f3a2-7c1e-7000-8000-0123456789ab\ntitle: Page\ntags: a\n#+end meta\n\nBody\n`;
      const next = apply(source, planMarkdownTagChanges(source, { add: ["b"], remove: [] }));
      expect(next.match(/#\+begin meta/g)).toHaveLength(1);
      expect(metadataTagsFromMarkdown(next)).toEqual(["a", "b"]);
      // The page is still the page it was.
      expect(wikiPageMetadata(next)).toMatchObject({
        id: "0190f3a2-7c1e-7000-8000-0123456789ab",
        title: "Page",
        tags: "a b",
      });
    });
  }

  test("adds a tags field to a block that has none, wherever the block is", () => {
    const source = "\n#+begin meta\nid: abc\ntitle: Page\n#+end meta\n\nBody\n";
    const next = apply(source, planMarkdownTagChanges(source, { add: ["x"], remove: [] }));
    expect(next).toBe("\n#+begin meta\nid: abc\ntitle: Page\ntags: x\n#+end meta\n\nBody\n");
  });

  test("reads and writes the spaced directive form", () => {
    const source = "#+ begin meta\ntitle: Page\ntags: a\n#+ end meta\n\nBody\n";
    expect(metadataTagsFromMarkdown(source)).toEqual(["a"]);
    const next = apply(source, planMarkdownMetadataChanges(source, { project: "noema" }));
    expect(next).toBe("#+ begin meta\ntitle: Page\ntags: a\nproject: noema\n#+ end meta\n\nBody\n");
  });

  test("keeps CRLF line endings and a block on the first line working", () => {
    const source = "#+begin meta\r\ntitle: Page\r\ntags: a\r\n#+end meta\r\n\r\nBody\r\n";
    const next = apply(source, planMarkdownTagChanges(source, { add: ["b"], remove: ["a"] }));
    expect(next).toBe("#+begin meta\r\ntitle: Page\r\ntags: b\r\n#+end meta\r\n\r\nBody\r\n");
  });

  test("a block that only appears deep in the body is not the note's metadata", () => {
    const body = Array.from({ length: 14 }, (_, index) => `line ${index}`).join("\n");
    const source = `${body}\n#+begin meta\ntags: example\n#+end meta\n`;
    expect(metadataTagsFromMarkdown(source)).toBeNull();
    const next = apply(source, planMarkdownTagChanges(source, { add: ["x"], remove: [] }));
    expect(next.startsWith("#+begin meta\ntags: x\n#+end meta\n\n")).toBe(true);
    expect(next.endsWith(source)).toBe(true);
  });

  test("YAML front matter at the start still wins", () => {
    const source = "---\ntitle: Page\ntags: [a, b]\n---\n\nBody\n";
    const next = apply(source, planMarkdownTagChanges(source, { add: ["c"], remove: ["a"] }));
    expect(next).toBe("---\ntitle: Page\ntags: [b, c]\n---\n\nBody\n");
  });
});
