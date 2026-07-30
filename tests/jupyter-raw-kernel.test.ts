import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import * as zmq from "zeromq";
import { createRawKernelConnection, waitForConnected, warmupKernelInfo } from "../server/jupyter/raw-kernel.mjs";

// Exercises the raw ZMQ kernel stack (wire protocol + RawSocket + the
// kernel_info/first-iopub handshake) against the managed Conda ipykernel.
// Gated: needs a real kernel process, so it's opt-in.
const RUN = process.env.AARONNOTE_TEST_KERNEL === "1";
const describeIfKernel = RUN ? describe : describe.skip;

const pythonBin = join(import.meta.dirname, "..", "jupyter", "bin", "python-jupyter-kernel");

async function findFreePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
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
  return ports;
}

describeIfKernel("raw ZMQ kernel stack (real ipykernel)", () => {
  test(
    "handshake + execute against a real kernel process",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "aaronnote-rawkernel-"));
      const ports = await findFreePorts(5);
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
      const connFile = join(root, "kernel.json");
      await writeFile(connFile, JSON.stringify(connectionInfo));

      const proc = spawn(pythonBin, ["-m", "ipykernel_launcher", "-f", connFile], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderrOutput = "";
      proc.stderr.on("data", (d) => { stderrOutput += String(d); });

      try {
        // ZMQ queues messages for peers that aren't up yet, so we don't need
        // to wait for the process to fully initialize before connecting —
        // but give it a beat so failures surface faster in the test.
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const { kernel, socket } = createRawKernelConnection({
          connectionInfo,
          clientId: crypto.randomUUID(),
          username: crypto.randomUUID(),
          model: { name: "python3", id: crypto.randomUUID() },
          zmq,
        });

        try {
          const connected = await waitForConnected(kernel, 15_000);
          expect(connected).toBe(true);

          const warm = await warmupKernelInfo(kernel, 15_000);
          expect(warm).toBe(true);

          const info = await kernel.info;
          expect(info?.language_info?.name).toBe("python");

          const streamed: string[] = [];
          const future = kernel.requestExecute({ code: "print(1 + 1)" });
          future.onIOPub = (msg: any) => {
            if (msg.header.msg_type === "stream") streamed.push(msg.content.text);
          };
          const reply = await future.done;
          expect(reply.content.status).toBe("ok");
          expect(streamed.join("")).toContain("2");
        } finally {
          kernel.dispose();
          socket.dispose();
        }
      } finally {
        proc.kill("SIGTERM");
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
