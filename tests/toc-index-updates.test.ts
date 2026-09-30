import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorState } from "@codemirror/state";
import { readFileSync } from "node:fs";
import { tocIndexExtension, tocIndexFromState, tocIndexSourceLinesScanned } from "../src/cm6/toc-index.ts";

describe("Markdown outline updates", () => {
  test("fence edits preserve exactly the headings, tags, and ranges of a full parse", () => {
    let state = EditorState.create({
      doc: [
        "# Before", "@@tag(alpha)", "```js", "# Hidden", "```", "# Middle",
        "@@part(Research)", "~~~", "@@tag(hidden)", "~~~", "# After",
      ].join("\n"),
      extensions: [tocIndexExtension],
    });
    const edit = (from: number, to: number, insert: string) => {
      state = state.update({ changes: { from, to, insert } }).state;
      const fresh = EditorState.create({ doc: state.doc.toString(), extensions: [tocIndexExtension] });
      expect(tocIndexFromState(state)).toEqual(tocIndexFromState(fresh));
    };
    const language = state.doc.toString().indexOf("```js") + 5;
    edit(language, language, "x");
    const atMiddle = state.doc.toString().indexOf("# Middle");
    edit(atMiddle, atMiddle, "```\n");
    const atAfter = state.doc.toString().indexOf("# After");
    edit(atAfter, atAfter, "@@tag(beta)\n");
    const firstFence = state.doc.toString().indexOf("```js");
    edit(firstFence, firstFence + 3, "~~~");
    const laterFence = state.doc.toString().lastIndexOf("~~~");
    edit(laterFence, laterFence + 1, "");
    edit(state.doc.toString().indexOf("# Before"), state.doc.toString().indexOf("# Before"), "# ");
  });

  test("a fence edit in the 5 MB note scans only its affected suffix", () => {
    const content = readFileSync("tests/synthetic_qc_note_5mb.md", "utf8");
    let state = EditorState.create({ doc: content, extensions: [tocIndexExtension] });
    const line = state.doc.line(Math.floor(state.doc.lines / 2));
    const before = tocIndexSourceLinesScanned();
    state = state.update({ changes: { from: line.from, insert: "```\n" } }).state;
    expect(tocIndexSourceLinesScanned() - before).toBeLessThan(state.doc.lines * 0.6);
    const fresh = EditorState.create({ doc: state.doc.toString(), extensions: [tocIndexExtension] });
    expect(tocIndexFromState(state)).toEqual(tocIndexFromState(fresh));
  }, 20_000);

  test("mixed nearby Markdown edits keep the incremental outline exact", () => {
    let state = EditorState.create({
      doc: "# A\nplain `code`\n```ts\n# hidden\n```\n@@section(Proof)\n@@tag(one)\n# B\n",
      extensions: [tocIndexExtension],
    });
    const inserts = ["x", "`", "```", "\n", "#", "@@part", "~", "~~~\n", " "];
    for (let step = 0; step < 60; step += 1) {
      const from = (step * 37) % (state.doc.length + 1);
      const to = Math.min(state.doc.length, from + (step % 6 === 0 ? 2 : 0));
      state = state.update({ changes: { from, to, insert: inserts[step % inserts.length]! } }).state;
      const fresh = EditorState.create({ doc: state.doc.toString(), extensions: [tocIndexExtension] });
      expect(tocIndexFromState(state)).toEqual(tocIndexFromState(fresh));
    }
  });

  test("removing the last semantic heading restores Markdown levels", () => {
    let state = EditorState.create({
      doc: "# Before\n@@part(Research)\n# After\n",
      extensions: [tocIndexExtension],
    });
    const from = state.doc.toString().indexOf("@@part") + "@@par".length;
    state = state.update({ changes: { from, to: from + 1 } }).state;
    const fresh = EditorState.create({ doc: state.doc.toString(), extensions: [tocIndexExtension] });
    expect(tocIndexFromState(state)).toEqual(tocIndexFromState(fresh));
  });
});
