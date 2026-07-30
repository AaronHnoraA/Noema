import { EditorState, Text } from "@codemirror/state";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { tocIndexExtension } from "../src/cm6/toc-index.ts";
import { countWritingStats, headingSubtreeRange, readingMinutes } from "../aaronnote/writing-stats.ts";

describe("writing stats", () => {
  test("counts CJK characters and non-CJK words without counting whitespace", () => {
    const stats = countWritingStats(Text.of(["你好 world, Aaron-note!", "第二行"]));
    expect(stats).toEqual({ words: 7, characters: 22, cjkCharacters: 5, nonCjkWords: 2 });
    expect(readingMinutes(stats)).toBe(1);
  });

  test("counts only the selected range", () => {
    const doc = Text.of(["alpha beta 中文"]);
    expect(countWritingStats(doc, 6, 13).words).toBe(3);
  });

  test("excludes the nested meta summary from external word statistics", () => {
    const doc = Text.of([
      "#+begin meta",
      "title: Graph Tensor",
      "#+begin summary",
      "# Hidden heading",
      "hidden abstract words 中文",
      "#+end summary",
      "#+end meta",
      "visible body",
    ]);
    const stats = countWritingStats(doc);
    expect(stats.words).toBe(9);

    const abstractFrom = doc.toString().indexOf("hidden abstract");
    expect(countWritingStats(doc, abstractFrom, abstractFrom + 21).words).toBe(0);
  });

  test("finds the current heading subtree", () => {
    const state = EditorState.create({
      doc: "# One\nintro\n## Child\nbody\n# Two\ntail",
      extensions: [tocIndexExtension],
    });
    const range = headingSubtreeRange(state, state.doc.toString().indexOf("body"));
    expect(range && state.doc.sliceString(range.from, range.to)).toBe("## Child\nbody\n");
  });
});
