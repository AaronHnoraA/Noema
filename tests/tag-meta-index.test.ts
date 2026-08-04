import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore Node ESM server modules are outside the renderer TS graph.
import { configure } from "../server/lib/state.mjs";
// @ts-ignore Node ESM server modules are outside the renderer TS graph.
import { saveNote } from "../server/lib/runtime.mjs";
import { planMarkdownTagChanges } from "../aaronnote/note-tag-transaction.ts";
// @ts-ignore Node ESM server modules are outside the renderer TS graph.
import { wikiMutationFiles } from "../server/lib/wiki-index-refresh.mjs";
// @ts-ignore Node ESM server modules are outside the renderer TS graph.
import {
  buildWikiIndex,
  initWikiRepository,
  initWikiWorkspace,
  searchWikiDatabase,
} from "../server/lib/wiki-workspace.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("current-note tag persistence", () => {
  test("applies one tag intent and leaves extension metadata byte-stable", () => {
    const content = [
      "#+begin meta",
      "id: ip-pcp",
      "title: IP-PCP",
      "plugin-field: preserve exactly  ",
      "tags:",
      "  - tcs",
      "  - pcp",
      "refs: theorem-1",
      "#+end meta",
      "",
      "# IP-PCP",
      "",
    ].join("\n");
    const edit = planMarkdownTagChanges(content, { add: ["complexity"], remove: ["pcp"] });
    const next = `${content.slice(0, edit.from)}${edit.insert}${content.slice(edit.to)}`;
    expect(next).toContain("plugin-field: preserve exactly  \n");
    expect(next).toContain("tags:\n  - tcs\n  - complexity\nrefs: theorem-1");
    expect(planMarkdownTagChanges(next, { add: [], remove: [] }).changed).toBe(false);
  });

  test("writes metadata tags and incrementally refreshes the Wiki database", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-note-tags-"));
    roots.push(root);
    await initWikiWorkspace(root);
    const repository = await initWikiRepository(root, "private", "research");
    const file = join(repository.repository.path, "ip-pcp.md");
    await writeFile(file, [
      "#+begin meta",
      "id: ip-pcp",
      "title: IP-PCP",
      "kind: default",
      "tags: tcs",
      "refs:",
      "#+end meta",
      "",
      "# IP-PCP",
      "",
    ].join("\n"), "utf8");
    await buildWikiIndex(root, { layout: "wiki", mode: "full" });
    configure({ root, workspaceRoot: root, pluginRoot: join(root, ".test-plugin") });

    const content = await readFile(file, "utf8");
    const edit = planMarkdownTagChanges(content, { add: ["pcp"], remove: [] });
    const next = `${content.slice(0, edit.from)}${edit.insert}${content.slice(edit.to)}`;
    const result = await saveNote({
      file,
      content: next,
      force: true,
      refresh: "deferred",
      clientId: "tag-transaction-test",
      seq: 1,
    });
    expect(result.ok).toBe(true);
    const changedFiles = wikiMutationFiles(result);
    expect(changedFiles).toEqual([file]);
    expect(await readFile(file, "utf8")).toContain("tags: tcs pcp");

    const index = await buildWikiIndex(root, {
      layout: "wiki",
      mode: "incremental",
      changedFiles,
    });
    expect(index.maintenance).toMatchObject({ mode: "incremental" });
    expect(searchWikiDatabase(root, { query: "tag:pcp" })).toMatchObject({ total: 1 });
    expect(searchWikiDatabase(root, { query: "tag:tcs" })).toMatchObject({ total: 1 });

    expect(planMarkdownTagChanges(await readFile(file, "utf8"), { add: ["pcp"], remove: [] }).changed).toBe(false);
  });
});
