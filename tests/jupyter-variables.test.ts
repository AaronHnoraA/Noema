import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zmq from "zeromq";
import { createJupyterCellService } from "../server/lib/jupyter-cell.mjs";

// variables() must exclude the kernel's *startup* namespace (Sage's
// `from sage.all import *` injects thousands of builtins directly into
// globals()) and IPython's own execution bookkeeping (In/Out/_i/_N history),
// showing only names the user's own code actually defined — matching real
// Jupyter/VS Code variable explorers. Gated: real kernel process.
const RUN = process.env.AARONNOTE_TEST_KERNEL === "1";
const describeIfKernel = RUN ? describe : describe.skip;

const aaronnoteRoot = join(import.meta.dirname, "..");

describeIfKernel("jupyter-cell variables() (real kernel)", () => {
  test(
    "excludes the startup namespace and IPython history, keeping only user-defined names",
    async () => {
      const noteRoot = await mkdtemp(join(tmpdir(), "aaronnote-vars-"));
      const service = createJupyterCellService({ runtimeRoot: aaronnoteRoot, noteRoot, workspaceRoot: noteRoot, zmq });
      const note = join(noteRoot, "note.md");
      await writeFile(note, "# note\n", "utf8");

      try {
        const before = await service.variables({ file: note, kernel: "python3", session: "default", language: "python" });
        expect(before.supported).toBe(true);
        expect(before.variables).toEqual([]);

        await service.execute({ file: note, kernel: "python3", session: "default", code: "my_var = 42\nanother = 'hello'" });
        const after = await service.variables({ file: note, kernel: "python3", session: "default", language: "python" });
        const names = after.variables.map((v: { name?: string }) => v.name).sort();
        expect(names).toEqual(["another", "my_var"]);
      } finally {
        await service.shutdown();
        await rm(noteRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test("non-python kernels report unsupported without erroring", async () => {
    const noteRoot = await mkdtemp(join(tmpdir(), "aaronnote-vars-bash-"));
    const service = createJupyterCellService({ runtimeRoot: aaronnoteRoot, noteRoot, workspaceRoot: noteRoot, zmq });
    const note = join(noteRoot, "note.md");
    await writeFile(note, "# note\n", "utf8");
    try {
      const result = await service.variables({ file: note, kernel: "bash", session: "default", language: "bash" });
      expect(result.supported).toBe(false);
      expect(result.variables).toEqual([]);
    } finally {
      await service.shutdown();
      await rm(noteRoot, { recursive: true, force: true });
    }
  });
});
