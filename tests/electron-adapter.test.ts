import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { installLocalApp } from "../scripts/install-local-app.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const readJson = (path: string) => JSON.parse(read(path));

describe("SiYuan-derived Electron desktop adapter", () => {
  test("uses pinned Electron without retaining Tauri runtime dependencies", () => {
    const manifest = readJson("package.json");
    const lock = read("package-lock.json");
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };

    expect(manifest.main).toBe("./desktop/main.mjs");
    expect(manifest.devDependencies.electron).toBe("42.9.2");
    expect(dependencies["@tauri-apps/api"]).toBeUndefined();
    expect(dependencies["@tauri-apps/cli"]).toBeUndefined();
    expect(lock).toContain('"node_modules/electron"');
    expect(lock).not.toMatch(/"node_modules\/@tauri-apps\/(?:api|cli)"/);
    expect(existsSync(resolve(root, "desktop/main.mjs"))).toBe(true);
    expect(existsSync(resolve(root, "desktop/preload.cjs"))).toBe(true);
    expect(existsSync(resolve(root, "desktop/Noema.icns"))).toBe(true);
    expect(existsSync(resolve(root, "src-tauri"))).toBe(false);
  });

  test("keeps Electron as a system adapter over the shared Node and Go backend", () => {
    const main = read("desktop/main.mjs");
    const preload = read("desktop/preload.cjs");
    const protocol = read("desktop/protocol-url.mjs");
    const webHost = read("web-host.mjs");

    expect(main).toContain("derived from SiYuan");
    expect(main).toContain("spawn(process.execPath, [hostScript]");
    expect(main).toContain('ELECTRON_RUN_AS_NODE: "1"');
    expect(main).toContain('AARONNOTE_HOST_MODE: "desktop"');
    expect(main).toContain("NOEMA_KERNEL_BIN: kernelBinaryPath()");
    expect(main).toContain("NOEMA_KERNEL_WORKSPACE");
    expect(main).toContain('app.setPath("sessionData"');
    expect(main).toContain('"Caches", "com.noema.desktop"');
    expect(main).toContain("noema-desktop-smoke-(\\d+)");
    expect(main).toContain("scheduleDesktopSmokeCleanup");
    expect(main).toContain('ELECTRON_RUN_AS_NODE: "1"');
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("sandbox: true");
    expect(main).toContain('ipcMain.handle("noema:export-pdf"');
    expect(main).toContain('ipcMain.handle("noema:export-html"');
    expect(main).toContain('ipcMain.handle("noema:select-directory"');
    expect(main).toContain('commandItem("Export Self-contained HTML…", "export-html")');
    expect(main).toContain('commandItem("Export PDF…", "export-pdf")');
    expect(main).toContain('commandItem("Import Obsidian Vault…", "import-obsidian")');
    expect(main).toContain('commandItem("Asset Maintenance…", "asset-maintenance")');
    expect(main).toContain("printHtmlToPdf");
    expect(main).toContain('app.on("open-url"');
    expect(main).toContain("app.setAsDefaultProtocolClient(NOEMA_PROTOCOL_SCHEME)");
    expect(main).not.toMatch(/const protocolRegistered = app\.isPackaged/);
    expect(main).toContain("parseNoemaProtocolUrl");
    expect(main).toContain('sendEditorCommand("open-location"');
    expect(protocol).toContain('export const NOEMA_PROTOCOL_SCHEME = "noema"');
    expect(protocol).toContain("protocolPathWithin");
    expect(main).not.toMatch(/spawn\([^\n]*noema-kernel/);
    expect(webHost).toContain("createKernelSupervisor");
    expect(webHost).toContain("createKernelVaultGitProvider");
    expect(webHost).toContain("configureWikiGitProvider");
    expect(webHost).not.toContain("connectDesktopKernel");
    expect(preload).toContain('contextBridge.exposeInMainWorld("noemaDesktop"');
    expect(preload).toContain('"noema:desktop-smoke-report"');
    expect(preload).toContain('"noema:broadcast-app-config"');
    expect(preload).toContain('ipcRenderer.invoke("noema:export-pdf", options)');
    expect(preload).toContain('ipcRenderer.invoke("noema:export-html", options)');
    expect(preload).toContain('ipcRenderer.invoke("noema:select-directory", options)');
  });

  test("retains current titlebar, TOC popover, Knowledge double-click and packaged smoke contracts", () => {
    const bridge = read("aaronnote/desktop-bridge.ts");
    const editor = read("aaronnote/main.ts");
    const wiki = read("aaronnote/wiki-main.ts");

    expect(editor).toContain('import "./desktop-bridge.ts"');
    expect(editor).toContain("floatingTocPanel.toggle()");
    expect(editor).toContain('addEventListener("dblclick", openKnowledgeDockFromPage)');
    expect(editor).toContain('desktopKnowledgeDock.show("backlinks")');
    expect(editor).toContain('case "knowledge-mentions"');
    expect(editor).toContain("api.knowledge.virtualReferences");
    expect(editor).toContain("createWorkspaceLayoutView(layoutRoot");
    expect(editor).toContain("createWorkspaceDockController({");
    expect(editor).toContain('id: "knowledge"');
    expect(editor).toContain('id: "agenda"');
    expect(editor).toContain('case "workspace-split-right"');
    expect(editor).toContain('case "workspace-split-below"');
    expect(editor).toContain("renderPublishedNoteHTML(currentMarkdownText()");
    expect(editor).toContain('case "export-pdf"');
    expect(editor).toContain('case "export-html"');
    expect(editor).toContain('case "asset-maintenance"');
    expect(editor).toContain('case "import-obsidian"');
    expect(editor).toContain("api.imports.obsidianStart(started.taskID, target)");
    expect(editor).toContain("createSelfContainedNoteHTML(currentMarkdownText()");
    expect(editor).toContain("window.noemaDesktop.exportPdf(printable)");
    expect(editor).toContain("window.__noemaDesktopPrintDocument = currentPrintablePdfDocument");
    expect(bridge).toContain("nativeReport.printDocument = window.__noemaDesktopPrintDocument?.()");
    expect(bridge).toContain("protocolProbeExpected");
    expect(bridge).toContain("openedFile: openedNoteFile");
    expect(editor).toContain('case "open-location"');
    expect(editor).not.toContain('desktopKnowledgeDock.toggle("outline")');
    expect(bridge).toContain("tocPopover");
    expect(bridge).toContain("openedByDoubleClick");
    expect(bridge).toContain('command: "knowledge-mentions"');
    expect(bridge).toContain("mentionStatus");
    expect(bridge).toContain("mentionItems");
    expect(bridge).toContain("agendaDock");
    expect(bridge).toContain("katexMacros");
    expect(bridge).toContain("b3ThemePrimary");
    expect(bridge).toContain('getPropertyValue("--b3-theme-background")');
    expect(bridge).toContain("visualTypography: auditVisualTypography(document)");
    expect(bridge).toContain("productionHandfeel: auditProductionHandfeel(document)");
    expect(bridge).toContain("workspaceLayout:");
    expect(bridge).toContain('command: "workspace-split-right"');
    expect(bridge).toContain('command: "workspace-close-active"');
    expect(bridge).toContain("splitWorkspaceFrames");
    expect(bridge).toContain("reportSmoke");
    expect(bridge).not.toContain("__TAURI_INTERNALS__");
    expect(wiki).toContain("window.noemaDesktop.openTarget");
    expect(wiki).toContain("window.noemaDesktop?.onCommand");
  });

  test("assembles a linked local Electron app without Rust or copied Chromium", () => {
    const build = read("scripts/build-electron.mjs");
    const prepare = read("scripts/prepare-electron-runtime.mjs");
    const makefile = read("Makefile");

    expect(build).toContain('resolve("node_modules", "electron", "dist", "Electron.app")');
    expect(build).toContain('hardlinkTree(join(sourceContents, "Frameworks")');
    expect(build).toContain('link(projectRoot, join(resources, "app")');
    expect(build).toContain('link(kernel, join(resources, "bin", "noema-kernel")');
    expect(build).toContain('link(resolve("desktop", "Noema.icns"), join(resources, "electron.icns")');
    expect(build).toContain('execFileSync("/bin/cp", ["-c"');
    expect(build).toContain('Add :CFBundleURLTypes array');
    expect(build).toContain('Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string noema');
    expect(build).not.toContain("cargo");
    expect(build).not.toContain("rustc");
    expect(prepare).toContain('"go",');
    expect(prepare).toContain('"fts5"');
    expect(makefile).toContain("build/electron/$(APP_NAME).app");
    expect(makefile).toContain("prune-legacy-garbage");
    expect(makefile).toContain("prune-desktop-stage");
    expect(makefile).toContain("clean-cache:");
    expect(makefile).toContain('"$(HOME)/Library/Caches/com.noema.desktop"');
    expect(makefile).toContain('"$(APP_DEST)" --link');
    expect(makefile).not.toContain("LOCAL_APP_MODE");
    expect(makefile).not.toContain("NOEMA_PORTABLE");
    expect(makefile).not.toContain("npm run prepare:tauri");
    expect(makefile).not.toContain("build-tauri.mjs");
  });

  test("transactionally installs a local app shell while preserving dependency links", async () => {
    const suite = await mkdtemp(join(tmpdir(), "noema-electron-install-"));
    const source = join(suite, "build", "Noema.app");
    const destination = join(suite, "Applications", "Noema.app");
    try {
      await mkdir(join(source, "Contents", "MacOS"), { recursive: true });
      await writeFile(join(source, "Contents", "Info.plist"), "plist");
      await writeFile(join(source, "Contents", "MacOS", "Noema"), "binary");
      const frameworks = join(source, "Contents", "Frameworks");
      const appSource = join(suite, "source");
      await mkdir(join(frameworks, "Versions", "A"), { recursive: true });
      await writeFile(join(frameworks, "Versions", "A", "Electron Framework"), "framework-binary");
      await symlink("A", join(frameworks, "Versions", "Current"), "dir");
      await symlink("Versions/Current/Electron Framework", join(frameworks, "Electron Framework"), "file");
      await mkdir(appSource);
      await mkdir(join(source, "Contents", "Resources"), { recursive: true });
      await symlink(appSource, join(source, "Contents", "Resources", "app"), "dir");
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "old-copy"), "old");

      await installLocalApp(source, destination);
      expect((await lstat(destination)).isDirectory()).toBe(true);
      const installedFrameworks = join(destination, "Contents", "Frameworks");
      const installedApp = join(destination, "Contents", "Resources", "app");
      expect((await lstat(installedFrameworks)).isDirectory()).toBe(true);
      expect(await realpath(installedApp)).toBe(await realpath(appSource));
      const sourceFramework = await stat(join(frameworks, "Versions", "A", "Electron Framework"));
      const installedFramework = await stat(join(installedFrameworks, "Electron Framework"));
      expect(installedFramework.dev).toBe(sourceFramework.dev);
      expect(installedFramework.ino).toBe(sourceFramework.ino);
      const sourceExecutable = await stat(join(source, "Contents", "MacOS", "Noema"));
      const installedExecutable = await stat(join(destination, "Contents", "MacOS", "Noema"));
      expect(installedExecutable.dev).toBe(sourceExecutable.dev);
      expect(installedExecutable.ino).not.toBe(sourceExecutable.ino);
      expect(existsSync(join(destination, "old-copy"))).toBe(false);

      await rm(source, { recursive: true, force: true });
      expect((await stat(join(destination, "Contents", "MacOS", "Noema"))).isFile()).toBe(true);
      expect((await stat(join(installedFrameworks, "Electron Framework"))).isFile()).toBe(true);
      expect(await realpath(installedApp)).toBe(await realpath(appSource));
    } finally {
      await rm(suite, { recursive: true, force: true });
    }
  });
});
