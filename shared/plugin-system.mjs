import { delimiter } from "node:path";

const PLUGIN_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;

export function pluginIdList(value = "") {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function pluginDirectoryList(value = "") {
  return String(value || "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function validatePluginManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("plugin.json must contain an object");
  }
  const id = String(value.id || "");
  if (!PLUGIN_ID_RE.test(id)) throw new Error(`Invalid plugin id: ${id || "<missing>"}`);
  if (Number(value.apiVersion) !== 1) throw new Error(`Unsupported plugin API for ${id}`);
  const main = String(value.main || "main.mjs");
  if (!/^[A-Za-z0-9._-]+\.mjs$/.test(main)) throw new Error(`Invalid plugin entry for ${id}`);
  return {
    ...value,
    id,
    name: String(value.name || id),
    version: String(value.version || "0.0.0"),
    apiVersion: 1,
    main,
  };
}

export function pluginEnabled(manifest, { enabled = [], disabled = [], env = {} } = {}) {
  const enabledSet = new Set(enabled);
  const disabledSet = new Set(disabled);
  if (disabledSet.has(manifest.id)) return false;
  if (enabledSet.has(manifest.id)) return true;

  const environment = String(manifest.activation?.environment || "");
  if (environment && Object.prototype.hasOwnProperty.call(env, environment)) {
    const value = String(env[environment] || "").trim().toLowerCase();
    if (["0", "false", "off", "no"].includes(value)) return false;
    if (["1", "true", "on", "yes"].includes(value)) return true;
  }

  return manifest.enabledByDefault === true;
}
