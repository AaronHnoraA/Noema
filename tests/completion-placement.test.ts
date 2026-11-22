import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { completionPlacement } from "../pages/preview-placement.ts";

const viewport = { width: 1000, height: 600 };

describe("completion list beside the caret", () => {
  test("goes below when its maximum height fits there", () => {
    const placed = completionPlacement({ left: 100, top: 100, bottom: 120 }, { width: 340, height: 80, maxHeight: 240 }, viewport);
    expect(placed).toEqual({ left: 100, top: 128, width: 340, side: "below" });
  });

  test("near the bottom it goes above, with its bottom edge on the caret line", () => {
    const placed = completionPlacement({ left: 100, top: 480, bottom: 500 }, { width: 340, height: 120, maxHeight: 240 }, viewport);
    expect(placed.side).toBe("above");
    expect(placed.top + 120).toBe(480 - 8);
  });

  test("a list that shrinks or grows while typing never hops across the caret", () => {
    const caret = { left: 100, top: 400, bottom: 420 };
    // Small lists would fit below, but the maximum does not: start above.
    let side = completionPlacement(caret, { width: 340, height: 40, maxHeight: 240 }, viewport).side;
    expect(side).toBe("above");
    for (const height of [240, 32, 160, 64, 240]) {
      side = completionPlacement(caret, { width: 340, height, maxHeight: 240 }, viewport, side).side;
      expect(side).toBe("above");
    }
  });

  test("keeps below while the list still fits, even after it grows past the reserve check", () => {
    const caret = { left: 100, top: 300, bottom: 320 };
    const first = completionPlacement(caret, { width: 340, height: 60, maxHeight: 240 }, viewport);
    expect(first.side).toBe("below");
    expect(completionPlacement(caret, { width: 340, height: 240, maxHeight: 240 }, viewport, first.side).side).toBe("below");
  });

  test("stays inside a narrow viewport", () => {
    const placed = completionPlacement({ left: 280, top: 100, bottom: 120 }, { width: 340, height: 80, maxHeight: 240 }, { width: 300, height: 600 });
    expect(placed.width).toBe(284);
    expect(placed.left).toBe(8);
  });
});

describe("completion option geometry", () => {
  test("the active marker is pinned, so selection never changes a row's height", () => {
    const css = readFileSync(resolve(process.cwd(), "pages/style.css"), "utf8");
    const rule = css.slice(css.indexOf(".noema-snippet-option.is-active::after"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toMatch(/grid-column:\s*4/);
    expect(body).toMatch(/grid-row:\s*1/);
  });
});
