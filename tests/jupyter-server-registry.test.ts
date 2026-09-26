import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createServerRegistry } from "../server/jupyter/server-registry.mjs";

describe("Jupyter server registry", () => {
  test("coalesces parallel provider resolutions", async () => {
    let resolves = 0;
    const registry = createServerRegistry({
      async resolveServer() {
        resolves += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { url: "http://127.0.0.1:41000/", auth: "none", kind: "server" };
      },
    });

    const [left, right] = await Promise.all([
      registry.config("lab"),
      registry.config("lab"),
    ]);
    expect(left.baseUrl).toBe(right.baseUrl);
    expect(resolves).toBe(1);
    await registry.forgetAll();
  });

  test("re-resolves a provider URL when a recovered forward changes port", async () => {
    const urls = ["http://127.0.0.1:41001/", "http://127.0.0.1:41002/"];
    let resolves = 0;
    let releases = 0;
    const registry = createServerRegistry({
      async resolveServer() {
        const url = urls[Math.min(resolves, urls.length - 1)];
        resolves += 1;
        return { url, auth: "none", kind: "server" };
      },
      async releaseServer() {
        releases += 1;
      },
    });

    expect((await registry.config("lab")).baseUrl).toBe(urls[0]);
    const refreshed = await registry.refresh("lab");
    expect(refreshed.changed).toBe(true);
    expect((await registry.config("lab")).baseUrl).toBe(urls[1]);
    expect(resolves).toBe(3);

    await registry.forget("lab");
    expect(releases).toBe(1);
  });

  test("forget cancels an in-flight resolution without resurrecting its forward", async () => {
    let finishFirst;
    let resolves = 0;
    let releases = 0;
    const registry = createServerRegistry({
      resolveServer() {
        resolves += 1;
        if (resolves === 1) {
          return new Promise((resolve) => {
            finishFirst = () => resolve({
              url: "http://127.0.0.1:41003/", auth: "none", kind: "server",
            });
          });
        }
        return Promise.resolve({
          url: "http://127.0.0.1:41004/", auth: "none", kind: "server",
        });
      },
      async releaseServer() {
        releases += 1;
      },
    });

    const pending = registry.config("lab");
    // resolveServer is invoked synchronously before its returned promise is
    // awaited, so the deferred completion hook is available immediately.
    expect(typeof finishFirst).toBe("function");
    await registry.forget("lab");
    finishFirst!();
    await expect(pending).rejects.toThrow(/cancelled/);

    // A fresh request must not reuse the late result or its old local port.
    expect((await registry.config("lab")).baseUrl).toBe("http://127.0.0.1:41004/");
    expect(resolves).toBe(2);
    // One immediate release plus one after the late provider result becomes
    // visible.  Both calls are intentionally idempotent.
    expect(releases).toBe(2);
    await registry.forgetAll();
  });

  test("forget also cancels an in-flight refresh that resolves to the same config", async () => {
    let finishRefresh;
    let resolves = 0;
    let releases = 0;
    const stable = {
      url: "http://127.0.0.1:41005/", auth: "none" as const, kind: "server" as const,
    };
    const registry = createServerRegistry({
      resolveServer() {
        resolves += 1;
        if (resolves === 2) {
          return new Promise((resolve) => {
            finishRefresh = () => resolve(stable);
          });
        }
        return Promise.resolve(stable);
      },
      async releaseServer() {
        releases += 1;
      },
    });

    await registry.config("lab");
    const refreshing = registry.config("lab");
    expect(typeof finishRefresh).toBe("function");
    await registry.forget("lab");
    finishRefresh!();
    await expect(refreshing).rejects.toThrow(/cancelled/);
    expect(releases).toBe(2);

    // The cancelled refresh did not repopulate the cache.
    expect((await registry.config("lab")).baseUrl).toBe(stable.url);
    expect(resolves).toBe(3);
    await registry.forgetAll();
  });

  test("retain releases providers removed from the authoritative catalogue", async () => {
    const releases: string[] = [];
    const registry = createServerRegistry({
      async resolveServer(serverId) {
        return {
          url: `http://127.0.0.1:${serverId === "keep" ? 41006 : 41007}/`,
          auth: "none",
          kind: "server",
        };
      },
      async releaseServer(serverId) {
        releases.push(serverId);
      },
    });

    await Promise.all([registry.config("keep"), registry.config("remove")]);
    await registry.retain(["keep"]);
    expect(releases).toEqual(["remove"]);
    await registry.forgetAll();
    expect(releases).toEqual(["remove", "keep"]);
  });
});
