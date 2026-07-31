import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { wikiCompletionSnippets, wikiLinkCompletionContext } from "../aaronnote/wiki-completion.ts";
import type { WikiNote } from "../aaronnote/api-client.ts";

const note: WikiNote = {
  id: "page-id",
  title: "Emacs",
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
};

describe("Wiki editor completion", () => {
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
    expect(wikiCompletionSnippets([note], context)[0]).toMatchObject({ provider: "wiki", body: "Emacs" });
  });

  test("offers page creation when the title is not indexed", () => {
    const context = wikiLinkCompletionContext("[[New idea", "]]")!;
    expect(wikiCompletionSnippets([note], context)).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "wiki-create", source: "New idea", body: "New idea" }),
    ]));
  });
});
