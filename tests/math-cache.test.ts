import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { clearMathRenderCache, mathRenderCacheSize, renderMathLazy } from "../src/math-render.ts";

describe("math render cache", () => {
  test("caps cached render html", () => {
    clearMathRenderCache();
    for (let i = 0; i < 600; i++) {
      const el = document.createElement("span");
      document.body.appendChild(el);
      renderMathLazy(`x_${i}`, el, { displayMode: false, throwOnError: false }, () => {});
      el.remove();
    }
    expect(mathRenderCacheSize()).toBeLessThanOrEqual(512);
    clearMathRenderCache();
  });
});
