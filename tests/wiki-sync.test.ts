import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { get } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createWikiPage, initWikiRepository } from "../server/lib/wiki-workspace.mjs";
import {
  defaultWikiSyncIntervalMs,
  readWikiConflict,
  resolveWikiConflict,
  syncWikiRepository,
} from "../server/lib/wiki-sync.mjs";
import { openWikiGitUi, stopAllWikiGitUis } from "../server/lib/wiki-git-ui.mjs";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(path: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", path, ...args], { maxBuffer: 1024 * 1024 * 16 });
  return result.stdout.trim();
}

async function httpText(url: string): Promise<{ status: number; text: string }> {
  return await new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
  });
}

async function fixture(): Promise<{
  suite: string;
  root: string;
  repositoryPath: string;
  remote: string;
  configDir: string;
}> {
  const suite = await mkdtemp(join(tmpdir(), "noema-sync-"));
  roots.push(suite);
  const root = join(suite, "notes");
  await mkdir(root, { recursive: true });
  const created = await initWikiRepository(root, "private", "research");
  const page = await createWikiPage(root, "wiki", {
    title: "Sync page",
    repositoryId: "private/research",
    filename: "sync.md",
  });
  await writeFile(page.file, (await readFile(page.file, "utf8")).replace("# Sync page", "# Common"));
  await git(created.repository.path, "add", "-A");
  await git(created.repository.path, "-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-m", "baseline");
  const remote = join(suite, "remote.git");
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", remote]);
  await git(created.repository.path, "remote", "add", "origin", remote);
  await git(created.repository.path, "push", "-u", "origin", "main");
  return {
    suite,
    root,
    repositoryPath: created.repository.path,
    remote,
    configDir: join(suite, "config"),
  };
}

afterEach(async () => {
  await stopAllWikiGitUis();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Wiki Git synchronization", () => {
  test("keeps the established six-hour automatic sync cadence", () => {
    expect(defaultWikiSyncIntervalMs()).toBe(6 * 60 * 60 * 1000);
  });

  test("bootstraps main when an attached origin has no branches", async () => {
    const suite = await mkdtemp(join(tmpdir(), "noema-sync-empty-"));
    roots.push(suite);
    const root = join(suite, "notes");
    await mkdir(root, { recursive: true });
    const created = await initWikiRepository(root, "public", "math");
    const page = await createWikiPage(root, "wiki", {
      title: "Public page",
      repositoryId: "public/math",
      filename: "public.md",
    });
    const remote = join(suite, "remote.git");
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", remote]);
    await git(created.repository.path, "remote", "add", "origin", remote);

    const state = await syncWikiRepository(root, "public/math", { configDir: join(suite, "config") });
    expect(state).toMatchObject({ phase: "idle", localOnly: false, bootstrappedMain: true });
    expect(await git(created.repository.path, "ls-remote", "--heads", "origin", "refs/heads/main"))
      .toContain("refs/heads/main");

    const checkout = join(suite, "verification");
    await execFileAsync("git", ["clone", remote, checkout]);
    expect(await readFile(join(checkout, "public.md"), "utf8")).toBe(await readFile(page.file, "utf8"));
  });

  test("checkpoints a device branch and integrates it into origin/main", async () => {
    const item = await fixture();
    await git(item.repositoryPath, "config", "user.name", "Researcher");
    await git(item.repositoryPath, "config", "user.email", "researcher@example.test");
    const file = join(item.repositoryPath, "sync.md");
    await writeFile(file, (await readFile(file, "utf8")).replace("# Common", "# Local edit"));
    const state = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    expect(state).toMatchObject({ phase: "idle", localOnly: false, committed: true, changedFiles: 1 });
    expect(state.changedPaths).toEqual([file]);
    expect(await git(item.repositoryPath, "branch", "--show-current")).toMatch(/^noema\//);
    expect(await git(item.repositoryPath, "log", "-1", "--format=%an <%ae>")).toBe("Researcher <researcher@example.test>");
    expect(await git(item.repositoryPath, "log", "-1", "--format=%s")).toMatch(/^noema: checkpoint 1 file/);

    const checkout = join(item.suite, "verification");
    await execFileAsync("git", ["clone", item.remote, checkout]);
    expect(await readFile(join(checkout, "sync.md"), "utf8")).toContain("# Local edit");
  });

  test("coalesces repeated manual sync clicks for the same repository", async () => {
    const item = await fixture();
    const first = syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    const second = syncWikiRepository(item.root, "private/research", { configDir: item.configDir });

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ phase: "idle", localOnly: false });
  });

  test("captures three stages outside the working repository and resolves with product-side semantics", async () => {
    const item = await fixture();
    const collaborator = join(item.suite, "collaborator");
    await execFileAsync("git", ["clone", item.remote, collaborator]);
    const remoteFile = join(collaborator, "sync.md");
    await writeFile(remoteFile, (await readFile(remoteFile, "utf8")).replace("# Common", "# Remote edit"));
    await git(collaborator, "add", "sync.md");
    await git(collaborator, "-c", "user.name=Remote", "-c", "user.email=remote@local", "commit", "-m", "remote edit");
    await git(collaborator, "push", "origin", "main");

    const localFile = join(item.repositoryPath, "sync.md");
    await writeFile(localFile, (await readFile(localFile, "utf8")).replace("# Common", "# Local edit"));
    const state = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    expect(state.phase).toBe("conflicted");
    expect(state.conflicts).toEqual([expect.objectContaining({ path: "sync.md", stages: [1, 2, 3] })]);
    expect(await git(item.repositoryPath, "status", "--porcelain")).not.toContain("UU ");

    const conflict = await readWikiConflict(item.root, {
      repositoryId: "private/research",
      path: "sync.md",
    });
    expect(conflict.base).toContain("# Common");
    expect(conflict.ours).toContain("# Local edit");
    expect(conflict.theirs).toContain("# Remote edit");

    const resolved = await resolveWikiConflict(item.root, {
      repositoryId: "private/research",
      path: "sync.md",
      choice: "ours",
    });
    expect(resolved).toMatchObject({ phase: "idle", conflicts: [] });
    expect(resolved.changedPaths).toEqual([localFile]);
    await git(collaborator, "pull", "--ff-only");
    expect(await readFile(remoteFile, "utf8")).toContain("# Local edit");
  });

  test("starts ungit as a loopback-only embedded sidecar behind an opaque capability path", async () => {
    const item = await fixture();
    const result = await openWikiGitUi(item.root, "private/research");
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/noema-git-[0-9a-f]{48}\/\?noheader=true#\/repository\?path=/);
    expect(decodeURIComponent(result.url.split("path=", 2)[1]!)).toBe(item.repositoryPath);
    const response = await httpText(result.url);
    expect(response.status).toBe(200);
    expect(response.text).toContain("ungit");

    const socketUrl = new URL(result.url);
    socketUrl.hash = "";
    socketUrl.search = `?EIO=4&transport=polling&t=${Date.now()}`;
    socketUrl.pathname = `${socketUrl.pathname}socket.io/`;
    const handshake = await httpText(socketUrl.toString());
    expect(handshake.status).toBe(200);
    expect(handshake.text).toMatch(/^0\{"sid":/);

    const statusUrl = new URL(result.url);
    statusUrl.hash = "";
    statusUrl.search = `?path=${encodeURIComponent(item.repositoryPath)}`;
    statusUrl.pathname = `${statusUrl.pathname}api/status`;
    const status = await httpText(statusUrl.toString());
    expect(status.status).toBe(200);
    expect(JSON.parse(status.text)).toMatchObject({ branch: expect.stringContaining("main") });
  }, 15_000);
});
