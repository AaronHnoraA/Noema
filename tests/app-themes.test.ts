import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  NOEMA_APP_THEMES,
  NOEMA_DEFAULT_THEME_ID,
  noemaAppTheme,
  validNoemaAppThemeId,
} from "../shared/app-themes.mjs";

const themeRoot = resolve(process.cwd(), "src", "styles", "themes");

describe("packaged Noema themes", () => {
  test("discovers selectable themes from the manifest without a JS theme list", () => {
    const manifest = JSON.parse(readFileSync(resolve(themeRoot, "themes.json"), "utf8"));
    expect(NOEMA_APP_THEMES).toEqual(manifest.themes);
    expect(NOEMA_DEFAULT_THEME_ID).toBe(manifest.defaultTheme);
    expect(noemaAppTheme("missing").id).toBe(manifest.defaultTheme);
    expect(validNoemaAppThemeId(manifest.defaultTheme)).toBe(true);
  });

  test("has one packaged CSS file and a complete token palette for every manifest entry", () => {
    const files = new Set(readdirSync(themeRoot));
    for (const theme of NOEMA_APP_THEMES) {
      expect(files.has(theme.file)).toBe(true);
      const css = readFileSync(resolve(themeRoot, theme.file), "utf8");
      expect(css).toContain(`data-noema-theme="${theme.id}"`);
      for (const token of [
        "--aaronnote-bg",
        "--aaronnote-chrome",
        "--aaron-ink",
        "--aaron-accent",
        "--aaron-code-bg",
        "--aaron-heading-1",
        "--aaron-role-strong",
      ]) {
        expect(css).toContain(token);
      }
    }
  });

  test("keeps the reusable editor theme inside the theme convention", () => {
    expect(filesInThemeDirectory()).toContain("theme-typora.css");
  });
});

function filesInThemeDirectory(): string[] {
  return readdirSync(themeRoot);
}
