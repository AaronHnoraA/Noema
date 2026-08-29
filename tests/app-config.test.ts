import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureNoemaAppConfig,
  getNoemaAppConfig,
  noemaAppConfigDir,
  noemaAppConfigFile,
  updateNoemaAppConfig,
} from "../server/lib/app-config.mjs";
import {
  NOEMA_APP_THEMES,
  NOEMA_DEFAULT_THEME_ID,
} from "../shared/app-themes.mjs";

const roots: string[] = [];

async function tempConfigDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "noema-app-config-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Noema app config", () => {
  test("uses ~/.config/noema and supports an explicit config directory override", () => {
    expect(noemaAppConfigDir({ env: {} })).toBe(join(homedir(), ".config", "noema"));
    expect(noemaAppConfigDir({ env: { NOEMA_CONFIG_DIR: "/tmp/noema-portable" } }))
      .toBe("/tmp/noema-portable");
    expect(noemaAppConfigFile({ configDir: "/tmp/noema-config" }))
      .toBe("/tmp/noema-config/config.json");
  });

  test("creates a minimal default config with private permissions", async () => {
    const configDir = await tempConfigDir();
    const payload = await ensureNoemaAppConfig({ configDir });
    expect(payload.configFile).toBe(join(configDir, "config.json"));
    expect(payload.config).toEqual({
      schemaVersion: 3,
      appearance: { theme: NOEMA_DEFAULT_THEME_ID },
      editor: { lineBreaking: "optimal" },
      workspace: { root: "~/Documents/Noema", layout: "legacy" },
      wiki: {
        creation: {
          activeProfile: "default",
          profiles: [{
            id: "default",
            name: "Default",
            partition: "private",
            repository: "",
            directory: "",
            filenamePattern: "{slug}.md",
            kind: "page",
          }],
        },
      },
    });
    expect(payload.themes).toEqual(NOEMA_APP_THEMES);
    expect(JSON.parse(await readFile(join(configDir, "config.json"), "utf8"))).toEqual(payload.config);
    expect((await stat(join(configDir, "config.json"))).mode & 0o777).toBe(0o600);
  });

  test("migrates v1, atomically updates the theme, and preserves unrelated settings", async () => {
    const configDir = await tempConfigDir();
    const file = join(configDir, "config.json");
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      appearance: { theme: NOEMA_DEFAULT_THEME_ID, density: "compact" },
      editor: { lineNumbers: true },
    }), "utf8");
    const initial = await getNoemaAppConfig({ configDir });
    const nextTheme = NOEMA_APP_THEMES.find((theme) => theme.id !== NOEMA_DEFAULT_THEME_ID)!;
    const updated = await updateNoemaAppConfig({
      appearance: { theme: nextTheme.id },
      revision: initial.revision,
    }, { configDir });

    expect(updated.config.appearance.theme).toBe(nextTheme.id);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      schemaVersion: 3,
      appearance: { theme: nextTheme.id, density: "compact" },
      editor: { lineNumbers: true },
    });
    expect((await readdir(configDir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("updates workspace layout and Wiki creation defaults", async () => {
    const configDir = await tempConfigDir();
    const initial = await ensureNoemaAppConfig({ configDir });
    const updated = await updateNoemaAppConfig({
      revision: initial.revision,
      workspace: { root: "~/Documents/Noema", layout: "wiki" },
      wiki: {
        creation: {
          activeProfile: "research",
          profiles: [{
            id: "research",
            name: "Research",
            partition: "public",
            repository: "math",
            directory: "papers",
            filenamePattern: "{slug}.md",
            kind: "paper",
          }],
        },
      },
    }, { configDir });
    expect(updated.config.workspace.layout).toBe("wiki");
    expect(updated.config.wiki.creation.profiles[0]).toMatchObject({
      id: "research",
      partition: "public",
      repository: "math",
      directory: "papers",
    });
  });

  test("updates the line-breaking mode and rejects unknown modes", async () => {
    const configDir = await tempConfigDir();
    const initial = await ensureNoemaAppConfig({ configDir });
    const updated = await updateNoemaAppConfig({
      revision: initial.revision,
      editor: { lineBreaking: "native" },
    }, { configDir });

    expect(updated.config.editor.lineBreaking).toBe("native");
    await expect(updateNoemaAppConfig({
      editor: { lineBreaking: "unknown" },
    }, { configDir })).rejects.toThrow("lineBreaking must be optimal or native");
  });

  test("rejects stale revisions and unknown themes", async () => {
    const configDir = await tempConfigDir();
    const initial = await ensureNoemaAppConfig({ configDir });
    const second = NOEMA_APP_THEMES[1]!;
    await updateNoemaAppConfig({
      appearance: { theme: second.id },
      revision: initial.revision,
    }, { configDir });

    await expect(updateNoemaAppConfig({
      appearance: { theme: NOEMA_DEFAULT_THEME_ID },
      revision: initial.revision,
    }, { configDir })).rejects.toMatchObject({ code: "ERR_STALE_NOEMA_CONFIG" });
    await expect(updateNoemaAppConfig({
      appearance: { theme: "not-installed" },
    }, { configDir })).rejects.toMatchObject({ code: "ERR_UNKNOWN_NOEMA_THEME" });
  });

  test("falls back without overwriting invalid JSON or unsupported schema", async () => {
    const configDir = await tempConfigDir();
    const file = join(configDir, "config.json");
    await writeFile(file, "{broken", "utf8");
    const broken = await getNoemaAppConfig({ configDir });
    expect(broken.config.appearance.theme).toBe(NOEMA_DEFAULT_THEME_ID);
    expect(broken.diagnostics[0]?.code).toBe("invalid-json");
    await expect(updateNoemaAppConfig({ appearance: { theme: NOEMA_APP_THEMES[1]!.id } }, { configDir }))
      .rejects.toMatchObject({ code: "ERR_INVALID_NOEMA_CONFIG" });
    expect(await readFile(file, "utf8")).toBe("{broken");

    await writeFile(file, JSON.stringify({ schemaVersion: 99, appearance: { theme: NOEMA_APP_THEMES[1]!.id } }), "utf8");
    const future = await getNoemaAppConfig({ configDir });
    expect(future.config.appearance.theme).toBe(NOEMA_DEFAULT_THEME_ID);
    expect(future.diagnostics[0]?.code).toBe("unsupported-schema");
  });

  test("reports an unavailable theme and keeps the manifest default active", async () => {
    const configDir = await tempConfigDir();
    await writeFile(join(configDir, "config.json"), JSON.stringify({
      schemaVersion: 1,
      appearance: { theme: "removed-theme" },
    }), "utf8");
    const payload = await getNoemaAppConfig({ configDir });
    expect(payload.config.appearance.theme).toBe(NOEMA_DEFAULT_THEME_ID);
    expect(payload.activeTheme.id).toBe(NOEMA_DEFAULT_THEME_ID);
    expect(payload.diagnostics.map((diagnostic) => diagnostic.code)).toContain("unknown-theme");
  });
});
