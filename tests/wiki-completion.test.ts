import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { wikiCompletionSnippets, wikiLinkCompletionContext } from "../aaronnote/wiki-completion.ts";
import type { WikiNote } from "../aaronnote/api-client.ts";
import { qualifiedWikiTitle, splitQualifiedWikiTarget, splitWantedWikiTarget } from "../shared/wiki-link.mjs";

const note: WikiNote = {
  id: "page-id",
  title: "Emacs",
  namespace: "Tools",
  qualifiedNamespace: "public/Tools",
  qualifiedTitle: "Tools:Emacs",
  fullTitle: "public/Tools:Emacs",
  aliases: ["GNU Emacs"],
  tags: [],
  private: false,
  file: "/notes/public/tools/emacs.md",
  path: "public/tools/emacs.md",
  repositoryPath: "emacs.md",
  repository: "tools",
  repositoryId: "public/tools",
  partition: "public",
  mtimeMs: 1,
  refs: [],
  backlinks: [],
  unresolvedLinks: [],
  blocks: [{
    id: "0198fbac-0780-7c99-85e6-333333333333",
    kind: "org-env",
    envKind: "theorem",
    label: "theorem · Fixed point",
    offset: 120,
  }],
};

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

  test("reuses an existing closing delimiter", () => {
    const context = wikiLinkCompletionContext("[[E", "]]")!;
    expect(wikiCompletionSnippets([note], context)[0]).toMatchObject({
      provider: "wiki",
      body: "roam://page-id|Emacs",
    });
  });

  test("matches qualified namespace titles and exposes namespace context", () => {
    const context = wikiLinkCompletionContext("[[Tools:E", "]]" )!;
    expect(wikiCompletionSnippets([note], context)[0]).toMatchObject({
      key: "Tools:Emacs",
      description: expect.stringContaining("Tools · public/tools"),
      body: "roam://page-id|Emacs",
    });
  });

  test("offers page creation when the title is not indexed", () => {
    const context = wikiLinkCompletionContext("[[New idea", "]]")!;
    expect(wikiCompletionSnippets([note], context)).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "wiki-create", source: "New idea", body: "New idea" }),
    ]));
  });

  test("offers stable page-scoped block wikicites", () => {
    const context = wikiLinkCompletionContext("See [[Fixed", "]]" )!;
    expect(wikiCompletionSnippets([note], context)[0]).toMatchObject({
      group: "Wiki blocks",
      kind: "theorem",
      body: "roam://page-id#0198fbac-0780-7c99-85e6-333333333333|theorem · Fixed point",
    });
  });

  test("with nothing typed, lists the most recent pages and leaves blocks out", () => {
    const pages: WikiNote[] = Array.from({ length: 40 }, (_, index) => ({
      ...note,
      id: `page-${index}`,
      title: `Page ${index}`,
      qualifiedTitle: `Tools:Page ${index}`,
      fullTitle: `public/Tools:Page ${index}`,
      aliases: [],
      mtimeMs: index,
      blocks: [{ ...note.blocks![0]!, id: `block-${index}`, label: `theorem ${index}` }],
    }));
    const suggestions = wikiCompletionSnippets(pages, { prefix: "", hasClosingDelimiter: false }, 5);
    expect(suggestions.map((item) => item.name)).toEqual(["Page 39", "Page 38", "Page 37", "Page 36", "Page 35"]);
    expect(suggestions.every((item) => item.group === "Wiki pages")).toBe(true);
  });

  test("with fewer pages than rows, blocks fill the remaining rows", () => {
    const suggestions = wikiCompletionSnippets([note], { prefix: "", hasClosingDelimiter: false }, 5);
    expect(suggestions.map((item) => item.group)).toEqual(["Wiki pages", "Wiki blocks"]);
  });

  test("ranks an exact title over a prefix, a substring, and a block", () => {
    const pages: WikiNote[] = [
      { ...note, id: "a", title: "Set theory", qualifiedTitle: "Math:Set theory", aliases: [], blocks: [], mtimeMs: 9 },
      { ...note, id: "b", title: "Reset", qualifiedTitle: "Ops:Reset", aliases: [], blocks: [], mtimeMs: 8 },
      { ...note, id: "c", title: "Set", qualifiedTitle: "Math:Set", aliases: [], mtimeMs: 1,
        blocks: [{ ...note.blocks![0]!, id: "blk", label: "definition · Set" }] },
    ];
    const suggestions = wikiCompletionSnippets(pages, { prefix: "set", hasClosingDelimiter: true });
    expect(suggestions.map((item) => item.name)).toEqual(["Set", "Set theory", "Reset", "definition · Set"]);
  });
});
