import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  mapPositionAcrossText,
  minimalDocumentChange,
} from "../src/cm6/viewport-stability.ts";

describe("CM6 viewport position mapping", () => {
  test("maps a position through an insertion before the visible content", () => {
    const source = "alpha\nbeta\ngamma\n";
    const target = "new heading\nalpha\nbeta\ngamma\n";
    const position = source.indexOf("beta") + 2;

    expect(mapPositionAcrossText(source, target, position)).toBe(
      target.indexOf("beta") + 2,
    );
  });

  test("uses local context when several distant edits span the viewport", () => {
    const visible = "the uniquely visible paragraph remains exactly where the reader left it";
    const source = `old heading\n\n${visible}\n\nold footer`;
    const target = `a longer replacement heading\n\n${visible}\n\na completely different footer`;
    const position = source.indexOf("visible paragraph") + 9;

    expect(mapPositionAcrossText(source, target, position)).toBe(
      target.indexOf("visible paragraph") + 9,
    );
  });

  test("builds a minimal contiguous document transaction", () => {
    expect(minimalDocumentChange("prefix old suffix", "prefix new suffix")).toEqual({
      from: 7,
      to: 10,
      insert: "new",
    });
    expect(minimalDocumentChange("same", "same")).toBeNull();
  });
});
