import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { get } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createWikiPage, initWikiRepository } from "../server/lib/wiki-workspace.mjs";
import {
  checkpointWikiRepository,
  configureWikiSyncGitProvider,
  defaultWikiGitMaintenanceBytes,
  defaultWikiSyncIntervalMs,
  onWikiSyncStateChange,
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
  repositoryUid: string;
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
    repositoryUid: created.repository.uid,
  };
}

afterEach(async () => {
  configureWikiSyncGitProvider(null);
  onWikiSyncStateChange(null);
  await stopAllWikiGitUis();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Wiki Git synchronization", () => {
  test("uses a once-daily automatic sync cadence", () => {
    expect(defaultWikiSyncIntervalMs()).toBe(24 * 60 * 60 * 1000);
    expect(defaultWikiGitMaintenanceBytes()).toBe(2 * 1024 * 1024 * 1024);
  });

  test("routes checkpoint commit data through the kernel provider", async () => {
    const item = await fixture();
    const head = await git(item.repositoryPath, "rev-parse", "HEAD");
    const calls: Array<{
      repositoryPath: string;
      request: { branch: string; message?: string; deviceName: string; deviceId: string };
    }> = [];
    configureWikiSyncGitProvider({
      owns: (repositoryPath: string) => repositoryPath === item.repositoryPath,
      async checkpoint(repositoryPath: string, request: {
        branch: string; message?: string; deviceName: string; deviceId: string;
      }) {
        calls.push({ repositoryPath, request });
        return {
          branch: request.branch,
          head,
          committed: false,
          changedFiles: 0,
          identityFallback: false,
          source: "kernel-vaultgit" as const,
        };
      },
    });

    const state = await checkpointWikiRepository(item.root, "private/research", {
      configDir: item.configDir,
      name: "Checkpoint Device",
      message: "provider checkpoint",
    });
    expect(state).toMatchObject({
      phase: "idle",
      committed: false,
      changedFiles: 0,
      head,
      source: "kernel-vaultgit",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      repositoryPath: item.repositoryPath,
      request: {
        branch: expect.stringMatching(/^noema\/checkpoint-device-[0-9a-f]{8}$/),
        message: "provider checkpoint",
        deviceName: "checkpoint-device",
        deviceId: expect.any(String),
      },
    });
    expect(await git(item.repositoryPath, "status", "--porcelain")).toBe("");
  });

  test("routes complete origin/main transport through the kernel provider", async () => {
    const item = await fixture();
    const calls: string[] = [];
    configureWikiSyncGitProvider({
      owns: (repositoryPath: string) => repositoryPath === item.repositoryPath,
      async checkpoint(repositoryPath: string, request: {
        branch: string; message?: string; deviceName: string; deviceId: string;
      }) {
        calls.push("checkpoint");
        return {
          branch: request.branch,
          head: await git(repositoryPath, "rev-parse", "HEAD"),
          committed: false,
          changedFiles: 0,
          identityFallback: false,
          source: "kernel-vaultgit" as const,
        };
      },
      async ensureMain(repositoryPath: string, commit: string) {
        calls.push("ensure-main");
        const remoteHead = (await git(repositoryPath, "ls-remote", "origin", "refs/heads/main")).split(/\s+/, 1)[0];
        return {
          action: "ensure-main" as const, commit, remoteHead, bootstrapped: false,
          source: "kernel-vaultgit" as const,
        };
      },
      async fetchMain(repositoryPath: string) {
        calls.push("fetch-main");
        await git(repositoryPath, "fetch", "--prune", "origin", "main");
        return {
          action: "fetch-main" as const, commit: "",
          remoteHead: await git(repositoryPath, "rev-parse", "refs/remotes/origin/main"),
          bootstrapped: false, source: "kernel-vaultgit" as const,
        };
      },
      async pushMain(repositoryPath: string, commit: string) {
        calls.push("push-main");
        await git(repositoryPath, "push", "origin", `${commit}:refs/heads/main`);
        return {
          action: "push-main" as const, commit, remoteHead: commit, bootstrapped: false,
          source: "kernel-vaultgit" as const,
        };
      },
    });

    const state = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    expect(state).toMatchObject({
      phase: "idle",
      localOnly: false,
      checkpointSource: "kernel-vaultgit",
      transportSource: "kernel-vaultgit",
    });
    expect(state.source).toBeUndefined();
    expect(calls).toEqual(["checkpoint", "ensure-main", "fetch-main", "checkpoint", "push-main"]);
  });

  test("cleans only merged, unused Noema branches after the Git object store crosses the threshold", async () => {
    const item = await fixture();
    await git(item.repositoryPath, "branch", "noema/merged-stale", "main");
    await git(item.repositoryPath, "branch", "noema-integration/merged-stale", "main");
    await git(item.repositoryPath, "branch", "user/merged-stale", "main");
    await git(item.repositoryPath, "switch", "-c", "noema/unmerged-stale");
    await writeFile(join(item.repositoryPath, "unmerged.md"), "# Preserve me\n");
    await git(item.repositoryPath, "add", "unmerged.md");
    await git(item.repositoryPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-m", "unmerged local work");
    await git(item.repositoryPath, "switch", "main");

    await syncWikiRepository(item.root, "private/research", {
      configDir: item.configDir,
      gitMaintenanceThresholdBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(await git(item.repositoryPath, "branch", "--list", "noema/merged-stale")).toContain("noema/merged-stale");

    await syncWikiRepository(item.root, "private/research", {
      configDir: item.configDir,
      gitMaintenanceThresholdBytes: 0,
    });
    const branches = await git(item.repositoryPath, "for-each-ref", "--format=%(refname:short)", "refs/heads");
    expect(branches).not.toContain("noema/merged-stale");
    expect(branches).not.toContain("noema-integration/merged-stale");
    expect(branches).toContain("user/merged-stale");
    expect(branches).toContain("noema/unmerged-stale");
    expect(branches).toMatch(/^noema\//m);
    expect(branches).toMatch(/^noema-integration\//m);
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
    expect(state).toMatchObject({
      phase: "idle", localOnly: false, committed: true, changedFiles: 1,
      checkpointSource: "node-vaultgit",
      transportSource: "node-vaultgit",
    });
    expect(state.source).toBeUndefined();
    expect(state.changedPaths).toEqual([file]);
    expect(await git(item.repositoryPath, "branch", "--show-current")).toMatch(/^noema\//);
    expect(await git(item.repositoryPath, "log", "-1", "--format=%an <%ae>")).toBe("Researcher <researcher@example.test>");
    expect(await git(item.repositoryPath, "log", "-1", "--format=%s")).toMatch(/^noema: checkpoint 1 file/);

    const checkout = join(item.suite, "verification");
    await execFileAsync("git", ["clone", item.remote, checkout]);
    expect(await readFile(join(checkout, "sync.md"), "utf8")).toContain("# Local edit");
  });

  test("quarantines an untracked integration collision and rebuilds the disposable worktree", async () => {
    const item = await fixture();
    const initial = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    const relativePath = "project/UNSW/ISO(202603)/.cell/GraphTensor.bash.default.ipynb";
    const localFile = join(item.repositoryPath, relativePath);
    const integrationFile = join(String(initial.integrationPath), relativePath);
    await mkdir(join(localFile, ".."), { recursive: true });
    await mkdir(join(integrationFile, ".."), { recursive: true });
    await writeFile(localFile, "local contribution\n");
    await writeFile(integrationFile, "stale integration artifact\n");

    const state = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });

    expect(state.phase).toBe("idle");
    const artifact = state.recoveryArtifacts?.find((entry) => entry.source === "integration");
    expect(artifact?.files).toEqual([relativePath]);
    expect(await readFile(join(item.root, artifact!.path, "files", relativePath), "utf8"))
      .toBe("stale integration artifact\n");
    expect(await readFile(localFile, "utf8")).toBe("local contribution\n");

    const checkout = join(item.suite, "integration-recovery-verification");
    await execFileAsync("git", ["clone", item.remote, checkout]);
    expect(await readFile(join(checkout, relativePath), "utf8")).toBe("local contribution\n");
  });

  test("quarantines a differing ignored primary file before applying a remote tracked path", async () => {
    const item = await fixture();
    await writeFile(join(item.repositoryPath, ".gitignore"), "generated/\n");
    await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });

    const collaborator = join(item.suite, "primary-collision-collaborator");
    await execFileAsync("git", ["clone", item.remote, collaborator]);
    await mkdir(join(collaborator, "generated"), { recursive: true });
    await writeFile(join(collaborator, "generated/result.txt"), "remote tracked result\n");
    await git(collaborator, "add", "-f", "generated/result.txt");
    await git(collaborator, "-c", "user.name=Remote", "-c", "user.email=remote@local", "commit", "-m", "track generated result");
    await git(collaborator, "push", "origin", "main");

    const localCollision = join(item.repositoryPath, "generated/result.txt");
    await mkdir(join(item.repositoryPath, "generated"), { recursive: true });
    await writeFile(localCollision, "local ignored result\n");
    const state = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });

    expect(state.phase).toBe("idle");
    expect(await readFile(localCollision, "utf8")).toBe("remote tracked result\n");
    const artifact = state.recoveryArtifacts?.find((entry) => entry.source === "primary");
    expect(artifact?.files).toEqual(["generated"]);
    expect(await readFile(join(item.root, artifact!.path, "files/generated/result.txt"), "utf8"))
      .toBe("local ignored result\n");
  });

  test("preserves an untracked collision when returning an externally switched repository to its device branch", async () => {
    const item = await fixture();
    const deviceOnly = join(item.repositoryPath, "device-only.txt");
    await writeFile(deviceOnly, "tracked device contribution\n");
    await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    await git(item.repositoryPath, "switch", "main");
    await writeFile(deviceOnly, "external untracked contribution\n");

    const state = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });

    expect(state.phase).toBe("idle");
    expect(await readFile(deviceOnly, "utf8")).toBe("tracked device contribution\n");
    const recovered = state.recoveryArtifacts?.find((artifact) => (
      artifact.source === "primary" && artifact.files.includes("device-only.txt")
    ));
    expect(await readFile(join(item.root, recovered!.path, "files/device-only.txt"), "utf8"))
      .toBe("external untracked contribution\n");
  });

  test("preserves both sides when origin/main advances immediately before push", async () => {
    const item = await fixture();
    const collaborator = join(item.suite, "push-race-collaborator");
    await execFileAsync("git", ["clone", item.remote, collaborator]);
    await writeFile(join(collaborator, "remote-race.md"), "# Remote won the race\n");
    await git(collaborator, "add", "remote-race.md");
    await git(collaborator, "-c", "user.name=Remote", "-c", "user.email=remote@local", "commit", "-m", "remote race");
    await writeFile(join(item.repositoryPath, "local-race.md"), "# Local contribution\n");
    let raced = false;

    const state = await syncWikiRepository(item.root, "private/research", {
      configDir: item.configDir,
      testHooks: {
        async beforePush({ attempt }: { attempt: number }) {
          if (attempt !== 1 || raced) return;
          raced = true;
          await git(collaborator, "push", "origin", "main");
        },
      },
    });

    expect(state.phase).toBe("idle");
    const checkout = join(item.suite, "push-race-verification");
    await execFileAsync("git", ["clone", item.remote, checkout]);
    expect(await readFile(join(checkout, "local-race.md"), "utf8")).toContain("Local contribution");
    expect(await readFile(join(checkout, "remote-race.md"), "utf8")).toContain("Remote won the race");
  });

  test("retries a kernel transport push race through kernel fetch and exact push", async () => {
    const item = await fixture();
    const collaborator = join(item.suite, "kernel-push-race-collaborator");
    await execFileAsync("git", ["clone", item.remote, collaborator]);
    await writeFile(join(collaborator, "remote-kernel-race.md"), "# Remote kernel race\n");
    await git(collaborator, "add", "remote-kernel-race.md");
    await git(collaborator, "-c", "user.name=Remote", "-c", "user.email=remote@local", "commit", "-m", "remote kernel race");
    await writeFile(join(item.repositoryPath, "local-kernel-race.md"), "# Local kernel contribution\n");
    const calls: string[] = [];

    configureWikiSyncGitProvider({
      owns: (repositoryPath: string) => repositoryPath === item.repositoryPath,
      async checkpoint(repositoryPath: string, request: {
        branch: string; message?: string; deviceName: string; deviceId: string;
      }) {
        calls.push("checkpoint");
        await git(repositoryPath, "add", "-A", "--", ".");
        const changed = (await git(repositoryPath, "diff", "--cached", "--name-only", "--"))
          .split("\n").filter(Boolean);
        if (changed.length) {
          await git(
            repositoryPath,
            "-c", `user.name=Noema (${request.deviceName})`,
            "-c", `user.email=noema-${request.deviceId.slice(0, 8)}@local`,
            "commit", "-m", request.message || "kernel checkpoint",
          );
        }
        return {
          branch: request.branch,
          head: await git(repositoryPath, "rev-parse", "HEAD"),
          committed: changed.length > 0,
          changedFiles: changed.length,
          identityFallback: true,
          source: "kernel-vaultgit" as const,
        };
      },
      async ensureMain(repositoryPath: string, commit: string) {
        calls.push("ensure-main");
        const remoteHead = (await git(repositoryPath, "ls-remote", "origin", "refs/heads/main")).split(/\s+/, 1)[0];
        return {
          action: "ensure-main" as const, commit, remoteHead, bootstrapped: false,
          source: "kernel-vaultgit" as const,
        };
      },
      async fetchMain(repositoryPath: string) {
        calls.push("fetch-main");
        await git(repositoryPath, "fetch", "--prune", "origin", "main");
        return {
          action: "fetch-main" as const, commit: "",
          remoteHead: await git(repositoryPath, "rev-parse", "refs/remotes/origin/main"),
          bootstrapped: false, source: "kernel-vaultgit" as const,
        };
      },
      async pushMain(repositoryPath: string, commit: string) {
        calls.push("push-main");
        await git(repositoryPath, "push", "origin", `${commit}:refs/heads/main`);
        return {
          action: "push-main" as const, commit, remoteHead: commit, bootstrapped: false,
          source: "kernel-vaultgit" as const,
        };
      },
    });

    let raced = false;
    const state = await syncWikiRepository(item.root, "private/research", {
      configDir: item.configDir,
      testHooks: {
        async beforePush({ attempt }: { attempt: number }) {
          if (attempt !== 1 || raced) return;
          raced = true;
          await git(collaborator, "push", "origin", "main");
        },
      },
    });

    expect(state).toMatchObject({
      phase: "idle",
      checkpointSource: "kernel-vaultgit",
      transportSource: "kernel-vaultgit",
    });
    expect(calls.filter((call) => call === "fetch-main")).toHaveLength(2);
    expect(calls.filter((call) => call === "push-main")).toHaveLength(2);
    const checkout = join(item.suite, "kernel-push-race-verification");
    await execFileAsync("git", ["clone", item.remote, checkout]);
    expect(await readFile(join(checkout, "local-kernel-race.md"), "utf8")).toContain("Local kernel contribution");
    expect(await readFile(join(checkout, "remote-kernel-race.md"), "utf8")).toContain("Remote kernel race");
  });

  test("records a published head when a newer local edit blocks application, then reconciles without loss", async () => {
    const item = await fixture();
    const collaborator = join(item.suite, "published-apply-collaborator");
    await execFileAsync("git", ["clone", item.remote, collaborator]);
    await writeFile(join(collaborator, "sync.md"), "# Remote published content\n");
    await git(collaborator, "add", "sync.md");
    await git(collaborator, "-c", "user.name=Remote", "-c", "user.email=remote@local", "commit", "-m", "remote content");
    await git(collaborator, "push", "origin", "main");
    await writeFile(join(item.repositoryPath, "local-published.md"), "# Local published contribution\n");

    const first = await syncWikiRepository(item.root, "private/research", {
      configDir: item.configDir,
      testHooks: {
        async afterPublished() {
          await writeFile(join(item.repositoryPath, "sync.md"), "# Newer local edit after publish\n");
        },
      },
    });

    expect(first).toMatchObject({ phase: "applying", errorKind: "workspace", retryable: true });
    expect(first.publishedHead).toBeTruthy();
    expect(await readFile(join(item.repositoryPath, "sync.md"), "utf8")).toContain("Newer local edit");
    const verification = join(item.suite, "published-apply-verification");
    await execFileAsync("git", ["clone", item.remote, verification]);
    expect(await readFile(join(verification, "local-published.md"), "utf8")).toContain("Local published contribution");

    const second = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    expect(second.phase).toBe("conflicted");
    const conflict = await readWikiConflict(item.root, { repositoryId: "private/research", path: "sync.md" });
    expect(conflict.ours).toContain("Newer local edit");
    expect(conflict.theirs).toContain("Remote published content");
    expect(conflict.oursLabel).toBe("Your latest local contribution");
    expect(conflict.theirsLabel).toBe("Recovered sync result");
  });

  test("reconciles an interrupted transaction after the remote publish was recorded", async () => {
    const item = await fixture();
    await writeFile(join(item.repositoryPath, "interrupted.md"), "# Durable local contribution\n");
    const first = await syncWikiRepository(item.root, "private/research", {
      configDir: item.configDir,
      testHooks: {
        afterPublished() {
          throw new Error("simulated process interruption after publish");
        },
      },
    });

    expect(first).toMatchObject({ phase: "waiting", errorKind: "internal", retryable: true });
    expect(first.publishedHead).toBeTruthy();

    const second = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    expect(second.phase).toBe("idle");
    expect(await readFile(join(item.repositoryPath, "interrupted.md"), "utf8")).toContain("Durable local contribution");
    const localHead = await git(item.repositoryPath, "rev-parse", "HEAD");
    const remoteHead = await git(item.repositoryPath, "rev-parse", "origin/main");
    expect(localHead).toBe(remoteHead);
  });

  test("prunes only expired Noema Git recovery batches", async () => {
    const item = await fixture();
    const oldBatch = join(item.root, ".noema/recovery/git/fixture/old-batch");
    await mkdir(oldBatch, { recursive: true });
    await writeFile(join(oldBatch, "preserved.txt"), "expired recovery\n");
    const old = new Date(Date.now() - 60_000);
    await utimes(oldBatch, old, old);

    const state = await syncWikiRepository(item.root, "private/research", {
      configDir: item.configDir,
      recoveryRetentionMs: 1_000,
    });

    expect(state.phase).toBe("idle");
    await expect(readFile(join(oldBatch, "preserved.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(item.repositoryPath, "sync.md"), "utf8")).toContain("# Common");
  });

  test("coalesces repeated manual sync clicks for the same repository", async () => {
    const item = await fixture();
    const first = syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    const second = syncWikiRepository(item.root, "private/research", { configDir: item.configDir });

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ phase: "idle", localOnly: false });
  });

  test("preserves and recovers an old empty orphaned Git index lock", async () => {
    const item = await fixture();
    const gitDir = await git(item.repositoryPath, "rev-parse", "--absolute-git-dir");
    const lock = join(gitDir, "index.lock");
    await writeFile(lock, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);

    const state = await checkpointWikiRepository(item.root, "private/research", {
      configDir: item.configDir,
      gitLockStaleMs: 1_000,
    });

    expect(state).toMatchObject({
      phase: "idle",
      recoveredGitLock: { kind: "orphan-index-lock", size: 0 },
    });
    await expect(readFile(lock)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(item.root, state.recoveredGitLock!.backup), "utf8")).toBe("");
  });

  test("never recovers a non-empty index lock that may belong to external Git", async () => {
    const item = await fixture();
    const gitDir = await git(item.repositoryPath, "rev-parse", "--absolute-git-dir");
    const lock = join(gitDir, "index.lock");
    await writeFile(lock, "active-index-data");

    const state = await syncWikiRepository(item.root, "private/research", {
      configDir: item.configDir,
      gitLockStaleMs: 0,
      repositoryLeaseWaitMs: 0,
      repositoryBusyRetryMs: 25,
    });

    expect(state).toMatchObject({ phase: "waiting", retryable: true, retryAfterMs: 25 });
    expect(await readFile(lock, "utf8")).toBe("active-index-data");
  });

  test("recovers a fresh empty lock when a dead Noema lease identifies its owner", async () => {
    const item = await fixture();
    const leaseDirectory = join(item.root, ".noema", "git-leases");
    await mkdir(leaseDirectory, { recursive: true });
    await writeFile(join(leaseDirectory, `${item.repositoryUid}.json`), `${JSON.stringify({
      schema: 1,
      token: "dead-host",
      pid: 2_147_483_647,
      host: hostname(),
      operation: "sync",
      repositoryId: "private/research",
    })}\n`);
    const gitDir = await git(item.repositoryPath, "rev-parse", "--absolute-git-dir");
    const lock = join(gitDir, "index.lock");
    await writeFile(lock, "");

    const state = await checkpointWikiRepository(item.root, "private/research", {
      configDir: item.configDir,
      gitLockStaleMs: 60 * 60_000,
      repositoryLeaseWaitMs: 0,
      repositoryLeaseDeadGraceMs: 0,
    });

    expect(state.recoveredGitLock).toMatchObject({
      kind: "orphan-index-lock",
      size: 0,
      previousOwnerPid: 2_147_483_647,
    });
    await expect(readFile(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("returns a transient waiting state while another live Noema host owns the repository", async () => {
    const item = await fixture();
    const leaseDirectory = join(item.root, ".noema", "git-leases");
    const lease = join(leaseDirectory, `${item.repositoryUid}.json`);
    await mkdir(leaseDirectory, { recursive: true });
    await writeFile(lease, `${JSON.stringify({
      schema: 1,
      token: "live-host",
      pid: process.pid,
      operation: "sync",
      repositoryId: "private/research",
    })}\n`);

    const state = await syncWikiRepository(item.root, "private/research", {
      configDir: item.configDir,
      repositoryLeaseWaitMs: 0,
      repositoryBusyRetryMs: 25,
    });

    expect(state).toMatchObject({ phase: "waiting", retryable: true, retryAfterMs: 25 });
    expect(JSON.parse(await readFile(lease, "utf8"))).toMatchObject({ token: "live-host" });
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
    expect(conflict.oursLabel).toBe("Your local contribution");
    expect(conflict.theirsLabel).toBe("Remote main");

    const duringConflict = join(item.repositoryPath, "during-conflict.md");
    await writeFile(duringConflict, "# Local work continued\n");

    const resolved = await resolveWikiConflict(item.root, {
      repositoryId: "private/research",
      path: "sync.md",
      choice: "ours",
    });
    expect(resolved).toMatchObject({ phase: "idle", conflicts: [] });
    expect(resolved.changedPaths).toEqual([duringConflict, localFile]);
    await git(collaborator, "pull", "--ff-only");
    expect(await readFile(remoteFile, "utf8")).toContain("# Local edit");
    expect(await readFile(join(collaborator, "during-conflict.md"), "utf8")).toContain("Local work continued");
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
  test("streams every phase transition to a registered listener", async () => {
    const item = await fixture();
    const seen: Array<Record<string, unknown>> = [];
    onWikiSyncStateChange((state) => { seen.push(state); });
    await writeFile(join(item.repositoryPath, "streamed.md"), "# Streamed contribution\n");
    const state = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    onWikiSyncStateChange(null);

    expect(state.phase).toBe("idle");
    const phases = seen.map((entry) => String(entry.phase || ""));
    expect(phases).toContain("checkpointing");
    expect(phases).toContain("fetching");
    expect(phases).toContain("merging");
    expect(phases).toContain("pushing");
    expect(phases.at(-1)).toBe("idle");
    expect(seen.every((entry) => entry.repositoryId === "private/research")).toBe(true);
  });

  test("hands the conflict editor git's merge draft, not the common ancestor", async () => {
    const item = await fixture();
    const file = join(item.repositoryPath, "sync.md");
    await writeFile(file, "top\nmiddle\nbottom\n");
    await git(item.repositoryPath, "add", "-A");
    await git(item.repositoryPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-m", "three lines");
    await git(item.repositoryPath, "push", "origin", "HEAD:main");

    const collaborator = join(item.suite, "merge-draft-collaborator");
    await execFileAsync("git", ["clone", item.remote, collaborator]);
    await writeFile(join(collaborator, "sync.md"), "remote top\nremote middle\nbottom\n");
    await git(collaborator, "add", "sync.md");
    await git(collaborator, "-c", "user.name=Remote", "-c", "user.email=remote@local", "commit", "-m", "remote edit");
    await git(collaborator, "push", "origin", "main");

    // Only the middle line is contested; the other two edits are one-sided and
    // git merges them on its own.
    await writeFile(file, "top\nlocal middle\nlocal bottom\n");
    const state = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    expect(state.phase).toBe("conflicted");

    const conflict = await readWikiConflict(item.root, { repositoryId: "private/research", path: "sync.md" });
    expect(conflict.merged).toContain("remote top");
    expect(conflict.merged).toContain("local bottom");
    expect(conflict.merged).toMatch(/^<{7}/m);
    expect(conflict.base).toBe("top\nmiddle\nbottom\n");
    expect(conflict.base).not.toContain("remote top");
    expect(conflict.conflicts.map((entry) => entry.path)).toContain("sync.md");
  });
  test("recovers when an interrupted worktree add left the integration branch locked", async () => {
    const item = await fixture();
    await writeFile(join(item.repositoryPath, "first.md"), "# First contribution\n");
    const first = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    expect(first.phase).toBe("idle");

    // Exactly what a killed `git worktree add` leaves behind: a locked
    // registration whose directory is gone.  `git worktree prune` skips locked
    // registrations, so the integration branch stays claimed forever.
    const listed = await git(item.repositoryPath, "worktree", "list", "--porcelain");
    const integration = listed.split(/\n\n+/)
      .map((block) => block.split(/\n/))
      .map((lines) => ({
        path: lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) || "",
        branch: lines.find((line) => line.startsWith("branch "))?.slice("branch refs/heads/".length) || "",
      }))
      .find((record) => record.branch.startsWith("noema-integration/"));
    expect(integration?.path).toBeTruthy();
    await git(item.repositoryPath, "worktree", "lock", "--reason", "initializing", integration!.path);
    await rm(integration!.path, { recursive: true, force: true });
    await expect(git(item.repositoryPath, "worktree", "add", "-B", integration!.branch, integration!.path, "HEAD"))
      .rejects.toThrow(/already used by worktree/);

    await writeFile(join(item.repositoryPath, "second.md"), "# Second contribution\n");
    const recovered = await syncWikiRepository(item.root, "private/research", { configDir: item.configDir });
    expect(recovered.phase).toBe("idle");

    const verification = join(item.suite, "worktree-recovery-verification");
    await execFileAsync("git", ["clone", item.remote, verification]);
    expect(await readFile(join(verification, "second.md"), "utf8")).toContain("Second contribution");
  });
});
