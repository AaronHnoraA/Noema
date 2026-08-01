import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { configure } from "../server/lib/index.mjs";
import { buildServerPublicCatalog, publicOpenedNote } from "../server/lib/server-public-catalog.mjs";
import { buildWikiIndex } from "../server/lib/wiki-workspace.mjs";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

function note(id: string, title: string, body = "", extra = "") {
  return `#+begin meta\nid: ${id}\ntitle: ${title}\nkind: note\ntags: test\n${extra}#+end meta\n\n# ${title}\n\n${body}\n`;
}

async function repository(root: string, partition: "public" | "private", name: string) {
  const path = join(root, partition, name);
  await mkdir(path, { recursive: true });
  await execFileAsync("git", ["init", path]);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Server public projection", () => {
  test("removes private pages and only serves assets referenced by visible pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-server-public-"));
    roots.push(root);
    const publicRepo = await repository(root, "public", "knowledge");
    const privateRepo = await repository(root, "private", "journal");
    await mkdir(join(publicRepo, "images"), { recursive: true });
    await mkdir(join(privateRepo, "images"), { recursive: true });
    await writeFile(join(publicRepo, "images", "plot.png"), "public plot");
    await writeFile(join(publicRepo, "images", "unused.png"), "unused");
    await writeFile(join(privateRepo, "images", "secret.png"), "secret image");
    await writeFile(join(publicRepo, "visible.md"), note("visible", "Visible", "[[Secret]]\n![Plot](images/plot.png)", "aliases: Shown\n"));
    await writeFile(join(publicRepo, "hidden.md"), note("hidden", "Hidden", "", "private: true\n"));
    await writeFile(join(privateRepo, "secret.md"), note("secret", "Secret", "![Secret](images/secret.png)"));

    configure({ root, workspaceRoot: root, workspaceLayout: "wiki", stateRoot: join(root, "state") });
    const full = await buildWikiIndex(root, { layout: "wiki" });
    const config = {
      repositories: [
        { id: "public/knowledge" },
        { id: "private/journal" },
      ],
    };
    const catalog = await buildServerPublicCatalog(full, config);
    const localVisible = full.notes.find((item) => item.title === "Visible");
    const publicVisible = catalog.index.notes.find((item) => item.title === "Visible");

    expect(catalog.index.notes.map((item) => item.title)).toEqual(["Visible"]);
    expect(publicVisible).toMatchObject({
      id: localVisible?.id,
      title: localVisible?.title,
      kind: localVisible?.kind,
      namespace: localVisible?.namespace,
      aliases: localVisible?.aliases,
      tags: localVisible?.tags,
    });
    expect(catalog.index.repositories.map((item) => item.id)).toEqual(["public/knowledge"]);
    expect(catalog.search({ query: "Secret" }).total).toBe(0);
    expect(catalog.index.reports.wanted).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Secret" }),
    ]));
    expect((await publicOpenedNote(catalog, "public/knowledge/visible.md")).content).toContain("# Visible");
    await expect(publicOpenedNote(catalog, "private/journal/secret.md")).rejects.toMatchObject({ statusCode: 404 });
    expect(catalog.asset("images/plot.png", "public/knowledge/visible.md")).toBe(join(publicRepo, "images", "plot.png"));
    expect(catalog.asset("images/unused.png", "public/knowledge/visible.md")).toBe("");
    expect(catalog.asset("../journal/images/secret.png", "public/knowledge/visible.md")).toBe("");
  });
});
