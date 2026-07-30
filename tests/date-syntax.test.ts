import { describe, test, expect, beforeAll, vi, afterAll } from "@voidzero-dev/vite-plus-test";
import {
  formatDateValue,
  normalizeDateValue,
  parseDateValue,
  relativeDateClass,
  relativeDateLabel,
} from "../src/date-syntax.ts";

describe("date-syntax: parseDateValue", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 20, 12, 0, 0));
  });
  afterAll(() => vi.useRealTimers());

  test("ISO with and without time", () => {
    expect(normalizeDateValue("2026-05-21")).toBe("2026-05-21");
    expect(normalizeDateValue("2026-5-21")).toBe("2026-05-21");
    expect(normalizeDateValue("2026-05-21 14:30")).toBe("2026-05-21 14:30");
    expect(normalizeDateValue("2026-05-21T14:30")).toBe("2026-05-21 14:30");
  });

  test("slash / dot separators", () => {
    expect(normalizeDateValue("2026/05/21")).toBe("2026-05-21");
    expect(normalizeDateValue("2026.05.21")).toBe("2026-05-21");
    expect(normalizeDateValue("2026/5/21 9:05")).toBe("2026-05-21 09:05");
  });

  test("CJK 年/月/日", () => {
    expect(normalizeDateValue("2026年5月21日")).toBe("2026-05-21");
    expect(normalizeDateValue("2026年5月21号")).toBe("2026-05-21");
  });

  test("M-D shorthand assumes current year", () => {
    expect(normalizeDateValue("5/21")).toBe("2026-05-21");
    expect(normalizeDateValue("5-21")).toBe("2026-05-21");
    expect(normalizeDateValue("5.21 14:30")).toBe("2026-05-21 14:30");
  });

  test("relative keywords", () => {
    expect(normalizeDateValue("today")).toBe("2026-05-20");
    expect(normalizeDateValue("tomorrow")).toBe("2026-05-21");
    expect(normalizeDateValue("yesterday")).toBe("2026-05-19");
    expect(normalizeDateValue("今天")).toBe("2026-05-20");
    expect(normalizeDateValue("明天")).toBe("2026-05-21");
  });

  test("relative offsets", () => {
    expect(normalizeDateValue("+3d")).toBe("2026-05-23");
    expect(normalizeDateValue("+2w")).toBe("2026-06-03");
    expect(normalizeDateValue("-1d")).toBe("2026-05-19");
    expect(normalizeDateValue("+1m")).toBe("2026-06-20");
  });

  test("garbage returns null", () => {
    expect(normalizeDateValue("")).toBeNull();
    expect(normalizeDateValue("notadate")).toBeNull();
  });

  test("relativeDateClass", () => {
    expect(relativeDateClass(parseDateValue("2026-05-19")!.time)).toBe("overdue");
    expect(relativeDateClass(parseDateValue("today")!.time)).toBe("today");
    expect(relativeDateClass(parseDateValue("+3d")!.time)).toBe("soon");
    expect(relativeDateClass(parseDateValue("+30d")!.time)).toBe("future");
  });

  test("relativeDateLabel", () => {
    expect(relativeDateLabel(parseDateValue("today")!.time)).toBe("today");
    expect(relativeDateLabel(parseDateValue("tomorrow")!.time)).toBe("tomorrow");
    expect(relativeDateLabel(parseDateValue("-2d")!.time)).toBe("2d ago");
    expect(relativeDateLabel(parseDateValue("+3d")!.time)).toBe("in 3d");
  });

  test("formatDateValue respects hasTime", () => {
    const t = parseDateValue("2026-05-21 09:05")!;
    expect(formatDateValue(t.time, t.hasTime)).toBe("2026-05-21 09:05");
    expect(formatDateValue(t.time, false)).toBe("2026-05-21");
  });
});
