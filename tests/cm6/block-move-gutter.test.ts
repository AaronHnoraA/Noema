/** The drag gutter's cheap start test agrees with the full block scan. */

import { describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { blockBeginningAtLine, blockStartAtLine } from "../../src/cm6/block-move.ts";

function agree(doc: string): void {
  const state = EditorState.create({ doc });
  for (let line = 1; line <= state.doc.lines; line++) {
    expect([line, blockStartAtLine(state, line)]).toEqual([line, blockBeginningAtLine(state, line)?.kind ?? null]);
  }
}

describe("block drag gutter", () => {
  it("matches the full scan on mixed content", () => {
    agree([
      "---", "title: x", "---", "", "# H", "para", "more", "", "- a", "  - b", "1. c", "",
      "```js", "x", "```", "", "\\[", "x", "\\]", "", "#+begin note", "y", "#+end note", "",
      "| a | b |", "|-|:-:|", "| 1 | 2 |", "", "@@cell(python)", "", "| lone |", "## H2", "text",
    ].join("\n"));
  });

  it("matches the full scan on a real note slice", () => {
    agree(readFileSync("tests/synthetic_qc_note_5mb.md", "utf8").slice(0, 60_000));
  });
});
