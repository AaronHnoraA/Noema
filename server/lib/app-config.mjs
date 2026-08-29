import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  NOEMA_APP_THEMES,
  NOEMA_DEFAULT_THEME_ID,
  noemaAppTheme,
  validNoemaAppThemeId,
} from "../../shared/app-themes.mjs";

export const NOEMA_APP_CONFIG_SCHEMA_VERSION = 3;

const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: NOEMA_APP_CONFIG_SCHEMA_VERSION,
  appearance: Object.freeze({ theme: NOEMA_DEFAULT_THEME_ID }),
  workspace: Object.freeze({
    root: "~/Documents/Noema",
    layout: "legacy",
  }),
  wiki: Object.freeze({
    creation: Object.freeze({
      activeProfile: "default",
      profiles: Object.freeze([
        Object.freeze({
          id: "default",
          name: "Default",
          partition: "private",
          repository: "",
          directory: "",
          filenamePattern: "{slug}.md",
          kind: "page",
        }),
      ]),
    }),
  }),
});

let mutationQueue = Promise.resolve();
let atomicWriteCounter = 0;

function optionEnv(options) {
  return options?.env && typeof options.env === "object" ? options.env : process.env;
}

function envValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function cloneDefaults() {
  return {
    schemaVersion: DEFAULT_CONFIG.schemaVersion,
    appearance: { ...DEFAULT_CONFIG.appearance },
    workspace: { ...DEFAULT_CONFIG.workspace },
    wiki: {
      creation: {
        activeProfile: DEFAULT_CONFIG.wiki.creation.activeProfile,
        profiles: DEFAULT_CONFIG.wiki.creation.profiles.map((profile) => ({ ...profile })),
      },
    },
  };
}

export function noemaAppConfigDir(options = {}) {
  const env = optionEnv(options);
  return resolve(String(
    options.configDir
      || envValue(env, "NOEMA_CONFIG_DIR")
      || join(homedir(), ".config", "noema"),
  ));
}

export function noemaAppConfigFile(options = {}) {
  return resolve(String(options.configFile || join(noemaAppConfigDir(options), "config.json")));
}

function revisionFor(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function withoutRetiredLineBreaking(raw) {
  if (!plainObject(raw) || !plainObject(raw.editor)
      || !Object.prototype.hasOwnProperty.call(raw.editor, "lineBreaking")) return raw;
  const editor = { ...raw.editor };
  delete editor.lineBreaking;
  const next = { ...raw };
  if (Object.keys(editor).length > 0) next.editor = editor;
  else delete next.editor;
  return next;
}

function normalizeParsedConfig(raw) {
  const diagnostics = [];
  const source = plainObject(raw) ? raw : {};
  const schemaVersion = Number(source.schemaVersion || 1);
  if (![1, 2, NOEMA_APP_CONFIG_SCHEMA_VERSION].includes(schemaVersion)) {
    diagnostics.push({
      code: "unsupported-schema",
      message: `Unsupported Noema config schemaVersion: ${String(source.schemaVersion)}`,
    });
    return { config: cloneDefaults(), diagnostics, writable: false };
  }
  if (schemaVersion < NOEMA_APP_CONFIG_SCHEMA_VERSION) {
    diagnostics.push({
      code: "migrated-schema",
      message: `Noema config schema v${schemaVersion} is loaded as v${NOEMA_APP_CONFIG_SCHEMA_VERSION}; existing settings are preserved`,
    });
  }

  const requestedTheme = String(
    plainObject(source.appearance) ? source.appearance.theme || "" : "",
  ).trim().toLowerCase();
  const theme = validNoemaAppThemeId(requestedTheme) ? requestedTheme : DEFAULT_CONFIG.appearance.theme;
  if (requestedTheme && requestedTheme !== theme) {
    diagnostics.push({
      code: "unknown-theme",
      message: `Unknown Noema theme: ${requestedTheme}; using ${noemaAppTheme("").name}`,
    });
  }

  const workspaceSource = plainObject(source.workspace) ? source.workspace : {};
  const root = String(workspaceSource.root || DEFAULT_CONFIG.workspace.root).trim() || DEFAULT_CONFIG.workspace.root;
  const layout = String(workspaceSource.layout || DEFAULT_CONFIG.workspace.layout).trim().toLowerCase() === "wiki"
    ? "wiki"
    : "legacy";
  const wikiSource = plainObject(source.wiki) ? source.wiki : {};
  const creationSource = plainObject(wikiSource.creation) ? wikiSource.creation : {};
  const rawProfiles = Array.isArray(creationSource.profiles) ? creationSource.profiles : [];
  const profiles = rawProfiles.map((profile, index) => {
    const value = plainObject(profile) ? profile : {};
    const id = String(value.id || `profile-${index + 1}`).trim().replace(/[^A-Za-z0-9._-]/g, "-");
    return {
      id: id || `profile-${index + 1}`,
      name: String(value.name || id || `Profile ${index + 1}`).trim(),
      partition: String(value.partition || "private").toLowerCase() === "public" ? "public" : "private",
      repository: String(value.repository || "").trim(),
      directory: String(value.directory || "").trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""),
      filenamePattern: String(value.filenamePattern || "{slug}.md").trim() || "{slug}.md",
      kind: String(value.kind || "page").trim() || "page",
    };
  });
  if (!profiles.length) profiles.push({ ...DEFAULT_CONFIG.wiki.creation.profiles[0] });
  const requestedProfile = String(creationSource.activeProfile || DEFAULT_CONFIG.wiki.creation.activeProfile).trim();
  const activeProfile = profiles.some((profile) => profile.id === requestedProfile)
    ? requestedProfile
    : profiles[0].id;

  return {
    config: {
      schemaVersion: NOEMA_APP_CONFIG_SCHEMA_VERSION,
      appearance: { theme },
      workspace: { root, layout },
      wiki: { creation: { activeProfile, profiles } },
    },
    diagnostics,
    writable: true,
  };
}

async function readConfigState(options = {}) {
  const file = noemaAppConfigFile(options);
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    if (!plainObject(raw)) throw new Error("Noema config root must be a JSON object");
    const normalized = normalizeParsedConfig(raw);
    return {
      file,
      exists: true,
      raw,
      revision: revisionFor(raw),
      ...normalized,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      const config = cloneDefaults();
      return {
        file,
        exists: false,
        raw: config,
        config,
        revision: revisionFor(config),
        diagnostics: [],
        writable: true,
      };
    }
    const config = cloneDefaults();
    return {
      file,
      exists: true,
      raw: null,
      config,
      revision: revisionFor(config),
      diagnostics: [{
        code: "invalid-json",
        message: `Unable to read Noema config: ${error instanceof Error ? error.message : String(error)}`,
      }],
      writable: false,
    };
  }
}

function publicPayload(state) {
  const theme = noemaAppTheme(state.config.appearance.theme);
  return {
    ok: true,
    configFile: state.file,
    config: state.config,
    defaults: cloneDefaults(),
    themes: NOEMA_APP_THEMES,
    activeTheme: theme,
    revision: state.revision,
    diagnostics: state.diagnostics,
  };
}

async function atomicWriteConfig(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
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

export async function getNoemaAppConfig(options = {}) {
  return publicPayload(await readConfigState(options));
}

export async function ensureNoemaAppConfig(options = {}) {
  return enqueueMutation(async () => {
    const state = await readConfigState(options);
    if (!state.exists) {
      await atomicWriteConfig(state.file, state.config);
      return publicPayload(await readConfigState(options));
    }
    const hasRetiredLineBreaking = plainObject(state.raw?.editor)
      && Object.prototype.hasOwnProperty.call(state.raw.editor, "lineBreaking");
    if (state.writable
        && (Number(state.raw?.schemaVersion || 1) < NOEMA_APP_CONFIG_SCHEMA_VERSION
          || hasRetiredLineBreaking)) {
      const sanitizedRaw = withoutRetiredLineBreaking(state.raw);
      await atomicWriteConfig(state.file, {
        ...sanitizedRaw,
        ...state.config,
        appearance: {
          ...(plainObject(state.raw.appearance) ? state.raw.appearance : {}),
          ...state.config.appearance,
        },
        workspace: {
          ...(plainObject(state.raw.workspace) ? state.raw.workspace : {}),
          ...state.config.workspace,
        },
        wiki: {
          ...(plainObject(state.raw.wiki) ? state.raw.wiki : {}),
          creation: {
            ...(plainObject(state.raw.wiki?.creation) ? state.raw.wiki.creation : {}),
            ...state.config.wiki.creation,
          },
        },
      });
      return publicPayload(await readConfigState(options));
    }
    return publicPayload(state);
  });
}

export async function updateNoemaAppConfig(patch = {}, options = {}) {
  if (!plainObject(patch)) {
    throw Object.assign(new Error("Noema config update must be an object"), { statusCode: 400 });
  }
  return enqueueMutation(async () => {
    const state = await readConfigState(options);
    if (!state.writable || !plainObject(state.raw)) {
      throw Object.assign(new Error(`Fix ${state.file} before changing settings`), {
        code: "ERR_INVALID_NOEMA_CONFIG",
        statusCode: 409,
      });
    }
    const expectedRevision = String(options.expectedRevision || patch.revision || "").trim();
    if (expectedRevision && expectedRevision !== state.revision) {
      throw Object.assign(new Error("Noema settings changed in another window; reopen Tools"), {
        code: "ERR_STALE_NOEMA_CONFIG",
        statusCode: 409,
      });
    }

    const appearancePatch = plainObject(patch.appearance) ? patch.appearance : {};
    const requestedTheme = Object.prototype.hasOwnProperty.call(appearancePatch, "theme")
      ? String(appearancePatch.theme || "").trim().toLowerCase()
      : state.config.appearance.theme;
    if (!validNoemaAppThemeId(requestedTheme)) {
      throw Object.assign(new Error(`Unknown Noema theme: ${requestedTheme}`), {
        code: "ERR_UNKNOWN_NOEMA_THEME",
        statusCode: 400,
      });
    }

    const rawAppearance = plainObject(state.raw.appearance) ? state.raw.appearance : {};
    const workspacePatch = plainObject(patch.workspace) ? patch.workspace : {};
    const requestedRoot = Object.prototype.hasOwnProperty.call(workspacePatch, "root")
      ? String(workspacePatch.root || "").trim()
      : state.config.workspace.root;
    if (!requestedRoot) {
      throw Object.assign(new Error("Workspace root is required"), { statusCode: 400 });
    }
    const requestedLayout = Object.prototype.hasOwnProperty.call(workspacePatch, "layout")
      ? String(workspacePatch.layout || "").trim().toLowerCase()
      : state.config.workspace.layout;
    if (!["legacy", "wiki"].includes(requestedLayout)) {
      throw Object.assign(new Error("Workspace layout must be legacy or wiki"), { statusCode: 400 });
    }
    const wikiPatch = plainObject(patch.wiki) ? patch.wiki : {};
    const creationPatch = plainObject(wikiPatch.creation) ? wikiPatch.creation : {};
    const requestedProfiles = Object.prototype.hasOwnProperty.call(creationPatch, "profiles")
      ? creationPatch.profiles
      : state.config.wiki.creation.profiles;
    if (!Array.isArray(requestedProfiles) || requestedProfiles.length === 0) {
      throw Object.assign(new Error("At least one Wiki creation profile is required"), { statusCode: 400 });
    }
    const normalizedWiki = normalizeParsedConfig({
      schemaVersion: NOEMA_APP_CONFIG_SCHEMA_VERSION,
      appearance: { theme: requestedTheme },
      workspace: { root: requestedRoot, layout: requestedLayout },
      wiki: { creation: {
        activeProfile: creationPatch.activeProfile ?? state.config.wiki.creation.activeProfile,
        profiles: requestedProfiles,
      } },
    }).config.wiki;
    const rawWorkspace = plainObject(state.raw.workspace) ? state.raw.workspace : {};
    const rawWiki = plainObject(state.raw.wiki) ? state.raw.wiki : {};
    const next = {
      ...withoutRetiredLineBreaking(state.raw),
      schemaVersion: NOEMA_APP_CONFIG_SCHEMA_VERSION,
      appearance: {
        ...rawAppearance,
        theme: requestedTheme,
      },
      workspace: {
        ...rawWorkspace,
        root: requestedRoot,
        layout: requestedLayout,
      },
      wiki: {
        ...rawWiki,
        creation: normalizedWiki.creation,
      },
    };
    await atomicWriteConfig(state.file, next);
    return publicPayload(await readConfigState(options));
  });
}
