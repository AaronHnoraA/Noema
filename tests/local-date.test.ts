import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { todayDateValue } from "../shared/planning-values.mjs";

describe("today's date", () => {
  test("is the author's calendar date, not the UTC one", () => {
    // Built from local fields, so the expectation holds in every timezone.
    // East of Greenwich the UTC date of the first is still the previous day.
    expect(todayDateValue(new Date(2026, 0, 5, 0, 30).getTime())).toBe("2026-01-05");
    expect(todayDateValue(new Date(2026, 0, 5, 23, 30).getTime())).toBe("2026-01-05");
    expect(todayDateValue(new Date(2026, 11, 31, 9, 0).getTime())).toBe("2026-12-31");
  });

  test("defaults to now", () => {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    expect(todayDateValue())
      .toBe(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  });
});
