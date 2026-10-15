import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { jupyterKernelLabel } from "../aaronnote/jupyter-kernel-view.ts";

describe("Jupyter output page kernel state", () => {
  test("distinguishes an uncertain connection from confirmed kernel death", () => {
    expect(jupyterKernelLabel("python3", "default", { status: "disconnected" }))
      .toBe("python3 · default · connection lost · state unknown");
    expect(jupyterKernelLabel("python3", "default", { status: "unavailable" }))
      .toBe("python3 · default · status unavailable · state unknown");
    expect(jupyterKernelLabel("python3", "default", { status: "dead" }))
      .toBe("python3 · default · kernel dead · state lost");
    expect(jupyterKernelLabel("python3", "default", { status: "disconnected", stateLost: true }))
      .toBe("python3 · default · connection lost · state unknown");
  });

  test("keeps a new kernel's lost-state warning separate from its run status", () => {
    expect(jupyterKernelLabel("python3", "default", { status: "idle", stateLost: true }))
      .toBe("python3 · default · idle · state lost");
    expect(jupyterKernelLabel("python3", "default", { status: "error" }))
      .toBe("python3 · default · last run error");
    expect(jupyterKernelLabel("", "default", { status: "no-kernel" }))
      .toBe("No kernel selected");
  });
});
