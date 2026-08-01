import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { serverRepositoryPath } from "./server-config.mjs";

const execFileAsync = promisify(execFile);

async function git(path, args, options = {}) {
  try {
    return await execFileAsync("git", path
      ? ["-C", path, ...args]
      : args, { maxBuffer: 1024 * 1024 * 16 });
  } catch (error) {
    if (options.allowFailure) return { stdout: error?.stdout || "", stderr: error?.stderr || "", error };
    throw new Error(String(error?.stderr || error?.message || "Git command failed").trim());
  }
}

function remoteHeadBranch(text) {
  const match = String(text || "").match(/^ref:\s+refs\/heads\/(main|master)\s+HEAD$/m);
  return match?.[1] || "";
}

export async function resolveServerRepositoryBranch(path, requested = "auto") {
  if (requested === "main" || requested === "master") {
    const found = await git(path, ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${requested}`], { allowFailure: true });
    if (found.error) throw new Error(`origin/${requested} does not exist`);
    return requested;
  }
  const head = await git(path, ["ls-remote", "--symref", "origin", "HEAD"], { allowFailure: true });
  const fromHead = !head.error ? remoteHeadBranch(head.stdout) : "";
  if (fromHead) return fromHead;
  for (const branch of ["main", "master"]) {
    const found = await git(path, ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], { allowFailure: true });
    if (!found.error) return branch;
  }
  throw new Error("origin has neither a main nor master branch");
}

async function cloneIfMissing(config, repository, path) {
  if (existsSync(join(path, ".git"))) return false;
  if (existsSync(path)) throw new Error(`Repository destination is not a Git checkout: ${repository.id}`);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.clone-${process.pid}-${Date.now()}`;
  try {
    await git("", ["clone", "--no-checkout", "--origin", "origin", "--", repository.url, temporary]);
    await rename(temporary, path);
    return true;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function verifyRemote(path, repository) {
  const remote = await git(path, ["remote", "get-url", "origin"]);
  if (String(remote.stdout || "").trim() !== repository.url) {
    throw new Error(`origin URL does not match server config for ${repository.id}`);
  }
}

export async function syncServerRepository(config, repository) {
  const path = serverRepositoryPath(config, repository);
  const cloned = await cloneIfMissing(config, repository, path);
  await verifyRemote(path, repository);
  const branch = await resolveServerRepositoryBranch(path, repository.branch);
  await git(path, ["fetch", "--prune", "origin"]);
  // The checkout is a disposable mirror. Clear both tracked edits and
  // untracked collisions before switching branches, then enforce the remote
  // tree again after checkout.
  await git(path, ["reset", "--hard"]);
  await git(path, ["clean", "-ffdx"]);
  await git(path, ["checkout", "-B", branch, `refs/remotes/origin/${branch}`]);
  await git(path, ["reset", "--hard", `refs/remotes/origin/${branch}`]);
  await git(path, ["clean", "-ffdx"]);
  const head = String((await git(path, ["rev-parse", "HEAD"])).stdout || "").trim();
  return { ok: true, id: repository.id, path, branch, head, cloned, syncedAt: new Date().toISOString() };
}

async function writeState(config, payload) {
  const file = join(config.stateRoot, "repositories.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export async function readServerRepositoryState(config) {
  try {
    return JSON.parse(await readFile(join(config.stateRoot, "repositories.json"), "utf8"));
  } catch {
    return { schemaVersion: 1, updatedAt: "", repositories: [] };
  }
}

export function serverRepositoryContentSignature(config, state, fallbackState = null) {
  const current = new Map((state?.repositories || [])
    .filter((item) => item?.ok && item.head)
    .map((item) => [item.id, item.head]));
  const fallback = new Map((fallbackState?.repositories || [])
    .filter((item) => item?.head)
    .map((item) => [item.id, item.head]));
  return JSON.stringify(config.repositories.map((repository) => [
    repository.id,
    current.get(repository.id) || fallback.get(repository.id) || "",
  ]));
}

export async function syncServerRepositories(config, options = {}) {
  const pending = [...config.repositories];
  const results = [];
  const concurrency = Math.max(1, Math.min(2, Number(options.concurrency) || 2, pending.length || 1));
  const workers = Array.from({ length: concurrency }, async () => {
    while (pending.length) {
      const repository = pending.shift();
      if (!repository) return;
      try {
        results.push(await syncServerRepository(config, repository));
      } catch (error) {
        const path = serverRepositoryPath(config, repository);
        results.push({
          ok: false,
          id: repository.id,
          path,
          stale: existsSync(join(path, ".git")),
          error: String(error?.message || error),
          syncedAt: new Date().toISOString(),
        });
      }
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.id.localeCompare(b.id));
  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    degraded: results.some((result) => !result.ok),
    contentChanged: true,
    repositories: results,
  };
  payload.contentChanged = options.previousState
    ? serverRepositoryContentSignature(config, payload, options.previousState)
      !== serverRepositoryContentSignature(config, options.previousState)
    : true;
  return await writeState(config, payload);
}
