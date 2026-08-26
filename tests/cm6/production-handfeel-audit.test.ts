import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { auditProductionHandfeel } from "../../src/cm6/production-handfeel-audit.ts";

describe("packaged production handfeel audit", () => {
  test("exercises isolated production CM6 behavior and removes its scratch editor", () => {
    const sentinel = document.createElement("div");
    sentinel.dataset.productionNote = "untouched";
    sentinel.textContent = "live note sentinel";
    document.body.append(sentinel);

    const report = auditProductionHandfeel(document);

    expect(report).toEqual({
      installed: true,
      scratchOnly: true,
      orderedListEnter: true,
      bracketCompletion: true,
      bracketTypeOver: true,
      selectionWrapping: true,
      unicodeGraphemeDelete: true,
      undoRedo: true,
      programmaticLoadPreservesNumbers: true,
      passed: true,
    });
    expect(document.querySelector("[data-noema-production-handfeel-audit]")).toBeNull();
    expect(sentinel.textContent).toBe("live note sentinel");
    sentinel.remove();
  });
});
