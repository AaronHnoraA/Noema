import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore Node ESM modules outside the TS app graph.
import { hostDescriptorPath, readHostDescriptor, writeHostDescriptor } from "../server/lib/host-descriptor.mjs";
// @ts-ignore
import { mcpDescriptorPath, removeMcpDescriptor, writeMcpDescriptor } from "../server/lib/kernel-supervisor.mjs";

const roots: string[] = [];
const stateRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "noema-descriptor-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host descriptor", () => {
  test("names where the host listens and the process that wrote it, privately", async () => {
    const root = await stateRoot();
    const file = writeHostDescriptor(root, { url: "http://127.0.0.1:4100", noteRoot: "/vault" });
    expect(file).toBe(hostDescriptorPath(root));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: "http://127.0.0.1:4100", noteRoot: "/vault", pid: process.pid });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readHostDescriptor(root)).toMatchObject({ url: "http://127.0.0.1:4100", pid: process.pid });
  });

  test("a file left by a host that is gone is not a running host", async () => {
    const root = await stateRoot();
    writeHostDescriptor(root, { url: "http://127.0.0.1:4100" });
    expect(readHostDescriptor(root, () => false)).toBeNull();
    await writeFile(hostDescriptorPath(root), "not json");
    expect(readHostDescriptor(root)).toBeNull();
    expect(readHostDescriptor(join(root, "missing"))).toBeNull();
  });
});

describe("kernel descriptor", () => {
  test("only the process that wrote it removes it", async () => {
    const root = await stateRoot();
    // A restarted host writes its descriptor before the old host has exited.
    writeMcpDescriptor(root, { url: "http://127.0.0.1:6806/mcp", pid: 4242 });
    removeMcpDescriptor(root, 1111);
    expect(existsSync(mcpDescriptorPath(root))).toBe(true);
    removeMcpDescriptor(root, 4242);
    expect(existsSync(mcpDescriptorPath(root))).toBe(false);
    // Nothing to remove is not an error, and an unreadable file is cleared.
    removeMcpDescriptor(root, 4242);
    await writeFile(mcpDescriptorPath(root), "not json");
    removeMcpDescriptor(root, 4242);
    expect(existsSync(mcpDescriptorPath(root))).toBe(false);
  });
});
