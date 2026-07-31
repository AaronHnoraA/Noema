import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { get } from "node:http";

import { repositoryFromId } from "./wiki-workspace.mjs";

const require = createRequire(import.meta.url);
const ungitBin = require.resolve("ungit/bin/ungit");
const sessions = new Map();

function encodeUngitPath(path) {
  return encodeURIComponent(path).replaceAll("%2F", "/");
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntilReady(url, child) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("ungit exited before its embedded interface was ready");
    try {
      const status = await new Promise((resolve, reject) => {
        const request = get(url, (response) => {
          response.resume();
          resolve(response.statusCode || 0);
        });
        request.once("error", reject);
        request.setTimeout(500, () => request.destroy(new Error("probe timeout")));
      });
      if (status >= 200 && status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out while starting the embedded ungit interface");
}

export async function openWikiGitUi(root, repositoryId) {
  const repository = await repositoryFromId(root, repositoryId);
  const previous = sessions.get(repository.id);
  if (previous?.child?.exitCode === null) {
    return { ok: true, type: "wiki-git-ui", repositoryId: repository.id, url: previous.url };
  }

  const port = await availablePort();
  const capabilityPath = `/noema-git-${randomBytes(24).toString("hex")}`;
  const baseUrl = `http://127.0.0.1:${port}${capabilityPath}`;
  const url = `${baseUrl}/?noheader=true#/repository?path=${encodeUngitPath(repository.path)}`;
  const child = spawn(process.execPath, [
    ungitBin,
    "--cliconfigonly",
    "--no-launchBrowser",
    `--port=${port}`,
    "--ungitBindIp=127.0.0.1",
    `--rootPath=${capabilityPath}`,
    `--forcedLaunchPath=${repository.path}`,
    `--defaultRepositories=${repository.path}`,
    "--autoFetch=false",
    "--isEnableNumStat=false",
    "--bugtracking=false",
    "--logRESTRequests=false",
    "--logGitCommands=false",
    "--logGitOutput=false",
    "--logLevel=error",
    "--autoShutdownTimeout=14400000",
  ], {
    cwd: repository.path,
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errorOutput = "";
  child.stderr?.on("data", (chunk) => {
    errorOutput = `${errorOutput}${chunk}`.slice(-4000);
  });
  const session = { child, url, repositoryId: repository.id };
  sessions.set(repository.id, session);
  child.once("exit", () => {
    if (sessions.get(repository.id) === session) sessions.delete(repository.id);
  });
  try {
    await waitUntilReady(`${baseUrl}/`, child);
  } catch (error) {
    child.kill("SIGTERM");
    sessions.delete(repository.id);
    const detail = errorOutput.trim();
    throw new Error(detail ? `${error.message}: ${detail}` : error.message);
  }
  return { ok: true, type: "wiki-git-ui", repositoryId: repository.id, url };
}

export async function stopAllWikiGitUis() {
  const stopping = [];
  for (const session of sessions.values()) {
    stopping.push(new Promise((resolve) => {
      if (session.child.exitCode !== null) return resolve();
      const timeout = setTimeout(() => {
        session.child.kill("SIGKILL");
        resolve();
      }, 1500);
      timeout.unref();
      session.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      session.child.kill("SIGTERM");
    }));
  }
  sessions.clear();
  await Promise.allSettled(stopping);
}
