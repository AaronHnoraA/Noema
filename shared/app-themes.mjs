import manifest from "../src/styles/themes/themes.json" with { type: "json" };
const entries = Array.isArray(manifest?.themes) ? manifest.themes : [];

function validEntry(theme) {
  return theme
    && typeof theme === "object"
    && /^[a-z0-9][a-z0-9_-]*$/.test(String(theme.id || ""))
    && String(theme.name || "").trim()
    && String(theme.file || "") === `${String(theme.id)}.css`
    && (theme.colorScheme === "dark" || theme.colorScheme === "light")
    && /^#[0-9a-f]{6}$/i.test(String(theme.backgroundColor || ""));
}

if (Number(manifest?.schemaVersion) !== 1 || entries.length === 0 || !entries.every(validEntry)) {
  throw new Error("Invalid Noema theme manifest");
}

const ids = entries.map((theme) => String(theme.id));
if (new Set(ids).size !== ids.length || !ids.includes(String(manifest.defaultTheme || ""))) {
  throw new Error("Noema theme manifest has duplicate IDs or an invalid default");
}

export const NOEMA_DEFAULT_THEME_ID = String(manifest.defaultTheme);
export const NOEMA_APP_THEMES = Object.freeze(entries.map((theme) => Object.freeze({
  id: String(theme.id),
  name: String(theme.name).trim(),
  file: String(theme.file),
  colorScheme: theme.colorScheme,
  backgroundColor: String(theme.backgroundColor),
  description: String(theme.description || "").trim(),
})));

const themeIds = new Set(NOEMA_APP_THEMES.map((theme) => theme.id));

export function noemaAppTheme(themeId) {
  const normalized = String(themeId || "").trim().toLowerCase();
  return NOEMA_APP_THEMES.find((theme) => theme.id === normalized)
    || NOEMA_APP_THEMES.find((theme) => theme.id === NOEMA_DEFAULT_THEME_ID)
    || NOEMA_APP_THEMES[0];
}

export function validNoemaAppThemeId(themeId) {
  return themeIds.has(String(themeId || "").trim().toLowerCase());
}
