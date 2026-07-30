import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { buildVimJumpLabels, selectJumpCandidates, VIM_JUMP_LABELS } from "../../src/cm6/vim-jump.ts";

// Guards the s-jump ordering contract: matches must be ranked by direction and
// proximity to the cursor BEFORE being capped to the label budget. The previous
// bug capped while scanning the viewport top-down, so a forward (s) jump whose
// cursor sat below a cluster of matches could surface zero forward targets.
describe("selectJumpCandidates", () => {
  // Cursor at 100; many matches above it, a few below.
  const positions = [10, 20, 30, 40, 50, 60, 70, 80, 90, 130, 160, 200];
  const cursor = 100;

  test("forward jump surfaces nearest below-cursor targets first", () => {
    const result = selectJumpCandidates(positions, cursor, 1, 3);
    // Nearest forward (>cursor) in ascending order, regardless of how many
    // above-cursor matches exist.
    expect(result).toEqual([130, 160, 200]);
  });

  test("backward jump surfaces nearest above-cursor targets first", () => {
    const result = selectJumpCandidates(positions, cursor, -1, 3);
    // Nearest backward (<cursor) in descending order.
    expect(result).toEqual([90, 80, 70]);
  });

  test("forward jump falls back to above-cursor matches once below ones run out", () => {
    const result = selectJumpCandidates(positions, cursor, 1, 5);
    expect(result).toEqual([130, 160, 200, 90, 80]);
  });

  test("does not drop nearest target when matches exceed the label budget", () => {
    // 30 below-cursor matches, then one just-below target. With a budget of 26,
    // the just-below target (closest forward) must still be selected first.
    const below = Array.from({ length: 30 }, (_, i) => i + 1); // 1..30, all < cursor
    const justForward = 101;
    const result = selectJumpCandidates([...below, justForward], 100, 1, 26);
    expect(result[0]).toBe(justForward);
  });

  test("uses the same label alphabet as the Emacs avy config without truncating candidates", () => {
    expect(VIM_JUMP_LABELS).toBe("asdfghjklqweruiop");
    const positions = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(selectJumpCandidates(positions, 0, 1)).toHaveLength(positions.length);
  });

  test("builds prefix-free multi-key labels for the whole visible candidate set", () => {
    const labels = buildVimJumpLabels(VIM_JUMP_LABELS.length + 8);
    expect(labels).toHaveLength(VIM_JUMP_LABELS.length + 8);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.some((label) => label.length === 1)).toBe(true);
    expect(labels.some((label) => label.length === 2)).toBe(true);
    for (const label of labels) {
      expect(labels.some((other) => other !== label && other.startsWith(label))).toBe(false);
    }
  });
});
