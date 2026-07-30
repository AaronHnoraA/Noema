import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const LANGUAGETOOL_SETTINGS_SCHEMA_VERSION = 1;

export const LANGUAGETOOL_SETTINGS_LIMITS = Object.freeze({
  remoteTimeoutMs: Object.freeze({ min: 500, max: 30_000 }),
  retryCooldownMs: Object.freeze({ min: 1_000, max: 300_000 }),
});

const HARD_DEFAULTS = Object.freeze({
  automaticEnabled: true,
  serverUrl: "http://10.243.90.222:8765",
  language: "en-US",
  level: "picky",
  performanceProfile: "balanced",
  manualLocalFallback: true,
  remoteTimeoutMs: 5_000,
  retryCooldownMs: 30_000,
});

const LEVELS = new Set(["default", "picky"]);
const PERFORMANCE_PROFILES = new Set(["responsive", "balanced", "quiet"]);
const settingsCache = new Map();
let mutationQueue = Promise.resolve();
let atomicWriteCounter = 0;

function optionEnv(options) {
  return options?.env && typeof options.env === "object" ? options.env : process.env;
}

function envValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function clampInteger(value, fallback, limits) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(numeric)));
}

function canonicalHttpUrl(value) {
  const source = String(value ?? "").trim();
  if (!source) return "";
  try {
    const parsed = new URL(source);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!parsed.hostname) return "";
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function normalizeLanguage(value, fallback) {
  const source = String(value ?? "").trim();
  if (!source) return fallback;
  if (source.toLowerCase() === "auto") return "auto";
  if (source.length > 64 || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(source)) return fallback;
  const parts = source.split("-");
  return parts.map((part, index) => {
    if (index === 0) return part.toLowerCase();
    if (part.length === 2 || /^\d{3}$/.test(part)) return part.toUpperCase();
    if (part.length === 4) return `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
    return part.toLowerCase();
  }).join("-");
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizedFallbacks(defaults = {}) {
  const serverUrl = canonicalHttpUrl(defaults.serverUrl) || HARD_DEFAULTS.serverUrl;
  return {
    automaticEnabled: normalizeBoolean(defaults.automaticEnabled, HARD_DEFAULTS.automaticEnabled),
    serverUrl,
    language: normalizeLanguage(defaults.language, HARD_DEFAULTS.language),
    level: normalizeEnum(defaults.level, LEVELS, HARD_DEFAULTS.level),
    performanceProfile: normalizeEnum(
      defaults.performanceProfile,
      PERFORMANCE_PROFILES,
      HARD_DEFAULTS.performanceProfile,
    ),
    manualLocalFallback: normalizeBoolean(defaults.manualLocalFallback, HARD_DEFAULTS.manualLocalFallback),
    remoteTimeoutMs: clampInteger(
      defaults.remoteTimeoutMs,
      HARD_DEFAULTS.remoteTimeoutMs,
      LANGUAGETOOL_SETTINGS_LIMITS.remoteTimeoutMs,
    ),
    retryCooldownMs: clampInteger(
      defaults.retryCooldownMs,
      HARD_DEFAULTS.retryCooldownMs,
      LANGUAGETOOL_SETTINGS_LIMITS.retryCooldownMs,
    ),
  };
}

export function normalizeLanguageToolSettings(value = {}, defaults = HARD_DEFAULTS) {
  const source = value && typeof value === "object" ? value : {};
  const fallback = normalizedFallbacks(defaults);
  return {
    automaticEnabled: normalizeBoolean(source.automaticEnabled, fallback.automaticEnabled),
    serverUrl: canonicalHttpUrl(source.serverUrl) || fallback.serverUrl,
    language: normalizeLanguage(source.language, fallback.language),
    level: normalizeEnum(source.level, LEVELS, fallback.level),
    performanceProfile: normalizeEnum(
      source.performanceProfile,
      PERFORMANCE_PROFILES,
      fallback.performanceProfile,
    ),
    manualLocalFallback: normalizeBoolean(source.manualLocalFallback, fallback.manualLocalFallback),
    remoteTimeoutMs: clampInteger(
      source.remoteTimeoutMs,
      fallback.remoteTimeoutMs,
      LANGUAGETOOL_SETTINGS_LIMITS.remoteTimeoutMs,
    ),
    retryCooldownMs: clampInteger(
      source.retryCooldownMs,
      fallback.retryCooldownMs,
      LANGUAGETOOL_SETTINGS_LIMITS.retryCooldownMs,
    ),
  };
}

export function languageToolSettingsDefaults(options = {}) {
  const env = optionEnv(options);
  return normalizeLanguageToolSettings({
    automaticEnabled: envValue(env, "AARONNOTE_LANGUAGETOOL_AUTOMATIC_ENABLED"),
    serverUrl: envValue(env, "AARONNOTE_LANGUAGETOOL_URL"),
    language: envValue(env, "AARONNOTE_LANGUAGETOOL_LANGUAGE"),
    level: envValue(env, "AARONNOTE_LANGUAGETOOL_LEVEL"),
    performanceProfile: envValue(env, "AARONNOTE_LANGUAGETOOL_PERFORMANCE_PROFILE"),
    manualLocalFallback: envValue(env, "AARONNOTE_LANGUAGETOOL_MANUAL_LOCAL_FALLBACK"),
    remoteTimeoutMs: envValue(env, "AARONNOTE_LANGUAGETOOL_REMOTE_TIMEOUT_MS"),
    retryCooldownMs: envValue(env, "AARONNOTE_LANGUAGETOOL_RETRY_COOLDOWN_MS"),
  }, HARD_DEFAULTS);
}

export function languageToolSettingsRevision(settings) {
  const normalized = normalizeLanguageToolSettings(settings);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

export function languageToolSettingsStateFile(options = {}) {
  const env = optionEnv(options);
  const workspaceRoot = resolve(String(
    options.workspaceRoot
      || envValue(env, "AARONNOTE_WORKSPACE_ROOT")
      || join(homedir(), ".config", "emacs"),
  ));
  const stateRoot = resolve(String(
    options.stateRoot
      || envValue(env, "AARONNOTE_STATE_DIR")
      || join(workspaceRoot, "var", "aaronnote"),
  ));
  return join(stateRoot, "languagetool.json");
}

function cacheKeyForDefaults(defaults) {
  return JSON.stringify(defaults);
}

async function readSettingsState(file, defaults) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const settings = parsed?.settings && typeof parsed.settings === "object"
      ? parsed.settings
      : parsed;
    return normalizeLanguageToolSettings(settings, defaults);
  } catch {
    return { ...defaults };
  }
}

async function readRawState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function atomicWriteJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temp = join(
    dirname(file),
    `.${basename(file)}.tmp-${process.pid}-${Date.now()}-${++atomicWriteCounter}`,
  );
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

function enqueueMutation(task) {
  const current = mutationQueue.catch(() => {}).then(task);
  mutationQueue = current.then(() => undefined, () => undefined);
  return current;
}

function invalidServerUrlError(value) {
  return Object.assign(
    new Error(`LanguageTool server URL must use http or https: ${String(value ?? "")}`),
    { code: "ERR_INVALID_LANGUAGETOOL_URL", statusCode: 400 },
  );
}

export async function getLanguageToolSettings(options = {}) {
  const file = languageToolSettingsStateFile(options);
  const defaults = languageToolSettingsDefaults(options);
  const defaultsKey = cacheKeyForDefaults(defaults);
  const cached = settingsCache.get(file);
  if (cached?.defaultsKey === defaultsKey) return { ...cached.settings };
  const settings = await readSettingsState(file, defaults);
  const latest = settingsCache.get(file);
  if (latest && latest !== cached && latest.defaultsKey === defaultsKey) return { ...latest.settings };
  settingsCache.set(file, { defaultsKey, settings });
  return { ...settings };
}

export async function updateLanguageToolSettings(patch = {}, options = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw Object.assign(new Error("LanguageTool settings update must be an object"), { statusCode: 400 });
  }
  if (Object.prototype.hasOwnProperty.call(patch, "serverUrl") && !canonicalHttpUrl(patch.serverUrl)) {
    throw invalidServerUrlError(patch.serverUrl);
  }
  return enqueueMutation(async () => {
    const file = languageToolSettingsStateFile(options);
    const defaults = languageToolSettingsDefaults(options);
    const current = await getLanguageToolSettings(options);
    const expectedRevision = String(options.expectedRevision || "").trim();
    if (expectedRevision && expectedRevision !== languageToolSettingsRevision(current)) {
      throw Object.assign(new Error("LanguageTool settings changed in another Noema window; reopen the tool"), {
        code: "ERR_STALE_LANGUAGETOOL_SETTINGS",
        statusCode: 409,
      });
    }
    const settings = normalizeLanguageToolSettings({ ...current, ...patch }, defaults);
    const raw = await readRawState(file);
    await atomicWriteJson(file, {
      ...raw,
      schemaVersion: LANGUAGETOOL_SETTINGS_SCHEMA_VERSION,
      settings,
      updatedAt: new Date().toISOString(),
    });
    settingsCache.set(file, { defaultsKey: cacheKeyForDefaults(defaults), settings });
    return { ...settings };
  });
}

export async function resetLanguageToolSettings(options = {}) {
  return enqueueMutation(async () => {
    const file = languageToolSettingsStateFile(options);
    const defaults = languageToolSettingsDefaults(options);
    await rm(file, { force: true });
    settingsCache.set(file, { defaultsKey: cacheKeyForDefaults(defaults), settings: defaults });
    return { ...defaults };
  });
}

export function clearLanguageToolSettingsCache(options) {
  if (options) {
    settingsCache.delete(languageToolSettingsStateFile(options));
    return;
  }
  settingsCache.clear();
}
