import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zmq from "zeromq";
import { createKernelRegistry } from "../server/jupyter/kernel-registry.mjs";
import { defaultKernelSearchDirs, findKernelSpecs } from "../server/jupyter/kernel-finder.mjs";
import { executeOnKernel } from "../server/jupyter/execution-message-handler.mjs";

const RUN = process.env.AARONNOTE_TEST_KERNEL === "1";
const describeIfKernel = RUN ? describe : describe.skip;
const aaronnoteRoot = join(import.meta.dirname, "..");
const jupyterDataDir = join(aaronnoteRoot, "jupyter", ".jupyter", "data");

describeIfKernel("SageMath project kernel", () => {
  test("loads Sage and keeps the versioned user site enabled", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "aaronnote-sage-real-"));
    const registry = createKernelRegistry({ runtimeDir, zmq, launchTimeoutMs: 30_000 });
    const specs = await findKernelSpecs({
      searchDirs: defaultKernelSearchDirs({ dataDir: jupyterDataDir, useHomeKernels: false }),
    });
    const sagemath = specs.find((spec) => spec.name === "sagemath");
    expect(sagemath).toBeDefined();

    try {
      const record = await registry.ensure("sage-real-test", sagemath!);
      const result = await executeOnKernel(record.kernel, "import site\n(site.ENABLE_USER_SITE, factor(120))");
      expect(result.status).toBe("ok");
      const text = result.outputs
        .filter((output: any) => output.output_type === "execute_result")
        .map((output: any) => output.data?.["text/plain"] || "")
        .join("\n");
      expect(text).toContain("True");
      expect(text).toContain("2^3 * 3 * 5");
    } finally {
      await registry.shutdownAll();
      await rm(runtimeDir, { recursive: true, force: true });
    }
  }, 45_000);
});
