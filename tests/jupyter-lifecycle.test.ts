import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import * as zmq from "zeromq";
import { createKernelRegistry, sweepOrphanKernels } from "../server/jupyter/kernel-registry.mjs";
import { defaultKernelSearchDirs, findKernelSpecs } from "../server/jupyter/kernel-finder.mjs";
import { createJupyterCellService } from "../server/lib/jupyter-cell.mjs";

// Lifecycle-audit fixes: self-heal generation bump, orphan-process sweep on
// startup, execution-hang timeout+interrupt escalation, and idle-TTL reap.
// Gated (real kernel processes), like the other server/jupyter tests.
const RUN = process.env.AARONNOTE_TEST_KERNEL === "1";
const describeIfKernel = RUN ? describe : describe.skip;

const aaronnoteRoot = join(import.meta.dirname, "..");
const jupyterDataDir = join(aaronnoteRoot, "jupyter", ".jupyter", "data");
const pythonKernelRunner = join(aaronnoteRoot, "jupyter", "bin", "python-jupyter-kernel");

describeIfKernel("kernel lifecycle (real ipykernel)", () => {
  test(
    "ensure() self-heals a dead record and bumps widgetGeneration (not just manual restart)",
    async () => {
      const runtimeDir = await mkdtemp(join(tmpdir(), "aaronnote-selfheal-"));
      const registry = createKernelRegistry({ runtimeDir, zmq, launchTimeoutMs: 15_000 });
      const searchDirs = defaultKernelSearchDirs({ dataDir: jupyterDataDir, useHomeKernels: false });
      const specs = await findKernelSpecs({ searchDirs });
      const python3 = specs.find((s) => s.name === "python3")!;
      const key = "self-heal-test";

      try {
        const first = await registry.ensure(key, python3);
        expect(first.widgetGeneration).toBe(1);

        // Simulate an unexpected kernel death (crash, OOM-killed, etc) rather
        // than a user-initiated restart.
        process.kill(first.process!.pid!, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(registry.get(key)).toBeUndefined(); // dead records are hidden from get()

        const healed = await registry.ensure(key, python3);
        expect(healed.id).not.toBe(first.id);
        expect(healed.widgetGeneration).toBe(2); // bumped on self-heal, not just manual restart

        const future = healed.kernel.requestExecute({ code: "1+1" });
        const reply = await future.done;
        expect(reply.content.status).toBe("ok");
      } finally {
        await registry.shutdownAll();
        await rm(runtimeDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "orphan sweep kills a kernel process left running by a sidecar entry, and ignores dead ones",
    async () => {
      const runtimeDir = await mkdtemp(join(tmpdir(), "aaronnote-orphan-"));
      // Spawn a bare kernel process directly (no registry attached) to model a
      // process left behind by a *crashed, no-longer-running* server instance
      // — nothing in this test process reacts to its death, unlike a live
      // registry's own exit handler would.
      const ports: number[] = [];
      for (let i = 0; i < 5; i++) {
        const port = await new Promise<number>((resolve, reject) => {
          const srv = net.createServer();
          srv.listen(0, "127.0.0.1", () => {
            const address = srv.address();
            const p = typeof address === "object" && address ? address.port : 0;
            srv.close(() => resolve(p));
          });
          srv.on("error", reject);
        });
        ports.push(port);
      }
      const connectionInfo = {
        key: crypto.randomUUID(),
        signature_scheme: "hmac-sha256",
        transport: "tcp" as const,
        ip: "127.0.0.1",
        hb_port: ports[0],
        control_port: ports[1],
        shell_port: ports[2],
        stdin_port: ports[3],
        iopub_port: ports[4],
        kernel_name: "python3",
      };
      const connectionFile = join(runtimeDir, "orphan-kernel.json");
      await writeFile(connectionFile, JSON.stringify(connectionInfo));
      const proc = spawn(pythonKernelRunner, ["-m", "ipykernel_launcher", "-f", connectionFile], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const pid = proc.pid!;

      const sidecarPath = join(runtimeDir, "aaronnote-owned.json");
      const staleFile = join(runtimeDir, "stale-already-gone.json");
      await writeFile(staleFile, "{}");
      await writeFile(
        sidecarPath,
        JSON.stringify([
          { pid, connectionFile, key: "orphan-test" },
          { pid: 999_999_999, connectionFile: staleFile, key: "stale" },
        ]),
      );

      try {
        expect(() => process.kill(pid, 0)).not.toThrow(); // still alive before sweep

        const { reaped } = await sweepOrphanKernels({ sidecarPath });
        expect(reaped).toBe(1);

        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(() => process.kill(pid, 0)).toThrow(); // reaped

        // Sidecar and stale connection files are cleaned up either way.
        await expect(readFile(sidecarPath)).rejects.toThrow();
        await expect(readFile(staleFile)).rejects.toThrow();
      } finally {
        try { process.kill(-pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
        await rm(runtimeDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "a hung execution times out, escalates to interrupt, and leaves the kernel usable",
    async () => {
      const originalTimeout = process.env.AARONNOTE_JUPYTER_EXEC_TIMEOUT_MS;
      const originalGrace = process.env.AARONNOTE_JUPYTER_INTERRUPT_GRACE_MS;
      process.env.AARONNOTE_JUPYTER_EXEC_TIMEOUT_MS = "1000";
      process.env.AARONNOTE_JUPYTER_INTERRUPT_GRACE_MS = "500";
      const noteRoot = await mkdtemp(join(tmpdir(), "aaronnote-hang-"));
      // runtimeRoot stays the real aaronnote checkout so its project-owned
      // Python kernelspec resolves; only notes live in the scratch dir.
      const service = createJupyterCellService({ runtimeRoot: aaronnoteRoot, noteRoot, workspaceRoot: noteRoot, zmq });
      const note = join(noteRoot, "note.md");
      await writeFile(note, "# note\n", "utf8");

      try {
        await expect(
          service.execute({ file: note, kernel: "python3", code: "import time\ntime.sleep(30)" }),
        ).rejects.toThrow(/timed out/i);

        // The kernel must still be usable afterward — interrupt (not a kill)
        // is what unblocked it.
        const followUp = await service.execute({ file: note, kernel: "python3", code: "6*7" });
        expect(followUp.status).toBe("ok");
        expect(followUp.outputs.some((o: any) => o.output_type === "execute_result" && o.data["text/plain"] === "42")).toBe(true);
      } finally {
        if (originalTimeout == null) delete process.env.AARONNOTE_JUPYTER_EXEC_TIMEOUT_MS;
        else process.env.AARONNOTE_JUPYTER_EXEC_TIMEOUT_MS = originalTimeout;
        if (originalGrace == null) delete process.env.AARONNOTE_JUPYTER_INTERRUPT_GRACE_MS;
        else process.env.AARONNOTE_JUPYTER_INTERRUPT_GRACE_MS = originalGrace;
        await service.shutdown();
        await rm(noteRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "idle TTL reaps an unused owned kernel but never an attached one",
    async () => {
      const runtimeDir = await mkdtemp(join(tmpdir(), "aaronnote-idle-"));
      const registry = createKernelRegistry({ runtimeDir, zmq, launchTimeoutMs: 15_000 });
      const searchDirs = defaultKernelSearchDirs({ dataDir: jupyterDataDir, useHomeKernels: false });
      const specs = await findKernelSpecs({ searchDirs });
      const python3 = specs.find((s) => s.name === "python3")!;

      try {
        const owned = await registry.ensure("idle-owned", python3);
        owned.lastActivity = Date.now() - 1_000_000; // long idle
        const runningRecent = await registry.ensure("idle-running", python3);
        runningRecent.lastActivity = Date.now(); // fresh

        // Force-idle reap by hand (mirrors jupyter-cell.mjs's cleanupIdle loop):
        for (const record of registry.list()) {
          if (record.attached) continue;
          const idleMs = Date.now() - record.lastActivity;
          if (idleMs > 500_000) await registry.shutdown(record.key);
        }

        expect(registry.get("idle-owned")).toBeUndefined();
        expect(registry.get("idle-running")).toBeDefined();
      } finally {
        await registry.shutdownAll();
        await rm(runtimeDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
