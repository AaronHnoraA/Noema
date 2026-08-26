import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { newNoemaId } from "../../shared/identity.mjs";
import { expandNoemaPath, repositoryFromId } from "./wiki-workspace.mjs";

const execFileAsync = promisify(execFile);
const repositoryQueues = new Map();
let wikiSyncGitProvider = null;
const DEFAULT_GIT_MAINTENANCE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_GIT_LOCK_STALE_MS = 10 * 60 * 1000;
const DEFAULT_REPOSITORY_LEASE_STALE_MS = 10 * 60 * 1000;
const DEFAULT_REPOSITORY_LEASE_HEARTBEAT_MS = 5_000;
const DEFAULT_REPOSITORY_LEASE_DEAD_GRACE_MS = 5_000;
const DEFAULT_REPOSITORY_LEASE_WAIT_MS = 250;
const DEFAULT_REPOSITORY_LEASE_POLL_MS = 40;
const DEFAULT_REPOSITORY_BUSY_RETRY_MS = 5_000;
const DEFAULT_RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_NETWORK_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const SYNC_SCHEMA = 2;

export function configureWikiSyncGitProvider(provider = null) {
  wikiSyncGitProvider = provider && typeof provider === "object" ? provider : null;
}

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

function syncOperationId() {
  return `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

function transactionState(state = {}) {
  return Object.fromEntries([
    "operationId",
    "snapshotHead",
    "remoteHead",
    "integrationHead",
    "publishedHead",
    "integrationBranch",
    "integrationPath",
    "branch",
    "checkpointSource",
    "transportSource",
    "recoveryArtifacts",
  ].filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
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
    schema: SYNC_SCHEMA,
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
    schema: SYNC_SCHEMA,
    repositoryId: repository.id,
    repositoryUid: repository.uid,
    updatedAt: new Date().toISOString(),
    ...state,
  };
}

async function storedWikiSyncState(root, repository) {
  try {
    return JSON.parse(await readFile(stateFile(root, repository), "utf8"));
  } catch {
    return null;
  }
}

export async function readWikiSyncState(rootValue, repositoryId = "") {
  const root = expandNoemaPath(rootValue);
  if (repositoryId) {
    const repository = await repositoryFromId(root, repositoryId);
    const stored = await storedWikiSyncState(root, repository);
    if (stored) return stored;
    else {
      return {
        schema: SYNC_SCHEMA,
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

async function ensureWorkBranch(root, repository, device) {
  const branch = `noema/${safeDeviceName(device.name)}-${String(device.id).slice(0, 8)}`;
  if (await currentBranch(repository) === branch) return { branch, recoveryArtifact: null };
  let recoveryArtifact = null;
  if (await branchExists(repository, branch)) {
    const switched = await git(repository, ["switch", branch], { allowFailure: true });
    if (switched.error) {
      const classified = classifyGitFailure(switched);
      if (classified.errorKind !== "workspace") throw apiError(classified.message, 409);
      const targetHead = (await git(repository, ["rev-parse", branch])).stdout.trim();
      recoveryArtifact = await quarantineWorkingFiles(
        root,
        repository,
        repository.path,
        await primaryCollisionPaths(repository, targetHead),
        "primary",
      );
      await git(repository, ["switch", branch]);
    }
  } else if (await hasHead(repository)) await git(repository, ["switch", "-c", branch]);
  else await git(repository, ["switch", "--orphan", branch]);
  return { branch, recoveryArtifact };
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
  const persistState = options.persistState !== false;
  if (persistState) {
    await writeSyncState(root, repository, {
      phase: "checkpointing",
      ...(recoveredGitLock ? { recoveredGitLock } : {}),
    });
  }
  try {
    const workBranch = await ensureWorkBranch(root, repository, device);
    const branch = workBranch.branch;
    let committed = false;
    let changedFiles = 0;
    let identityFallback = false;
    let headValue = "";
    let source = "node-vaultgit";
    if (typeof wikiSyncGitProvider?.owns === "function"
        && wikiSyncGitProvider.owns(repository.path)
        && typeof wikiSyncGitProvider.checkpoint === "function") {
      const checkpoint = await wikiSyncGitProvider.checkpoint(repository.path, {
        branch,
        message: String(options.message || ""),
        deviceName: String(device.name || ""),
        deviceId: String(device.id || ""),
      });
      committed = checkpoint.committed;
      changedFiles = checkpoint.changedFiles;
      identityFallback = checkpoint.identityFallback;
      headValue = checkpoint.head;
      source = checkpoint.source;
    } else {
      await git(repository, ["add", "-A", "--", "."]);
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
      headValue = head.stdout.trim();
    }
    const payload = {
      phase: "idle",
      branch,
      head: headValue,
      checkpointedAt: new Date().toISOString(),
      committed,
      changedFiles,
      identityFallback,
      source,
      ...(workBranch.recoveryArtifact ? { recoveryArtifacts: [workBranch.recoveryArtifact] } : {}),
      ...(recoveredGitLock ? {
        recoveredGitLock,
        message: "Recovered an orphaned Git index lock before checkpointing",
      } : {}),
    };
    const state = persistState
      ? await writeSyncState(root, repository, payload)
      : transientSyncState(repository, payload);
    return { ok: true, type: "wiki-checkpoint", repository, ...state };
  } catch (error) {
    if (persistState) {
      await writeSyncState(root, repository, {
        phase: "error",
        failedAt: new Date().toISOString(),
        error: String(error?.message || error),
      }).catch(() => {});
    }
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

function originMainTransportProvider(repository) {
  if (typeof wikiSyncGitProvider?.owns !== "function" || !wikiSyncGitProvider.owns(repository.path)) return null;
  if (typeof wikiSyncGitProvider.ensureMain !== "function"
      || typeof wikiSyncGitProvider.fetchMain !== "function"
      || typeof wikiSyncGitProvider.pushMain !== "function") return null;
  return wikiSyncGitProvider;
}

function gitFailureMessage(value) {
  return String(value?.stderr || value?.error?.stderr || value?.message || value?.error?.message || value || "Git command failed").trim();
}

function classifyGitFailure(value) {
  const message = gitFailureMessage(value);
  const lower = message.toLowerCase();
  if (/non-fast-forward|fetch first|failed to push some refs|stale info/.test(lower)) {
    return { errorKind: "remote-race", retryable: true, message };
  }
  if (/authentication failed|permission denied \(publickey\)|could not read username|terminal prompts disabled|access denied/.test(lower)) {
    return { errorKind: "authentication", retryable: false, actionRequired: "Check the origin credentials and retry sync", message };
  }
  if (/does not appear to be a git repository|repository .* not found|no such remote|couldn't find remote ref|has no main branch|no configured push destination/.test(lower)) {
    return { errorKind: "configuration", retryable: false, actionRequired: "Check the origin remote and its main branch", message };
  }
  if (/could not resolve host|connection (timed out|reset|refused)|network is unreachable|remote end hung up|http 5\d\d|operation timed out|temporary failure/.test(lower)) {
    return { errorKind: "network", retryable: true, message };
  }
  if (/untracked working tree files would be overwritten|local changes .* would be overwritten|would be overwritten by (merge|checkout)|unable to create .*index\.lock/.test(lower)) {
    return { errorKind: "workspace", retryable: true, message };
  }
  return { errorKind: "internal", retryable: false, actionRequired: "Open the repository status and retry after reviewing the Git error", message };
}

function networkRetryDelay(previousState = {}, options = {}) {
  const configured = Array.isArray(options.networkRetryDelaysMs)
    ? options.networkRetryDelaysMs.map(Number).filter((value) => Number.isFinite(value) && value >= 0)
    : DEFAULT_NETWORK_RETRY_DELAYS_MS;
  const delays = configured.length ? configured : DEFAULT_NETWORK_RETRY_DELAYS_MS;
  const failureCount = Math.max(1, Number(previousState.consecutiveFailures || 0) + 1);
  return {
    failureCount,
    retryAfterMs: delays[Math.min(failureCount - 1, delays.length - 1)],
  };
}

function recoveryBaseDirectory(root) {
  return join(root, ".noema", "recovery", "git");
}

async function gitPathList(worktree, args) {
  const result = await execFileAsync("git", ["-C", worktree, ...args], {
    maxBuffer: 1024 * 1024 * 32,
  }).catch(() => ({ stdout: "" }));
  return String(result.stdout || "").split("\0").filter(Boolean);
}

async function unexpectedWorktreePaths(worktree) {
  const groups = await Promise.all([
    gitPathList(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
    gitPathList(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
    gitPathList(worktree, ["diff", "--name-only", "-z", "--"]),
    gitPathList(worktree, ["diff", "--cached", "--name-only", "-z", "--"]),
  ]);
  const ordered = [...new Set(groups.flat())].sort((left, right) => left.length - right.length);
  return ordered.filter((path, index) => !ordered.slice(0, index).some((parent) => path.startsWith(`${parent}${sep}`)));
}

async function filesystemWorkingPaths(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const paths = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    const relativeFile = relative(root, file);
    if (!relativeFile || relativeFile === ".git") continue;
    if (entry.isDirectory()) paths.push(...await filesystemWorkingPaths(root, file));
    else paths.push(relativeFile);
  }
  return paths;
}

async function validGitWorktree(path) {
  const result = await execFileAsync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], {
    maxBuffer: 1024 * 1024,
  }).catch(() => ({ stdout: "" }));
  return String(result.stdout || "").trim() === "true";
}

async function quarantineWorkingFiles(root, repository, worktree, paths, source) {
  const safePaths = [...new Set(paths.map(String).filter(Boolean))];
  if (safePaths.length === 0) return null;
  const createdAt = new Date().toISOString();
  const batch = `${timestampToken()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const directory = join(recoveryBaseDirectory(root), repositoryToken(repository), batch);
  const files = [];
  for (const path of safePaths) {
    const sourceFile = resolve(worktree, path);
    const sourceRelative = relative(resolve(worktree), sourceFile);
    if (!sourceRelative || sourceRelative === ".." || sourceRelative.startsWith(`..${sep}`)) continue;
    try {
      await lstat(sourceFile);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const target = join(directory, "files", sourceRelative);
    await mkdir(dirname(target), { recursive: true });
    await rename(sourceFile, target);
    files.push(sourceRelative);
  }
  if (files.length === 0) return null;
  const artifact = {
    kind: "working-files",
    source,
    createdAt,
    path: relative(root, directory),
    files,
  };
  await writeFile(join(directory, "recovery.json"), `${JSON.stringify({
    schema: 1,
    repositoryId: repository.id,
    ...artifact,
  }, null, 2)}\n`, "utf8");
  return artifact;
}

async function pruneWikiGitRecovery(root, options = {}) {
  const retentionMs = numericOption(options, "recoveryRetentionMs", DEFAULT_RECOVERY_RETENTION_MS);
  const base = recoveryBaseDirectory(root);
  let repositories = [];
  try {
    repositories = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const repositoryEntry of repositories) {
    if (!repositoryEntry.isDirectory()) continue;
    const repositoryDirectory = join(base, repositoryEntry.name);
    const batches = await readdir(repositoryDirectory, { withFileTypes: true }).catch(() => []);
    for (const batch of batches) {
      if (!batch.isDirectory()) continue;
      const directory = join(repositoryDirectory, batch.name);
      const info = await stat(directory).catch(() => null);
      if (!info || Date.now() - info.mtimeMs <= retentionMs) continue;
      await rm(directory, { recursive: true, force: true });
      removed.push(relative(root, directory));
    }
    const remaining = await readdir(repositoryDirectory).catch(() => ["unknown"]);
    if (remaining.length === 0) await rm(repositoryDirectory, { recursive: true, force: true });
  }
  return removed;
}

async function ensureOriginMain(repository, localHead, provider = null) {
  if (provider) {
    try {
      const result = await provider.ensureMain(repository.path, localHead);
      return { error: "", bootstrapped: result.bootstrapped };
    } catch (error) {
      return { error: gitFailureMessage(error), bootstrapped: false };
    }
  }
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

async function fetchOriginMain(repository, provider = null, prune = false) {
  if (provider) {
    try {
      const result = await provider.fetchMain(repository.path);
      return { remoteHead: result.remoteHead };
    } catch (error) {
      return { error, stderr: gitFailureMessage(error) };
    }
  }
  const args = ["fetch", ...(prune ? ["--prune"] : []), "origin", "main"];
  const fetched = await git(repository, args, { allowFailure: true });
  if (fetched.error) return fetched;
  const remoteHead = (await git(repository, ["rev-parse", "refs/remotes/origin/main"])).stdout.trim();
  return { remoteHead };
}

async function pushOriginMain(repository, worktree, commit, provider = null) {
  if (provider) {
    try {
      await provider.pushMain(repository.path, commit);
      return {};
    } catch (error) {
      return { error, stderr: gitFailureMessage(error) };
    }
  }
  return await execFileAsync("git", ["-C", worktree, "push", "origin", `${commit}:refs/heads/main`], {
    maxBuffer: 1024 * 1024 * 32,
  }).catch((error) => ({ error, stderr: error.stderr || "" }));
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

async function conflictFiles(path, context = {}) {
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
    oursStage: Number(context.oursStage) === 3 ? 3 : 2,
    theirsStage: Number(context.theirsStage) === 2 ? 2 : 3,
    oursLabel: String(context.oursLabel || "Your local contribution"),
    theirsLabel: String(context.theirsLabel || "Remote main"),
  }));
}

async function integrationWorktreeHead(path) {
  const result = await execFileAsync("git", ["-C", path, "rev-parse", "HEAD"], {
    maxBuffer: 1024 * 1024,
  }).catch(() => ({ stdout: "" }));
  return String(result.stdout || "").trim();
}

async function refIsAncestor(repository, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  const result = await git(repository, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true });
  return !result.error;
}

function conflictContextFromState(state = {}) {
  const first = Array.isArray(state.conflicts) ? state.conflicts[0] : null;
  if (first?.oursStage || first?.theirsStage) return first;
  if (Number(state.schema || 1) < SYNC_SCHEMA) {
    return {
      oursStage: 3,
      theirsStage: 2,
      oursLabel: "Your local contribution",
      theirsLabel: "Remote main",
    };
  }
  return {};
}

async function prepareIntegrationWorktree(root, repository, device, startHead, lease, options = {}) {
  const path = integrationPath(root, repository);
  const branch = integrationBranch(device, repository);
  let recoveryArtifact = null;
  if (existsSync(path)) {
    await recoverOrphanIndexLockAtPath(root, repository, path, lease, options, "integration");
    if (await mergeInProgress(path)) return { path, branch, conflicted: true };
    const worktreeIsValid = await validGitWorktree(path);
    recoveryArtifact = await quarantineWorkingFiles(
      root,
      repository,
      path,
      worktreeIsValid ? await unexpectedWorktreePaths(path) : await filesystemWorkingPaths(path),
      "integration",
    );
    await git(repository, ["worktree", "remove", "--force", path], { allowFailure: true });
    await rm(path, { recursive: true, force: true });
  }
  await mkdir(dirname(path), { recursive: true });
  await git(repository, ["worktree", "prune"]);
  await git(repository, ["worktree", "add", "-B", branch, path, startHead]);
  return { path, branch, conflicted: false, recoveryArtifact };
}

async function mergeIntoIntegration(path, ref, identity, context) {
  const merge = await execFileAsync(
    "git",
    ["-C", path, "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "merge", "--no-edit", ref],
    { maxBuffer: 1024 * 1024 * 32 },
  ).catch((error) => ({ error, stdout: error.stdout || "", stderr: error.stderr || "" }));
  if (!merge.error) return { ok: true, head: await integrationWorktreeHead(path), conflicts: [] };
  const conflicts = await conflictFiles(path, context);
  return { ok: false, merge, conflicts };
}

async function primaryCollisionPaths(repository, targetHead) {
  const current = await currentHeadSha(repository);
  if (!current || !targetHead || current === targetHead) return [];
  const changed = await gitPathList(repository.path, ["diff", "--name-only", "-z", current, targetHead, "--"]);
  const collisions = new Set();
  for (const path of changed) {
    const parts = path.split(sep);
    for (let length = 1; length <= parts.length; length++) {
      const candidate = parts.slice(0, length).join(sep);
      if (!existsSync(join(repository.path, candidate))) continue;
      const tracked = await git(repository, ["ls-files", "--error-unmatch", "--", candidate], { allowFailure: true });
      if (tracked.error) collisions.add(candidate);
      break;
    }
  }
  return [...collisions];
}

async function applyPublishedHead(root, repository, publishedHead, options = {}) {
  const current = await currentHeadSha(repository);
  if (current === publishedHead) return { applied: true, head: current, recoveryArtifact: null };
  if (!await refIsAncestor(repository, current, publishedHead)) {
    return { applied: false, reason: "Local device history advanced while the remote result was being published" };
  }
  const recoveryArtifact = await quarantineWorkingFiles(
    root,
    repository,
    repository.path,
    await primaryCollisionPaths(repository, publishedHead),
    "primary",
  );
  const applied = await git(repository, ["merge", "--ff-only", publishedHead], { allowFailure: true });
  if (applied.error) {
    return { applied: false, reason: gitFailureMessage(applied), recoveryArtifact };
  }
  return { applied: true, head: await currentHeadSha(repository), recoveryArtifact };
}

function recoveryArtifacts(...values) {
  const cutoff = Date.now() - DEFAULT_RECOVERY_RETENTION_MS;
  return values.flat().filter((artifact) => {
    if (!artifact) return false;
    const createdAt = Date.parse(String(artifact.createdAt || ""));
    return !Number.isFinite(createdAt) || createdAt >= cutoff;
  });
}

async function runSyncTestHook(options, name, payload) {
  const hook = options?.testHooks?.[name];
  if (typeof hook === "function") await hook(payload);
}

async function writeGitFailureState(root, repository, previousState, baseState, failure, options = {}) {
  const classified = classifyGitFailure(failure);
  if (classified.errorKind === "network") {
    const retry = networkRetryDelay(previousState, options);
    return await writeSyncState(root, repository, {
      ...baseState,
      phase: "waiting",
      error: classified.message,
      errorKind: classified.errorKind,
      retryable: true,
      retryAfterMs: retry.retryAfterMs,
      nextRetryAt: new Date(Date.now() + retry.retryAfterMs).toISOString(),
      consecutiveFailures: retry.failureCount,
      reportError: retry.failureCount === 1,
    });
  }
  if (classified.errorKind === "internal" && previousState.errorKind !== "internal") {
    return await writeSyncState(root, repository, {
      ...baseState,
      phase: "waiting",
      error: classified.message,
      errorKind: "internal",
      retryable: true,
      retryAfterMs: 0,
      nextRetryAt: new Date().toISOString(),
      consecutiveFailures: 1,
      reportError: false,
    });
  }
  return await writeSyncState(root, repository, {
    ...baseState,
    phase: classified.retryable ? "waiting" : "error",
    error: classified.message,
    errorKind: classified.errorKind,
    retryable: classified.retryable,
    retryAfterMs: classified.retryable ? DEFAULT_REPOSITORY_BUSY_RETRY_MS : undefined,
    nextRetryAt: classified.retryable
      ? new Date(Date.now() + DEFAULT_REPOSITORY_BUSY_RETRY_MS).toISOString()
      : undefined,
    actionRequired: classified.actionRequired,
    consecutiveFailures: Math.max(1, Number(previousState.consecutiveFailures || 0) + 1),
    reportError: !classified.retryable,
  });
}

async function runSync(root, repository, options = {}, recoveredGitLock = null, lease = null) {
  let previousState = await storedWikiSyncState(root, repository) || {};
  const device = await ensureNoemaDeviceIdentity(options);
  const identity = await commitIdentity(repository, device);
  const existingIntegrationPath = integrationPath(root, repository);
  if (existsSync(existingIntegrationPath) && await mergeInProgress(existingIntegrationPath)) {
    const context = conflictContextFromState(previousState);
    const existingConflicts = await conflictFiles(existingIntegrationPath, context);
    if (existingConflicts.length) {
      return await writeSyncState(root, repository, {
        ...transactionState(previousState),
        phase: "conflicted",
        conflicts: existingConflicts,
        errorKind: "conflict",
        retryable: false,
      });
    }
    await execFileAsync(
      "git",
      ["-C", existingIntegrationPath, "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "--no-edit"],
      { maxBuffer: 1024 * 1024 * 32 },
    );
    previousState = await writeSyncState(root, repository, {
      ...transactionState(previousState),
      phase: "merging",
      integrationHead: await integrationWorktreeHead(existingIntegrationPath),
      conflicts: [],
    });
  }
  const existingIntegrationHead = existsSync(existingIntegrationPath)
    ? await integrationWorktreeHead(existingIntegrationPath)
    : "";
  const resumableIntegrationHead = previousState.integrationHead
    && previousState.integrationHead === existingIntegrationHead
    ? existingIntegrationHead
    : "";

  const headBefore = await currentHeadSha(repository);
  const operationId = syncOperationId();
  await writeSyncState(root, repository, {
    phase: "checkpointing",
    operationId,
    ...(recoveredGitLock ? { recoveredGitLock } : {}),
  });
  const checkpoint = await checkpointWikiRepositoryUnlocked(
    root,
    repository,
    { ...options, persistState: false },
    recoveredGitLock,
  );
  const checkpointState = {
    operationId,
    checkpointedAt: checkpoint.checkpointedAt,
    committed: checkpoint.committed,
    changedFiles: checkpoint.changedFiles,
    branch: checkpoint.branch,
    snapshotHead: checkpoint.head,
    checkpointSource: checkpoint.source,
    ...(checkpoint.recoveryArtifacts?.length ? { recoveryArtifacts: checkpoint.recoveryArtifacts } : {}),
    ...(checkpoint.recoveredGitLock ? {
      recoveredGitLock: checkpoint.recoveredGitLock,
      message: checkpoint.message,
    } : {}),
  };
  if (!(await remoteUrl(repository))) {
    const changedPaths = await changedPathsBetween(repository, headBefore, checkpoint.head);
    await pruneWikiGitRecovery(root, options).catch(() => {});
    return await writeSyncState(root, repository, {
      ...checkpointState,
      phase: "idle",
      head: checkpoint.head,
      changedPaths,
      localOnly: true,
      consecutiveFailures: 0,
      message: "No origin remote; local checkpoint completed",
    });
  }
  const transportProvider = originMainTransportProvider(repository);
  const remoteCheckpointState = {
    ...checkpointState,
    transportSource: transportProvider ? "kernel-vaultgit" : "node-vaultgit",
  };
  const bootstrap = await ensureOriginMain(repository, checkpoint.head, transportProvider);
  if (bootstrap.error) {
    return await writeGitFailureState(root, repository, previousState, remoteCheckpointState, bootstrap.error, options);
  }
  await writeSyncState(root, repository, { ...remoteCheckpointState, phase: "fetching" });
  const fetch = await fetchOriginMain(repository, transportProvider, true);
  if (fetch.error) {
    return await writeGitFailureState(root, repository, previousState, remoteCheckpointState, fetch, options);
  }
  const remoteHead = fetch.remoteHead;
  const baseState = { ...remoteCheckpointState, remoteHead };
  await writeSyncState(root, repository, { ...baseState, phase: "merging" });
  const integration = await prepareIntegrationWorktree(root, repository, device, checkpoint.head, lease, options);
  const artifacts = recoveryArtifacts(
    previousState.recoveryArtifacts,
    checkpoint.recoveryArtifacts,
    integration.recoveryArtifact,
  );
  const integrationState = {
    ...baseState,
    integrationBranch: integration.branch,
    integrationPath: integration.path,
    ...(artifacts.length ? { recoveryArtifacts: artifacts } : {}),
  };
  if (integration.conflicted) {
    return await writeSyncState(root, repository, {
      ...integrationState,
      phase: "conflicted",
      conflicts: await conflictFiles(integration.path, conflictContextFromState(previousState)),
      errorKind: "conflict",
      retryable: false,
    });
  }
  if (resumableIntegrationHead && !await refIsAncestor(repository, resumableIntegrationHead, checkpoint.head)) {
    const resumed = await mergeIntoIntegration(integration.path, resumableIntegrationHead, identity, {
      oursStage: 2,
      theirsStage: 3,
      oursLabel: "Your latest local contribution",
      theirsLabel: "Recovered sync result",
    });
    if (!resumed.ok) {
      if (resumed.conflicts.length) {
        return await writeSyncState(root, repository, {
          ...integrationState,
          phase: "conflicted",
          integrationHead: await integrationWorktreeHead(integration.path),
          conflicts: resumed.conflicts,
          errorKind: "conflict",
          retryable: false,
        });
      }
      return await writeGitFailureState(root, repository, previousState, integrationState, resumed.merge, options);
    }
  }
  const mergedRemote = await mergeIntoIntegration(integration.path, remoteHead, identity, {
    oursStage: 2,
    theirsStage: 3,
    oursLabel: "Your local contribution",
    theirsLabel: "Remote main",
  });
  if (!mergedRemote.ok) {
    if (mergedRemote.conflicts.length) {
      return await writeSyncState(root, repository, {
        ...integrationState,
        phase: "conflicted",
        integrationHead: await integrationWorktreeHead(integration.path),
        conflicts: mergedRemote.conflicts,
        errorKind: "conflict",
        retryable: false,
      });
    }
    return await writeGitFailureState(root, repository, previousState, integrationState, mergedRemote.merge, options);
  }

  const finalCheckpoint = await checkpointWikiRepositoryUnlocked(
    root,
    repository,
    { ...options, persistState: false },
    null,
  );
  if (!await refIsAncestor(repository, finalCheckpoint.head, mergedRemote.head)) {
    const mergedLatest = await mergeIntoIntegration(integration.path, finalCheckpoint.head, identity, {
      oursStage: 3,
      theirsStage: 2,
      oursLabel: "Your latest local edits",
      theirsLabel: "Resolved sync result",
    });
    if (!mergedLatest.ok) {
      if (mergedLatest.conflicts.length) {
        return await writeSyncState(root, repository, {
          ...integrationState,
          snapshotHead: finalCheckpoint.head,
          phase: "conflicted",
          integrationHead: await integrationWorktreeHead(integration.path),
          conflicts: mergedLatest.conflicts,
          errorKind: "conflict",
          retryable: false,
        });
      }
      return await writeGitFailureState(root, repository, previousState, integrationState, mergedLatest.merge, options);
    }
  }

  let integrationHead = await integrationWorktreeHead(integration.path);
  let publishState = { ...integrationState, snapshotHead: finalCheckpoint.head, integrationHead };
  await writeSyncState(root, repository, { ...publishState, phase: "pushing" });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runSyncTestHook(options, "beforePush", { attempt, repository, integrationPath: integration.path });
    const push = await pushOriginMain(repository, integration.path, integrationHead, transportProvider);
    if (!push.error) break;
    const classified = classifyGitFailure(push);
    if (classified.errorKind !== "remote-race") {
      return await writeGitFailureState(root, repository, previousState, publishState, push, options);
    }
    if (attempt === 3) {
      return await writeSyncState(root, repository, {
        ...publishState,
        phase: "waiting",
        error: classified.message,
        errorKind: "remote-race",
        retryable: true,
        retryAfterMs: DEFAULT_REPOSITORY_BUSY_RETRY_MS,
        nextRetryAt: new Date(Date.now() + DEFAULT_REPOSITORY_BUSY_RETRY_MS).toISOString(),
      });
    }
    const racedFetch = await fetchOriginMain(repository, transportProvider);
    if (racedFetch.error) {
      return await writeGitFailureState(root, repository, previousState, publishState, racedFetch, options);
    }
    const latestRemote = racedFetch.remoteHead;
    const racedMerge = await mergeIntoIntegration(integration.path, latestRemote, identity, {
      oursStage: 2,
      theirsStage: 3,
      oursLabel: "Your resolved sync result",
      theirsLabel: "New remote changes",
    });
    if (!racedMerge.ok) {
      if (racedMerge.conflicts.length) {
        return await writeSyncState(root, repository, {
          ...publishState,
          remoteHead: latestRemote,
          phase: "conflicted",
          integrationHead: await integrationWorktreeHead(integration.path),
          conflicts: racedMerge.conflicts,
          errorKind: "conflict",
          retryable: false,
        });
      }
      return await writeGitFailureState(root, repository, previousState, publishState, racedMerge.merge, options);
    }
    integrationHead = racedMerge.head;
    publishState = { ...publishState, remoteHead: latestRemote, integrationHead };
    await writeSyncState(root, repository, { ...publishState, phase: "pushing" });
  }

  const applyingState = { ...publishState, publishedHead: integrationHead };
  await writeSyncState(root, repository, { ...applyingState, phase: "applying" });
  await runSyncTestHook(options, "afterPublished", { repository, publishedHead: integrationHead });
  const applied = await applyPublishedHead(root, repository, integrationHead, options);
  const finalArtifacts = recoveryArtifacts(artifacts, applied.recoveryArtifact);
  const recoveredThisRun = Boolean(integration.recoveryArtifact || applied.recoveryArtifact);
  if (!applied.applied) {
    return await writeSyncState(root, repository, {
      ...applyingState,
      ...(finalArtifacts.length ? { recoveryArtifacts: finalArtifacts } : {}),
      phase: "applying",
      error: applied.reason,
      errorKind: "workspace",
      retryable: true,
      retryAfterMs: DEFAULT_REPOSITORY_BUSY_RETRY_MS,
      nextRetryAt: new Date(Date.now() + DEFAULT_REPOSITORY_BUSY_RETRY_MS).toISOString(),
    });
  }
  const changedPaths = await changedPathsBetween(repository, headBefore, applied.head);
  await pruneWikiGitRecovery(root, options).catch(() => {});
  return await writeSyncState(root, repository, {
    ...applyingState,
    ...(finalArtifacts.length ? { recoveryArtifacts: finalArtifacts } : {}),
    phase: "idle",
    head: applied.head,
    changedPaths,
    lastSyncedAt: new Date().toISOString(),
    localOnly: false,
    bootstrappedMain: bootstrap.bootstrapped,
    consecutiveFailures: 0,
    retryable: false,
    message: recoveredThisRun ? "Git sync completed after safely recovering working files" : undefined,
  });
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
          errorKind: "busy",
          error: String(error?.message || error),
        });
      } else {
        const previousState = await storedWikiSyncState(root, repository) || {};
        result = await writeGitFailureState(root, repository, previousState, {
          ...transactionState(previousState),
          failedAt: new Date().toISOString(),
        }, error, options);
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
  const state = await storedWikiSyncState(root, repository) || {};
  const summary = (state.conflicts || []).find((conflict) => conflict.path === path) || conflictContextFromState(state);
  const oursStage = Number(summary.oursStage) === 3 ? 3 : 2;
  const theirsStage = Number(summary.theirsStage) === 2 ? 2 : 3;
  const [base, ours, theirs] = await Promise.all([
    stageContent(worktree, 1, path),
    stageContent(worktree, oursStage, path),
    stageContent(worktree, theirsStage, path),
  ]);
  const kind = [base, ours, theirs].some((buffer) => contentKind(buffer) === "binary") ? "binary" : "text";
  const encode = (buffer) => kind === "text" ? buffer.toString("utf8") : buffer.toString("base64");
  return {
    ok: true,
    type: "wiki-conflict-file",
    repositoryId: repository.id,
    path,
    kind,
    base: encode(base),
    ours: encode(ours),
    theirs: encode(theirs),
    oursLabel: String(summary.oursLabel || "Your local contribution"),
    theirsLabel: String(summary.theirsLabel || "Remote main"),
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
  const previousState = await storedWikiSyncState(root, repository) || {};
  const transportProvider = originMainTransportProvider(repository);
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
  const summary = (previousState.conflicts || []).find((conflict) => conflict.path === path)
    || conflictContextFromState(previousState);
  if (choice === "delete") {
    await rm(target, { recursive: true, force: true });
    await execFileAsync("git", ["-C", worktree, "rm", "-f", "--ignore-unmatch", "--", path]);
  } else if (choice === "ours" || choice === "theirs") {
    const selectedStage = choice === "ours"
      ? (Number(summary.oursStage) === 3 ? 3 : 2)
      : (Number(summary.theirsStage) === 2 ? 2 : 3);
    const gitSide = selectedStage === 2 ? "ours" : "theirs";
    await execFileAsync("git", ["-C", worktree, "checkout", `--${gitSide}`, "--", path]);
    await execFileAsync("git", ["-C", worktree, "add", "--", path]);
  } else {
    await mkdir(dirname(target), { recursive: true });
    const data = body.encoding === "base64" ? Buffer.from(String(body.result || ""), "base64") : String(body.result || "");
    await writeFile(target, data);
    await execFileAsync("git", ["-C", worktree, "add", "--", path]);
  }
  const remaining = await conflictFiles(worktree, summary);
  if (remaining.length) {
    return await writeSyncState(root, repository, {
      ...transactionState(previousState),
      phase: "conflicted",
      integrationPath: worktree,
      conflicts: remaining,
      errorKind: "conflict",
      retryable: false,
    });
  }
  await execFileAsync(
    "git",
    ["-C", worktree, "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "--no-edit"],
    { maxBuffer: 1024 * 1024 * 32 },
  );
  const integrationBranchName = (await execFileAsync("git", ["-C", worktree, "branch", "--show-current"])).stdout.trim();
  const resolvedConflictHead = await integrationWorktreeHead(worktree);
  const durableResolutionState = await writeSyncState(root, repository, {
    ...transactionState(previousState),
    phase: "merging",
    integrationBranch: integrationBranchName,
    integrationPath: worktree,
    integrationHead: resolvedConflictHead,
    conflicts: [],
  });
  const latestCheckpoint = await checkpointWikiRepositoryUnlocked(
    root,
    repository,
    { ...body, persistState: false },
    null,
  );
  let integrationHead = await integrationWorktreeHead(worktree);
  let resolutionState = {
    ...transactionState(durableResolutionState),
    operationId: previousState.operationId || syncOperationId(),
    branch: latestCheckpoint.branch,
    snapshotHead: latestCheckpoint.head,
    checkpointSource: latestCheckpoint.source,
    transportSource: transportProvider ? "kernel-vaultgit" : "node-vaultgit",
    integrationBranch: integrationBranchName,
    integrationPath: worktree,
    integrationHead,
    checkpointedAt: latestCheckpoint.checkpointedAt,
    committed: Boolean(previousState.committed || latestCheckpoint.committed),
    changedFiles: Number(previousState.changedFiles || 0) + Number(latestCheckpoint.changedFiles || 0),
    conflicts: [],
  };
  if (!await refIsAncestor(repository, latestCheckpoint.head, integrationHead)) {
    const latestMerge = await mergeIntoIntegration(worktree, latestCheckpoint.head, identity, {
      oursStage: 3,
      theirsStage: 2,
      oursLabel: "Your latest local edits",
      theirsLabel: "Resolved sync result",
    });
    if (!latestMerge.ok) {
      if (latestMerge.conflicts.length) {
        return await writeSyncState(root, repository, {
          ...resolutionState,
          phase: "conflicted",
          integrationHead: await integrationWorktreeHead(worktree),
          conflicts: latestMerge.conflicts,
          errorKind: "conflict",
          retryable: false,
        });
      }
      return await writeGitFailureState(root, repository, previousState, resolutionState, latestMerge.merge, body);
    }
    integrationHead = latestMerge.head;
    resolutionState = { ...resolutionState, integrationHead };
  }

  await writeSyncState(root, repository, { ...resolutionState, phase: "pushing" });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runSyncTestHook(body, "beforePush", { attempt, repository, integrationPath: worktree });
    const push = await pushOriginMain(repository, worktree, integrationHead, transportProvider);
    if (!push.error) break;
    const classified = classifyGitFailure(push);
    if (classified.errorKind !== "remote-race") {
      return await writeGitFailureState(root, repository, previousState, resolutionState, push, body);
    }
    if (attempt === 3) {
      return await writeSyncState(root, repository, {
        ...resolutionState,
        phase: "waiting",
        error: classified.message,
        errorKind: "remote-race",
        retryable: true,
        retryAfterMs: DEFAULT_REPOSITORY_BUSY_RETRY_MS,
      });
    }
    const fetched = await fetchOriginMain(repository, transportProvider);
    if (fetched.error) return await writeGitFailureState(root, repository, previousState, resolutionState, fetched, body);
    const latestRemote = fetched.remoteHead;
    const mergedRemote = await mergeIntoIntegration(worktree, latestRemote, identity, {
      oursStage: 2,
      theirsStage: 3,
      oursLabel: "Your resolved sync result",
      theirsLabel: "New remote changes",
    });
    if (!mergedRemote.ok) {
      if (mergedRemote.conflicts.length) {
        return await writeSyncState(root, repository, {
          ...resolutionState,
          remoteHead: latestRemote,
          phase: "conflicted",
          integrationHead: await integrationWorktreeHead(worktree),
          conflicts: mergedRemote.conflicts,
          errorKind: "conflict",
          retryable: false,
        });
      }
      return await writeGitFailureState(root, repository, previousState, resolutionState, mergedRemote.merge, body);
    }
    integrationHead = mergedRemote.head;
    resolutionState = { ...resolutionState, remoteHead: latestRemote, integrationHead };
    await writeSyncState(root, repository, { ...resolutionState, phase: "pushing" });
  }

  const applyingState = { ...resolutionState, publishedHead: integrationHead };
  await writeSyncState(root, repository, { ...applyingState, phase: "applying" });
  await runSyncTestHook(body, "afterPublished", { repository, publishedHead: integrationHead });
  const applied = await applyPublishedHead(root, repository, integrationHead, body);
  const artifacts = recoveryArtifacts(
    previousState.recoveryArtifacts,
    latestCheckpoint.recoveryArtifacts,
    applied.recoveryArtifact,
  );
  if (!applied.applied) {
    return await writeSyncState(root, repository, {
      ...applyingState,
      ...(artifacts.length ? { recoveryArtifacts: artifacts } : {}),
      phase: "applying",
      error: applied.reason,
      errorKind: "workspace",
      retryable: true,
      retryAfterMs: DEFAULT_REPOSITORY_BUSY_RETRY_MS,
    });
  }
  const head = applied.head;
  const changedPaths = [...new Set([
    ...await changedPathsBetween(repository, headBefore, head),
    join(repository.path, path),
  ])];
  await pruneWikiGitRecovery(root, body).catch(() => {});
  return await writeSyncState(root, repository, {
    ...applyingState,
    ...(artifacts.length ? { recoveryArtifacts: artifacts } : {}),
    phase: "idle",
    head,
    changedPaths,
    integrationPath: worktree,
    conflicts: [],
    lastSyncedAt: new Date().toISOString(),
    consecutiveFailures: 0,
    retryable: false,
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
