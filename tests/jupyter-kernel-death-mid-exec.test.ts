import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zmq from "zeromq";
import { createKernelRegistry } from "../server/jupyter/kernel-registry.mjs";
import { defaultKernelSearchDirs, findKernelSpecs } from "../server/jupyter/kernel-finder.mjs";
import { executeOnKernel } from "../server/jupyter/execution-message-handler.mjs";

// A kernel process dying *mid-execution* (crash, OOM-killed) must fail the
// pending execute() promptly rather than hang forever — verifies that jlab's
// own future.dispose()-on-kernel-dispose rejection (triggered by our
// kernel-registry exit handler calling kernel.dispose()) actually propagates
// through executeOnKernel. Gated: real kernel process.
const RUN = process.env.AARONNOTE_TEST_KERNEL === "1";
const describeIfKernel = RUN ? describe : describe.skip;

const aaronnoteRoot = join(import.meta.dirname, "..");
const jupyterDataDir = join(aaronnoteRoot, "jupyter", ".jupyter", "data");

describeIfKernel("kernel death mid-execution (real ipykernel)", () => {
  test(
    "executeOnKernel rejects promptly (not hangs) when the kernel process is killed mid-run",
    async () => {
      const runtimeDir = await mkdtemp(join(tmpdir(), "aaronnote-death-"));
      const registry = createKernelRegistry({ runtimeDir, zmq, launchTimeoutMs: 15_000 });
      const searchDirs = defaultKernelSearchDirs({ dataDir: jupyterDataDir, useHomeKernels: false });
      const specs = await findKernelSpecs({ searchDirs });
      const python3 = specs.find((s) => s.name === "python3")!;

      try {
        const record = await registry.ensure("death-test", python3);
        const pending = executeOnKernel(record.kernel, "import time\ntime.sleep(30)");
        await new Promise((resolve) => setTimeout(resolve, 500));
        process.kill(record.process!.pid!, "SIGKILL");

        const start = Date.now();
        await expect(pending).rejects.toThrow();
        const elapsed = Date.now() - start;
        // Should fail as soon as the exit handler disposes the kernel
        // connection, not after any execution timeout — a few seconds is
        // generous slack for process-exit + dispose propagation.
        expect(elapsed).toBeLessThan(5000);
      } finally {
        await registry.shutdownAll().catch(() => {});
        await rm(runtimeDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
