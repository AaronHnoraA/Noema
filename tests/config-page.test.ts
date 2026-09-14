import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Noema Emacs-hosted Web surfaces", () => {
  test("builds and serves the agenda, configuration, Wiki, and Jupyter components", () => {
    const vite = source("vite.aaronnote.config.ts");
    const host = source("web-host.mjs");
    expect(vite).toContain('agenda: resolve("aaronnote/agenda.html")');
    expect(vite).toContain('config: resolve("aaronnote/config.html")');
    expect(vite).toContain('wiki: resolve("aaronnote/wiki.html")');
    expect(vite).toContain('jupyter: resolve("aaronnote/jupyter.html")');
    expect(host).toContain('url.pathname === "/agenda"');
    expect(host).toContain('serveStatic("/agenda.html"');
    expect(host).toContain('url.pathname === "/config"');
    expect(host).toContain('serveStatic("/config.html"');
    expect(host).toContain('url.pathname === "/wiki"');
    expect(source("src/jupyter-rendermime.ts")).toContain("OutputArea");
    expect(source("aaronnote/config-main.ts")).not.toContain("desktop-bridge");
  });

  test("keeps theme selection out of the compact Tools panel", () => {
    const main = source("aaronnote/main.ts");
    expect(main).not.toContain("renderThemeTool");
    expect(main).toContain('title: "Configuration"');
    expect(main).toContain('new URL("/config", window.location.origin)');
    expect(main).toContain('new URL("/wiki", location.origin)');
    expect(main).toContain('url.searchParams.set("new", "1")');
  });

  test("exposes the Git synchronization cadence instead of only the environment override", () => {
    const page = source("aaronnote/config-main.ts");
    expect(page).toContain('id="git-sync"');
    expect(page).toContain("data-sync-automatic");
    expect(page).toContain("data-sync-interval");
    expect(page).toContain("wiki: { sync: { automatic: syncAutomaticEl.checked, intervalMinutes } }");
    const host = source("web-host.mjs");
    expect(host).toContain("applyWikiSyncPolicy");
    expect(host).toContain("reconfigure({ debounceMs: wikiSyncIntervalMs(), periodicMs: wikiSyncIntervalMs() })");
  });

  test("renders manifest-provided themes and saves through the shared config API", () => {
    const page = source("aaronnote/config-main.ts");
    expect(page).toContain("for (const theme of payload.themes)");
    expect(page).toContain("setNoemaAppTheme(theme.id)");
    expect(page).toContain("payload.configFile");
  });
});
