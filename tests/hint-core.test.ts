import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  endsWithMultiCharHintPrefix,
  findHintTrigger,
  findSlashHint,
  getBlockHintTriggerOffset,
  getBlockRefStaticText,
  normalizeHintMenuSeparators,
  reorderHintEntrySlots,
  resolveHintMenuItems,
  shouldIgnoreHintTrigger,
  type HintMenuItem,
} from "../src/hint-core.ts";

type Item = HintMenuItem & { value: string };
const entry = (entryKey: string, filter: string[] = [entryKey]): Item => ({ entryKey, filter, value: entryKey });
const separator = (entryKey: string): Item => ({ entryKey, separator: true, value: "" });

describe("hint menu ordering and filtering", () => {
  test("reorders known slots without moving plugin slots", () => {
    expect(reorderHintEntrySlots(
      [entry("a"), entry("plugin"), entry("b"), separator("separator")],
      ["b", "separator", "a"],
    ).map((item) => item.entryKey)).toEqual(["b", "plugin", "separator", "a"]);
  });

  test("deduplicates, applies visibility and multilingual filters, and repairs separators", () => {
    const items = [
      separator("s0"),
      entry("heading", ["Heading", "标题", "biaoti"]),
      entry("heading", ["duplicate"]),
      separator("s1"),
      entry("table", ["Table", "表格", "biaoge"]),
      separator("s2"),
    ];
    expect(resolveHintMenuItems(items, {
      query: "biaoTI",
      visible: (key) => key !== "table",
    }).map((item) => item.entryKey)).toEqual(["heading"]);
    expect(resolveHintMenuItems(items, { enabled: false })).toEqual([]);
  });

  test("normalizes leading, trailing, consecutive, and newly empty groups", () => {
    const items = [separator("s1"), entry("a"), separator("s2"), separator("s3"), entry("b"), separator("s4")];
    expect(normalizeHintMenuSeparators(items).map((item) => item.entryKey)).toEqual(["a", "s2", "b"]);
    expect(resolveHintMenuItems(items, {
      visible: (key) => key === "b",
    }).map((item) => item.entryKey)).toEqual(["b"]);
  });
});

describe("multi-character hint boundaries", () => {
  test("uses the correct overlapping trigger around existing closing markers", () => {
    expect(getBlockHintTriggerOffset("[[[", "]]", "[[", "]]")).toBe(1);
    expect(getBlockHintTriggerOffset("[[[query", "", "[[", "]]")).toBe(0);
    expect(getBlockHintTriggerOffset("[[[query", "]]", "[[", "]]")).toBe(1);
  });

  test("keeps toolbar text and strips inline triggers only when requested", () => {
    expect(getBlockRefStaticText("((literal", "((", false)).toBe("((literal");
    expect(getBlockRefStaticText("((query", "((", true)).toBe("query");
  });

  test("protects block and tag sessions from lower-priority triggers", () => {
    const blockKeys = ["((", "[[", "{{"];
    expect(shouldIgnoreHintTrigger("((", "/", blockKeys)).toBe(true);
    expect(shouldIgnoreHintTrigger("[[", "#", blockKeys)).toBe(true);
    expect(shouldIgnoreHintTrigger("#", "、", blockKeys)).toBe(true);
    expect(shouldIgnoreHintTrigger("", "、", blockKeys)).toBe(false);
    expect(endsWithMultiCharHintPrefix("query[", ["[[", "{{", "/"])).toBe(true);
  });

  test("finds the right-most trigger and preserves closed block-hint edits", () => {
    const match = findHintTrigger("prefix ((old / new", "))tail", [
      { key: "((", close: "))", kind: "block" },
      { key: "/", kind: "slash" },
    ], "((");
    expect(match).toMatchObject({ key: "((", query: "old / new", offset: 7 });
  });
});

describe("slash hint context", () => {
  test("supports slash and Chinese enumeration comma at source boundaries", () => {
    expect(findSlashHint("/head", "")).toMatchObject({ key: "/", query: "head", deleteBefore: 5 });
    expect(findSlashHint("paragraph 、biaoti", "")).toMatchObject({ key: "、", query: "biaoti" });
  });

  test("does not steal URL/path slashes or escaped literals", () => {
    expect(findSlashHint("https://noema.test", "")).toBeNull();
    expect(findSlashHint("folder/file", "")).toBeNull();
    expect(findSlashHint("\\/literal", "")).toBeNull();
  });

  test("limits matching to the current line", () => {
    expect(findSlashHint("/old\nplain", "")).toBeNull();
    expect(findSlashHint("/old\n  /new", "")).toMatchObject({ query: "new", offset: 2 });
  });
});
