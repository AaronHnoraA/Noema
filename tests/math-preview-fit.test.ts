import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { mathPreviewFitScale } from "../aaronnote/math-preview-fit.ts";

describe("math preview fitting", () => {
  test("keeps formulas at natural size when both dimensions fit", () => {
    expect(mathPreviewFitScale(600, 300, 500, 200)).toBe(1);
  });

  test("scales a wide formula to the available width", () => {
    expect(mathPreviewFitScale(500, 300, 1000, 200)).toBe(0.5);
  });

  test("uses the stricter dimension for a large display formula", () => {
    expect(mathPreviewFitScale(500, 200, 1000, 800)).toBe(0.25);
  });

  test("ignores incomplete measurements during initial layout", () => {
    expect(mathPreviewFitScale(0, 200, 500, 100)).toBe(1);
  });
});
