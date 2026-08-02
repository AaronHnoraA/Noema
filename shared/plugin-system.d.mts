export type NoemaPluginManifest = {
  id: string;
  name: string;
  description?: string;
  version: string;
  apiVersion: 1;
  main: string;
  enabledByDefault?: boolean;
  activation?: { environment?: string };
  [key: string]: unknown;
};

export function pluginIdList(value?: unknown): string[];
export function pluginDirectoryList(value?: unknown): string[];
export function validatePluginManifest(value: unknown): NoemaPluginManifest;
export function pluginEnabled(
  manifest: NoemaPluginManifest,
  options?: { enabled?: string[]; disabled?: string[]; env?: Record<string, string | undefined> },
): boolean;
