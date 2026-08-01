export type DesktopDropDisposition =
  | { type: "open"; paths: string[] }
  | { type: "insert"; paths: string[] };

export function isMarkdownFilePath(file: unknown): boolean;
export function desktopPlatformLabels(platform?: string): {
  primaryModifier: string;
  alternateModifier: string;
  fileManager: string;
  trash: string;
};
export function desktopTitleBarOverlay(platform: string, theme?: {
  backgroundColor?: string;
  colorScheme?: "dark" | "light" | string;
}): { color: string; symbolColor: string; height: number } | undefined;
export function desktopDropDisposition(
  files: Iterable<unknown> | ArrayLike<unknown>,
  forceAttachment?: boolean,
): DesktopDropDisposition;

export type DesktopWindowKind = "wiki" | "graph" | "note" | "config";
export type DesktopOpenAction = "focus" | "replace" | "new" | "split-right" | "split-down";

export function desktopWindowKind(urlValue?: string, file?: string): DesktopWindowKind;
export function desktopOpenDecision(options?: {
  source?: string;
  file?: string;
  windows?: Array<{
    id: number;
    kind?: string;
    file?: string;
    dirty?: boolean;
    busy?: boolean;
    destroyed?: boolean;
  }>;
  explicit?: string;
}): { action: DesktopOpenAction; windowId?: number };
export function desktopWindowRisk(state?: {
  dirty?: boolean;
  saveInFlight?: boolean;
  conflict?: boolean;
  busy?: boolean;
}): boolean;
export function sanitizeDesktopSession(value: unknown, limit?: number): {
  version: 1;
  windows: Array<{
    kind: "wiki" | "graph" | "note";
    file: string;
    route: string;
    bounds?: { x: number; y: number; width: number; height: number };
    maximized: boolean;
    fullScreen: boolean;
  }>;
};
