// Browser-facing kernel channels WebSocket, bridging directly to raw ZMQ.
// Replaces jupyter-widget-proxy.mjs (which proxied to a real jupyter-server's
// `/api/kernels/{id}/channels` WebSocket). Each browser connection gets its
// own RawSocket (own ZMQ DEALER identity + its own IOPub SUB) against the
// same kernel connection info the server's persistent execution connection
// uses — mirroring how jupyter_server itself bridges one ZMQ socket set per
// WebSocket rather than fanning a single connection out to many clients.
//
// Always negotiates the legacy (no-subprotocol) kernel wire format: we don't
// implement the `v1.kernel.websocket.jupyter.org` binary framing, and
// @jupyterlab/services' browser KernelConnection falls back to it cleanly
// when the server doesn't select a subprotocol.

import { WebSocketServer } from "ws";
import * as jlabSerialize from "@jupyterlab/services/lib/kernel/serialize.js";
import { RawSocket } from "../jupyter/raw-socket.mjs";
import { noop, makeLogger } from "../jupyter/util.mjs";

export function jupyterKernelWsId(pathname) {
  const match = /^\/jupyter\/(?:api\/kernels|widget-runtimes)\/([^/]+)\/channels$/.exec(String(pathname || ""));
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

/**
 * @param {object} options
 * @param {import("node:http").Server} options.server
 * @param {(id: string) => object | undefined} options.resolveConnectionInfo - kernel connection info for a live kernel id, or undefined
 * @param {object} options.zmq - the `zeromq` module
 * @param {(id: string) => void} [options.touchKernel]
 * @param {NodeJS.WritableStream} [options.stderr]
 */
export function installJupyterKernelWebSocket({ server, resolveConnectionInfo, zmq, touchKernel = noop, stderr = process.stderr }) {
  const log = makeLogger(stderr);
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => false });

  server.on("upgrade", async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    const id = jupyterKernelWsId(url.pathname);
    const connectionInfo = id ? await resolveConnectionInfo(id) : undefined;
    if (!connectionInfo || socket.destroyed) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const protocol = ws.protocol || "";
      let rawSocket;
      try {
        rawSocket = new RawSocket(connectionInfo, jlabSerialize.serialize, zmq, { stderr });
      } catch (ex) {
        log.error(`Failed to open raw kernel socket for ${id}`, ex);
        try {
          ws.close(1011, "Failed to bridge to kernel");
        } catch {
          /* ignore */
        }
        return;
      }

      rawSocket.onmessage = (event) => {
        touchKernel(id);
        if (ws.readyState !== ws.OPEN) return;
        try {
          ws.send(jlabSerialize.serialize(event.data, protocol));
        } catch (ex) {
          log.error(`Failed to serialize kernel message for browser (kernel ${id})`, ex);
        }
      };
      rawSocket.onerror = () => {
        try {
          ws.close(1011, "Kernel channel error");
        } catch {
          /* ignore */
        }
      };

      ws.on("message", (data, isBinary) => {
        touchKernel(id);
        try {
          const wsData = isBinary ? toArrayBuffer(data) : data.toString();
          const message = jlabSerialize.deserialize(wsData, protocol);
          rawSocket.send(message, noop);
        } catch (ex) {
          log.error(`Failed to bridge browser message to kernel ${id}`, ex);
        }
      });
      ws.on("close", () => {
        try {
          rawSocket.dispose();
        } catch {
          /* ignore */
        }
      });
      ws.on("error", (ex) => {
        log.error(`Widget WebSocket error for kernel ${id}`, ex);
        try {
          rawSocket.dispose();
        } catch {
          /* ignore */
        }
      });

    });
  });

  return {
    close() {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
      try {
        wss.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
