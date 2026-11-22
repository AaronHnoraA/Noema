import { writeFileSync } from "node:fs";
import { parseWikiNoteContent } from "../../server/lib/wiki-workspace.mjs";
const cases = [
  { name: "meta block with id, aliases, tags", file: "group.md", content: "#+begin meta\nid: 019fb6e9-5a90-779a-9784-63e211090ac7\ntitle: Group Theory\naliases: Groups, 群论\ntags: algebra, structure\n#+end meta\n\n# Ignored heading\n\nSee [[Ring]] and [[Field|fields]].\n" },
  { name: "legacy timestamp id and heading title", file: "legacy.md", content: "#+begin meta\nid: 20261006T121300-graph-isomorphism\n#+end meta\n\n# Graph Isomorphism 图同构\n\nText.\n" },
  { name: "no metadata: provisional, title from heading", file: "plain.md", content: "# Plain Note\n\nA [[Target#Section]] link.\n" },
  { name: "no heading: title from file name", file: "file-name-title.md", content: "Just text.\n" },
  { name: "links: roam, fragments, markdown .md#, external ignored", file: "links.md", content: "# L\n\n[r](roam://019fb7a8-12ff-752d-ad5a-958fc37f4a1f) [f](#local) [m](./other.md#top) [w](https://example.org/README.md#x) [mail](mailto:a@b.c)\n" },
  { name: "code fences and inline code hide links", file: "code.md", content: "# C\n\n```md\n[[NotALink]]\n```\n\n`[[AlsoNot]]` but [[Real]].\n" },
  { name: "block ids: anchor and org env", file: "blocks.md", content: "# B\n\nA paragraph. {#para-1}\n\n#+begin theorem Mathon {#thm-mathon}\nBody\n#+end theorem\n\nAgain {#para-1}\n" },
  { name: "comment anchors keep only their text", file: "comments.md", content: "# K\n\nSome {==commented [[Linked]] text==}{>>#c-abc<<} here.\n" },
  { name: "front matter wins over a meta block", file: "front.md", content: "---\ntitle: 'Quoted Title'\ntags: [a, \"b c\"]\n---\n\n#+begin meta\ntitle: Not used\n#+end meta\n" },
  { name: "a meta block past the preamble is prose", file: "late.md", content: "# Late\n\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n#+begin meta\nid: 019fb6e9-5a90-779a-9784-63e211090ac7\n#+end meta\n" },
  { name: "setext title", file: "setext.md", content: "Intro\n=== Big Title\n" },
  { name: "escaped wiki link is literal", file: "escaped.md", content: "# E\n\n\\[[Literal]] and [[Real|  spaced label  ]] and [[ |empty]]\n" },
  { name: "CJK and astral text before anchors count UTF-16 units", file: "cjk.md", content: "# 标题\n\n中文段落😀 {#cjk-para}\n\n#+begin lemma 引理 {#lem-cjk}\nx\n#+end lemma\n" },
  { name: "planning ids", file: "plan.md", content: "# P\n\n@@todo [Write the proof] {id: task-proof, ddl: 2026-12-01}\n- [ ] item {id=item-two}\n" },
  { name: "ediff: a valid proposal indexes its old side", file: "ediff.md", content: "# D\n\n#+begin ediff Fix\n@@ediff-author {\"name\":\"agent\"}\n-Old [[Before]]\n+New [[After]]\n#+end ediff\n\nTail.\n" },
  { name: "ediff: an invalid block stays as source", file: "ediff-bad.md", content: "# D\n\n#+begin ediff\nnot a diff line [[Kept]]\n#+end ediff\n" },
  { name: "a {#id} on a non-semantic environment (tikz) is still a plain anchor", file: "nonsem.md", content: "# N\n\n#+begin tikz {#not-an-id}\n\\draw;\n#+end tikz\n" },
  { name: "namespace aliases", file: "ns.md", content: "#+begin meta\nnamespace: math\nnamespace_aliases: maths, mathematics\n#+end meta\n\n# N\n" },
];
const out = cases.map(({ name, file, content }) => {
  const parsed = parseWikiNoteContent(content, file);
  const { approvedContent, meta, ...fields } = parsed;
  return { name, file, content, expected: fields };
});
writeFileSync(new URL("../../shared/wiki-note-parse-fixtures.json", import.meta.url), JSON.stringify({ version: 1, cases: out }, null, 2) + "\n");
console.log(out.length, "cases");
for (const c of out) console.log(c.name, JSON.stringify(c.expected).slice(0, 200));
