import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { reviewedWikiLinkChange, scanWikiLinkSuggestions, type WikiLinkTarget } from "../aaronnote/wiki-link-review.ts";

const id = "019a1234-5678-7abc-8123-abcdefabcdef";
const pages: WikiLinkTarget[] = [{
  id, title: "Graph Theory", aliases: ["图论"], repositoryId: "math",
  namespace: "Research", partition: "private", file: "/math/graph.md",
}, {
  id: "019a1234-5678-7abc-8123-abcdefabcdee", title: "图论", aliases: [], repositoryId: "public",
  namespace: "Knowledge", partition: "public", file: "/public/graph.md",
}];

describe("manual Wiki link review", () => {
  test("suggests prose and preserves exact source offsets while skipping existing markup", () => {
    const markdown = [
      "---", "title: Graph Theory", "---",
      "#+begin meta", "aliases: Graph Theory", "#+end meta",
      "# Graph Theory", "Graph Theory and 图论 meet Graph Theory.",
      "Already [[Graph Theory]] and [Graph Theory](roam://wiki/Graph%20Theory).",
      "`Graph Theory` $Graph Theory$ https://example.com/Graph Theory",
      "```md", "Graph Theory", "```",
    ].join("\n");
    const suggestions = scanWikiLinkSuggestions(markdown, pages);
    expect(suggestions.map((item) => item.text)).toEqual(["Graph Theory", "图论", "Graph Theory"]);
    expect(suggestions[1]?.targets).toHaveLength(2);
    expect(suggestions.every((item) => markdown.slice(item.from, item.to) === item.text)).toBe(true);
    expect(reviewedWikiLinkChange(markdown, suggestions[0]!, id)?.insert).toBe(`[[roam://${id}|Graph Theory]]`);
  });

  test("public source excludes private targets and exact matches do not hit word fragments", () => {
    const markdown = "Graph Theory, Graph Theoryish, 图论。";
    const suggestions = scanWikiLinkSuggestions(markdown, pages, { sourcePartition: "public" });
    expect(suggestions.map((item) => item.text)).toEqual(["图论"]);
    expect(suggestions[0]?.targets.map((page) => page.repositoryId)).toEqual(["public"]);
    expect(reviewedWikiLinkChange(markdown, suggestions[0]!, id)).toBeNull();
  });

  test("finds a Han title inside unspaced prose but keeps Latin word boundaries", () => {
    const markdown = "我们研究图论的基本方法，Graph Theoryを学ぶ。Subgraph Theory is not it.";
    const suggestions = scanWikiLinkSuggestions(markdown, pages);
    expect(suggestions.map((item) => item.text)).toEqual(["图论", "Graph Theory"]);
    expect(suggestions.every((item) => markdown.slice(item.from, item.to) === item.text)).toBe(true);
  });
});
