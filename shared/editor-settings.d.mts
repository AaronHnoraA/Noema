export type NoemaHeadingNumberFormat =
  | "decimal-hierarchical"
  | "upper-alpha-hierarchical"
  | "lower-alpha-hierarchical"
  | "upper-roman-hierarchical"
  | "lower-roman-hierarchical"
  | "upper-greek-hierarchical"
  | "lower-greek-hierarchical"
  | "decimal-parenthesized"
  | "chinese-document";

export type NoemaEditorSettings = {
  headingNumbering: { enabled: boolean; format: NoemaHeadingNumberFormat };
};
export type NoemaEditorSettingsPatch = {
  [K in keyof NoemaEditorSettings]?: Partial<NoemaEditorSettings[K]>;
};

export type NoemaEditorSetting =
  | {
      id: "headingNumbering.enabled";
      path: readonly ["headingNumbering", "enabled"];
      title: string;
      description: string;
      type: "boolean";
      default: false;
    }
  | {
      id: "headingNumbering.format";
      path: readonly ["headingNumbering", "format"];
      title: string;
      description: string;
      type: "enum";
      default: "decimal-hierarchical";
      choices: readonly { value: NoemaHeadingNumberFormat; label: string }[];
    };

export const NOEMA_EDITOR_SETTINGS: readonly NoemaEditorSetting[];
export function noemaEditorDefaults(): NoemaEditorSettings;
export function normalizeNoemaEditorSettings(
  source: unknown,
  options?: { strict?: boolean; diagnostics?: Array<{ code: string; message: string }> },
): NoemaEditorSettings;
export function mergeNoemaEditorSettings(
  current: NoemaEditorSettings,
  patch: NoemaEditorSettingsPatch,
): NoemaEditorSettings;
