import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { noteAutoSaveEnabled } from "../aaronnote/save-policy.ts";

describe("note save policy", () => {
  test("keeps local note autosave enabled", () => {
    expect(noteAutoSaveEnabled(false)).toBe(true);
  });

  test("requires explicit save for Remote-backed notes", () => {
    expect(noteAutoSaveEnabled(true)).toBe(false);
  });
});
