import { expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import { setSystemClipboardWriter } from "../src/system-clipboard.ts";
// @ts-ignore Host runtime uses the independent Node module graph.
import { configure } from "../server/lib/state.mjs";
// @ts-ignore Host runtime uses the independent Node module graph.
import { readDocumentVersion } from "../server/lib/runtime.mjs";

const command = (name: string, args: string[], cwd: string) => execFileSync(name, args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});

async function project(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const repo = join(root, "work");
  await mkdir(repo);
  configure({root, workspaceRoot:root, pluginRoot:join(root, "plugin")});
  const notePath = join(repo, "note.md");
  await writeFile(notePath, "# Work\n");
  return { root, repo, notePath };
}

test("Git history and patch support exact path scopes, including a deleted file", async () => {
  const { root, repo, notePath } = await project("noema-doc-git-");
  try {
    command("git", ["-c", "init.templateDir=", "init", "-q"], repo);
    const file = join(repo, "old [v1].txt");
    await writeFile(file, "old line\n");
    await writeFile(join(repo, "other.txt"), "unrelated\n");
    command("git", ["add", "--", "old [v1].txt", "other.txt"], repo);
    command("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Save prototype"], repo);
    const index = await readFile(join(repo, ".git", "index"));
    await rm(file);
    const filter = { notePath, path: "old [v1].txt" };
    const history = await readDocumentVersion({ ...filter, kind: "git-log", limit: 1 });
    expect(history).toMatchObject({ok:true, provider:"git", commits:[{author:"Fixture", subject:"Save prototype"}]});
    expect(history.commits[0].id).toMatch(/^[\da-f]{40,64}$/);
    const diff = await readDocumentVersion({...filter, kind:"git-diff"});
    expect(diff).toMatchObject({ok:true, provider:"git", truncated:false});
    expect(diff.patch).toContain("-old line");
    expect(diff.patch).not.toContain("other.txt");
    expect(await readFile(join(repo,".git","index"))).toEqual(index);
    const docs = join(repo, "docs");
    const nestedNote = join(docs, "note.md");
    await mkdir(join(docs, ".git"), {recursive:true});
    await writeFile(nestedNote, "# Nested note\n");
    const nested = await readDocumentVersion({...filter, notePath:nestedNote, kind:"git-log"});
    expect(nested).toMatchObject({label:"work", commits:history.commits});
    expect(await readDocumentVersion({...filter, notePath:nestedNote, kind:"git-diff"})).toEqual(diff);
    await expect(readDocumentVersion({...filter, kind:"git-diff", range:"--stat"})).rejects.toMatchObject({statusCode:400});
    await expect(readDocumentVersion({notePath, kind:"git-log", path:"../../.."})).rejects.toMatchObject({statusCode:403});
  } finally {
    await rm(root, {recursive:true, force:true});
  }
});

const hasJj = (() => { try { command("jj", ["--version"], tmpdir()); return true; } catch { return false; } })();
test.skipIf(!hasJj)("Jujutsu without a Git worktree supplies history and an explicit revision patch", async () => {
  const { root, repo, notePath } = await project("noema-doc-jj-");
  try {
    command("jj", ["--config", 'user.name="Fixture"', "--config", 'user.email="fixture@example.invalid"', "git", "init", "--no-colocate"], repo);
    const file = join(repo, "source.txt");
    await writeFile(file, "initial\n");
    command("jj", ["--config", 'user.name="Fixture"', "--config", 'user.email="fixture@example.invalid"', "commit", "-m", "First"], repo);
    await writeFile(file, "next\n");
    command("jj", ["--config", 'user.name="Fixture"', "--config", 'user.email="fixture@example.invalid"', "commit", "-m", "Second"], repo);
    const inputs = { notePath, path:"source.txt" };
    const result = await readDocumentVersion({ ...inputs, kind:"git-log", limit:2 });
    expect(result.provider).toBe("jj");
    expect(result.commits.map((record: {subject: string}) => record.subject)).toEqual(["Second", "First"]);
    const diff = await readDocumentVersion({ ...inputs, kind:"git-diff", range:"@--..@-" });
    expect(diff.patch).toContain("-initial\n+next");
  } finally {
    await rm(root, {recursive:true, force:true});
  }
});

test("the editor shows repository rows and copies exact object IDs or patch text", async () => {
  const previousApi = window.noemaApi;
  const previousFile = window.NoemaCurrentFile;
  const patch = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-value\n+++literal\n";
  const object = "12af".repeat(10);
  const read = vi.fn(async (body: unknown) => (body as { kind: string }).kind === "git-log"
    ? {ok:true, provider:"git", label:"fixture", commits:[{id:object, short:"12af12af", author:"Fixture", date:"2026-11-26", subject:"Publish example"}]}
    : {ok:true, provider:"jj", label:"fixture", patch, truncated:false});
  const clipboard = vi.fn(async () => true);
  vi.stubGlobal("IntersectionObserver", undefined);
  window.noemaApi = { documentAssets:{version:read} };
  window.NoemaCurrentFile = () => "/fixture/history.md";
  setSystemClipboardWriter(clipboard);
  const host = document.createElement("div");
  document.body.append(host);
  const source = "#+begin git-log History {limit=3}\nThe public milestone.\n#+end git-log\n\n"
    + "#+begin git-diff Changes {vcs=jj range=@--..@-}\nThe public patch summary.\n#+end git-diff\n\nAfter.";
  const editor = createEditor(host, {initialContent:source});
  try {
    editor.setMarkdownSelection(source.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledWith(expect.objectContaining({notePath:"/fixture/history.md", kind:"git-diff", range:"@--..@-"}));
    expect(host.querySelector(".noema-repo-subject")?.textContent).toBe("Publish example");
    expect(host.querySelector('[data-patch-line="added"]')?.textContent).toContain("+++literal");
    host.querySelector<HTMLButtonElement>(".noema-repo-hash")?.click();
    host.querySelector<HTMLButtonElement>("[data-repo-copy]")?.click();
    expect(clipboard).toHaveBeenNthCalledWith(1, object);
    expect(clipboard).toHaveBeenNthCalledWith(2, patch);
    expect(editor.getMarkdown()).toBe(source);
    const published = renderMarkdownHTML(source);
    expect(published).toContain("The public patch summary.");
    expect(published).not.toContain("data-repo-kind");
  } finally {
    editor.destroy();
    host.remove();
    setSystemClipboardWriter(null);
    window.noemaApi = previousApi;
    window.NoemaCurrentFile = previousFile;
    vi.unstubAllGlobals();
  }
});
