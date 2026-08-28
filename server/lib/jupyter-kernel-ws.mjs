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

import WebSocketClient, { WebSocketServer } from "ws";
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
 * @param {(id: string) => Promise<object | undefined>} options.resolveKernelChannel
 *   Where to bridge a live kernel id: `{ kind: "zmq", connectionInfo }` for a
 *   local or attached kernel, or `{ kind: "server", upstream }` for one living
 *   on a remote Jupyter server.
 * @param {object} options.zmq - the `zeromq` module
 * @param {(id: string) => void} [options.touchKernel]
 * @param {NodeJS.WritableStream} [options.stderr]
 */
export function installJupyterKernelWebSocket({
  server,
  resolveKernelChannel,
  zmq,
  touchKernel = noop,
  stderr = process.stderr,
  keepaliveMs = 30_000,
}) {
  const log = makeLogger(stderr);
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => false });

  // A browser that goes away without closing cleanly (laptop suspended, tab
  // killed) leaves a half-open socket that holds its four ZMQ sockets open
  // until TCP eventually notices, which can be many minutes. Keep the ping
  // guard while clients exist, without waking an idle host that has none.
  let keepalive = null;

  const stopKeepaliveIfIdle = () => {
    if (wss.clients.size || !keepalive) return;
    clearInterval(keepalive);
    keepalive = null;
  };

  const startKeepalive = () => {
    if (keepalive || !wss.clients.size) return;
    keepalive = setInterval(() => {
      for (const client of wss.clients) {
        if (client.isAlive === false) {
          try { client.terminate(); } catch { /* ignore */ }
          continue;
        }
        client.isAlive = false;
        try { client.ping(); } catch { /* ignore */ }
      }
      stopKeepaliveIfIdle();
    }, keepaliveMs);
    keepalive.unref?.();
  };

  const trackLiveness = (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("close", stopKeepaliveIfIdle);
    startKeepalive();
  };

  const onUpgrade = async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    const id = jupyterKernelWsId(url.pathname);
    let channel;
    try {
      channel = id ? await resolveKernelChannel(id) : undefined;
    } catch (ex) {
      log.error(`Failed to resolve kernel channel for ${id}`, ex);
    }
    if (!channel || socket.destroyed) {
      socket.destroy();
      return;
    }

    if (channel.kind === "server") {
      // The kernel lives on a real Jupyter server, so bridge the browser to
      // that server's own channels endpoint. This is a message relay, not a
      // socket splice: the upstream handshake needs the auth headers and TLS
      // options a browser WebSocket cannot carry, so they are applied here.
      wss.handleUpgrade(req, socket, head, (ws) => {
        trackLiveness(ws);
        bridgeUpstream(ws, id, channel.upstream, log);
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      trackLiveness(ws);
      const protocol = ws.protocol || "";
      let rawSocket;
      try {
        rawSocket = new RawSocket(channel.connectionInfo, jlabSerialize.serialize, zmq, { stderr });
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
  };

  server.on("upgrade", onUpgrade);

  return {
    close() {
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      // Leaving this attached would keep a closed bridge handling upgrades,
      // and stack another handler on every re-install.
      server.off("upgrade", onUpgrade);
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

/**
 * Relay one browser kernel-channels socket to the upstream Jupyter server's.
 * Frames pass through untouched — both ends already speak the same wire
 * format — so nothing here needs to understand Jupyter messages.
 */
function bridgeUpstream(ws, id, upstream, log, { queueLimit = 256 } = {}) {
  // Frames the browser sends before the upstream handshake finishes are
  // replayed in order. Bounded, because a browser that keeps sending while
  // the upstream never connects would otherwise buffer without limit.
  let queued = [];
  let queueDropped = 0;
  const remote = new WebSocketClient(upstream.url, [], {
    headers: upstream.headers || {},
    ...(upstream.allowUnauthorized ? { rejectUnauthorized: false } : {}),
    ...(upstream.serverName ? { servername: upstream.serverName } : {}),
  });

  const closeBoth = (code, reason) => {
    try { if (ws.readyState === ws.OPEN) ws.close(code, reason); } catch { /* ignore */ }
    try { if (remote.readyState === remote.OPEN) remote.close(code, reason); } catch { /* ignore */ }
  };

  remote.on("open", () => {
    // Anything the browser sent during the upstream handshake is replayed in
    // order; dropping it would lose the first kernel_info_request.
    for (const frame of queued) {
      try { remote.send(frame.data, { binary: frame.binary }); } catch { /* ignore */ }
    }
    queued = [];
  });
  remote.on("message", (data, isBinary) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(data, { binary: isBinary }); } catch { /* ignore */ }
  });
  remote.on("close", (code, reason) => closeBoth(code >= 1000 && code <= 4999 ? code : 1011, reason?.toString?.() || ""));
  remote.on("error", (ex) => {
    log.error(`Upstream kernel WebSocket error for ${id}`, ex);
    closeBoth(1011, "Upstream kernel channel error");
  });

  ws.on("message", (data, isBinary) => {
    if (remote.readyState === remote.OPEN) {
      try { remote.send(data, { binary: isBinary }); } catch { /* ignore */ }
    } else if (remote.readyState === remote.CONNECTING) {
      if (queued.length >= queueLimit) {
        if (!queueDropped) log.error(`Upstream kernel channel for ${id} is not keeping up; dropping queued frames`);
        queueDropped += 1;
        return;
      }
      queued.push({ data, binary: isBinary });
    }
  });
  ws.on("close", () => closeBoth(1000, ""));
  ws.on("error", (ex) => {
    log.error(`Browser kernel WebSocket error for ${id}`, ex);
    closeBoth(1011, "Browser channel error");
  });
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
