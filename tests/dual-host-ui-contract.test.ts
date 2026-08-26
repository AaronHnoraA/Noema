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
    expect(entry).not.toMatch(/workspace-layout-view|workspace-dock|workspacePane|noema-desktop-workspace/);
    expect(entry).toContain('graphPanelRoot.className = "aaronnote-local-graph-panel noema-knowledge-dock is-collapsed"');
    expect(entry).not.toMatch(/desktopMode\s*&&\s*desktopKnowledgeDock/);
    expect(entry).not.toMatch(/surface:\s*"desktop-dock"/);
    expect(css).not.toMatch(/noema-workspace-(?:tab|leaf|dock|split|layout)/);
    expect(css).not.toMatch(/data-host-mode="emacs"[^}]*\.cm-(?:editor|content|scroller)/s);
  });

  test("serves the same dist renderer to Electron and the default Emacs host", () => {
    const host = read("web-host.mjs");
    const desktop = read("desktop/main.mjs");
    const makefile = read("Makefile");
    const manifest = JSON.parse(read("package.json"));

    expect(host).toContain('join(scriptDir, "dist", "aaronnote")');
    expect(desktop).toContain('AARONNOTE_WEB_DIR: join(appRoot, "dist", "aaronnote")');
    expect(desktop).toContain('AARONNOTE_HOST_MODE: "desktop"');
    expect(makefile).toContain("build: check-env check-go prune-legacy-garbage build-web");
    expect(manifest.scripts["build:desktop-shell"]).not.toContain("build:aaronnote");
    expect(manifest.scripts["build:desktop"]).toContain("build:aaronnote");
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
});
