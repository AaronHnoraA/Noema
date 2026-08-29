import type { NoemaAppTheme, NoemaAppThemeId } from "../../shared/app-themes.mjs";

export type NoemaAppConfig = {
  schemaVersion: 3;
  appearance: {
    theme: NoemaAppThemeId;
  };
  editor: {
    lineBreaking: "optimal" | "native";
  };
  workspace: {
    root: string;
    layout: "legacy" | "wiki";
  };
  wiki: {
    creation: {
      activeProfile: string;
      profiles: NoemaWikiCreationProfile[];
    };
  };
};

export type NoemaWikiCreationProfile = {
  id: string;
  name: string;
  partition: "public" | "private";
  repository: string;
  directory: string;
  filenamePattern: string;
  kind: string;
};

export type NoemaAppConfigDiagnostic = {
  code: string;
  message: string;
};

export type NoemaAppConfigPayload = {
  ok: true;
  configFile: string;
  config: NoemaAppConfig;
  defaults: NoemaAppConfig;
  themes: readonly NoemaAppTheme[];
  activeTheme: NoemaAppTheme;
  revision: string;
  diagnostics: NoemaAppConfigDiagnostic[];
};

export type NoemaAppConfigOptions = {
  env?: Record<string, string | undefined>;
  configDir?: string;
  configFile?: string;
  expectedRevision?: string;
};

export const NOEMA_APP_CONFIG_SCHEMA_VERSION: 3;
export function noemaAppConfigDir(options?: NoemaAppConfigOptions): string;
export function noemaAppConfigFile(options?: NoemaAppConfigOptions): string;
export function getNoemaAppConfig(options?: NoemaAppConfigOptions): Promise<NoemaAppConfigPayload>;
export function ensureNoemaAppConfig(options?: NoemaAppConfigOptions): Promise<NoemaAppConfigPayload>;
export function updateNoemaAppConfig(
  patch?: {
    appearance?: { theme?: NoemaAppThemeId | string };
    editor?: { lineBreaking?: "optimal" | "native" | string };
    workspace?: { root?: string; layout?: "legacy" | "wiki" | string };
    wiki?: { creation?: { activeProfile?: string; profiles?: NoemaWikiCreationProfile[] } };
    revision?: string;
  },
  options?: NoemaAppConfigOptions,
): Promise<NoemaAppConfigPayload>;
