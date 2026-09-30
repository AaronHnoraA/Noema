import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorState } from "@codemirror/state";
import { fencedCodeRangesExtension } from "../src/cm6/code-ranges.ts";
import {
  getOrgEnvBlockIdentities,
  orgEnvBlocksExtension,
} from "../src/cm6/extensions/visual/widgets/block-extras.ts";

const ID_A = "0198fbac-0780-7c99-85e6-111111111111";
const ID_B = "0198fbac-0780-7c99-85e6-222222222222";

describe("org environment index after fence edits", () => {
  test("regional update matches a fresh scan across nested blocks", () => {
    const extensions = [fencedCodeRangesExtension, orgEnvBlocksExtension];
    let state = EditorState.create({
      doc: [
        `#+begin theorem Outer {#${ID_A}}`,
        "Opening prose.",
        `#+begin proof Inner {#${ID_B}}`,
        "Details.",
        "#+end proof",
        "Final prose.",
        "#+end theorem",
        "Afterward.",
      ].join("\n"),
      extensions,
    });
    const edit = (from: number, to: number, insert: string) => {
      state = state.update({ changes: { from, to, insert } }).state;
      const fresh = EditorState.create({ doc: state.doc.toString(), extensions });
      expect(getOrgEnvBlockIdentities(state)).toEqual(getOrgEnvBlockIdentities(fresh));
    };
    const inside = state.doc.toString().indexOf("Opening prose.");
    edit(inside, inside, "```\n");
    const close = state.doc.toString().indexOf("Final prose.");
    edit(close, close, "```\n");
    edit(inside, inside + 4, "");
    const remaining = state.doc.toString().indexOf("```\n");
    edit(remaining, remaining + 4, "");
  });
});
