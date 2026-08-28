export interface EmacsApiDependencies {
  apiOpenInEmacs: (file: unknown, line?: unknown, col?: unknown, tag?: unknown) => unknown;
  apiCurrentFile: (file: unknown) => unknown;
  apiEmacsInputFocus: (body: unknown) => unknown;
  apiEmacsUiState: (body: unknown) => unknown;
  apiEmacsKey: (key: unknown) => unknown;
  apiSystemOpen: (target: unknown) => unknown;
  apiEmacsZotero: (body: unknown, eventName?: string) => unknown;
  apiChooseNotePath: (body: unknown) => unknown;
}

export type EmacsApiHandler = (...args: unknown[]) => unknown;

export function createEmacsApiHandlers(
  dependencies: EmacsApiDependencies,
): Record<string, EmacsApiHandler>;
