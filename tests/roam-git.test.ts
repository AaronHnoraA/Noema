import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { commitRoam, diffRoamCommit, diffRoamFile, roamRepoChanges, roamRepoStatus } from "../server/lib/roam-git.mjs";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout.trim();
}

async function setupRepo() {
  const root = await mkdtemp(join(tmpdir(), "aaronnote-git-"));
  const notes = join(root, "roam");
  await mkdir(notes, { recursive: true });
  roots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Noema Test"]);
  await writeFile(join(notes, "a.md"), "# A\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return { root, notes };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("roam git tools", () => {
  test("lists note-root changes and renders working diffs", async () => {
    const { notes } = await setupRepo();
    await writeFile(join(notes, "a.md"), "# A\n\nChanged\n", "utf8");
    await writeFile(join(notes, "b.md"), "# B\n", "utf8");

    const changes = await roamRepoChanges(notes) as Array<{ path?: string; kind?: string; isMarkdown?: boolean }>;
    expect(changes).toContainEqual(expect.objectContaining({ path: "a.md", kind: "modified", isMarkdown: true }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "b.md", kind: "untracked", isMarkdown: true }));
    await expect(roamRepoStatus(notes)).resolves.toMatchObject({ uncommitted: true });

    const modifiedDiff = await diffRoamFile(notes, join(notes, "a.md")) as { diff?: string };
    expect(modifiedDiff.diff).toContain("+Changed");

    const untrackedDiff = await diffRoamFile(notes, "b.md") as { diff?: string };
    expect(untrackedDiff.diff).toContain("new file mode");
    expect(untrackedDiff.diff).toContain("+# B");
  });

  test("detects working changes through a symlinked note root", async () => {
    const { notes } = await setupRepo();
    const linkedNotes = join(tmpdir(), `aaronnote-git-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(linkedNotes);
    await symlink(notes, linkedNotes, "dir");
    await writeFile(join(notes, "a.md"), "# A\n\nChanged through link\n", "utf8");

    const changes = await roamRepoChanges(linkedNotes) as Array<{ path?: string; kind?: string }>;
    expect(changes).toContainEqual(expect.objectContaining({ path: "a.md", kind: "modified" }));
    await expect(roamRepoStatus(linkedNotes)).resolves.toMatchObject({ uncommitted: true });
    await expect(diffRoamFile(linkedNotes, "a.md")).resolves.toMatchObject({
      path: "a.md",
      diff: expect.stringContaining("+Changed through link"),
    });
  });

  test("commits scoped roam changes and exposes commit diff", async () => {
    const { notes } = await setupRepo();
    await writeFile(join(notes, "a.md"), "# A\n\nCommitted\n", "utf8");

    const sha = await commitRoam(notes, "notes update");
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(await readFile(join(notes, "a.md"), "utf8")).toContain("Committed");
    expect(await roamRepoChanges(notes)).toEqual([]);

    const commitDiff = await diffRoamCommit(notes, sha) as { diff?: string };
    expect(commitDiff.diff).toContain("notes update");
    expect(commitDiff.diff).toContain("+Committed");
  });
});
