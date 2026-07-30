import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findKernelSpecs } from "../server/jupyter/kernel-finder.mjs";

async function writeKernel(root: string, name: string, displayName: string): Promise<void> {
  const directory = join(root, "kernels", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "kernel.json"), JSON.stringify({
    argv: ["python", "-f", "{connection_file}"],
    display_name: displayName,
    language: "python",
  }));
}

describe("Jupyter kernelspec discovery", () => {
  test("stable project Sage hides versioned duplicates but keeps remote Sage", async () => {
    const project = await mkdtemp(join(tmpdir(), "aaronnote-kernels-project-"));
    const system = await mkdtemp(join(tmpdir(), "aaronnote-kernels-system-"));
    await writeKernel(project, "sagemath", "SageMath current");
    await writeKernel(system, "SageMath-10.9", "SageMath 10.9");
    await writeKernel(system, "rik_ssh_remote_sage", "Remote Sage");
    const kernels = await findKernelSpecs({ searchDirs: [project, system] });
    expect(kernels.map((kernel) => kernel.name).sort()).toEqual([
      "rik_ssh_remote_sage",
      "sagemath",
    ]);
  });

  test("an explicit allowlist can still select a versioned Sage spec", async () => {
    const project = await mkdtemp(join(tmpdir(), "aaronnote-kernels-project-"));
    const system = await mkdtemp(join(tmpdir(), "aaronnote-kernels-system-"));
    await writeKernel(project, "sagemath", "SageMath current");
    await writeKernel(system, "SageMath-10.9", "SageMath 10.9");
    const kernels = await findKernelSpecs({
      searchDirs: [project, system],
      allowedNames: ["SageMath-10.9"],
    });
    expect(kernels.map((kernel) => kernel.name)).toEqual(["SageMath-10.9"]);
  });
});
