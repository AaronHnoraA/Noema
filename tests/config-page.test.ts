import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Noema configuration page", () => {
  test("is a dedicated build entry and server route", () => {
    expect(source("vite.aaronnote.config.ts")).toContain('config: resolve("aaronnote/config.html")');
    expect(source("web-host.mjs")).toContain('url.pathname === "/config"');
    expect(source("web-host.mjs")).toContain('serveStatic("/config.html"');
  });

  test("keeps theme selection out of the compact Tools panel", () => {
    const main = source("aaronnote/main.ts");
    expect(main).not.toContain("renderThemeTool");
    expect(main).toContain('title: "Configuration"');
    expect(main).toContain('new URL("/config", window.location.origin)');
  });

  test("exposes the Git synchronization cadence instead of only the environment override", () => {
    const page = source("aaronnote/config-main.ts");
    expect(page).toContain('id="git-sync"');
    expect(page).toContain("data-sync-automatic");
    expect(page).toContain("data-sync-interval");
    expect(page).toContain("wiki: { sync: { automatic: syncAutomaticEl.checked, intervalMinutes } }");
    // The policy takes effect without a restart, unlike the layout section.
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
