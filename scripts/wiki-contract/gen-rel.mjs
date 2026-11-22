import { writeFileSync } from "node:fs";
import { resolveWikiRelationships } from "../../server/lib/wiki-workspace.mjs";
const V = "/v";
function page(over) {
  const repo = over.repositoryId ?? "private/math";
  const [partition, name] = repo.split("/");
  const namespace = over.namespace ?? name;
  const qualifiedNamespace = `${partition}/${namespace}`;
  return {
    id: over.id, identityStatus: over.identityStatus ?? "managed", title: over.title, aliases: over.aliases ?? [],
    kind: over.kind ?? "page", redirectTo: over.redirectTo ?? "", namespace, qualifiedNamespace,
    namespaceAliases: over.namespaceAliases ?? [name, repo, qualifiedNamespace],
    fullTitle: `${qualifiedNamespace}:${over.title}`, repository: name, repositoryId: repo,
    repositoryPath: over.path, partition, file: `${V}/${repo}/${over.path}`,
    blocks: over.blocks ?? [], wikiLinks: (over.links ?? []).map((target) => ({ target, label: target })),
  };
}
const scenarios = [
  { name: "titles, aliases, refs and backlinks", pages: [
    page({ id: "a", title: "Group", aliases: ["Groups"], path: "group.md", links: ["Ring", "Groups"] }),
    page({ id: "b", title: "Ring", path: "ring.md", links: ["Group", "[[x]]", "Field"] }),
    page({ id: "c", title: "Reader", path: "reader.md", links: ["groups", "Group", "Nowhere"] }),
  ] },
  { name: "namespaces, colons in titles and wanted pages", pages: [
    page({ id: "a", title: "Chapter 1: Scope", path: "ch.md" }),
    page({ id: "b", title: "Scope", repositoryId: "private/notes", path: "scope.md" }),
    page({ id: "c", title: "Reader", path: "r.md", links: ["Chapter 1: Scope", "notes:Scope", "Nowhere: Else", "Research:New Page", "定理：存在性", "beta"] }),
  ] },
  { name: "ambiguity, local preference and duplicate titles", pages: [
    page({ id: "a", title: "Tensor", path: "t.md" }),
    page({ id: "b", title: "Tensor", repositoryId: "private/notes", path: "t.md" }),
    page({ id: "c", title: "Tensor", repositoryId: "private/physics", path: "t.md" }),
    page({ id: "d", title: "Reader", repositoryId: "private/other", path: "r.md", links: ["Tensor"] }),
    page({ id: "e", title: "Local", path: "l.md", links: ["Tensor"] }),
  ] },
  { name: "stable ids, redirects, fragments and file links", pages: [
    page({ id: "019fb6e9-5a90-779a-9784-63e211090ac7", title: "Target", path: "dir/target.md",
      blocks: [{ id: "thm-1", kind: "anchor", envKind: "", label: "thm-1", offset: 0 }] }),
    page({ id: "old-id", title: "Old", kind: "redirect", redirectTo: "roam://019fb6e9-5a90-779a-9784-63e211090ac7", path: "old.md" }),
    page({ id: "c", title: "Reader", path: "dir/reader.md", links: [
      "roam://019fb6e9-5a90-779a-9784-63e211090ac7", "roam://old-id", "Target#thm-1",
      "Target#019fb7a8-12ff-752d-ad5a-958fc37f4a1f", "Target#plain-missing", "./target.md#x", "#local", "Old"] }),
  ] },
  { name: "duplicate ids; provisional ids are not compared", pages: [
    page({ id: "dup", title: "One", path: "one.md" }),
    page({ id: "dup", title: "Two", path: "assets/two.md" }),
    page({ id: "dup", title: "Three", path: "assets/three.md" }),
    page({ id: "p:1", identityStatus: "provisional", title: "Four", path: "four.md" }),
    page({ id: "p:1", identityStatus: "provisional", title: "Five", path: "five.md" }),
  ] },
];
const cases = scenarios.map(({ name, pages }) => {
  const input = JSON.parse(JSON.stringify(pages));
  const { notes, reports } = resolveWikiRelationships(pages);
  const { similar: _similar, ...rest } = reports;
  return { name, pages: input, expected: {
    pages: notes.map((n) => ({ refs: n.refs, backlinks: n.backlinks, unresolvedLinks: n.unresolvedLinks })),
    reports: rest,
  } };
});
writeFileSync(new URL("../../shared/wiki-relationship-fixtures.json", import.meta.url), JSON.stringify({ version: 1, cases }, null, 2) + "\n");
for (const c of cases) console.log(c.name, JSON.stringify(c.expected).slice(0, 300));
