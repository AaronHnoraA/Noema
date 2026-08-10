import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultKernelSearchDirs, findKernelSpecs } from "../server/jupyter/kernel-finder.mjs";

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
  test("uses Windows Jupyter data roots without Unix or macOS directories", () => {
    expect(defaultKernelSearchDirs({
      dataDir: "C:\\Noema\\jupyter",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming", PROGRAMDATA: "C:\\ProgramData" },
    })).toEqual([
      "C:\\Noema\\jupyter",
      join("C:\\Users\\me\\AppData\\Roaming", "jupyter"),
      join("C:\\ProgramData", "jupyter"),
    ]);
  });

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

  test("loads bundled fallback templates and resolves runtime placeholders", async () => {
    const data = await mkdtemp(join(tmpdir(), "noema-kernels-data-"));
    const templates = await mkdtemp(join(tmpdir(), "noema-kernels-templates-"));
    const python = join(templates, "python3");
    await mkdir(python, { recursive: true });
    await writeFile(join(python, "kernel.json"), JSON.stringify({
      argv: ["@AARONNOTE_JUPYTER_ROOT@/bin/python-jupyter-kernel", "-f", "{connection_file}"],
      display_name: "Noema Python",
      language: "python",
      env: {
        HOME: "@NOEMA_USER_HOME@",
        IPYTHONDIR: "@AARONNOTE_JUPYTER_STATE_ROOT@/ipython",
      },
    }));

    const kernels = await findKernelSpecs({
      searchDirs: [data],
      fallbackKernelDirs: [templates],
      templateVariables: {
        AARONNOTE_JUPYTER_ROOT: "/Applications/Noema.app/Contents/Resources/jupyter",
        AARONNOTE_JUPYTER_STATE_ROOT: "/Users/me/Library/Application Support/com.noema.desktop/state/jupyter",
        NOEMA_USER_HOME: "/Users/me",
      },
    });

    expect(kernels).toHaveLength(1);
    expect(kernels[0]?.name).toBe("python3");
    expect(kernels[0]?.spec.argv[0]).toBe("/Applications/Noema.app/Contents/Resources/jupyter/bin/python-jupyter-kernel");
    expect(kernels[0]?.spec.env?.HOME).toBe("/Users/me");
    expect(kernels[0]?.spec.env?.IPYTHONDIR).toBe("/Users/me/Library/Application Support/com.noema.desktop/state/jupyter/ipython");
  });
});
