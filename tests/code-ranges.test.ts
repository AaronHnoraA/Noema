import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorState } from "@codemirror/state";
import {
  fencedCodeRangesExtension,
  getFencedCodeRanges,
  scanFencedCodeRangesInDoc,
} from "../src/cm6/code-ranges.ts";

describe("fenced code range updates", () => {
  test("regional edits match a full scan across openers, closers, and deletions", () => {
    let state = EditorState.create({
      doc: [
        "intro", "```js", "code", "```", "outside", "~~~", "more code", "~~~", "tail",
      ].join("\n"),
      extensions: [fencedCodeRangesExtension],
    });
    const edit = (from: number, to: number, insert: string) => {
      state = state.update({ changes: { from, to, insert } }).state;
      expect(getFencedCodeRanges(state)).toEqual(scanFencedCodeRangesInDoc(state.doc));
    };
    const language = state.doc.toString().indexOf("```js") + 5;
    edit(language, language, "x");
    edit(state.doc.toString().indexOf("outside"), state.doc.toString().indexOf("outside"), "```");
    edit(state.doc.toString().indexOf("code"), state.doc.toString().indexOf("code"), "```\n");
    const oldClose = state.doc.toString().indexOf("~~~", state.doc.toString().indexOf("more code"));
    edit(oldClose, oldClose + 3, "~~~extra");
    const firstOpen = state.doc.toString().indexOf("```js");
    edit(firstOpen, firstOpen + 3, "~~~");
  });

  test("two edits on one line can jointly create a fence", () => {
    let state = EditorState.create({
      doc: "`\n| A | B |\n| --- | --- |\n| x | y |\n",
      extensions: [fencedCodeRangesExtension],
    });
    state = state.update({ changes: [
      { from: 0, insert: "`" },
      { from: 1, insert: "`" },
    ] }).state;
    expect(getFencedCodeRanges(state)).toEqual(scanFencedCodeRangesInDoc(state.doc));
  });
});
