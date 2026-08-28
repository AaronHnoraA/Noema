import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Noema kernel serve profile", () => {
  test("does not start unused SiYuan background services", () => {
    const serve = source("kernel/cli/cmd/serve.go");
    expect(serve).not.toContain("model.LoadFlashcards()\n");
    expect(serve).not.toContain("go model.AutoGenerateFileHistory()\n");
    expect(serve).not.toContain("go util.CheckFileSysStatus()\n");
    expect(serve).not.toContain("model.WatchEmojis()\n");
    expect(serve).not.toContain("model.WatchThemes()\n");

    // These are live Noema capabilities, not removable SiYuan residue.
    expect(serve).toContain("go cache.LoadAssets()\n");
    expect(serve).toContain("go model.StartEmbeddingIndexer()\n");
    expect(serve).toContain("model.WatchAssets()\n");
  });

  test("compatibility history code owns no package-init ticker", () => {
    const history = source("kernel/model/history.go");
    expect(history).not.toMatch(/historyTicker\s*=\s*time\.NewTicker/);
    expect(history).toContain("historyTicker   *time.Ticker");
  });

  test("removes the SiYuan third-party-sync stress loop", () => {
    const runtime = source("kernel/util/runtime.go");
    expect(runtime).not.toContain("thirdPartySyncCheckTicker");
    expect(runtime).not.toContain("filesys_status_check");
    expect(runtime).not.toContain("func CheckFileSysStatus");
  });

  test("arms connection keepalives only where live clients need them", () => {
    const host = source("web-host.mjs");
    expect(host).toContain("let sseHeartbeatInterval = null");
    expect(host).toContain('if (hostMode !== "server" || sseHeartbeatInterval || !eventClients.size) return;');
    expect(host).toContain("eventClients.set(res, eventClient);\n      startSseHeartbeat();");
    expect(host).toContain("req.on(\"close\", () => removeEventClient(res))");
    expect(host).toContain('if (!force && status === "connected") return Promise.resolve(true);');
    expect(host).not.toMatch(/const sseHeartbeatInterval\s*=\s*setInterval/);

    const jupyterWs = source("server/lib/jupyter-kernel-ws.mjs");
    expect(jupyterWs).toContain("let keepalive = null");
    expect(jupyterWs).toContain("ws.on(\"close\", stopKeepaliveIfIdle)");
    expect(jupyterWs).toContain("startKeepalive();");
    expect(jupyterWs).not.toMatch(/const keepalive\s*=\s*setInterval/);
  });

  test("sleeps until weekly wiki maintenance is due", () => {
    const host = source("web-host.mjs");
    expect(host).toContain("lastFull + WIKI_MAINTENANCE_INTERVAL_MS - Date.now()");
    expect(host).toContain("wikiMaintenanceTimer = setTimeout(async () => {");
    expect(host).not.toMatch(/wikiMaintenanceTimer\s*=.*setInterval/);
  });
});
