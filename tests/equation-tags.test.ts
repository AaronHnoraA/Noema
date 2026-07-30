import { EditorState } from "@codemirror/state";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { equationTagsFromText, getEquationTagHits } from "../src/equation-tags.ts";

describe("equation tag scanning", () => {
  test("finds display math tag ranges in CM6 source offsets", () => {
    const markdown = String.raw`intro
\[
x \tag{ eq:1 }
\]
outro`;
    const state = EditorState.create({ doc: markdown });
    const hit = getEquationTagHits(state)[0]!;

    expect(hit.tag).toBe("eq:1");
    expect(hit.from).toBe(markdown.indexOf("eq:1"));
    expect(hit.to).toBe(hit.from + "eq:1".length);
    expect(hit.blockPos).toBe(markdown.indexOf("\\["));
  });

  test("extracts tag suggestions from arbitrary TeX text", () => {
    expect(equationTagsFromText(String.raw`x \tag{a} + y \tag{ b }`)).toEqual(["a", "b"]);
  });
});
