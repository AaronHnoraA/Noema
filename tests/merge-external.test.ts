import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { ChangeSet, Text } from "@codemirror/state";
import { changesConflict, mergeExternalText, textChangeSet } from "../pages/merge-external.ts";

const doc = (s: string) => Text.of(s.split("\n"));
const apply = (changes: ChangeSet, s: string) => changes.apply(doc(s)).toString();

describe("another writer's save merged under unsaved typing", () => {
  const base = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

  test("a line diff reproduces the remote text, one hunk per changed region", () => {
    const remote = base.replace("First paragraph.", "First, rewritten.").replace("Third", "Last");
    const changes = textChangeSet(base, remote)!;
    expect(apply(changes, base)).toBe(remote);
    let hunks = 0;
    changes.iterChanges(() => { hunks++; });
    expect(hunks).toBe(2);
  });

  test("an agent edit elsewhere lands while the person's typing stays", () => {
    const local = ChangeSet.of([{ from: base.indexOf("Second") + 6, insert: " (typing)" }], base.length);
    const remote = base.replace("First paragraph.", "First, by the agent.");
    const merged = mergeExternalText(base, remote, local);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const page = local.apply(doc(base));
    const result = merged.remote.apply(page).toString();
    expect(result).toBe(remote.replace("Second", "Second (typing)"));
    // The person's unsaved changes now sit over the remote text.
    expect(merged.local.apply(doc(remote)).toString()).toBe(result);
  });

  test("typing at the start of the next paragraph is not a conflict", () => {
    const at = base.indexOf("Second");
    const local = ChangeSet.of([{ from: at, insert: "Note: " }], base.length);
    const remote = base.replace("First paragraph.\n", "First, rewritten.\n");
    expect(mergeExternalText(base, remote, local).ok).toBe(true);
  });

  test("both changing the same text is a conflict, and nothing is merged", () => {
    const from = base.indexOf("First");
    const local = ChangeSet.of([{ from, to: from + 5, insert: "Opening" }], base.length);
    const remote = base.replace("First paragraph.", "Agent paragraph.");
    expect(mergeExternalText(base, remote, local)).toEqual({ ok: false, reason: "conflict" });
  });

  test("two insertions at one point conflict", () => {
    const a = ChangeSet.of([{ from: 3, insert: "x" }], 10);
    const b = ChangeSet.of([{ from: 3, insert: "y" }], 10);
    expect(changesConflict(a, b)).toBe(true);
  });

  test("a local change set over another base is refused", () => {
    const local = ChangeSet.of([{ from: 0, insert: "x" }], 3);
    expect(mergeExternalText(base, base + "more\n", local)).toEqual({ ok: false, reason: "mismatch" });
  });

  test("a text without a final newline and unicode survive", () => {
    const b = "α\nβ\nγ";
    const r = "α\nβ changed\nγ";
    expect(apply(textChangeSet(b, r)!, b)).toBe(r);
    expect(apply(textChangeSet("", "new\n")!, "")).toBe("new\n");
    expect(apply(textChangeSet("old\n", "")!, "old\n")).toBe("");
  });

  test("a diff too large to bound is refused rather than stalling the page", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`).join("");
    const other = Array.from({ length: 3000 }, (_, i) => `other ${i}\n`).join("");
    expect(textChangeSet(big, other, 100)).toBeNull();
  });
});
