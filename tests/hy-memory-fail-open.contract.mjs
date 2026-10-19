import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Run memory failure yields no context and leaves the caller running", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "noema-memory-fail-open-"));
  const config = path.join(directory, "memory.env");
  writeFileSync(config,
    "MEMORY_EMBEDDER_BASE_URL=http://127.0.0.1:1/v1\n"
    + "MEMORY_EMBEDDER_MODEL=unavailable\n"
    + "MEMORY_EMBEDDER_API_KEY=dummy\n", { mode: 0o600 });
  const oldConfig = process.env.NOEMA_HY_MEMORY_CONFIG;
  const oldPython = process.env.NOEMA_HY_MEMORY_PYTHON;
  process.env.NOEMA_HY_MEMORY_CONFIG = config;
  process.env.NOEMA_HY_MEMORY_PYTHON = "/bin/false";
  try {
    const { recallHyMemory } = await import("../server/lib/hy-memory-bridge.mjs");
    assert.deepEqual(await recallHyMemory("/tmp/project", "What is next?"), []);
    assert.deepEqual(await recallHyMemory("/tmp/project", "And then?"), []);
  } finally {
    if (oldConfig === undefined) delete process.env.NOEMA_HY_MEMORY_CONFIG;
    else process.env.NOEMA_HY_MEMORY_CONFIG = oldConfig;
    if (oldPython === undefined) delete process.env.NOEMA_HY_MEMORY_PYTHON;
    else process.env.NOEMA_HY_MEMORY_PYTHON = oldPython;
    rmSync(directory, { recursive: true, force: true });
  }
});
