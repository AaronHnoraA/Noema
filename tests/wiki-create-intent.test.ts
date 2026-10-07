import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createdWikiLinkChange, wikiCreationSource } from "../aaronnote/wiki-create-intent.ts";

const pageId = "019a1234-5678-7abc-8123-abcdefabcdef";

describe("Wiki link creation intent", () => {
  test("upgrades only the clicked occurrence when a title appears twice", () => {
    const markdown = "First [[New page]]; second [[New page|custom label]].";
    const second = wikiCreationSource(markdown, "New page", markdown.lastIndexOf("New page"));
    expect(second).toEqual({ from: markdown.lastIndexOf("[["), raw: "[[New page|custom label]]" });
    const change = createdWikiLinkChange(markdown, second!, pageId);
    expect(change?.insert).toBe(`[[roam://${pageId}|custom label]]`);
    expect(createdWikiLinkChange(`x${markdown}`, second!, pageId)).toBeNull();
  });

  test("preserves Markdown link labels and refuses an ambiguous source without a cursor match", () => {
    const markdown = "[Readable](roam://wiki/New%20page) and [[New page]]";
    const source = wikiCreationSource(markdown, "New page", 2);
    expect(source).toEqual({ from: 0, raw: "[Readable](roam://wiki/New%20page)" });
    expect(createdWikiLinkChange(markdown, source!, pageId)?.insert).toBe(`[Readable](roam://${pageId})`);
    expect(wikiCreationSource(markdown, "New page", markdown.length + 10)).toBeNull();
  });

  test("keeps an explicit section fragment when a missing page becomes stable", () => {
    const wiki = "See [[Research:New page#Section A|section]].";
    const wikiSource = wikiCreationSource(wiki, "Research:New page#Section A", wiki.indexOf("Section"));
    expect(createdWikiLinkChange(wiki, wikiSource!, pageId)?.insert)
      .toBe(`[[roam://${pageId}#Section%20A|section]]`);
    const markdown = "[section](roam://wiki/Research%3ANew%20page%23Section%20A)";
    const markdownSource = wikiCreationSource(markdown, "Research:New page#Section A", 4);
    expect(createdWikiLinkChange(markdown, markdownSource!, pageId)?.insert)
      .toBe(`[section](roam://${pageId}#Section%20A)`);
  });
});
