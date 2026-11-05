// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, writeFile, readFile, stat, lstat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { call, validateConnection } from "../plugins/marginnote/client.mjs";
import { buildAddon } from "../scripts/build-marginnote-addon.mjs";
const cleanups: (() => unknown)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const c of cleanups.splice(0).reverse()) await c(); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), "noema-mn-audit-")); cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir; }
const token = "t".repeat(43);

describe("MarginNote private client and package", () => {
  it("packages the official panel with no host credentials", async () => {
    const dir = await temp(), target = join(dir, "noema.mnaddon");
    await buildAddon(null, fileURLToPath(new URL("../plugins/marginnote", import.meta.url)), target);
    const names = JSON.parse(execFileSync("python3", ["-c", "import json,zipfile,sys;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))", target], {encoding:"utf8"}));
    expect(names).toContain("panel.html"); expect(names).not.toContain("connection.json");
  });
  it("MN-C5: rejects remote, credential-bearing and non-bridge destinations", () => {
    for (const url of ["https://example.com/v1/marginnote", "http://127.0.0.1.example.com:3212/v1/marginnote", "http://user@127.0.0.1:3212/v1/marginnote", "http://127.0.0.1:3212/api", "http://127.0.0.1:3212/v1/marginnote?secret=1"]) {
      expect(() => validateConnection({ url, token })).toThrow();
    }
    expect(validateConnection({ url: "http://127.0.0.1:3212/v1/marginnote", token }).url).toBe("http://127.0.0.1:3212/v1/marginnote");
  });
  it("MN-C5: a redirect never forwards a request to another route", async () => {
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.writeHead(302, { Location: "/leak" }); res.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
    const dir = await temp(), descriptor = join(dir, "host.json"), port = (server.address() as any).port;
    await writeFile(descriptor, JSON.stringify({ pid: process.pid, marginnote: { url: `http://127.0.0.1:${port}/v1/marginnote`, token } }), { mode: 0o600 });
    vi.stubEnv("NOEMA_HOST_DESCRIPTOR", descriptor);
    await expect(call("/sessions", undefined, {transport:"legacy"})).rejects.toThrow();
    expect(requests).toBe(1);
  });
  it("MN-C5: atomically replaces an archive without following an existing output symlink", async () => {
    const dir = await temp(), target = join(dir, "noema.mnaddon"), victim = join(dir, "unrelated.txt");
    await writeFile(victim, "keep me"); await symlink(victim, target);
    const source = fileURLToPath(new URL("../plugins/marginnote", import.meta.url));
    await buildAddon({ url: "http://127.0.0.1:3212/v1/marginnote", token }, source, target);
    expect(await readFile(victim, "utf8")).toBe("keep me");
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect((await readFile(target)).subarray(0, 2).toString()).toBe("PK");
  });
});
