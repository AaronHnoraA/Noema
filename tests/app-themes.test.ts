import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
      const css = effectiveThemeCss(resolve(themeRoot, theme.file));
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
      expect(b3Definitions(css).size, `${theme.id} b3 variable contract`).toBe(165);
    }
  });

  test("bundles the complete source-owned b3 palette for daylight and midnight", () => {
    for (const id of ["daylight", "midnight"]) {
      const adapter = effectiveThemeCss(resolve(themeRoot, `${id}.css`));
      const source = readFileSync(resolve(
        process.cwd(), "app", "appearance", "themes", id, "theme.css",
      ), "utf8");
      const expected = b3Definitions(source);
      const actual = b3Definitions(adapter);
      expect(expected.size).toBe(165);
      expect([...actual].sort()).toEqual([...expected].sort());
      expect(source).toContain(":root:not([data-noema-theme])");
      expect(source).toContain(`:root[data-noema-theme="${id}"]`);
    }
  });

  test("keeps the reusable editor theme inside the theme convention", () => {
    expect(filesInThemeDirectory()).toContain("theme-typora.css");
  });
});

function filesInThemeDirectory(): string[] {
  return readdirSync(themeRoot);
}

function effectiveThemeCss(file: string, seen = new Set<string>()): string {
  const absolute = resolve(file);
  if (seen.has(absolute)) return "";
  seen.add(absolute);
  const source = readFileSync(absolute, "utf8");
  const imports = [...source.matchAll(/@import\s+["']([^"']+)["']/g)]
    .map((match) => effectiveThemeCss(resolve(dirname(absolute), match[1]!), seen));
  return `${source}\n${imports.join("\n")}`;
}

function b3Definitions(css: string): Set<string> {
  return new Set([...css.matchAll(/^\s*(--b3-[a-z0-9-]+)\s*:/gmi)].map((match) => match[1]!));
}
