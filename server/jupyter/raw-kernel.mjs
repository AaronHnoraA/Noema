// Ported from microsoft/vscode-jupyter (MIT)
// src/kernels/raw/session/rawKernelConnection.node.ts @ 7a4b2fae07617a6704e6e3af8590cd6c2f7cf519
// (newRawKernel / waitForReady / postStartKernel, trimmed of VS Code ceremony:
// no CancellationToken/telemetry/progress-reporter — plain timeouts instead.)
//
// Wraps a real @jupyterlab/services `KernelConnection` around a `RawSocket`
// (raw ZMQ), so the rest of the stack (execution, comms, ipywidgets) can use
// the standard jlab kernel API without knowing there is no Jupyter server.

import { KernelConnection, ServerConnection } from "@jupyterlab/services";
import * as jlabSerialize from "@jupyterlab/services/lib/kernel/serialize.js";
import { KernelMessage } from "@jupyterlab/services";
import { RawSocket } from "./raw-socket.mjs";
import { createDeferred, raceTimeout, sleep, noop, makeLogger } from "./util.mjs";

/**
 * Build a live jlab `KernelConnection` bridged to raw ZMQ sockets described
 * by `connectionInfo` (the connection-file JSON: key/ip/ports/transport).
 *
 * Returns `{ kernel, socket }`; `socket` is the RawSocket instance backing the
 * connection — call `socket.addSendHook`/`addReceiveHook` for ipywidgets
 * message mirroring, and `socket.dispose()` (via `kernel.dispose()`) to close
 * the ZMQ sockets.
 */
export function createRawKernelConnection({ connectionInfo, clientId, username, model, zmq, stderr }) {
  let socketInstance;
  class RawSocketWrapper extends RawSocket {
    constructor() {
      // @jupyterlab/services calls `new settings.WebSocket(url, protocols)`;
      // we ignore both and always bridge to the one kernel this closure owns.
      super(connectionInfo, jlabSerialize.serialize, zmq, { stderr });
      socketInstance = this;
    }
  }

  const settings = ServerConnection.makeSettings({
    WebSocket: RawSocketWrapper,
    wsUrl: "RAW",
    serializer: {
      deserialize: (data) => data,
      serialize: (data) => data,
    },
  });

  // handleComms MUST be false here. This connection is execution-only (no
  // widget manager is ever registered on it); jlab's KernelConnection with
  // handleComms:true actively processes every incoming comm_open itself, and
  // when it finds no registered `jupyter.widget` target it throws inside
  // _handleCommOpen — whose catch block calls `comm.close()`, which sends a
  // REAL comm_close back to the kernel over the shell channel. Since IOPub is
  // broadcast to every subscriber (including this connection), that silently
  // destroyed every ipywidgets model moments after creation, regardless of
  // whether a browser widget connection was attached — the actual root cause
  // of sliders never responding (not a client-side timing race). Capturing
  // comm traffic for widgetMessages only needs `anyMessage`, which fires
  // unconditionally and does not require handleComms.
  const kernel = new KernelConnection({
    serverSettings: settings,
    clientId,
    handleComms: false,
    username,
    model,
  });

  socketInstance.emit("open");
  return { kernel, socket: socketInstance };
}

/**
 * Wait for the jlab kernel connection to report `connectionStatus === 'connected'`.
 */
export async function waitForConnected(kernel, timeoutMs) {
  if (kernel.connectionStatus === "connected") return true;
  const deferred = createDeferred();
  const handler = (_kernel, status) => {
    if (status === "connected") deferred.resolve(true);
  };
  kernel.connectionStatusChanged.connect(handler);
  try {
    const result = await raceTimeout(timeoutMs, false, deferred.promise);
    return result === true;
  } finally {
    kernel.connectionStatusChanged.disconnect(handler);
  }
}

/**
 * Send `interrupt_request` on the control channel — the "message" interrupt
 * mode some kernelspecs declare (`interrupt_mode: "message"`) instead of the
 * default OS-signal interrupt.
 */
export async function sendInterruptRequest(kernel, { stderr } = {}) {
  const log = makeLogger(stderr);
  const msg = KernelMessage.createMessage({
    msgType: "interrupt_request",
    channel: "control",
    username: kernel.username,
    session: kernel.clientId,
    content: {},
  });
  await kernel.sendControlMessage(msg, true, true).done.catch((ex) => log.error("Failed to interrupt via a message", ex));
}

/**
 * The classic jupyter_client `wait_for_ready` handshake: repeatedly send
 * kernel_info_request on BOTH shell and control channels (every ~500ms) until
 * we've seen a reply AND at least one iopub message. This guarantees the SUB
 * socket is actually subscribed (ZMQ "slow joiner" problem) before the caller
 * starts trusting iopub traffic — the same fix vscode-jupyter uses to avoid
 * silently dropping the first status/comm messages after kernel start.
 */
export async function warmupKernelInfo(kernel, timeoutMs, { stderr } = {}) {
  const log = makeLogger(stderr);
  const gotIopubMessage = createDeferred();
  const kernelInfoHandled = createDeferred();
  const iopubHandler = () => gotIopubMessage.resolve(true);
  gotIopubMessage.promise.catch(noop);
  kernelInfoHandled.promise.catch(noop);
  kernel.iopubMessage.connect(iopubHandler);

  const sendOnControlChannel = () => {
    const msg = KernelMessage.createMessage({
      msgType: "kernel_info_request",
      channel: "control",
      username: kernel.username,
      session: kernel.clientId,
      content: {},
    });
    kernel
      .sendControlMessage(msg, true, true)
      .done.then(() => kernelInfoHandled.resolve(true))
      .catch(noop);
  };
  const sendOnShellChannel = () => {
    kernel.requestKernelInfo().then(() => kernelInfoHandled.resolve(true)).catch(noop);
  };

  const start = Date.now();
  try {
    let attempts = 0;
    while (Date.now() - start < timeoutMs) {
      attempts += 1;
      sendOnControlChannel();
      sendOnShellChannel();
      await Promise.race([
        Promise.all([gotIopubMessage.promise, kernelInfoHandled.promise]),
        sleep(Math.min(timeoutMs, 500)),
      ]);
      if (gotIopubMessage.completed && kernelInfoHandled.completed) break;
    }
    const ok = gotIopubMessage.completed && kernelInfoHandled.completed;
    if (!ok) log.warn(`Didn't get a response for requestKernelInfo after ${attempts} attempt(s)`);
    return ok;
  } finally {
    kernel.iopubMessage.disconnect(iopubHandler);
  }
}
