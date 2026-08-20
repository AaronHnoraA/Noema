import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

// The server handler stays a tiny JavaScript boundary by design.
// @ts-expect-error no declaration file is needed for this route table.
import { createJupyterApiHandlers } from "../server/Features/Jupyter/api.mjs";

describe("Emacs-owned Jupyter manager API", () => {
  test("exposes manager, script, session, and opaque kernel routes", async () => {
    const managerSnapshot = vi.fn(async () => ({ ok: true, kernels: [] }));
    const documentSnapshot = vi.fn(async (body: unknown) => ({ ok: true, body }));
    const scriptAction = vi.fn(async (body: unknown) => ({ ok: true, body }));
    const sessionSelect = vi.fn(async (body: unknown) => ({ ok: true, body }));
    const kernelControl = vi.fn(async (body: unknown) => ({ ok: true, body }));
    const handlers = createJupyterApiHandlers({
      managerSnapshot,
      documentSnapshot,
      scriptAction,
      sessionSelect,
      kernelControl,
    });

    await handlers["aaronnote:api:jupyter:manager-snapshot"]();
    await handlers["aaronnote:api:jupyter:script-snapshot"]({ scriptFile: "/tmp/a.ipynb" });
    await handlers["aaronnote:api:jupyter:script-action"]({ scriptFile: "/tmp/a.ipynb", action: "run-all" });
    await handlers["aaronnote:api:jupyter:session-select"]({ scriptFile: "/tmp/a.ipynb", kind: "none" });
    await handlers["aaronnote:api:jupyter:kernel-control"]({ kernelId: "kernel-a", action: "interrupt" });

    expect(managerSnapshot).toHaveBeenCalledOnce();
    expect(documentSnapshot).toHaveBeenCalledWith({ scriptFile: "/tmp/a.ipynb" });
    expect(scriptAction).toHaveBeenCalledWith({ scriptFile: "/tmp/a.ipynb", action: "run-all" });
    expect(sessionSelect).toHaveBeenCalledWith({ scriptFile: "/tmp/a.ipynb", kind: "none" });
    expect(kernelControl).toHaveBeenCalledWith({ kernelId: "kernel-a", action: "interrupt" });
  });
});
