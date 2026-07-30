import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  collectFindMatches,
  createFindPattern,
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
