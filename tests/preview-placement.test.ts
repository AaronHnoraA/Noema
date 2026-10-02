import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { previewPlacement, type FloatingBox } from "../aaronnote/preview-placement.ts";

const viewport = { width: 1000, height: 600 };
const source = { top: 20, bottom: 40 };
function separated(a: FloatingBox, b: FloatingBox): boolean {
  return a.left + a.width <= b.left || b.left + b.width <= a.left
    || a.top + a.height <= b.top || b.top + b.height <= a.top;
}

describe("formula preview beside completion", () => {
  test("keeps separate windows still, including a long formula anchored far from its caret", () => {
    const preview = { left: 390, top: 210, width: 600, height: 100 };
    const menu = { left: 1390, top: 200, width: 340, height: 240 };
    expect(previewPlacement(preview, menu, { width: 2048, height: 530 }, { top: 165, bottom: 190 }))
      .toEqual({ left: 390, top: 210 });
  });

  test.each([
    [{ left: 100, top: 50, width: 380, height: 100 }, { left: 100, top: 50, width: 340, height: 240 }, source],
    [{ left: 100, top: 350, width: 380, height: 100 }, { left: 100, top: 300, width: 340, height: 240 }, { top: 550, bottom: 575 }],
    [{ left: 100, top: 100, width: 200, height: 320 }, { left: 100, top: 100, width: 340, height: 240 }, { top: 50, bottom: 90 }],
  ] as const)("moves an overlapping preview into free space: %j", (preview, menu, band) => {
    const position = previewPlacement(preview, menu, viewport, band);
    expect(position).not.toBeNull();
    const next = { ...preview, ...position! };
    expect(separated(next, menu)).toBe(true);
    expect(next.top + next.height <= band.top || next.top >= band.bottom).toBe(true);
    expect(next.left).toBeGreaterThanOrEqual(8);
    expect(next.top).toBeGreaterThanOrEqual(8);
    expect(next.left + next.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(next.top + next.height).toBeLessThanOrEqual(viewport.height - 8);
  });

  test("suppresses only when no space exists, and immediately restores the preferred position when completion closes", () => {
    const preview = { left: 8, top: 50, width: 380, height: 120 };
    const menu = { left: 8, top: 50, width: 340, height: 240 };
    const small = { width: 400, height: 300 };
    expect(previewPlacement(preview, menu, small, source)).toBeNull();
    expect(previewPlacement(preview, null, small, source)).toEqual({ left: 8, top: 50 });
  });

  test("rechecks an async formula size change without moving the menu", () => {
    const menu = { left: 450, top: 50, width: 340, height: 240 };
    const small = { left: 100, top: 50, width: 200, height: 100 };
    expect(previewPlacement(small, menu, viewport, source)).toEqual({ left: 100, top: 50 });
    const large = { ...small, width: 600 };
    const next = previewPlacement(large, menu, viewport, source);
    expect(next).not.toBeNull();
    expect(separated({ ...large, ...next! }, menu)).toBe(true);
    expect(menu).toEqual({ left: 450, top: 50, width: 340, height: 240 });
  });
});
