import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  isPersistedNoemaId,
  isUuidV7,
  newNoemaId,
  normalizeNoemaIdKind,
} from "../shared/identity.mjs";

describe("Noema identity", () => {
  test("creates portable UUIDv7 values for repositories, pages, and blocks", () => {
    const ids = (["repository", "page", "block"] as const).map((kind) => newNoemaId(kind));
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(isUuidV7(id)).toBe(true);
      expect(isPersistedNoemaId(id)).toBe(true);
    }
  });

  test("normalizes only persisted identity kinds", () => {
    expect(normalizeNoemaIdKind(" PAGE ")).toBe("page");
    expect(() => normalizeNoemaIdKind("note")).toThrow("Unsupported Noema identity kind");
    expect(isPersistedNoemaId("tensor-id")).toBe(true);
    expect(isPersistedNoemaId("")).toBe(false);
  });
});
