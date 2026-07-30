import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { KernelConnection, ServerConnection } from "@jupyterlab/services";
import * as zmq from "zeromq";
import { createKernelRegistry } from "../server/jupyter/kernel-registry.mjs";
import { defaultKernelSearchDirs, findKernelSpecs } from "../server/jupyter/kernel-finder.mjs";
import { installJupyterKernelWebSocket, jupyterKernelWsId } from "../server/lib/jupyter-kernel-ws.mjs";

describe("jupyterKernelWsId", () => {
  test("extracts the kernel id from either channels path shape", () => {
    expect(jupyterKernelWsId("/jupyter/api/kernels/kernel%201/channels")).toBe("kernel 1");
    expect(jupyterKernelWsId("/jupyter/widget-runtimes/kernel%201/channels")).toBe("kernel 1");
    expect(jupyterKernelWsId("/jupyter/api/kernels/kernel-1/restart")).toBe("");
    expect(jupyterKernelWsId("/other/path")).toBe("");
  });
});

// Proves the browser-facing WS bridge (server/lib/jupyter-kernel-ws.mjs) end
// to end: a *second*, independent @jupyterlab/services `KernelConnection` —
// standing in for the browser's ipywidgets runtime connection — talks to a
// real kernel entirely through the bridge (not the server's own persistent
// execution connection), matching the two-independent-ZMQ-identities model
// the "first-run ipywidgets" fix (Phase 4) depends on. Gated: real kernel + a
// real HTTP/WS server.
const RUN = process.env.AARONNOTE_TEST_KERNEL === "1";
const describeIfKernel = RUN ? describe : describe.skip;

const aaronnoteRoot = join(import.meta.dirname, "..");
const jupyterDataDir = join(aaronnoteRoot, "jupyter", ".jupyter", "data");

describeIfKernel("jupyter kernel WebSocket bridge (real kernel)", () => {
  test(
    "a browser-style KernelConnection executes code entirely through the bridge",
    async () => {
      const runtimeDir = await mkdtemp(join(tmpdir(), "aaronnote-ws-bridge-"));
      const registry = createKernelRegistry({ runtimeDir, zmq, launchTimeoutMs: 15_000 });
      const searchDirs = defaultKernelSearchDirs({ dataDir: jupyterDataDir, useHomeKernels: false });
      const specs = await findKernelSpecs({ searchDirs });
      const python3 = specs.find((s) => s.name === "python3")!;

      const httpServer = createServer((_req, res) => { res.writeHead(404); res.end(); });
      let bridge: ReturnType<typeof installJupyterKernelWebSocket> | undefined;
      let browserKernel: KernelConnection | undefined;

      try {
        const record = await registry.ensure("ws-bridge-test", python3);

        bridge = installJupyterKernelWebSocket({
          server: httpServer,
          resolveConnectionInfo: (id) => (id === record.id ? record.connectionInfo : undefined),
          zmq,
        });

        const port = await new Promise<number>((resolve) => {
          httpServer.listen(0, "127.0.0.1", () => {
            const address = httpServer.address();
            resolve(typeof address === "object" && address ? address.port : 0);
          });
        });

        // A real browser client rewrites the WebSocket URL to
        // `/jupyter/widget-runtimes/{id}/channels` (see
        // src/jupyter-widget-runtime.ts's `runtimeWebSocketCtor`); reproduce
        // that here instead of relying on @jupyterlab/services' own
        // `/api/kernels/{id}/channels` path join, so this test exercises the
        // exact URL shape the real client uses.
        class RuntimeWebSocket extends WebSocket {
          constructor() {
            super(`ws://127.0.0.1:${port}/jupyter/widget-runtimes/${record.id}/channels`);
          }
        }
        const settings = ServerConnection.makeSettings({
          WebSocket: RuntimeWebSocket as unknown as typeof globalThis.WebSocket,
          wsUrl: "RUNTIME",
        });

        browserKernel = new KernelConnection({
          serverSettings: settings,
          clientId: "browser-client",
          username: "browser-user",
          handleComms: true,
          model: { name: python3.name, id: record.id },
        });

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("timed out waiting for bridged connection")), 15_000);
          const check = () => {
            if (browserKernel!.connectionStatus === "connected") {
              clearTimeout(timeout);
              resolve();
            }
          };
          browserKernel!.connectionStatusChanged.connect(check);
          check();
        });

        const future = browserKernel.requestExecute({ code: "print('via bridge'); 3 * 3" });
        const streamed: string[] = [];
        future.onIOPub = (msg: any) => {
          if (msg.header.msg_type === "stream") streamed.push(msg.content.text);
        };
        const reply = await future.done;
        expect(reply.content.status).toBe("ok");
        expect(streamed.join("")).toContain("via bridge");

        // The bridge must not have gone through the server's own execution
        // connection — confirm the server-side persistent kernel connection
        // still works independently afterward (both share one real kernel).
        const serverFuture = record.kernel.requestExecute({ code: "1 + 1" });
        const serverReply = await serverFuture.done;
        expect(serverReply.content.status).toBe("ok");
      } finally {
        browserKernel?.dispose();
        bridge?.close();
        await new Promise((resolve) => httpServer.close(resolve));
        await registry.shutdownAll();
        await rm(runtimeDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
