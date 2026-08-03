import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

const root = resolve(import.meta.dirname, "..");
const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

describe("Tauri desktop migration", () => {
  test("does not ship Electron or its bundled Chromium runtime", () => {
    const manifest = readJson("package.json");
    const lock = readFileSync(resolve(root, "package-lock.json"), "utf8");
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };

    expect(dependencies.electron).toBeUndefined();
    expect(dependencies["electron-builder"]).toBeUndefined();
    expect(lock).not.toMatch(/node_modules\/(?:electron|electron-builder)(?:"|\/)/);
    expect(existsSync(resolve(root, "desktop/main.mjs"))).toBe(false);
    expect(existsSync(resolve(root, "desktop/preload.cjs"))).toBe(false);
  });

  test("packages the web host behind a Tauri system-webview adapter", () => {
    const manifest = readJson("package.json");
    const config = readJson("src-tauri/tauri.conf.json");
    const bridge = readFileSync(resolve(root, "aaronnote/tauri-bridge.ts"), "utf8");
    const editor = readFileSync(resolve(root, "aaronnote/main.ts"), "utf8");
    const wiki = readFileSync(resolve(root, "aaronnote/wiki-main.ts"), "utf8");
    const webHost = readFileSync(resolve(root, "web-host.mjs"), "utf8");
    const host = readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");

    expect(manifest.dependencies["@tauri-apps/api"]).toBe("2.11.1");
    expect(manifest.devDependencies["@tauri-apps/cli"]).toBe("2.11.4");
    expect(config.mainBinaryName).toBe("Noema");
    expect(config.bundle.externalBin).toContain("binaries/noema-node");
    expect(config.bundle.resources["../web-host.mjs"]).toBe("web-host.mjs");
    expect(config.bundle.icon).toEqual(expect.arrayContaining([
      "icons/icon.icns",
      "icons/icon.ico",
    ]));
    expect(bridge).toContain("__TAURI_INTERNALS__");
    expect(bridge).toContain('listen("noema:command"');
    expect(host).toContain('append_pair("client", client)');
    expect(host).toContain("client: String");
    expect(host).toContain("migrate_legacy_desktop_state");
    expect(host).toContain("merge_legacy_cursor_positions");
    expect(wiki).toContain("window.noemaDesktop.openTarget");
    expect(wiki).toContain('source: "wiki"');
    expect(editor).toContain("flushCursorPositionKeepalive");
    expect(webHost).toContain("savePositionKeepalive");
  });

  test("selects native bundle formats for macOS, Windows, and Linux", () => {
    const buildScript = readFileSync(resolve(root, "scripts/build-tauri.mjs"), "utf8");
    const sidecarScript = readFileSync(resolve(root, "scripts/prepare-tauri-sidecar.mjs"), "utf8");

    expect(buildScript).toContain('win32: "nsis"');
    expect(buildScript).toContain('linux: "appimage"');
    expect(buildScript).toContain('darwin: "app"');
    expect(sidecarScript).toContain('"win32-x64"');
    expect(sidecarScript).toContain('"win32-arm64"');
  });
});
