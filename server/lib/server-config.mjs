import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_SSH_TARGET = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/;
const SAFE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,127}(?:\.service)?$/;

function configError(message) {
  return Object.assign(new Error(message), { code: "ERR_NOEMA_SERVER_CONFIG" });
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, label) {
  const result = String(value || "").trim();
  if (!result) throw configError(`${label} is required`);
  return result;
}

function optionalBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw configError(`${label} must be true or false`);
  return value;
}

function safeAbsolutePath(value, label) {
  const path = requiredString(value, label);
  if (/\s|[\u0000-\u001f\u007f]/.test(path)) throw configError(`${label} must not contain whitespace or control characters`);
  if (!isAbsolute(path)) throw configError(`${label} must be an absolute path`);
  return resolve(path);
}

function validateRepositoryUrl(value, label) {
  const url = requiredString(value, label);
  if (url.startsWith("-")) throw configError(`${label} must not start with '-'`);
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      throw configError(`${label} must not contain embedded credentials`);
    }
    if (!["https:", "ssh:", "git:"].includes(parsed.protocol)) {
      throw configError(`${label} must use https, ssh, git, or an SSH alias`);
    }
  } catch (error) {
    if (error?.code === "ERR_NOEMA_SERVER_CONFIG") throw error;
    if (!/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:.+/.test(url)) {
      throw configError(`${label} is not a supported Git URL`);
    }
  }
  return url;
}

function normalizeRepository(source, index) {
  if (!plainObject(source)) throw configError(`repositories[${index}] must be an object`);
  const name = requiredString(source.name, `repositories[${index}].name`);
  if (!SAFE_NAME.test(name) || name === "." || name === "..") {
    throw configError(`repositories[${index}].name is invalid`);
  }
  const partition = String(source.partition || "").trim().toLowerCase();
  if (partition !== "public" && partition !== "private") {
    throw configError(`repositories[${index}].partition must be public or private`);
  }
  const branch = String(source.branch || "auto").trim().toLowerCase();
  if (!["auto", "main", "master"].includes(branch)) {
    throw configError(`repositories[${index}].branch must be auto, main, or master`);
  }
  return Object.freeze({
    name,
    url: validateRepositoryUrl(source.url, `repositories[${index}].url`),
    partition,
    branch,
    id: `${partition}/${name}`,
  });
}

export function normalizeServerRuntimeConfig(raw, options = {}) {
  if (!plainObject(raw)) throw configError("Server config root must be an object");
  if (Number(raw.schemaVersion) !== 1) throw configError("Server config schemaVersion must be 1");
  const listen = plainObject(raw.listen) ? raw.listen : {};
  const host = String(listen.host || "127.0.0.1").trim() || "127.0.0.1";
  const port = Number(listen.port ?? 5179);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw configError("listen.port must be an integer from 1 to 65535");
  }
  const pullIntervalMinutes = Number(raw.pullIntervalMinutes ?? 360);
  if (!Number.isFinite(pullIntervalMinutes) || pullIntervalMinutes < 1 || pullIntervalMinutes > 10080) {
    throw configError("pullIntervalMinutes must be between 1 and 10080");
  }
  const repositories = (Array.isArray(raw.repositories) ? raw.repositories : [])
    .map(normalizeRepository);
  const ids = repositories.map((repository) => repository.id);
  if (new Set(ids).size !== ids.length) throw configError("Server repository ids must be unique");
  const configFile = resolve(String(options.configFile || "server-config/runtime.json"));
  const configDir = dirname(configFile);
  const appearance = plainObject(raw.appearance) ? raw.appearance : {};
  const reader = plainObject(raw.reader) ? raw.reader : {};
  return Object.freeze({
    schemaVersion: 1,
    configFile,
    configDir,
    listen: Object.freeze({ host, port }),
    appearance: Object.freeze({ theme: String(appearance.theme || "claude").trim() || "claude" }),
    reader: Object.freeze({
      showSource: optionalBoolean(reader.showSource, false, "reader.showSource"),
      showGraph: optionalBoolean(reader.showGraph, true, "reader.showGraph"),
      showStatus: optionalBoolean(reader.showStatus, false, "reader.showStatus"),
      selectionToolbar: optionalBoolean(reader.selectionToolbar, false, "reader.selectionToolbar"),
      customContextMenu: optionalBoolean(reader.customContextMenu, false, "reader.customContextMenu"),
      editingAids: optionalBoolean(reader.editingAids, false, "reader.editingAids"),
    }),
    pullIntervalMinutes,
    repositories: Object.freeze(repositories),
    repositoriesRoot: resolve(configDir, "repos"),
    stateRoot: resolve(configDir, "state"),
    noteRoot: resolve(configDir, "repos"),
  });
}

export async function readServerRuntimeConfig(fileValue) {
  const configFile = resolve(requiredString(fileValue, "NOEMA_SERVER_CONFIG"));
  let raw;
  try {
    raw = JSON.parse(await readFile(configFile, "utf8"));
  } catch (error) {
    throw configError(`Cannot read server config ${configFile}: ${error?.message || error}`);
  }
  return normalizeServerRuntimeConfig(raw, { configFile });
}

export function normalizeServerDeployConfig(raw) {
  if (!plainObject(raw)) throw configError("Deploy config root must be an object");
  if (Number(raw.schemaVersion) !== 1) throw configError("Deploy config schemaVersion must be 1");
  const sshTarget = requiredString(raw.sshTarget, "sshTarget");
  if (!SAFE_SSH_TARGET.test(sshTarget)) throw configError("sshTarget is invalid; use an SSH host or user@host");
  const serviceName = requiredString(raw.serviceName || "noema-server.service", "serviceName");
  if (!SAFE_SERVICE.test(serviceName)) throw configError("serviceName is invalid");
  return Object.freeze({
    schemaVersion: 1,
    sshTarget,
    remoteRoot: safeAbsolutePath(raw.remoteRoot, "remoteRoot"),
    serviceName: serviceName.endsWith(".service") ? serviceName : `${serviceName}.service`,
    nodeBin: safeAbsolutePath(raw.nodeBin, "nodeBin"),
    npmBin: safeAbsolutePath(raw.npmBin, "npmBin"),
  });
}

export function serverRepositoryPath(config, repository) {
  return join(config.repositoriesRoot, repository.partition, repository.name);
}
