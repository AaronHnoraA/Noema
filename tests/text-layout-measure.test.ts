import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

const calls = vi.hoisted(() => ({
  prepare: vi.fn((text: string) => ({ text })),
  layout: vi.fn((prepared: { text: string }, width: number, lineHeight: number) => ({
    lineCount: Math.ceil(prepared.text.length * 8 / width),
    height: Math.ceil(prepared.text.length * 8 / width) * lineHeight,
  })),
  prepareWithSegments: vi.fn((text: string) => ({ text })),
  layoutNextLineRange: vi.fn((prepared: { text: string }, cursor: { segmentIndex: number; graphemeIndex: number }, width: number) => {
    if (cursor.graphemeIndex >= prepared.text.length) return null;
    const end = { segmentIndex: 0, graphemeIndex: Math.min(prepared.text.length, cursor.graphemeIndex + Math.max(1, Math.floor(width / 8))) };
    return { start: cursor, end, width };
  }),
}));
vi.mock("@chenglou/pretext", () => calls);

import { balanceTextColumns, measureTextBlock, measureVariableWidthText, suggestTextColumns } from "../src/text-layout-measure.ts";

describe("shared text layout measurement", () => {
  test("prepares each text/font once and reuses it across widths", async () => {
    const first = await measureTextBlock("A reusable paragraph", "16px Test", 320, 24);
    const second = await measureTextBlock("A reusable paragraph", "16px Test", 240, 24);
    expect(first?.lineCount).toBe(1);
    expect(second?.lineCount).toBe(1);
    expect(calls.prepare).toHaveBeenCalledTimes(1);
    expect(calls.layout).toHaveBeenCalledTimes(2);
  });

  test("invalid or oversized inputs never reach the measurement engine", async () => {
    const before = calls.prepare.mock.calls.length;
    expect(await measureTextBlock("x".repeat(16_385), "16px Test", 320, 24)).toBeNull();
    expect(await measureTextBlock("text", "16px Test", 0, 24)).toBeNull();
    expect(await suggestTextColumns("text", "16px Test", 500, 24)).toBe(2);
    expect(calls.prepare).toHaveBeenCalledTimes(before);
  });

  test("variable-width flow reuses segmented preparation across geometry changes", async () => {
    const first = await measureVariableWidthText("abcdefgh", "16px Test", 24, (line) => line === 0 ? 16 : 32);
    const second = await measureVariableWidthText("abcdefgh", "16px Test", 24, () => 64);
    expect(first).toEqual({ lineCount: 3, height: 72 });
    expect(second).toEqual({ lineCount: 1, height: 24 });
    expect(calls.prepareWithSegments).toHaveBeenCalledTimes(1);
  });

  test("column balancing uses cached estimates and returns normalized tracks", async () => {
    const widths = await balanceTextColumns(["short", "much longer text in the other column ".repeat(3)], "16px Test", 700, 24);
    expect(widths).toHaveLength(2);
    expect(widths![1]).toBeGreaterThan(widths![0]!);
    expect(widths!.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100);
  });
});
