import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { newNoemaId } from "../../shared/identity.mjs";
import { expandNoemaPath, repositoryFromId } from "./wiki-workspace.mjs";

const execFileAsync = promisify(execFile);
const repositoryQueues = new Map();
const DEFAULT_GIT_MAINTENANCE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_GIT_LOCK_STALE_MS = 10 * 60 * 1000;
const DEFAULT_REPOSITORY_LEASE_STALE_MS = 10 * 60 * 1000;
const DEFAULT_REPOSITORY_LEASE_HEARTBEAT_MS = 5_000;
const DEFAULT_REPOSITORY_LEASE_DEAD_GRACE_MS = 5_000;
const DEFAULT_REPOSITORY_LEASE_WAIT_MS = 250;
const DEFAULT_REPOSITORY_LEASE_POLL_MS = 40;
const DEFAULT_REPOSITORY_BUSY_RETRY_MS = 5_000;

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

function repositoryToken(repository) {
  return String(repository.uid || repository.id).replaceAll("/", "-");
}

function repositoryLeaseFile(root, repository) {
  return join(root, ".noema", "git-leases", `${repositoryToken(repository)}.json`);
}

function recoveredGitLockDirectory(root, repository) {
  return join(root, ".noema", "recovered-git-locks", repositoryToken(repository));
}

function timestampToken(value = new Date()) {
  return value.toISOString().replace(/[^0-9A-Za-z]+/g, "-").replace(/-+$/g, "");
}

function numericOption(options, key, fallback) {
  const value = Number(options?.[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function processIsAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function wait(delayMs) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function preserveRecoveryArtifact(root, repository, source, name) {
  const directory = recoveredGitLockDirectory(root, repository);
  await mkdir(directory, { recursive: true });
  const nonce = Math.random().toString(16).slice(2);
  const target = join(directory, `${timestampToken()}-${process.pid}-${nonce}-${name}`);
  await rename(source, target);
  return target;
}

async function inspectRepositoryLease(file, staleMs, deadGraceMs) {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { stale: false, owner: null, ageMs: 0 };
    throw error;
  }
  const owner = await readJsonFile(file);
  const ageMs = Math.max(0, Date.now() - info.mtimeMs);
  const ownerPid = Number(owner?.pid);
  const sameHost = owner?.host && owner.host === hostname();
  const stale = sameHost && Number.isInteger(ownerPid) && ownerPid > 0
    ? !processIsAlive(ownerPid) && ageMs >= deadGraceMs
    : ageMs >= staleMs;
  return { stale, owner, ageMs };
}

async function acquireRepositoryLease(root, repository, operation, options = {}) {
  const file = repositoryLeaseFile(root, repository);
  const waitMs = numericOption(options, "repositoryLeaseWaitMs", DEFAULT_REPOSITORY_LEASE_WAIT_MS);
  const pollMs = Math.max(10, numericOption(options, "repositoryLeasePollMs", DEFAULT_REPOSITORY_LEASE_POLL_MS));
  const staleMs = numericOption(options, "repositoryLeaseStaleMs", DEFAULT_REPOSITORY_LEASE_STALE_MS);
  const deadGraceMs = numericOption(
    options,
    "repositoryLeaseDeadGraceMs",
    DEFAULT_REPOSITORY_LEASE_DEAD_GRACE_MS,
  );
  const deadline = Date.now() + waitMs;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  let recoveredOwner = null;
  await mkdir(dirname(file), { recursive: true });
  for (;;) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          schema: 1,
          token,
          pid: process.pid,
          host: hostname(),
          operation,
          repositoryId: repository.id,
          startedAt: new Date().toISOString(),
        }, null, 2)}\n`);
      } catch (error) {
        await handle.close();
        await rm(file, { force: true }).catch(() => {});
        throw error;
      }
      return { file, token, recoveredOwner, handle };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lease = await inspectRepositoryLease(file, staleMs, deadGraceMs);
      if (lease.stale) {
        try {
          const backup = await preserveRecoveryArtifact(root, repository, file, "repository-lease.json");
          recoveredOwner = { ...lease, backup };
          continue;
        } catch (recoveryError) {
          if (recoveryError?.code === "ENOENT") continue;
          throw recoveryError;
        }
      }
      if (Date.now() >= deadline) {
        const ownerOperation = String(lease.owner?.operation || "Git maintenance");
        throw apiError(
          `${ownerOperation} is already active for ${repository.id}; Noema will retry shortly`,
          409,
          "ERR_WIKI_SYNC_BUSY",
        );
      }
      await wait(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }
}

async function releaseRepositoryLease(lease) {
  if (!lease) return;
  await lease.handle?.close().catch(() => {});
  const current = await readJsonFile(lease.file);
  if (current?.token !== lease.token) return;
  await rm(lease.file, { force: true });
}

async function recoverOrphanIndexLockAtPath(root, repository, worktreePath, lease, options = {}, label = "primary") {
  const gitDirResult = await execFileAsync(
    "git",
    ["-C", worktreePath, "rev-parse", "--absolute-git-dir"],
    { maxBuffer: 1024 * 1024 },
  ).catch((error) => ({ error, stdout: "" }));
  if (gitDirResult.error) return null;
  const lock = join(String(gitDirResult.stdout || "").trim(), "index.lock");
  let info;
  try {
    info = await stat(lock);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const ageMs = Math.max(0, Date.now() - info.mtimeMs);
  const staleMs = numericOption(options, "gitLockStaleMs", DEFAULT_GIT_LOCK_STALE_MS);
  const ownedByDeadNoema = Boolean(lease?.recoveredOwner?.owner?.pid);
  // Noema's lease cannot exclude an external Git client. A non-empty lock may
  // still be receiving index data, so it is never eligible for recovery.
  if (info.size !== 0 || (!ownedByDeadNoema && ageMs < staleMs)) {
    throw apiError(
      `Git index is actively locked for ${repository.id}; Noema will retry shortly`,
      409,
      "ERR_WIKI_SYNC_BUSY",
    );
  }
  const backup = await preserveRecoveryArtifact(root, repository, lock, `${label}-index.lock`);
  return {
    kind: "orphan-index-lock",
    recoveredAt: new Date().toISOString(),
    ageMs,
    size: info.size,
    backup: relative(root, backup),
    previousOwnerPid: Number(lease?.recoveredOwner?.owner?.pid) || undefined,
  };
}

async function recoverOrphanIndexLock(root, repository, lease, options = {}) {
  return await recoverOrphanIndexLockAtPath(root, repository, repository.path, lease, options);
}

async function withRepositoryLease(root, repository, operation, options, task) {
  const lease = await acquireRepositoryLease(root, repository, operation, options);
  const heartbeatMs = Math.max(250, numericOption(
    options,
    "repositoryLeaseHeartbeatMs",
    DEFAULT_REPOSITORY_LEASE_HEARTBEAT_MS,
  ));
  const heartbeat = setInterval(() => {
    const now = new Date();
    void lease.handle.utimes(now, now).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    const recoveredGitLock = await recoverOrphanIndexLock(root, repository, lease, options);
    return await task(recoveredGitLock, lease);
  } finally {
    clearInterval(heartbeat);
    await releaseRepositoryLease(lease).catch(() => {});
  }
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
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temporary, file);
  return payload;
}

function transientSyncState(repository, state) {
  return {
    schema: 1,
    repositoryId: repository.id,
    repositoryUid: repository.uid,
    updatedAt: new Date().toISOString(),
    ...state,
  };
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

function gitMaintenanceThresholdBytes(options = {}) {
  const configured = Number(options.gitMaintenanceThresholdBytes);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_GIT_MAINTENANCE_BYTES;
}

async function gitObjectBytes(repository) {
  const result = await git(repository, ["count-objects", "-v"], { allowFailure: true });
  if (result.error) return 0;
  const sizes = new Map(String(result.stdout || "").split(/\r?\n/).map((line) => {
    const separator = line.indexOf(":");
    return separator < 0 ? ["", 0] : [line.slice(0, separator), Number(line.slice(separator + 1).trim()) || 0];
  }));
  return 1024 * ((sizes.get("size") || 0) + (sizes.get("size-pack") || 0) + (sizes.get("size-garbage") || 0));
}

async function checkedOutBranches(repository) {
  const result = await git(repository, ["worktree", "list", "--porcelain"], { allowFailure: true });
  if (result.error) return new Set();
  return new Set(Array.from(String(result.stdout || "").matchAll(/^branch refs\/heads\/(.+)$/gm), (match) => match[1]));
}

async function maintenanceBaseRef(repository) {
  for (const ref of ["refs/remotes/origin/main", "refs/heads/main", "refs/heads/master"]) {
    const result = await git(repository, ["show-ref", "--verify", "--quiet", ref], { allowFailure: true });
    if (!result.error) return ref;
  }
  return "";
}

async function maintainWikiRepositoryGit(repository, options = {}) {
  const beforeBytes = await gitObjectBytes(repository);
  if (beforeBytes < gitMaintenanceThresholdBytes(options)) return { checked: true, beforeBytes, cleanedBranches: [] };
  await git(repository, ["worktree", "prune"], { allowFailure: true });
  const [baseRef, protectedBranches, candidatesResult] = await Promise.all([
    maintenanceBaseRef(repository),
    checkedOutBranches(repository),
    git(repository, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/noema",
      "refs/heads/noema-integration",
    ], { allowFailure: true }),
  ]);
  if (!baseRef || candidatesResult.error) return { checked: true, beforeBytes, cleanedBranches: [] };
  const candidates = String(candidatesResult.stdout || "").split(/\r?\n/).map((branch) => branch.trim()).filter(Boolean);
  const cleanedBranches = [];
  for (const branch of candidates) {
    if (branch === "main" || branch === "master" || protectedBranches.has(branch)) continue;
    const merged = await git(repository, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, baseRef], { allowFailure: true });
    if (merged.error) continue;
    const deleted = await git(repository, ["branch", "-D", "--", branch], { allowFailure: true });
    if (!deleted.error) cleanedBranches.push(branch);
  }
  if (cleanedBranches.length > 0) await git(repository, ["gc"], { allowFailure: true });
  return { checked: true, beforeBytes, cleanedBranches };
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

async function checkpointWikiRepositoryUnlocked(root, repository, options = {}, recoveredGitLock = null) {
  const device = await ensureNoemaDeviceIdentity(options);
  await writeSyncState(root, repository, {
    phase: "checkpointing",
    ...(recoveredGitLock ? { recoveredGitLock } : {}),
  });
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
      ...(recoveredGitLock ? {
        recoveredGitLock,
        message: "Recovered an orphaned Git index lock before checkpointing",
      } : {}),
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

export async function checkpointWikiRepository(rootValue, repositoryId, options = {}) {
  const root = expandNoemaPath(rootValue);
  const repository = await repositoryFromId(root, repositoryId);
  return await withRepositoryLease(root, repository, "checkpoint", options, (recoveredGitLock) => (
    checkpointWikiRepositoryUnlocked(root, repository, options, recoveredGitLock)
  ));
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

async function prepareIntegrationWorktree(root, repository, device, lease, options = {}) {
  const path = integrationPath(root, repository);
  const branch = integrationBranch(device, repository);
  if (existsSync(path)) {
    await recoverOrphanIndexLockAtPath(root, repository, path, lease, options, "integration");
    if (await mergeInProgress(path)) return { path, branch, conflicted: true };
    await execFileAsync("git", ["-C", path, "reset", "--hard", "origin/main"]);
    return { path, branch, conflicted: false };
  }
  await mkdir(dirname(path), { recursive: true });
  await git(repository, ["worktree", "prune"]);
  await git(repository, ["worktree", "add", "-B", branch, path, "origin/main"]);
  return { path, branch, conflicted: false };
}

async function runSync(root, repository, options = {}, recoveredGitLock = null, lease = null) {
  const device = await ensureNoemaDeviceIdentity(options);
  const identity = await commitIdentity(repository, device);
  const headBefore = await currentHeadSha(repository);
  const checkpoint = await checkpointWikiRepositoryUnlocked(root, repository, options, recoveredGitLock);
  const checkpointState = {
    checkpointedAt: checkpoint.checkpointedAt,
    committed: checkpoint.committed,
    changedFiles: checkpoint.changedFiles,
    ...(checkpoint.recoveredGitLock ? {
      recoveredGitLock: checkpoint.recoveredGitLock,
      message: checkpoint.message,
    } : {}),
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
  const integration = await prepareIntegrationWorktree(root, repository, device, lease, options);
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
    let result;
    try {
      result = await withRepositoryLease(root, repository, "sync", options, async (recoveredGitLock, lease) => {
        const synced = await runSync(root, repository, options, recoveredGitLock, lease);
        if (synced?.phase === "idle") await maintainWikiRepositoryGit(repository, options).catch(() => {});
        return synced;
      });
    } catch (error) {
      if (error?.code === "ERR_WIKI_SYNC_BUSY") {
        // Do not overwrite the durable state while its owning host is still
        // updating it. Waiting is a transient scheduler result.
        result = transientSyncState(repository, {
          phase: "waiting",
          retryable: true,
          retryAfterMs: numericOption(options, "repositoryBusyRetryMs", DEFAULT_REPOSITORY_BUSY_RETRY_MS),
          error: String(error?.message || error),
        });
      } else {
        result = await writeSyncState(root, repository, {
          phase: "error",
          failedAt: new Date().toISOString(),
          error: String(error?.message || error),
        });
      }
    }
    return result;
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

async function resolveWikiConflictUnlocked(root, repository, body = {}, recoveredGitLock = null, lease = null) {
  const device = await ensureNoemaDeviceIdentity(body);
  const identity = await commitIdentity(repository, device);
  const worktree = integrationPath(root, repository);
  const recoveredIntegrationLock = await recoverOrphanIndexLockAtPath(
    root,
    repository,
    worktree,
    lease,
    body,
    "integration",
  );
  const recovery = recoveredGitLock || recoveredIntegrationLock;
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
    message: recovery
      ? "Recovered an orphaned Git index lock; conflict resolved and pushed"
      : "Conflict resolved and pushed",
    ...(recovery ? { recoveredGitLock: recovery } : {}),
  });
}

export async function resolveWikiConflict(rootValue, body = {}) {
  const root = expandNoemaPath(rootValue);
  const repository = await repositoryFromId(root, body.repositoryId);
  return await withRepositoryLease(root, repository, "resolve-conflict", body, (recoveredGitLock, lease) => (
    resolveWikiConflictUnlocked(root, repository, body, recoveredGitLock, lease)
  ));
}

async function abortWikiConflictUnlocked(root, repository, options = {}, recoveredGitLock = null, lease = null) {
  const worktree = integrationPath(root, repository);
  const recoveredIntegrationLock = await recoverOrphanIndexLockAtPath(
    root,
    repository,
    worktree,
    lease,
    options,
    "integration",
  );
  const recovery = recoveredGitLock || recoveredIntegrationLock;
  if (await mergeInProgress(worktree)) {
    await execFileAsync("git", ["-C", worktree, "merge", "--abort"]);
  }
  return await writeSyncState(root, repository, {
    phase: "idle",
    conflicts: [],
    message: recovery ? "Recovered an orphaned Git index lock; merge aborted" : "Merge aborted",
    ...(recovery ? { recoveredGitLock: recovery } : {}),
  });
}

export async function abortWikiConflict(rootValue, repositoryId) {
  const root = expandNoemaPath(rootValue);
  const repository = await repositoryFromId(root, repositoryId);
  return await withRepositoryLease(root, repository, "abort-conflict", {}, (recoveredGitLock, lease) => (
    abortWikiConflictUnlocked(root, repository, {}, recoveredGitLock, lease)
  ));
}

// Repositories synchronize on startup and roughly once per day, not after
// each editor autosave.
export function defaultWikiSyncIntervalMs() {
  return 24 * 60 * 60 * 1000;
}

export function defaultWikiGitMaintenanceBytes() {
  return DEFAULT_GIT_MAINTENANCE_BYTES;
}
