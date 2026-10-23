import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { wikiLinkCompletionContext } from "../pages/wiki-completion.ts";
import { qualifiedWikiTitle, splitQualifiedWikiTarget, splitWantedWikiTarget } from "../shared/wiki-link.mjs";

describe("Wiki editor completion", () => {
  test("parses logical and fully qualified Wiki targets", () => {
    expect(splitQualifiedWikiTarget("Math:Tensor")).toEqual({
      target: "Math:Tensor", namespace: "Math", title: "Tensor", qualified: true,
    });
    expect(splitQualifiedWikiTarget("public/Math:Tensor").namespace).toBe("public/Math");
    expect(qualifiedWikiTitle("Research / Physics", "Hilbert Space")).toBe("Research/Physics:Hilbert Space");
  });

  test("reads a prose colon in a wanted title as part of the title", () => {
    const known = ["Math", "public/Math", "定理"];
    expect(splitWantedWikiTarget("Research:Page", known)).toMatchObject({ qualified: true, namespace: "Research", title: "Page" });
    expect(splitWantedWikiTarget("Chapter 1: Scope", known)).toEqual({
      target: "Chapter 1: Scope", namespace: "", title: "Chapter 1: Scope", qualified: false,
    });
    expect(splitWantedWikiTarget("引理：存在性", known)).toMatchObject({ qualified: false, title: "引理：存在性" });
    // A namespace that exists keeps its meaning whatever follows the colon.
    expect(splitWantedWikiTarget("math: Tensor", known)).toMatchObject({ qualified: true, namespace: "math", title: "Tensor" });
    expect(splitWantedWikiTarget("定理：存在性", known)).toMatchObject({ qualified: true, namespace: "定理", title: "存在性" });
    expect(splitWantedWikiTarget("Plain", known)).toMatchObject({ qualified: false, title: "Plain" });
  });

  test("recognizes an unfinished Wiki link", () => {
    expect(wikiLinkCompletionContext("See [[E", "")).toEqual({ prefix: "E", hasClosingDelimiter: false });
  });

  test("recognizes a cursor inside a pre-typed pair", () => {
    expect(wikiLinkCompletionContext("See [[E", "]] later")).toEqual({ prefix: "E", hasClosingDelimiter: true });
  });

  test("does not complete after a closed link", () => {
    expect(wikiLinkCompletionContext("See [[Emacs]]", "")).toBeNull();
  });
});
