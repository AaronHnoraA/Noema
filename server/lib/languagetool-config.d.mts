export type LanguageToolLevel = "default" | "picky";
export type LanguageToolPerformanceProfile = "responsive" | "balanced" | "quiet";

export type LanguageToolSettings = {
  automaticEnabled: boolean;
  serverUrl: string;
  language: string;
  level: LanguageToolLevel;
  performanceProfile: LanguageToolPerformanceProfile;
  manualLocalFallback: boolean;
  remoteTimeoutMs: number;
  retryCooldownMs: number;
};

export type LanguageToolConfigOptions = {
  env?: Record<string, string | undefined>;
  workspaceRoot?: string;
  stateRoot?: string;
  expectedRevision?: string;
};

export const LANGUAGETOOL_SETTINGS_SCHEMA_VERSION: 1;
export const LANGUAGETOOL_SETTINGS_LIMITS: Readonly<{
  remoteTimeoutMs: Readonly<{ min: number; max: number }>;
  retryCooldownMs: Readonly<{ min: number; max: number }>;
}>;

export function normalizeLanguageToolSettings(
  value?: Partial<LanguageToolSettings> | Record<string, unknown>,
  defaults?: Partial<LanguageToolSettings> | Record<string, unknown>,
): LanguageToolSettings;

export function languageToolSettingsDefaults(options?: LanguageToolConfigOptions): LanguageToolSettings;
export function languageToolSettingsRevision(settings: Partial<LanguageToolSettings> | Record<string, unknown>): string;
export function languageToolSettingsStateFile(options?: LanguageToolConfigOptions): string;
export function getLanguageToolSettings(options?: LanguageToolConfigOptions): Promise<LanguageToolSettings>;
export function updateLanguageToolSettings(
  patch?: Partial<LanguageToolSettings> | Record<string, unknown>,
  options?: LanguageToolConfigOptions,
): Promise<LanguageToolSettings>;
export function resetLanguageToolSettings(options?: LanguageToolConfigOptions): Promise<LanguageToolSettings>;
export function clearLanguageToolSettingsCache(options?: LanguageToolConfigOptions): void;
