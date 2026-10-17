import type { NoemaAppTheme, NoemaAppThemeId } from "../../shared/app-themes.mjs";
import type { NoemaEditorSettings, NoemaEditorSettingsPatch } from "../../shared/editor-settings.mjs";

export type NoemaAppConfig = {
  schemaVersion: 5;
  appearance: {
    theme: NoemaAppThemeId;
  };
  editor: NoemaEditorSettings;
  workspace: {
    root: string;
    layout: "legacy" | "wiki";
  };
  wiki: {
    sync: {
      automatic: boolean;
      intervalMinutes: number;
    };
    creation: {
      activeProfile: string;
      profiles: NoemaWikiCreationProfile[];
    };
  };
};

export declare const MIN_SYNC_INTERVAL_MINUTES: number;
export declare const MAX_SYNC_INTERVAL_MINUTES: number;

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
  editorSettingsExplicit: boolean;
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

export const NOEMA_APP_CONFIG_SCHEMA_VERSION: 5;
export function noemaAppConfigDir(options?: NoemaAppConfigOptions): string;
export function noemaAppConfigFile(options?: NoemaAppConfigOptions): string;
export function getNoemaAppConfig(options?: NoemaAppConfigOptions): Promise<NoemaAppConfigPayload>;
export function ensureNoemaAppConfig(options?: NoemaAppConfigOptions): Promise<NoemaAppConfigPayload>;
export function updateNoemaAppConfig(
  patch?: {
    appearance?: { theme?: NoemaAppThemeId | string };
    editor?: NoemaEditorSettingsPatch;
    workspace?: { root?: string; layout?: "legacy" | "wiki" | string };
    wiki?: {
      sync?: { automatic?: boolean; intervalMinutes?: number };
      creation?: { activeProfile?: string; profiles?: NoemaWikiCreationProfile[] };
    };
    revision?: string;
  },
  options?: NoemaAppConfigOptions,
): Promise<NoemaAppConfigPayload>;
