import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Server ESM module lives outside the renderer TypeScript graph.
import { createKernelVaultGitProvider } from "../server/lib/kernel-vaultgit-provider.mjs";

function kernelResponse(data: Record<string, unknown>, code = 0, msg = "") {
  return new Response(JSON.stringify({ code, msg, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("shared-host kernel vault Git provider", () => {
  test("maps repositories and actions to the bounded Go endpoints", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const status = {
        branch: "main",
        remote: "git@example.test:notes.git",
        clean: false,
        status: "## main\n M page.md",
        source: "kernel-vaultgit",
      };
      if (url.endsWith("/action")) {
        return kernelResponse({ ...status, action: body.action, phase: "idle", changedPaths: ["incoming.md"], message: "Repository refreshed" });
      }
      if (url.endsWith("/checkpoint")) {
        return kernelResponse({
          branch: body.branch,
          head: "0123456789abcdef0123456789abcdef01234567",
          committed: true,
          changedFiles: 2,
          identityFallback: false,
          source: "kernel-vaultgit",
        });
      }
      return kernelResponse(status);
    });
    const provider = createKernelVaultGitProvider({
      baseUrl: "http://127.0.0.1:43127/",
      box: { id: "box-1", root: "/notes" },
      fetchImpl,
    });

    expect(provider.owns("/notes/public/research")).toBe(true);
    expect(provider.owns("/outside/research")).toBe(false);
    await expect(provider.status("/notes/public/research")).resolves.toMatchObject({
      branch: "main", clean: false, source: "kernel-vaultgit",
    });
    await expect(provider.action({
      repositoryPath: "/notes/public/research",
      action: "pull",
      message: "",
      paths: [],
    })).resolves.toMatchObject({
      action: "pull", phase: "idle", changedPaths: ["incoming.md"], source: "kernel-vaultgit",
    });
    await expect(provider.checkpoint("/notes/public/research", {
      branch: "noema/test-device-01234567",
      message: "session checkpoint",
      deviceName: "test-device",
      deviceId: "01234567-device",
    })).resolves.toMatchObject({
      branch: "noema/test-device-01234567",
      committed: true,
      changedFiles: 2,
      source: "kernel-vaultgit",
    });
    expect(fetchImpl.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body || "{}")),
    }))).toEqual([
      {
        url: "http://127.0.0.1:43127/api/noema/vaultgit/status",
        body: { notebook: "box-1", path: "/public/research" },
      },
      {
        url: "http://127.0.0.1:43127/api/noema/vaultgit/action",
        body: { notebook: "box-1", path: "/public/research", action: "pull", message: "", paths: [] },
      },
      {
        url: "http://127.0.0.1:43127/api/noema/vaultgit/checkpoint",
        body: {
          notebook: "box-1",
          path: "/public/research",
          branch: "noema/test-device-01234567",
          message: "session checkpoint",
          deviceName: "test-device",
          deviceId: "01234567-device",
        },
      },
    ]);
  });

  test("fails closed on kernel errors and malformed status contracts", async () => {
    const failed = createKernelVaultGitProvider({
      baseUrl: "http://127.0.0.1:43127",
      box: { id: "box-1", root: "/notes" },
      fetchImpl: async () => kernelResponse({}, -1, "non-fast-forward pull rejected"),
    });
    await expect(failed.action({ repositoryPath: "/notes/public/research", action: "pull" }))
      .rejects.toMatchObject({ message: "non-fast-forward pull rejected", statusCode: 409 });

    const malformed = createKernelVaultGitProvider({
      baseUrl: "http://127.0.0.1:43127",
      box: { id: "box-1", root: "/notes" },
      fetchImpl: async () => kernelResponse({ branch: "main", clean: true }),
    });
    await expect(malformed.status("/notes/public/research")).rejects.toThrow(/invalid status shape/i);
    await expect(malformed.checkpoint("/notes/public/research", {
      branch: "main", deviceName: "test", deviceId: "01234567",
    })).rejects.toThrow(/invalid checkpoint shape/i);
    await expect(malformed.fetchMain("/notes/public/research"))
      .rejects.toThrow(/invalid transport shape/i);

    const requested = "0123456789abcdef0123456789abcdef01234567";
    const mismatchedPush = createKernelVaultGitProvider({
      baseUrl: "http://127.0.0.1:43127",
      box: { id: "box-1", root: "/notes" },
      fetchImpl: async () => kernelResponse({
        action: "push-main",
        commit: requested,
        remoteHead: "fedcba9876543210fedcba9876543210fedcba98",
        bootstrapped: false,
        source: "kernel-vaultgit",
      }),
    });
    await expect(mismatchedPush.pushMain("/notes/public/research", requested))
      .rejects.toThrow(/push commit does not match/i);
  });

  test("routes origin/main transport through exact bounded requests", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = createKernelVaultGitProvider({
      baseUrl: "http://127.0.0.1:43127",
      box: { id: "box-1", root: "/notes" },
      fetchImpl: async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || "{}"));
        calls.push({ url, body });
        return kernelResponse({
          action: body.action,
          commit: body.action === "fetch-main" ? "" : sha,
          remoteHead: sha,
          bootstrapped: body.action === "ensure-main",
          source: "kernel-vaultgit",
        });
      },
    });

    await expect(provider.ensureMain("/notes/private/research", sha)).resolves.toMatchObject({
      action: "ensure-main", commit: sha, remoteHead: sha, bootstrapped: true,
    });
    await expect(provider.fetchMain("/notes/private/research")).resolves.toMatchObject({
      action: "fetch-main", commit: "", remoteHead: sha, bootstrapped: false,
    });
    await expect(provider.pushMain("/notes/private/research", sha)).resolves.toMatchObject({
      action: "push-main", commit: sha, remoteHead: sha, bootstrapped: false,
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:43127/api/noema/vaultgit/transport",
        body: { notebook: "box-1", path: "/private/research", action: "ensure-main", commit: sha },
      },
      {
        url: "http://127.0.0.1:43127/api/noema/vaultgit/transport",
        body: { notebook: "box-1", path: "/private/research", action: "fetch-main", commit: "" },
      },
      {
        url: "http://127.0.0.1:43127/api/noema/vaultgit/transport",
        body: { notebook: "box-1", path: "/private/research", action: "push-main", commit: sha },
      },
    ]);
  });

  test("routes page history, diff, and indexed restore through Go", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = createKernelVaultGitProvider({
      baseUrl: "http://127.0.0.1:43127",
      box: { id: "box-1", root: "/notes" },
      fetchImpl: async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || "{}"));
        calls.push({ url, body });
        if (url.endsWith("/history")) return kernelResponse({
          path: "page.md",
          commits: [{ sha, date: "2026-08-26T00:00:00Z", author: "Historian", email: "history@example.test", subject: "version" }],
          source: "kernel-vaultgit",
        });
        if (url.endsWith("/diff")) return kernelResponse({
          path: "page.md", diff: "+Version", scope: "commit", sha, source: "kernel-vaultgit",
        });
        return kernelResponse({ path: "page.md", sha, source: "kernel-vaultgit", bytes: 18 });
      },
    });

    await expect(provider.history("/notes/private/history", "page.md", 25)).resolves.toMatchObject({
      path: "page.md", source: "kernel-vaultgit", commits: [{ sha, author: "Historian" }],
    });
    await expect(provider.diff("/notes/private/history", "page.md", sha)).resolves.toEqual({
      path: "page.md", diff: "+Version", scope: "commit", sha, source: "kernel-vaultgit",
    });
    await expect(provider.restore("/notes/private/history", "page.md", sha)).resolves.toEqual({
      path: "page.md", sha, source: "kernel-vaultgit", bytes: 18,
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:43127/api/noema/vaultgit/history",
        body: { notebook: "box-1", path: "/private/history", filePath: "page.md", limit: 25 },
      },
      {
        url: "http://127.0.0.1:43127/api/noema/vaultgit/diff",
        body: { notebook: "box-1", path: "/private/history", filePath: "page.md", sha },
      },
      {
        url: "http://127.0.0.1:43127/api/noema/vaultgit/restore",
        body: { notebook: "box-1", path: "/private/history", filePath: "page.md", sha },
      },
    ]);
  });
});
