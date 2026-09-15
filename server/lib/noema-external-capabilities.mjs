// Native agent libraries are read through explicit local links, never rewritten.
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : [];
const formats = new Set(["claude", "codex", "opencode", "pi"]);

export function validateExternalSources(sources) {
  if (sources === undefined) return;
  if (!Array.isArray(sources) || sources.length > 32) throw new Error("Capability sources must be an array of at most 32 libraries");
  const ids = new Set();
  for (const source of sources) {
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(source?.id || "") || ids.has(source.id)
        || !formats.has(source.format) || (source.config !== undefined && typeof source.config !== "string")
        || !Array.isArray(source.skills || []) || list(source.skills).some((path) => typeof path !== "string" || !path)) {
      throw new Error("Each capability source needs a unique id, native format, optional config path and Skill directories");
    }
    ids.add(source.id);
  }
}

function convertServer(id, raw, format, environment) {
  const config = object(raw);
  const errors = [];
  const expand = (value) => String(value ?? "").replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\{env:([^}]+)\}|\{file:([^}]+)\}/g,
    (match, name, fallback, envName, fileName) => {
      if (fileName) { errors.push("File interpolation needs an explicit Noema configuration"); return match; }
      const variable = name || envName;
      if (environment[variable] !== undefined) return environment[variable];
      if (fallback !== undefined) return fallback;
      errors.push(`Missing environment variable: ${variable}`);
      return match;
    });
  const pairs = (value) => Array.isArray(value)
    ? value.map((entry) => ({ name: String(entry.name || ""), value: expand(entry.value) }))
    : Object.entries(object(value)).map(([name, text]) => ({ name, value: expand(text) }));
  const command = Array.isArray(config.command) ? config.command : [config.command, ...list(config.args)];
  const type = config.type === "remote" ? "http" : config.type === "local" ? "stdio"
    : config.type || (config.url ? "http" : "stdio");
  const server = { id, type, default_enabled: false,
    description: `Linked ${format} MCP; enable explicitly in Noema.`,
  };
  if (type === "http" || type === "sse") {
    server.url = expand(config.url);
    server.headers = pairs(config.http_headers || config.headers);
    for (const [name, variable] of Object.entries(object(config.env_http_headers))) {
      if (environment[variable] === undefined) errors.push(`Missing environment variable: ${variable}`);
      else server.headers.push({ name, value: String(environment[variable]) });
    }
    if (config.bearer_token_env_var) {
      const variable = config.bearer_token_env_var;
      if (environment[variable] === undefined) errors.push(`Missing environment variable: ${variable}`);
      else server.headers.push({ name: "Authorization", value: `Bearer ${environment[variable]}` });
    }
  } else {
    server.command = expand(command[0]);
    server.args = command.slice(1).map(expand);
    server.env = pairs(config.environment || config.env);
    for (const name of list(config.env_vars)) {
      if (environment[name] !== undefined && !server.env.some((entry) => entry.name === name)) {
        server.env.push({ name, value: String(environment[name]) });
      }
    }
  }
  // Dropping execution directories or allow/deny lists would change semantics.
  for (const field of ["cwd", "enabled_tools", "disabled_tools", "allowedTools", "disabledTools", "oauth"]) {
    if (config[field] !== undefined && config[field] !== false
        && !(Array.isArray(config[field]) && config[field].length === 0)) {
      errors.push(`Native ${field} requires an explicit Noema definition; it is not silently discarded`);
    }
  }
  if (id === "noema") errors.push("The noema MCP id is reserved for the built-in endpoint");
  return { server, errors, disabled: config.enabled === false || config.disabled === true };
}

export async function loadExternalSource(source, base, environment) {
  const pathFor = (path) => isAbsolute(path) ? path : resolve(base, path);
  const path = source.config ? pathFor(source.config) : "";
  const result = {
    id: source.id, name: `external-${source.id}`, format: source.format, path,
    directories: list(source.skills).map(pathFor), state: "library", errors: new Map(),
    config: { skills: {}, mcp: { servers: [], disabled: [] } },
  };
  if (!path) return result;
  try {
    // Parse only local config files; parser errors may contain secrets, so never expose them.
    const text = await readFile(path, "utf8");
    const actualPath = await realpath(path);
    const data = source.format === "codex"
      ? (await import("smol-toml")).parse(text)
      : (await import("json5")).default.parse(text);
    const native = object(data);
    const servers = source.format === "codex" ? object(native.mcp_servers)
      : source.format === "opencode" ? object(native.mcp) : object(native.mcpServers);
    for (const [id, raw] of Object.entries(servers)) {
      const converted = convertServer(id, raw, source.format, environment);
      // A foreign entry must not shadow and remove Noema's own live endpoint.
      if (id === "noema") converted.server.id = `external-${source.id}-reserved-noema`;
      // Relative launch paths belong to the originating config, not the Emacs link directory.
      if (converted.server.command?.startsWith("./") || converted.server.command?.startsWith("../")) {
        converted.server.command = resolve(dirname(actualPath), converted.server.command);
      }
      result.config.mcp.servers.push(converted.server);
      result.errors.set(converted.server.id, converted.errors);
      if (converted.disabled) result.config.mcp.disabled.push(converted.server.id);
    }
    result.state = "available";
  } catch (error) {
    result.state = error?.code === "ENOENT" ? "missing" : "error";
  }
  return result;
}
