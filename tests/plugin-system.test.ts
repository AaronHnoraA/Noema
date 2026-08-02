import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  pluginDirectoryList,
  pluginEnabled,
  pluginIdList,
  validatePluginManifest,
} from "../shared/plugin-system.mjs";
// @ts-expect-error The desktop host is a Node ESM module outside the TS app graph.
import { createDesktopPluginHost } from "../desktop/plugin-host.mjs";

const chineseManifest = validatePluginManifest(JSON.parse(readFileSync(
  resolve(process.cwd(), "plugins/noema-zh-cn/plugin.json"),
  "utf8",
)));
const copilotManifest = validatePluginManifest(JSON.parse(readFileSync(
  resolve(process.cwd(), "plugins/noema-copilot/plugin.json"),
  "utf8",
)));

describe("Noema desktop plugin system", () => {
  test("validates versioned local plugin manifests", () => {
    expect(chineseManifest).toMatchObject({
      id: "noema.zh-cn",
      apiVersion: 1,
      main: "main.mjs",
      enabledByDefault: false,
    });
    expect(() => validatePluginManifest({ id: "unsafe", apiVersion: 1, main: "../main.mjs" })).toThrow();
    expect(() => validatePluginManifest({ id: "test.plugin", apiVersion: 2 })).toThrow();
    expect(copilotManifest).toMatchObject({
      id: "noema.copilot",
      enabledByDefault: true,
      configurable: false,
    });
  });

  test("uses explicit settings and environment overrides without locale activation", () => {
    expect(pluginEnabled(chineseManifest)).toBe(false);
    expect(pluginEnabled(chineseManifest, { enabled: ["noema.zh-cn"] })).toBe(true);
    expect(pluginEnabled(chineseManifest, { enabled: ["noema.zh-cn"], disabled: ["noema.zh-cn"] })).toBe(false);
    expect(pluginEnabled(chineseManifest, { enabled: ["noema.zh-cn"], env: { LANG: "zh_CN.UTF-8" } })).toBe(true);
  });

  test("parses configured IDs and platform path lists", () => {
    expect(pluginIdList("one.plugin, two.plugin\nthree.plugin")).toEqual(["one.plugin", "two.plugin", "three.plugin"]);
    expect(pluginDirectoryList(["/one", "/two"].join(process.platform === "win32" ? ";" : ":"))).toEqual(["/one", "/two"]);
  });

  test("ships the Chinese dictionary and protects editor content", () => {
    const dictionary = JSON.parse(readFileSync(resolve(process.cwd(), "plugins/noema-zh-cn/zh-CN.json"), "utf8"));
    const renderer = readFileSync(resolve(process.cwd(), "plugins/noema-zh-cn/renderer.js"), "utf8");
    expect(Object.keys(dictionary.exact).length).toBeGreaterThan(900);
    expect(dictionary.regex.length).toBeGreaterThan(150);
    expect(renderer).toContain('var SKIP_SELECTOR = ".cm-content"');
    expect(renderer).toContain("if (node.matches && node.matches(SKIP_SELECTOR)) continue");
  });

  test("keeps Copilot active and points desktop hosts at the packaged server", async () => {
    const userData = mkdtempSync(resolve(tmpdir(), "noema-plugin-test-"));
    const host = createDesktopPluginHost({
      app: { on: () => {} },
      session: {},
      net: {},
      appRoot: process.cwd(),
      userData,
      env: { NOEMA_DISABLED_PLUGINS: "noema.copilot" },
    });
    try {
      await host.load();
      expect(host.availablePlugins()).toContainEqual(expect.objectContaining({
        id: "noema.copilot",
        enabled: true,
        active: true,
        configurable: false,
        locked: true,
      }));
      const environment = host.transformHostEnvironment({}, { hostMode: "desktop" });
      expect(environment.NOEMA_COPILOT_PLUGIN).toBe("noema.copilot");
      expect(environment.AARONNOTE_COPILOT_LANGUAGE_SERVER_MODULE)
        .toBe(resolve(process.cwd(), "node_modules/@github/copilot-language-server/dist/language-server.js"));
      expect(environment.AARONNOTE_COPILOT_HOME).toBe(join(userData, "plugin-state/noema.copilot/home"));
      expect(environment.AARONNOTE_COPILOT_XDG_CONFIG_HOME).toBe(join(userData, "plugin-state/noema.copilot/xdg/config"));
      await expect(host.setPluginEnabled("noema.copilot", false)).rejects.toThrow(/always-active/);
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
