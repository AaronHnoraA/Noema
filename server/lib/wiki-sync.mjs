import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { newNoemaId } from "../../shared/identity.mjs";
import { expandNoemaPath, repositoryFromId } from "./wiki-workspace.mjs";

const execFileAsync = promisify(execFile);
const repositoryQueues = new Map();

function apiError(message, statusCode = 400, code = "ERR_WIKI_SYNC") {
  return Object.assign(new Error(message), { statusCode, code });
}

async function git(repository, args, options = {}) {
  try {
    return await execFileAsync("git", ["-C", repository.path, ...args], {
      maxBuffer: 1024 * 1024 * 32,
      ...options,
    });
  } catch (error) {
    if (options.allowFailure) return { stdout: error?.stdout || "", stderr: error?.stderr || "", error };
    throw apiError(String(error?.stderr || error?.message || "Git command failed").trim(), 409);
  }
}

function safeDeviceName(value) {
  return String(value || "device").normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "device";
}

export async function ensureNoemaDeviceIdentity(options = {}) {
  const configDir = resolve(String(options.configDir || join(homedir(), ".config", "noema")));
  const file = join(configDir, "device.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed?.id && parsed?.name) return { ...parsed, file };
  } catch {}
  const identity = {
    schema: 1,
    id: newNoemaId("repository"),
    name: safeDeviceName(options.name || hostname()),
    createdAt: new Date().toISOString(),
  };
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { ...identity, file };
}

function stateFile(root, repository) {
  return join(root, ".noema", "sync", `${repository.uid || repository.id.replaceAll("/", "-")}.json`);
}

async function writeSyncState(root, repository, state) {
  const file = stateFile(root, repository);
  await mkdir(dirname(file), { recursive: true });
  const payload = {
    schema: 1,
    repositoryId: repository.id,
    repositoryUid: repository.uid,
    updatedAt: new Date().toISOString(),
    ...state,
  };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export async function readWikiSyncState(rootValue, repositoryId = "") {
  const root = expandNoemaPath(rootValue);
  if (repositoryId) {
    const repository = await repositoryFromId(root, repositoryId);
    try {
      return JSON.parse(await readFile(stateFile(root, repository), "utf8"));
    } catch {
      return {
        schema: 1,
        repositoryId: repository.id,
        repositoryUid: repository.uid,
        phase: "idle",
        updatedAt: "",
      };
    }
  }
  const repositories = [];
  for (const partition of ["public", "private"]) {
    let names = [];
    try {
      names = await (await import("node:fs/promises")).readdir(join(root, partition), { withFileTypes: true });
    } catch {}
    for (const entry of names) {
      if (!entry.isDirectory() || !existsSync(join(root, partition, entry.name, ".git"))) continue;
      repositories.push(await readWikiSyncState(root, `${partition}/${entry.name}`));
    }
  }
  return { ok: true, type: "wiki-sync-state", repositories };
}

async function branchExists(repository, branch) {
  const result = await git(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
  return !result.error;
}

async function currentBranch(repository) {
  return (await git(repository, ["branch", "--show-current"])).stdout.trim();
}

async function hasHead(repository) {
  const result = await git(repository, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  return !result.error;
}

async function currentHeadSha(repository) {
  const result = await git(repository, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  return result.error ? "" : String(result.stdout || "").trim();
}

async function changedPathsBetween(repository, before, after) {
  if (!after || before === after) return [];
  const args = before
    ? ["diff", "--name-only", "-z", before, after, "--"]
    : ["ls-tree", "-r", "--name-only", "-z", after];
  const result = await git(repository, args, { allowFailure: true });
  if (result.error) return [];
  return String(result.stdout || "").split("\0").filter(Boolean)
    .map((path) => join(repository.path, path));
}

async function ensureWorkBranch(repository, device) {
  const branch = `noema/${safeDeviceName(device.name)}-${String(device.id).slice(0, 8)}`;
  if (await currentBranch(repository) === branch) return branch;
  if (await branchExists(repository, branch)) await git(repository, ["switch", branch]);
  else if (await hasHead(repository)) await git(repository, ["switch", "-c", branch]);
  else await git(repository, ["switch", "--orphan", branch]);
  return branch;
}

async function stagedChanges(repository) {
  const result = await git(repository, ["diff", "--cached", "--quiet"], { allowFailure: true });
  return Boolean(result.error);
}

async function stagedFileCount(repository) {
  const result = await git(repository, ["diff", "--cached", "--name-only", "-z"], { allowFailure: true });
  if (result.error) return 0;
  return String(result.stdout || "").split("\0").filter(Boolean).length;
}

async function commitIdentity(repository, device) {
  const [name, email] = await Promise.all([
    git(repository, ["config", "--get", "user.name"], { allowFailure: true }),
    git(repository, ["config", "--get", "user.email"], { allowFailure: true }),
  ]);
  const configuredName = String(name.stdout || "").trim();
  const configuredEmail = String(email.stdout || "").trim();
  if (configuredName && configuredEmail) return { name: configuredName, email: configuredEmail, fallback: false };
  return {
    name: `Noema (${device.name})`,
    email: `noema-${String(device.id).slice(0, 8)}@local`,
    fallback: true,
  };
}

export async function checkpointWikiRepository(rootValue, repositoryId, options = {}) {
  const root = expandNoemaPath(rootValue);
  const repository = await repositoryFromId(root, repositoryId);
  const device = await ensureNoemaDeviceIdentity(options);
  await writeSyncState(root, repository, { phase: "checkpointing" });
  try {
    const branch = await ensureWorkBranch(repository, device);
    await git(repository, ["add", "-A", "--", "."]);
    let committed = false;
    let changedFiles = 0;
    let identityFallback = false;
    if (await stagedChanges(repository)) {
      changedFiles = await stagedFileCount(repository);
      const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const identity = await commitIdentity(repository, device);
      identityFallback = identity.fallback;
      await git(repository, [
        "-c", `user.name=${identity.name}`,
        "-c", `user.email=${identity.email}`,
        "commit", "-m", String(options.message || `noema: checkpoint ${changedFiles} file${changedFiles === 1 ? "" : "s"} · ${at}`),
      ]);
      committed = true;
    }
    const head = await git(repository, ["rev-parse", "HEAD"], { allowFailure: true });
    const state = await writeSyncState(root, repository, {
      phase: "idle",
      branch,
      head: head.stdout.trim(),
      checkpointedAt: new Date().toISOString(),
      committed,
      changedFiles,
      identityFallback,
    });
    return { ok: true, type: "wiki-checkpoint", repository, ...state };
  } catch (error) {
    await writeSyncState(root, repository, {
      phase: "error",
      failedAt: new Date().toISOString(),
      error: String(error?.message || error),
    }).catch(() => {});
    throw error;
  }
}

async function remoteUrl(repository) {
  const result = await git(repository, ["remote", "get-url", "origin"], { allowFailure: true });
  return result.error ? "" : result.stdout.trim();
}

async function ensureOriginMain(repository, localHead) {
  const listed = await git(repository, ["ls-remote", "--heads", "origin"], { allowFailure: true });
  if (listed.error) {
    return { error: String(listed.stderr || listed.error.message).trim(), bootstrapped: false };
  }
  const heads = String(listed.stdout).split(/\r?\n/).map((line) => line.trim().split(/\s+/, 2)[1]).filter(Boolean);
  if (heads.includes("refs/heads/main")) return { error: "", bootstrapped: false };
  const unexpected = heads.filter((head) => !head.startsWith("refs/heads/noema/"));
  if (unexpected.length) {
    return {
      error: `origin has no main branch and contains unrelated branches: ${unexpected.join(", ")}`,
      bootstrapped: false,
    };
  }
  if (!await branchExists(repository, "main")) {
    await git(repository, ["branch", "main", localHead]);
  }
  const pushed = await git(
    repository,
    ["push", "origin", "refs/heads/main:refs/heads/main"],
    { allowFailure: true },
  );
  if (!pushed.error) return { error: "", bootstrapped: true };
  const raced = await git(
    repository,
    ["ls-remote", "--exit-code", "--heads", "origin", "refs/heads/main"],
    { allowFailure: true },
  );
  if (!raced.error) return { error: "", bootstrapped: false };
  return { error: String(pushed.stderr || pushed.error.message).trim(), bootstrapped: false };
}

function integrationBranch(device, repository) {
  return `noema-integration/${safeDeviceName(device.name)}-${String(repository.uid || device.id).slice(0, 8)}`;
}

function integrationPath(root, repository) {
  return join(root, ".noema", "worktrees", String(repository.uid || repository.id).replaceAll("/", "-"));
}

async function mergeInProgress(path) {
  const result = await execFileAsync("git", ["-C", path, "rev-parse", "-q", "--verify", "MERGE_HEAD"], {
    maxBuffer: 1024 * 1024,
  }).catch(() => null);
  return Boolean(result?.stdout?.trim());
}

async function conflictFiles(path) {
  const result = await execFileAsync("git", ["-C", path, "ls-files", "-u", "-z"], {
    maxBuffer: 1024 * 1024 * 16,
  }).catch(() => ({ stdout: "" }));
  const files = new Map();
  for (const entry of String(result.stdout).split("\0").filter(Boolean)) {
    const match = entry.match(/^(\d+)\s+([0-9a-f]+)\s+([123])\t(.+)$/);
    if (!match) continue;
    const pathValue = match[4];
    const current = files.get(pathValue) || { path: pathValue, stages: [] };
    current.stages.push(Number(match[3]));
    files.set(pathValue, current);
  }
  return [...files.values()].map((file) => ({
    ...file,
    kind: file.stages.length === 3 ? "text-or-binary" : "delete-modify",
  }));
}

async function prepareIntegrationWorktree(root, repository, device) {
  const path = integrationPath(root, repository);
  const branch = integrationBranch(device, repository);
  if (existsSync(path)) {
    if (await mergeInProgress(path)) return { path, branch, conflicted: true };
    await execFileAsync("git", ["-C", path, "reset", "--hard", "origin/main"]);
    return { path, branch, conflicted: false };
  }
  await mkdir(dirname(path), { recursive: true });
  await git(repository, ["worktree", "prune"]);
  await git(repository, ["worktree", "add", "-B", branch, path, "origin/main"]);
  return { path, branch, conflicted: false };
}

async function runSync(root, repository, options = {}) {
  const device = await ensureNoemaDeviceIdentity(options);
  const identity = await commitIdentity(repository, device);
  const headBefore = await currentHeadSha(repository);
  const checkpoint = await checkpointWikiRepository(root, repository.id, options);
  const checkpointState = {
    checkpointedAt: checkpoint.checkpointedAt,
    committed: checkpoint.committed,
    changedFiles: checkpoint.changedFiles,
  };
  if (!(await remoteUrl(repository))) {
    const changedPaths = await changedPathsBetween(repository, headBefore, checkpoint.head);
    return await writeSyncState(root, repository, {
      ...checkpointState,
      phase: "idle",
      branch: checkpoint.branch,
      head: checkpoint.head,
      changedPaths,
      localOnly: true,
      message: "No origin remote; local checkpoint completed",
    });
  }
  const bootstrap = await ensureOriginMain(repository, checkpoint.head);
  if (bootstrap.error) {
    return await writeSyncState(root, repository, {
      ...checkpointState,
      phase: "error",
      branch: checkpoint.branch,
      error: bootstrap.error,
    });
  }
  await writeSyncState(root, repository, { phase: "fetching", branch: checkpoint.branch });
  const fetch = await git(repository, ["fetch", "--prune", "origin", "main"], { allowFailure: true });
  if (fetch.error) {
    return await writeSyncState(root, repository, {
      ...checkpointState,
      phase: "error",
      branch: checkpoint.branch,
      error: String(fetch.stderr || fetch.error.message).trim(),
    });
  }
  const integration = await prepareIntegrationWorktree(root, repository, device);
  if (integration.conflicted) {
    return await writeSyncState(root, repository, {
      ...checkpointState,
      phase: "conflicted",
      branch: checkpoint.branch,
      integrationBranch: integration.branch,
      integrationPath: integration.path,
      conflicts: await conflictFiles(integration.path),
    });
  }
  await writeSyncState(root, repository, { phase: "merging", branch: checkpoint.branch });
  const merge = await execFileAsync(
    "git",
    ["-C", integration.path, "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "merge", "--no-edit", checkpoint.branch],
    { maxBuffer: 1024 * 1024 * 32 },
  ).catch((error) => ({ error, stdout: error.stdout || "", stderr: error.stderr || "" }));
  if (merge.error) {
    const conflicts = await conflictFiles(integration.path);
    if (conflicts.length) {
      return await writeSyncState(root, repository, {
        ...checkpointState,
        phase: "conflicted",
        branch: checkpoint.branch,
        integrationBranch: integration.branch,
        integrationPath: integration.path,
        conflicts,
      });
    }
    return await writeSyncState(root, repository, {
      ...checkpointState,
      phase: "error",
      branch: checkpoint.branch,
      error: String(merge.stderr || merge.error.message).trim(),
    });
  }
  await writeSyncState(root, repository, { phase: "pushing", branch: checkpoint.branch });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const push = await execFileAsync("git", ["-C", integration.path, "push", "origin", "HEAD:main"], {
      maxBuffer: 1024 * 1024 * 32,
    }).catch((error) => ({ error, stderr: error.stderr || "" }));
    if (!push.error) {
      await git(repository, ["merge", "--ff-only", integration.branch]);
      const head = await currentHeadSha(repository);
      const changedPaths = await changedPathsBetween(repository, headBefore, head);
      return await writeSyncState(root, repository, {
        ...checkpointState,
        phase: "idle",
        branch: checkpoint.branch,
        head,
        changedPaths,
        integrationBranch: integration.branch,
        lastSyncedAt: new Date().toISOString(),
        localOnly: false,
        bootstrappedMain: bootstrap.bootstrapped,
      });
    }
    if (attempt === 3) {
      return await writeSyncState(root, repository, {
        ...checkpointState,
        phase: "error",
        branch: checkpoint.branch,
        error: String(push.stderr || push.error.message).trim(),
      });
    }
    await git(repository, ["fetch", "origin", "main"]);
    await execFileAsync("git", ["-C", integration.path, "reset", "--hard", "origin/main"]);
    const retryMerge = await execFileAsync(
      "git",
      ["-C", integration.path, "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "merge", "--no-edit", checkpoint.branch],
      { maxBuffer: 1024 * 1024 * 32 },
    ).catch((error) => ({ error }));
    if (retryMerge.error) {
      return await writeSyncState(root, repository, {
        ...checkpointState,
        phase: "conflicted",
        branch: checkpoint.branch,
        integrationBranch: integration.branch,
        integrationPath: integration.path,
        conflicts: await conflictFiles(integration.path),
      });
    }
  }
}

export function syncWikiRepository(rootValue, repositoryId, options = {}) {
  const root = expandNoemaPath(rootValue);
  const key = `${root}\0${repositoryId}`;
  const active = repositoryQueues.get(key);
  if (active) return active;
  const next = (async () => {
    const repository = await repositoryFromId(root, repositoryId);
    try {
      return await runSync(root, repository, options);
    } catch (error) {
      return await writeSyncState(root, repository, {
        phase: "error",
        failedAt: new Date().toISOString(),
        error: String(error?.message || error),
      });
    }
  })();
  const tracked = next.finally(() => {
    if (repositoryQueues.get(key) === tracked) repositoryQueues.delete(key);
  });
  repositoryQueues.set(key, tracked);
  return tracked;
}

function contentKind(buffer) {
  return buffer.includes(0) ? "binary" : "text";
}

async function stageContent(worktree, stage, path) {
  const result = await execFileAsync("git", ["-C", worktree, "show", `:${stage}:${path}`], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 32,
  }).catch(() => ({ stdout: Buffer.alloc(0) }));
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || "");
}

export async function readWikiConflict(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const repository = await repositoryFromId(root, body.repositoryId);
  const worktree = integrationPath(root, repository);
  const path = String(body.path || "");
  if (!path || !await mergeInProgress(worktree)) throw apiError("No active merge conflict", 404);
  const [base, remoteMain, deviceBranch] = await Promise.all([
    stageContent(worktree, 1, path),
    stageContent(worktree, 2, path),
    stageContent(worktree, 3, path),
  ]);
  const kind = [base, remoteMain, deviceBranch].some((buffer) => contentKind(buffer) === "binary") ? "binary" : "text";
  const encode = (buffer) => kind === "text" ? buffer.toString("utf8") : buffer.toString("base64");
  return {
    ok: true,
    type: "wiki-conflict-file",
    repositoryId: repository.id,
    path,
    kind,
    base: encode(base),
    ours: encode(deviceBranch),
    theirs: encode(remoteMain),
  };
}

export async function resolveWikiConflict(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const repository = await repositoryFromId(root, body.repositoryId);
  const device = await ensureNoemaDeviceIdentity(body);
  const identity = await commitIdentity(repository, device);
  const worktree = integrationPath(root, repository);
  const headBefore = await currentHeadSha(repository);
  const path = String(body.path || "");
  const target = resolve(worktree, path);
  const targetRelative = relative(resolve(worktree), target);
  if (
    !path
    || targetRelative === ""
    || targetRelative === "."
    || targetRelative === ".."
    || targetRelative.startsWith(`..${sep}`)
  ) throw apiError("Invalid conflict path");
  const choice = String(body.choice || "result");
  if (choice === "delete") {
    await rm(target, { recursive: true, force: true });
    await execFileAsync("git", ["-C", worktree, "rm", "-f", "--ignore-unmatch", "--", path]);
  } else if (choice === "ours" || choice === "theirs") {
    const gitSide = choice === "ours" ? "theirs" : "ours";
    await execFileAsync("git", ["-C", worktree, "checkout", `--${gitSide}`, "--", path]);
    await execFileAsync("git", ["-C", worktree, "add", "--", path]);
  } else {
    await mkdir(dirname(target), { recursive: true });
    const data = body.encoding === "base64" ? Buffer.from(String(body.result || ""), "base64") : String(body.result || "");
    await writeFile(target, data);
    await execFileAsync("git", ["-C", worktree, "add", "--", path]);
  }
  const remaining = await conflictFiles(worktree);
  if (remaining.length) {
    return await writeSyncState(root, repository, {
      phase: "conflicted",
      integrationPath: worktree,
      conflicts: remaining,
    });
  }
  await execFileAsync(
    "git",
    ["-C", worktree, "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "--no-edit"],
    { maxBuffer: 1024 * 1024 * 32 },
  );
  const integrationBranchName = (await execFileAsync("git", ["-C", worktree, "branch", "--show-current"])).stdout.trim();
  const push = await execFileAsync("git", ["-C", worktree, "push", "origin", "HEAD:main"], {
    maxBuffer: 1024 * 1024 * 32,
  }).catch((error) => ({ error, stderr: error.stderr || "" }));
  if (push.error) {
    return await writeSyncState(root, repository, {
      phase: "error",
      integrationPath: worktree,
      conflicts: [],
      error: String(push.stderr || push.error.message).trim(),
    });
  }
  await git(repository, ["merge", "--ff-only", integrationBranchName]);
  const head = await currentHeadSha(repository);
  const changedPaths = [...new Set([
    ...await changedPathsBetween(repository, headBefore, head),
    join(repository.path, path),
  ])];
  return await writeSyncState(root, repository, {
    phase: "idle",
    head,
    changedPaths,
    integrationPath: worktree,
    conflicts: [],
    lastSyncedAt: new Date().toISOString(),
    message: "Conflict resolved and pushed",
  });
}

export async function abortWikiConflict(rootValue, repositoryId) {
  const root = expandNoemaPath(rootValue);
  const repository = await repositoryFromId(root, repositoryId);
  const worktree = integrationPath(root, repository);
  if (await mergeInProgress(worktree)) {
    await execFileAsync("git", ["-C", worktree, "merge", "--abort"]);
  }
  return await writeSyncState(root, repository, { phase: "idle", conflicts: [], message: "Merge aborted" });
}

// Preserve the established desktop cadence: repositories synchronize on
// startup and roughly every six hours, not after each editor autosave.
export function defaultWikiSyncIntervalMs() {
  return 6 * 60 * 60 * 1000;
}
