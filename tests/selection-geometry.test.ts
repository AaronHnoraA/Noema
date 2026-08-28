import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { unionSelectionRect } from "../aaronnote/selection-geometry.ts";

function rect(left: number, top: number, right: number, bottom: number) {
  return { left, top, right, bottom };
}

describe("unionSelectionRect", () => {
  test("spans every painted line of a multi-line selection", () => {
    const result = unionSelectionRect([
      rect(120, 40, 300, 58),
      rect(20, 58, 310, 76),
      rect(20, 76, 90, 94),
    ]);
    expect(result).not.toBeNull();
    expect({
      left: result!.left,
      top: result!.top,
      width: result!.width,
      height: result!.height,
    }).toEqual({ left: 20, top: 40, width: 290, height: 54 });
  });

  // drawSelection leaves a zero-size box for the cursor; it is not extent.
  test("ignores collapsed boxes", () => {
    const result = unionSelectionRect([rect(50, 10, 50, 10), rect(60, 20, 140, 38)]);
    expect(result).not.toBeNull();
    expect({ left: result!.left, top: result!.top, width: result!.width }).toEqual({
      left: 60,
      top: 20,
      width: 80,
    });
  });

  test("reports nothing when there is nothing painted", () => {
    expect(unionSelectionRect([])).toBeNull();
    expect(unionSelectionRect([rect(4, 4, 4, 4)])).toBeNull();
  });

  test("keeps a zero-height caret-line box that still has width", () => {
    const result = unionSelectionRect([rect(10, 30, 90, 30)]);
    expect(result).not.toBeNull();
    expect({ width: result!.width, height: result!.height }).toEqual({ width: 80, height: 0 });
  });
});
