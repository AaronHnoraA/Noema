// Kernel and file access on a remote Jupyter server.
//
// Uses @jupyterlab/services' low-level REST functions plus a directly
// constructed KernelConnection, rather than KernelManager/SessionManager.
// Those managers exist to keep a *UI* in sync and poll `/api/kernels` on a
// timer forever; a headless integration only needs the calls it makes, and
// background polling against a shared lab server is exactly the kind of
// traffic that gets a user rate-limited.
//
// Two server kinds behave differently and are kept distinct:
//
//   "server"  — a real Jupyter server / JupyterHub single-user server. Kernels
//               are started through the *sessions* API so the kernel is bound
//               to a notebook path: that gives it a working directory, makes
//               it visible in the server's own UI, and lets the server cull it
//               correctly. Shutting down means shutting down the session.
//   "gateway" — a kernel/enterprise gateway. There is no contents API and no
//               sessions API worth using; kernels are started directly.

import {
  KernelAPI,
  KernelConnection,
  KernelSpecAPI,
  SessionAPI,
  ContentsManager,
} from "@jupyterlab/services";
import { connectToServer } from "./server-auth.mjs";
import { createServerSettings } from "./server-connection.mjs";
import { makeLogger } from "./util.mjs";

/**
 * Normalize `/api/kernelspecs` into the same `{ name, spec, resourceDir }`
 * shape kernel-finder.mjs produces for local kernelspecs, so callers can merge
 * the two lists without caring where a kernel comes from.
 */
function normalizeSpecs(payload) {
  const specs = payload?.kernelspecs && typeof payload.kernelspecs === "object" ? payload.kernelspecs : {};
  return Object.entries(specs)
    .map(([name, entry]) => ({
      name: String(entry?.name || name),
      spec: entry?.spec || {},
      // A remote kernelspec has no directory on this machine; `resources` is
      // the set of URLs the server serves its assets from instead.
      resourceDir: "",
      resources: entry?.resources || {},
    }))
    .filter((entry) => entry.name);
}

/**
 * @param {object} options
 * @param {(serverId: string) => Promise<object|undefined>} options.resolveServer
 *   Returns the connection config for a server id: `{ url, kind, auth, token,
 *   password, user, allowUnauthorized, serverName }`. In Emacs host mode this
 *   is answered by the broker, which may open a Remote channel first and hand
 *   back a client-side URL.
 * @param {(serverId: string) => Promise<void>} [options.releaseServer]
 * @param {NodeJS.WritableStream} [options.stderr]
 */
export function createServerRegistry({ resolveServer, releaseServer, stderr = process.stderr } = {}) {
  const log = makeLogger(stderr);
  /** serverId -> Promise<{ settings, config, contents }> */
  const connections = new Map();

  async function connect(serverId) {
    const existing = connections.get(serverId);
    if (existing) return await existing;
    const pending = (async () => {
      const config = await resolveServer(serverId);
      if (!config) throw new Error(`Unknown Jupyter server: ${serverId}`);
      const { baseUrl, wsUrl, client, token } = await connectToServer({ ...config, stderr });
      const settings = createServerSettings({ baseUrl, wsUrl, client, token });
      const kind = String(config.kind || "server") === "gateway" ? "gateway" : "server";
      log.warn(`connected to Jupyter server "${serverId}" at ${baseUrl} (${kind})`);
      return {
        settings,
        client,
        config: { ...config, kind, baseUrl },
        // Contents is manager-based because there is no useful low-level
        // equivalent, but it only issues requests when asked — no polling.
        contents: kind === "server" ? new ContentsManager({ serverSettings: settings }) : null,
      };
    })();
    connections.set(serverId, pending);
    // A failed connection must not be cached, or a fixed password/token still
    // reports the original error until the process restarts.
    pending.catch(() => connections.delete(serverId));
    return await pending;
  }

  /** Build a live KernelConnection for a kernel model on this server. */
  function connectionFor(entry, model) {
    return new KernelConnection({
      model,
      serverSettings: entry.settings,
      // Unlike the raw-ZMQ execution connection, there is no second socket
      // fanning IOPub out here, so jlab's own comm handling is safe and is
      // what the ipywidgets manager expects.
      handleComms: true,
    });
  }

  return {
    async config(serverId) {
      return (await connect(serverId)).config;
    },

    /** `/api/kernelspecs`, in the same shape as a locally discovered kernelspec. */
    async listKernelSpecs(serverId) {
      const entry = await connect(serverId);
      return normalizeSpecs(await KernelSpecAPI.getSpecs(entry.settings));
    },

    /** Kernels already running on the server, so a reconnect can adopt one. */
    async listRunning(serverId) {
      const entry = await connect(serverId);
      const models = await KernelAPI.listRunning(entry.settings);
      return Array.from(models || []);
    },

    /**
     * Start a kernel. On a real server this creates a *session* so the kernel
     * is attached to `path`; the session id comes back so shutdown can remove
     * both. On a gateway it starts a bare kernel.
     */
    async startKernel(serverId, { kernelName, path = "", name = "" } = {}) {
      const entry = await connect(serverId);
      if (entry.config.kind === "gateway") {
        const model = await KernelAPI.startNew({ name: kernelName }, entry.settings);
        return { model, sessionId: "", kernel: connectionFor(entry, model) };
      }
      const session = await SessionAPI.startSession({
        path: path || `${name || kernelName}.ipynb`,
        name: name || path || kernelName,
        type: "notebook",
        kernel: { name: kernelName },
      }, entry.settings);
      if (!session?.kernel) throw new Error(`Jupyter server started a session without a kernel for ${kernelName}`);
      return { model: session.kernel, sessionId: String(session.id || ""), kernel: connectionFor(entry, session.kernel) };
    },

    /** Reconnect to a kernel that is already running on the server. */
    async connectKernel(serverId, kernelId) {
      const entry = await connect(serverId);
      const model = await KernelAPI.getKernelModel(kernelId, entry.settings);
      if (!model) throw new Error(`No kernel ${kernelId} on Jupyter server ${serverId}`);
      return { model, sessionId: "", kernel: connectionFor(entry, model) };
    },

    async interruptKernel(serverId, kernelId) {
      const entry = await connect(serverId);
      await KernelAPI.interruptKernel(kernelId, entry.settings);
    },

    async restartKernel(serverId, kernelId) {
      const entry = await connect(serverId);
      await KernelAPI.restartKernel(kernelId, entry.settings);
    },

    /**
     * Shut a kernel down. With a session, remove the session — deleting only
     * the kernel would leave an orphaned session in the server's UI.
     */
    async shutdownKernel(serverId, { kernelId, sessionId }) {
      const entry = await connect(serverId);
      if (sessionId) await SessionAPI.shutdownSession(sessionId, entry.settings).catch(() => {});
      else if (kernelId) await KernelAPI.shutdownKernel(kernelId, entry.settings).catch(() => {});
    },

    /** `/api/contents` — list, read, and write files that live on the server. */
    async contents(serverId) {
      const entry = await connect(serverId);
      if (!entry.contents) throw new Error(`Jupyter server ${serverId} is a gateway and has no contents API`);
      return entry.contents;
    },

    /** The websocket URL and headers for a kernel, for the browser-facing bridge. */
    async kernelChannelTarget(serverId, kernelId) {
      const entry = await connect(serverId);
      const settings = entry.settings;
      const url = new URL(`api/kernels/${encodeURIComponent(kernelId)}/channels`, settings.wsUrl);
      if (settings.token && settings.appendToken) url.searchParams.set("token", settings.token);
      return {
        url: url.toString(),
        headers: entry.client.websocketHeaders(),
        allowUnauthorized: Boolean(entry.client.allowUnauthorized),
        serverName: String(entry.client.serverName || ""),
      };
    },

    /** Drop a cached connection (config changed, or the forward went away). */
    async forget(serverId) {
      connections.delete(serverId);
      if (typeof releaseServer === "function") await releaseServer(serverId).catch(() => {});
    },

    async forgetAll() {
      const ids = Array.from(connections.keys());
      connections.clear();
      if (typeof releaseServer === "function") {
        await Promise.all(ids.map((id) => releaseServer(id).catch(() => {})));
      }
    },
  };
}
