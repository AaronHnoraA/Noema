import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearLanguageToolSettingsCache,
  getLanguageToolSettings,
  languageToolSettingsDefaults,
  languageToolSettingsRevision,
  languageToolSettingsStateFile,
  normalizeLanguageToolSettings,
  resetLanguageToolSettings,
  updateLanguageToolSettings,
} from "../server/lib/languagetool-config.mjs";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aaronnote-languagetool-config-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  clearLanguageToolSettingsCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LanguageTool settings", () => {
  test("uses environment variables as normalized defaults", () => {
    const workspaceRoot = join(tmpdir(), "aaronnote-workspace-defaults");
    const env = {
      AARONNOTE_WORKSPACE_ROOT: workspaceRoot,
      AARONNOTE_LANGUAGETOOL_AUTOMATIC_ENABLED: "off",
      AARONNOTE_LANGUAGETOOL_URL: "https://lt.example.test/base///",
      AARONNOTE_LANGUAGETOOL_LANGUAGE: "en-gb",
      AARONNOTE_LANGUAGETOOL_LEVEL: "DEFAULT",
      AARONNOTE_LANGUAGETOOL_PERFORMANCE_PROFILE: "QUIET",
      AARONNOTE_LANGUAGETOOL_MANUAL_LOCAL_FALLBACK: "0",
      AARONNOTE_LANGUAGETOOL_REMOTE_TIMEOUT_MS: "8200",
      AARONNOTE_LANGUAGETOOL_RETRY_COOLDOWN_MS: "45000",
    };

    expect(languageToolSettingsDefaults({ env })).toEqual({
      automaticEnabled: false,
      serverUrl: "https://lt.example.test/base",
      language: "en-GB",
      level: "default",
      performanceProfile: "quiet",
      manualLocalFallback: false,
      remoteTimeoutMs: 8_200,
      retryCooldownMs: 45_000,
    });
    expect(languageToolSettingsStateFile({ env })).toBe(join(workspaceRoot, "var", "aaronnote", "languagetool.json"));
  });

  test("normalizes enums and clamps performance limits", () => {
    expect(normalizeLanguageToolSettings({
      automaticEnabled: "yes",
      serverUrl: "http://localhost:8081///",
      language: "zh-hans-cn",
      level: "PICKY",
      performanceProfile: "responsive",
      manualLocalFallback: "disabled",
      remoteTimeoutMs: -20,
      retryCooldownMs: 9_000_000,
    })).toEqual({
      automaticEnabled: true,
      serverUrl: "http://localhost:8081",
      language: "zh-Hans-CN",
      level: "picky",
      performanceProfile: "responsive",
      manualLocalFallback: false,
      remoteTimeoutMs: 500,
      retryCooldownMs: 300_000,
    });
  });

  test("persists updates atomically and serves isolated cached values", async () => {
    const stateRoot = await tempRoot();
    const options = { stateRoot, env: {} };
    const updated = await updateLanguageToolSettings({
      automaticEnabled: false,
      serverUrl: "https://grammar.example.test/lt/",
      language: "en-AU",
      performanceProfile: "quiet",
      remoteTimeoutMs: 7_500,
    }, options);

    expect(updated).toMatchObject({
      automaticEnabled: false,
      serverUrl: "https://grammar.example.test/lt",
      language: "en-AU",
      performanceProfile: "quiet",
      remoteTimeoutMs: 7_500,
    });

    const stateFile = languageToolSettingsStateFile(options);
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    expect(persisted).toMatchObject({ schemaVersion: 1, settings: updated });
    expect(persisted.updatedAt).toEqual(expect.any(String));
    expect((await readdir(stateRoot)).filter((name) => name.includes(".tmp-"))).toEqual([]);

    updated.serverUrl = "http://mutated.invalid";
    expect((await getLanguageToolSettings(options)).serverUrl).toBe("https://grammar.example.test/lt");

    clearLanguageToolSettingsCache(options);
    expect(await getLanguageToolSettings(options)).toMatchObject({
      automaticEnabled: false,
      serverUrl: "https://grammar.example.test/lt",
      language: "en-AU",
    });
  });

  test("rejects non-http server URLs without changing persisted settings", async () => {
    const stateRoot = await tempRoot();
    const options = { stateRoot, env: {} };
    await updateLanguageToolSettings({ serverUrl: "https://valid.example.test" }, options);

    await expect(updateLanguageToolSettings({ serverUrl: "file:///tmp/languagetool" }, options))
      .rejects.toMatchObject({ code: "ERR_INVALID_LANGUAGETOOL_URL", statusCode: 400 });
    expect((await getLanguageToolSettings(options)).serverUrl).toBe("https://valid.example.test");
  });

  test("falls back from corrupt state and reset restores current environment defaults", async () => {
    const stateRoot = await tempRoot();
    const env = {
      AARONNOTE_LANGUAGETOOL_URL: "https://default.example.test",
      AARONNOTE_LANGUAGETOOL_LANGUAGE: "en-GB",
      AARONNOTE_LANGUAGETOOL_AUTOMATIC_ENABLED: "false",
    };
    const options = { stateRoot, env };
    const stateFile = languageToolSettingsStateFile(options);
    await writeFile(stateFile, "{not-json", "utf8");

    expect(await getLanguageToolSettings(options)).toMatchObject({
      automaticEnabled: false,
      serverUrl: "https://default.example.test",
      language: "en-GB",
    });

    await updateLanguageToolSettings({ automaticEnabled: true, language: "fr-FR" }, options);
    expect(await resetLanguageToolSettings(options)).toEqual(languageToolSettingsDefaults(options));
    await expect(readFile(stateFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await getLanguageToolSettings(options)).toEqual(languageToolSettingsDefaults(options));
  });

  test("serializes concurrent partial updates without losing fields", async () => {
    const stateRoot = await tempRoot();
    const options = { stateRoot, env: {} };

    await Promise.all([
      updateLanguageToolSettings({ language: "de-DE" }, options),
      updateLanguageToolSettings({ performanceProfile: "responsive" }, options),
      updateLanguageToolSettings({ retryCooldownMs: 12_345 }, options),
    ]);

    expect(await getLanguageToolSettings(options)).toMatchObject({
      language: "de-DE",
      performanceProfile: "responsive",
      retryCooldownMs: 12_345,
    });
  });

  test("rejects a stale compare-and-set revision", async () => {
    const stateRoot = await tempRoot();
    const options = { stateRoot, env: {} };
    const initial = await getLanguageToolSettings(options);
    const revision = languageToolSettingsRevision(initial);
    await updateLanguageToolSettings({ language: "en-AU" }, { ...options, expectedRevision: revision });

    await expect(updateLanguageToolSettings(
      { performanceProfile: "quiet" },
      { ...options, expectedRevision: revision },
    )).rejects.toMatchObject({ code: "ERR_STALE_LANGUAGETOOL_SETTINGS", statusCode: 409 });
    expect(await getLanguageToolSettings(options)).toMatchObject({
      language: "en-AU",
      performanceProfile: "balanced",
    });
  });
});
