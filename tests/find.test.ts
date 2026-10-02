import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  collectFindMatches,
  createFindPattern,
  smartCaseSensitive,
  findMatchIndexFrom,
  escapeFindQuery,
  replacementText,
  replaceAllFindMatches,
} from "../aaronnote/find.ts";

describe("find helpers", () => {
  test("escapes plain text queries", () => {
    expect(escapeFindQuery("a.b [x]")).toBe(String.raw`a\.b \[x\]`);
    const result = createFindPattern("a.b", false);
    expect(result.pattern?.test("a.b axb")).toBe(true);
    expect(result.pattern?.test("axb")).toBe(false);
  });

  test("reports invalid regex queries", () => {
    const result = createFindPattern("[", true);
    expect(result.pattern).toBeNull();
    expect(result.error).toBeTruthy();
  });

  test("collects global matches with source ranges", () => {
    const pattern = createFindPattern("todo", false).pattern;
    expect(collectFindMatches("todo x todo", pattern).map((match) => [match.from, match.to])).toEqual([
      [0, 4],
      [7, 11],
    ]);
  });

  test("expands regex replacement captures", () => {
    const pattern = createFindPattern("(a)(b)", true).pattern!;
    const [match] = collectFindMatches("ab", pattern);
    expect(replacementText(match!.match, "$2$1-$&-$$", true)).toBe("ba-ab-$");
  });

  test("replace all keeps plain and regex replacement semantics separate", () => {
    const plain = createFindPattern("$1", false).pattern!;
    expect(replaceAllFindMatches("a $1 b $1", plain, "x", false)).toBe("a x b x");

    const regex = createFindPattern("(todo):(\\d+)", true).pattern!;
    expect(replaceAllFindMatches("todo:1 todo:2", regex, "$2-$1", true)).toBe("1-todo 2-todo");
  });
});

describe("find options", () => {
  const text = "Noema noema NOEMA noemaX café Café";

  test("smart case ignores case until the query has an uppercase letter", () => {
    expect(collectFindMatches(text, createFindPattern("noema").pattern).length).toBe(4);
    expect(collectFindMatches(text, createFindPattern("Noema").pattern).map((m) => m.from)).toEqual([0]);
    expect(collectFindMatches(text, createFindPattern("café").pattern).length).toBe(2);
  });

  test("a regex class escape does not count as an uppercase letter", () => {
    expect(smartCaseSensitive("\\Snoema", true)).toBe(false);
    expect(smartCaseSensitive("\\Snoema", false)).toBe(true);
  });

  test("match case is exact", () => {
    expect(collectFindMatches(text, createFindPattern("noema", { caseSensitive: true }).pattern).map((m) => m.from)).toEqual([6, 18]);
  });

  test("whole word respects letters of every script", () => {
    const words = collectFindMatches(text, createFindPattern("noema", { wholeWord: true }).pattern).map((m) => m.from);
    expect(words).toEqual([0, 6, 12]);
    expect(collectFindMatches("x café y cafés", createFindPattern("café", { wholeWord: true }).pattern).map((m) => m.from)).toEqual([2]);
  });

  test("a regex valid only without unicode mode still runs", () => {
    const result = createFindPattern("a\\-b", { regex: true });
    expect(result.error).toBeUndefined();
    expect(collectFindMatches("a-b", result.pattern).length).toBe(1);
  });
});

describe("replace continuation", () => {
  test("the next match starts after a replacement that itself matches", () => {
    const after = "aa b a";
    const matches = collectFindMatches(after, createFindPattern("a").pattern);
    expect(findMatchIndexFrom(matches, 2)).toBe(2);
    expect(matches[2]!.from).toBe(5);
    expect(findMatchIndexFrom(matches, 6)).toBe(-1);
    expect(findMatchIndexFrom(collectFindMatches("aa", createFindPattern("a").pattern), 2)).toBe(-1);
  });
});
