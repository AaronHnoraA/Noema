import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");

describe("App and Emacs shared UI contract", () => {
  test("mounts one shared editor tree and limits host mode to adapter chrome", () => {
    const entry = read("aaronnote/main.ts");
    const css = read("aaronnote/style.css");

    expect(entry.match(/createEditor\(host/g)).toHaveLength(1);
    expect(entry).toContain('document.body.dataset.hostMode = serverReaderMode ? "server" : desktopMode ? "desktop" : "emacs"');
    expect(entry).toContain("createFocusQuiescenceController");
    expect(entry).toContain("focusQuiescenceEnabled()");
    expect(entry).toContain("createRendererActivityGate");
    expect(entry).toContain("rendererActivity.setPaused(next)");
    expect(entry).not.toMatch(/workspace-layout-view|workspace-dock|workspacePane|noema-desktop-workspace/);
    expect(entry).toContain('graphPanelRoot.className = "aaronnote-local-graph-panel noema-knowledge-dock is-collapsed"');
    expect(entry).not.toMatch(/desktopMode\s*&&\s*desktopKnowledgeDock/);
    expect(entry).not.toMatch(/surface:\s*"desktop-dock"/);
    expect(css).not.toMatch(/noema-workspace-(?:tab|leaf|dock|split|layout)/);
    expect(css).not.toMatch(/data-host-mode="emacs"[^}]*\.cm-(?:editor|content|scroller)/s);
  });

  test("serves the same dist renderer to Electron and the default Emacs host", () => {
    const host = read("web-host.mjs");
    const serverIndex = read("server/lib/index.mjs");
    const desktop = read("desktop/main.mjs");
    const makefile = read("Makefile");
    const manifest = JSON.parse(read("package.json"));

    expect(host).toContain('join(scriptDir, "dist", "aaronnote")');
    expect(host).toContain('command: "renderer-updated"');
    expect(host).toContain("window.AaronnotePrepareRendererReload");
    expect(host).toContain("window.__aaronnoteHostCapabilities");
    expect(host).toContain('focusQuiescence: hostMode === \"emacs\"');
    expect(host).toContain("kernelNoteCatalog");
    expect(serverIndex).toContain("kernelNoteCatalog,");
    expect(host).toContain("detail.generation !== window.__noemaRendererBuild");
    expect(host).toContain("generation: rendererBuildWatcher.generation");
    expect(desktop).toContain('AARONNOTE_WEB_DIR: join(appRoot, "dist", "aaronnote")');
    expect(desktop).toContain('AARONNOTE_HOST_MODE: "desktop"');
    expect(makefile).toContain("build: check-env check-go prune-legacy-garbage build-web");
    expect(makefile).toMatch(/^install: build$/mu);
    expect(manifest.scripts["build:desktop-shell"]).not.toContain("build:aaronnote");
    expect(manifest.scripts["build:desktop"]).toContain("build:aaronnote");
    expect(manifest.scripts["build:aaronnote"]).toContain("write-renderer-build.mjs");
  });

  test("keeps document canvas regions out of the raised b3 panel system", () => {
    const adapter = read("src/b3-component-system.ts");
    const widgets = read("src/styles/widgets.css");

    expect(adapter).toContain("Panels are deliberately opt-in");
    expect(adapter).not.toContain('element.tagName === "ASIDE"');
    expect(adapter).not.toContain('tokenEndsWithSurface(token, "panel")');
    expect(widgets).toMatch(/\.aaronnote-meta-cover\s*\{[^}]*background:\s*transparent/s);
    expect(widgets).toMatch(/\.aaronnote-meta-properties\s*\{[^}]*background:\s*transparent/s);
  });

  test("keeps block-handle hover selectors local during CM6 virtualization", () => {
    const widgets = read("src/styles/widgets.css");

    expect(widgets).toContain(".cm-editor .cm-block-drag-handle:hover");
    expect(widgets).not.toContain(".cm-line:hover ~ * .cm-block-drag-handle");
  });
});
