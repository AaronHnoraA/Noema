// Turns an authenticated HTTP client into `@jupyterlab/services` server
// settings, so the stock REST and WebSocket clients can talk to a real Jupyter
// server, JupyterHub, or kernel gateway.
//
// This is the counterpart to raw-kernel.mjs. There, a fake WebSocket is
// bridged onto raw ZMQ because there is no server; here there *is* a server,
// and the only adaptations needed are (a) routing fetch through the cookie-
// and TLS-aware client in http-client.mjs and (b) giving `ws` the auth headers
// and TLS options a browser WebSocket could never carry.

import { ServerConnection } from "@jupyterlab/services";
import WebSocketClient from "ws";

/**
 * @param {object} options
 * @param {string} options.baseUrl - normalized, trailing slash
 * @param {string} options.wsUrl
 * @param {ReturnType<import("./http-client.mjs").createHttpClient>} options.client
 * @param {string} [options.token]
 */
export function createServerSettings({ baseUrl, wsUrl, client, token = "" }) {
  const allowUnauthorized = Boolean(client.allowUnauthorized);
  const serverName = String(client.serverName || "");

  // @jupyterlab/services constructs sockets as `new settings.WebSocket(url,
  // protocols)`, with nowhere to pass Node options — so the options are closed
  // over here, exactly like RawSocketWrapper does for the ZMQ bridge.
  class ServerWebSocket extends WebSocketClient {
    constructor(url, protocols) {
      super(url, protocols, {
        // Re-read on construction: a cookie-authenticated session may have
        // been established after these settings were first built.
        headers: client.websocketHeaders(),
        ...(allowUnauthorized ? { rejectUnauthorized: false } : {}),
        ...(serverName ? { servername: serverName } : {}),
      });
    }
  }

  return ServerConnection.makeSettings({
    baseUrl,
    wsUrl,
    token,
    // Also put the token in the query string. Some deployments authenticate
    // the WebSocket upgrade from the query alone, and an extra copy alongside
    // the Authorization header is harmless.
    appendToken: Boolean(token),
    fetch: client.fetch,
    WebSocket: ServerWebSocket,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}
