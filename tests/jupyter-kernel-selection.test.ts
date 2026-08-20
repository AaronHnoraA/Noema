import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { selectedKernelOptionValue } from "../aaronnote/jupyter-kernel-selection.ts";

describe("Jupyter kernel selector state", () => {
  test("not-started never preselects the notebook kernelspec", () => {
    expect(selectedKernelOptionValue("", "not-started")).toBe("");
  });

  test("a detached session selects No Kernel", () => {
    expect(selectedKernelOptionValue("", "no-kernel")).toBe("none:");
  });

  test("a live runtime selects its connect entry", () => {
    expect(selectedKernelOptionValue("kernel-123", "idle"))
      .toBe("connect:kernel-123");
  });
});
