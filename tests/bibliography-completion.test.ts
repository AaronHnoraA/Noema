import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  citeKeyCompletionContext,
  citeKeyRenderPrefix,
  citeNamespaceCompletionPrefix,
  citeNamespaceRenderPrefix,
} from "../aaronnote/bibliography-completion.ts";

describe("bibliography completion context", () => {
  test("recognizes namespace completion from a bounded cursor tail", () => {
    const before = `${"long paragraph ".repeat(100)}@@cite(project/UNSW`;
    const bounded = before.slice(-320);
    expect(citeNamespaceCompletionPrefix(bounded)).toBe("project/UNSW");
  });

  test("recognizes the current key after semicolon-separated keys", () => {
    expect(citeKeyCompletionContext("text @@cite(iso) [Str87; Iv")).toEqual({
      namespace: "iso",
      separator: " ",
      prefix: "Iv",
    });
  });

  test("recognizes key completion without a space before the bracket", () => {
    const context = citeKeyCompletionContext("text @@cite(iso)[Str");
    expect(context).toEqual({
      namespace: "iso",
      separator: "",
      prefix: "Str",
    });
    expect(context && citeKeyRenderPrefix(context)).toBe("@@cite(iso)[Str");
  });

  test("accepts uppercase cite spelling but rejects an escaped command", () => {
    expect(citeNamespaceCompletionPrefix("text @@CITE(project/UNSW")).toBe("project/UNSW");
    expect(citeKeyCompletionContext("text @@CITE(iso)[Str")).toEqual({
      namespace: "iso",
      separator: "",
      prefix: "Str",
    });
    expect(citeNamespaceCompletionPrefix(String.raw`text \@@cite(iso`)).toBeNull();
    expect(citeKeyCompletionContext(String.raw`text \@@cite(iso)[Str`)).toBeNull();
    expect(citeKeyCompletionContext(String.raw`text \\@@cite(iso)[Str`)).toMatchObject({ prefix: "Str" });
  });

  test("does not treat a completed citation as an active completion", () => {
    expect(citeNamespaceCompletionPrefix("@@cite(iso) [Str87]")).toBeNull();
    expect(citeKeyCompletionContext("@@cite(iso) [Str87]")).toBeNull();
  });

  test("uses non-empty popup identities for empty namespace and key prefixes", () => {
    expect(citeNamespaceRenderPrefix("")).toBe("@@cite(");
    expect(citeKeyRenderPrefix({ namespace: "iso", prefix: "" })).toBe("@@cite(iso) [");
  });
});
