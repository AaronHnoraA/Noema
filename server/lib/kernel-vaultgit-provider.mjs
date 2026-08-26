import { kernelBoxPath } from "./kernel-markdown-provider.mjs";

function providerError(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

function validateStatus(data) {
  if (!data || typeof data.branch !== "string" || typeof data.remote !== "string"
      || typeof data.clean !== "boolean" || typeof data.status !== "string"
      || data.source !== "kernel-vaultgit") {
    throw providerError("Kernel vault Git response has an invalid status shape");
  }
  return {
    branch: data.branch,
    remote: data.remote,
    clean: data.clean,
    status: data.status,
    source: data.source,
  };
}

function validateHistory(data) {
  if (!data || typeof data.path !== "string" || data.source !== "kernel-vaultgit"
      || !Array.isArray(data.commits) || data.commits.some((commit) => !commit
        || typeof commit.sha !== "string" || typeof commit.date !== "string"
        || typeof commit.author !== "string" || typeof commit.email !== "string"
        || typeof commit.subject !== "string")) {
    throw providerError("Kernel vault Git response has an invalid history shape");
  }
  return { path: data.path, commits: data.commits.map((commit) => ({ ...commit })), source: data.source };
}

function validateTransport(data, action, requestedCommit = "") {
  const commitPattern = /^[0-9a-f]{7,64}$/i;
  if (!data || data.action !== action || typeof data.commit !== "string"
      || typeof data.remoteHead !== "string" || !commitPattern.test(data.remoteHead)
      || typeof data.bootstrapped !== "boolean" || data.source !== "kernel-vaultgit") {
    throw providerError("Kernel vault Git response has an invalid transport shape");
  }
  if ((action === "fetch-main" && data.commit !== "")
      || (action !== "fetch-main" && !commitPattern.test(data.commit))
      || (action !== "ensure-main" && data.bootstrapped)) {
    throw providerError("Kernel vault Git response has an invalid transport shape");
  }
  if (action === "push-main" && (data.commit !== requestedCommit || data.remoteHead !== requestedCommit)) {
    throw providerError("Kernel vault Git push commit does not match the request");
  }
  return {
    action: data.action,
    commit: data.commit,
    remoteHead: data.remoteHead,
    bootstrapped: data.bootstrapped,
    source: data.source,
  };
}

// The Go kernel owns bounded Git execution. Repository discovery, sync policy,
// conflict UX, worktrees, and ungit remain in the shared Node host.
export function createKernelVaultGitProvider({
  baseUrl,
  box,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  checkpointTimeoutMs = 5 * 60_000,
} = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const notebook = String(box?.id || "");
  const root = String(box?.root || "");
  if (!base || !notebook || !root || typeof fetchImpl !== "function") {
    throw new Error("Kernel vault Git provider requires baseUrl, box.id, box.root, and fetch");
  }

  function pathFor(repositoryPath) {
    return kernelBoxPath(root, repositoryPath);
  }

  const checkpointTimeout = Number.isFinite(Number(checkpointTimeoutMs))
    ? Math.max(1_000, Number(checkpointTimeoutMs))
    : 5 * 60_000;

  async function post(endpoint, body, failureStatus, requestTimeoutMs = timeoutMs) {
    const response = await fetchImpl(`${base}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code) !== 0 || !payload?.data) {
      throw providerError(
        String(payload?.msg || `kernel request failed with HTTP ${response.status}`),
        response.ok ? failureStatus : response.status,
      );
    }
    return payload.data;
  }

  return {
    owns(repositoryPath) {
      return Boolean(pathFor(repositoryPath));
    },
    async status(repositoryPath) {
      const path = pathFor(repositoryPath);
      if (!path) throw providerError("Git repository is outside the kernel Markdown box", 403);
      return validateStatus(await post("/api/noema/vaultgit/status", { notebook, path }, 502));
    },
    async history(repositoryPath, filePath, limit = 50) {
      const path = pathFor(repositoryPath);
      if (!path) throw providerError("Git repository is outside the kernel Markdown box", 403);
      const requestedPath = String(filePath || "");
      const result = validateHistory(await post("/api/noema/vaultgit/history", {
        notebook, path, filePath: requestedPath, limit: Number(limit) || 50,
      }, 502));
      if (result.path !== requestedPath) throw providerError("Kernel vault Git history path does not match the request");
      return result;
    },
    async diff(repositoryPath, filePath, sha) {
      const path = pathFor(repositoryPath);
      if (!path) throw providerError("Git repository is outside the kernel Markdown box", 403);
      const requestedPath = String(filePath || "");
      const requestedSHA = String(sha || "");
      const data = await post("/api/noema/vaultgit/diff", {
        notebook, path, filePath: requestedPath, sha: requestedSHA,
      }, 502);
      if (!data || data.path !== requestedPath || data.sha !== requestedSHA || data.scope !== "commit"
          || typeof data.diff !== "string" || data.source !== "kernel-vaultgit") {
        throw providerError("Kernel vault Git response has an invalid diff shape");
      }
      return { path: data.path, diff: data.diff, scope: data.scope, sha: data.sha, source: data.source };
    },
    async restore(repositoryPath, filePath, sha) {
      const path = pathFor(repositoryPath);
      if (!path) throw providerError("Git repository is outside the kernel Markdown box", 403);
      const requestedPath = String(filePath || "");
      const requestedSHA = String(sha || "");
      const data = await post("/api/noema/vaultgit/restore", {
        notebook, path, filePath: requestedPath, sha: requestedSHA,
      }, 409);
      if (!data || data.path !== requestedPath || data.sha !== requestedSHA
          || data.source !== "kernel-vaultgit" || !Number.isSafeInteger(data.bytes) || data.bytes < 0) {
        throw providerError("Kernel vault Git response has an invalid restore shape");
      }
      return { path: data.path, sha: data.sha, source: data.source, bytes: data.bytes };
    },
    async checkpoint(repositoryPath, {
      branch = "", message = "", deviceName = "", deviceId = "",
    } = {}) {
      const path = pathFor(repositoryPath);
      if (!path) throw providerError("Git repository is outside the kernel Markdown box", 403);
      const requestedBranch = String(branch || "");
      const data = await post("/api/noema/vaultgit/checkpoint", {
        notebook,
        path,
        branch: requestedBranch,
        message: String(message || ""),
        deviceName: String(deviceName || ""),
        deviceId: String(deviceId || ""),
      }, 409, checkpointTimeout);
      if (!data || data.branch !== requestedBranch || typeof data.head !== "string"
          || typeof data.committed !== "boolean" || !Number.isSafeInteger(data.changedFiles)
          || data.changedFiles < 0 || typeof data.identityFallback !== "boolean"
          || data.source !== "kernel-vaultgit") {
        throw providerError("Kernel vault Git response has an invalid checkpoint shape");
      }
      return {
        branch: data.branch,
        head: data.head,
        committed: data.committed,
        changedFiles: data.changedFiles,
        identityFallback: data.identityFallback,
        source: data.source,
      };
    },
    async ensureMain(repositoryPath, commit) {
      const path = pathFor(repositoryPath);
      if (!path) throw providerError("Git repository is outside the kernel Markdown box", 403);
      const requestedCommit = String(commit || "");
      const data = await post("/api/noema/vaultgit/transport", {
        notebook, path, action: "ensure-main", commit: requestedCommit,
      }, 409, checkpointTimeout);
      return validateTransport(data, "ensure-main", requestedCommit);
    },
    async fetchMain(repositoryPath) {
      const path = pathFor(repositoryPath);
      if (!path) throw providerError("Git repository is outside the kernel Markdown box", 403);
      const data = await post("/api/noema/vaultgit/transport", {
        notebook, path, action: "fetch-main", commit: "",
      }, 409, checkpointTimeout);
      return validateTransport(data, "fetch-main");
    },
    async pushMain(repositoryPath, commit) {
      const path = pathFor(repositoryPath);
      if (!path) throw providerError("Git repository is outside the kernel Markdown box", 403);
      const requestedCommit = String(commit || "");
      const data = await post("/api/noema/vaultgit/transport", {
        notebook, path, action: "push-main", commit: requestedCommit,
      }, 409, checkpointTimeout);
      return validateTransport(data, "push-main", requestedCommit);
    },
    async action({ repositoryPath, action, message = "", paths = [] } = {}) {
      const path = pathFor(repositoryPath);
      if (!path) throw providerError("Git repository is outside the kernel Markdown box", 403);
      const data = await post("/api/noema/vaultgit/action", {
        notebook,
        path,
        action: String(action || ""),
        message: String(message || ""),
        paths: Array.isArray(paths) ? paths.map(String) : [],
      }, 409);
      const status = validateStatus(data);
      if (data.action !== action || data.phase !== "idle" || !Array.isArray(data.changedPaths)
          || data.changedPaths.some((item) => typeof item !== "string") || typeof data.message !== "string") {
        throw providerError("Kernel vault Git response has an invalid action shape");
      }
      return {
        ...status,
        action: data.action,
        phase: data.phase,
        changedPaths: data.changedPaths,
        message: data.message,
      };
    },
  };
}
