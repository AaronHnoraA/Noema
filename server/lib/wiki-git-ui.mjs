import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { get } from "node:http";

import { repositoryFromId } from "./wiki-workspace.mjs";

const require = createRequire(import.meta.url);
const ungitBin = require.resolve("ungit/bin/ungit");
const ungitSupervisor = require.resolve("./ungit-supervisor.mjs");
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

function requestText(url, timeoutMs = 700) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body = `${body}${chunk}`.slice(0, 4096); });
      response.on("end", () => resolve({ status: response.statusCode || 0, body }));
    });
    request.once("error", reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error("probe timeout")));
  });
}

async function probeUngit(baseUrl, child, { socket = false } = {}) {
  if (child.exitCode !== null) throw new Error("ungit process exited");
  const ping = await requestText(`${baseUrl}/api/ping`);
  if (ping.status !== 200) throw new Error(`ungit ping returned HTTP ${ping.status}`);
  if (!socket) return;
  const handshake = await requestText(`${baseUrl}/socket.io/?EIO=4&transport=polling&t=${Date.now()}`);
  if (handshake.status !== 200 || !handshake.body.startsWith("0{")) {
    throw new Error(`ungit realtime channel returned HTTP ${handshake.status}`);
  }
}

async function waitUntilReady(baseUrl, child) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("ungit exited before its embedded interface was ready");
    try {
      await probeUngit(baseUrl, child, { socket: true });
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out while starting the embedded ungit interface");
}

export async function openWikiGitUi(root, repositoryId) {
  const repository = await repositoryFromId(root, repositoryId);
  const previous = sessions.get(repository.id);
  if (previous?.child?.exitCode === null) {
    try {
      await probeUngit(previous.baseUrl, previous.child);
      return { ok: true, type: "wiki-git-ui", repositoryId: repository.id, url: previous.url };
    } catch {
      previous.child.kill("SIGTERM");
      sessions.delete(repository.id);
    }
  }

  const port = await availablePort();
  const capabilityPath = `/noema-git-${randomBytes(24).toString("hex")}`;
  const baseUrl = `http://127.0.0.1:${port}${capabilityPath}`;
  const url = `${baseUrl}/?noheader=true#/repository?path=${encodeUngitPath(repository.path)}`;
  const child = spawn(process.execPath, [
    ungitSupervisor,
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
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stdin?.on("error", () => {});
  let errorOutput = "";
  child.stderr?.on("data", (chunk) => {
    errorOutput = `${errorOutput}${chunk}`.slice(-4000);
  });
  const session = { child, url, baseUrl, repositoryId: repository.id };
  sessions.set(repository.id, session);
  child.once("exit", () => {
    if (sessions.get(repository.id) === session) sessions.delete(repository.id);
  });
  try {
    await waitUntilReady(baseUrl, child);
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
