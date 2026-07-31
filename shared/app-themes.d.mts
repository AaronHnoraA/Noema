export type NoemaAppThemeId = string;

export type NoemaAppTheme = {
  readonly id: NoemaAppThemeId;
  readonly name: string;
  readonly file: string;
  readonly colorScheme: "dark" | "light";
  readonly backgroundColor: string;
  readonly description: string;
};

export const NOEMA_APP_THEMES: readonly NoemaAppTheme[];
export const NOEMA_DEFAULT_THEME_ID: NoemaAppThemeId;
export function noemaAppTheme(themeId: unknown): NoemaAppTheme;
export function validNoemaAppThemeId(themeId: unknown): boolean;
