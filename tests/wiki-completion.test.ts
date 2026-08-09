import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { wikiCompletionSnippets, wikiLinkCompletionContext } from "../aaronnote/wiki-completion.ts";
import type { WikiNote } from "../aaronnote/api-client.ts";
import { qualifiedWikiTitle, splitQualifiedWikiTarget } from "../shared/wiki-link.mjs";

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
});
