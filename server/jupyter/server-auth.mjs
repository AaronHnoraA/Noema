// Authenticating against a Jupyter server, a JupyterHub, or a kernel gateway.
//
// Ported in shape from microsoft/vscode-jupyter's jupyterPasswordConnect.ts /
// jupyterHubPasswordConnect.ts (MIT), reimplemented against the small HTTP
// client in http-client.mjs.
//
// Three kinds, because the three behave differently:
//
//   token    — `Authorization: token <t>`, what `jupyter server` prints on
//              startup and what a gateway expects. Stateless.
//   password — the notebook login form. GET /login to be issued an `_xsrf`
//              cookie, POST it back with the password, and keep the session
//              cookie. Everything after that is cookie-authenticated.
//   hub      — JupyterHub. Authenticate against the hub, make sure the user's
//              single-user server is actually spawned (it may be idle-culled),
//              then talk to `/user/<name>/`, which is a normal Jupyter server.

import { createHttpClient } from "./http-client.mjs";

/** Ensure a URL ends in exactly one slash — jlab's ServerConnection wants that shape. */
export function normalizeBaseUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Jupyter server URL is required");
  const url = new URL(text);
  // A pasted "copy/paste this URL" link carries the token in the query and
  // usually points at /lab or /tree; neither belongs in the API base.
  url.hash = "";
  const token = url.searchParams.get("token") || "";
  url.search = "";
  let path = url.pathname.replace(/\/(?:lab|tree|notebooks|doc)(?:\/.*)?$/, "/");
  if (!path.endsWith("/")) path += "/";
  url.pathname = path;
  return { baseUrl: url.toString(), token };
}

/** The websocket origin for a base URL (`https:` -> `wss:`). */
export function websocketUrlFor(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function formBody(fields) {
  return Object.entries(fields)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value ?? ""))}`)
    .join("&");
}

/** Scrape `_xsrf` out of a login page for servers that only render it as a hidden input. */
function xsrfFromHtml(html) {
  const match = /name=["']_xsrf["']\s+value=["']([^"']+)["']/i.exec(String(html || ""));
  return match ? match[1] : "";
}

async function loginWithPassword(client, baseUrl, password) {
  const loginUrl = new URL("login", baseUrl).toString();
  const page = await client.fetch(loginUrl, { method: "GET" });
  if (!page.ok && page.status !== 302) {
    throw new Error(`Jupyter login page returned ${page.status} ${page.statusText}`);
  }
  const xsrf = client.xsrf() || xsrfFromHtml(await page.text());
  if (!xsrf) {
    throw new Error("Jupyter server did not issue an _xsrf token; is this a password-protected server?");
  }
  const response = await client.fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-XSRFToken": xsrf },
    body: formBody({ _xsrf: xsrf, password }),
    redirect: "manual",
  });
  // A correct password redirects to the app; a wrong one re-renders /login.
  const redirected = response.status >= 300 && response.status < 400;
  if (!redirected && response.status !== 200) {
    throw new Error(`Jupyter login failed: ${response.status} ${response.statusText}`);
  }
  if (!redirected && /name=["']password["']/i.test(await response.text())) {
    throw new Error("Jupyter login failed: incorrect password");
  }
}

/**
 * Make sure the hub has a running single-user server for `user`, and return the
 * server's base URL. A hub that has idle-culled the server answers with
 * `servers: {}`, and starting one is asynchronous — hence the poll.
 */
async function ensureHubServer(client, hubBaseUrl, user, { timeoutMs = 120_000, stderr } = {}) {
  const userUrl = new URL(`hub/api/users/${encodeURIComponent(user)}`, hubBaseUrl).toString();
  const deadline = Date.now() + timeoutMs;
  let started = false;

  for (;;) {
    const response = await client.fetch(userUrl, { method: "GET" });
    if (response.status === 403 || response.status === 401) {
      throw new Error("JupyterHub rejected the credentials for this user");
    }
    if (!response.ok) throw new Error(`JupyterHub returned ${response.status} for ${userUrl}`);
    const info = await response.json();
    const servers = info?.servers && typeof info.servers === "object" ? info.servers : {};
    const server = servers[""] ?? Object.values(servers)[0];
    if (server?.ready) {
      return new URL(String(server.url || `/user/${user}/`), hubBaseUrl).toString().replace(/\/?$/, "/");
    }
    if (!started) {
      started = true;
      const spawn = await client.fetch(new URL(`hub/api/users/${encodeURIComponent(user)}/server`, hubBaseUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      // 201 started, 202 accepted (spawning), 400 "already running" is fine too.
      if (spawn.status >= 400 && spawn.status !== 400) {
        throw new Error(`JupyterHub refused to start a server: ${spawn.status} ${spawn.statusText}`);
      }
      stderr?.write?.(`[aaronnote-jupyter] waiting for JupyterHub to spawn a server for ${user}\n`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for JupyterHub to start a server for ${user}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Build an authenticated HTTP client and the final base URL for a configured
 * server.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {"token"|"password"|"hub"|"none"} [options.auth]
 * @param {string} [options.token]
 * @param {string} [options.password]
 * @param {string} [options.user] - hub only; defaults to the URL's /user/<name>/ segment
 * @param {boolean} [options.allowUnauthorized]
 * @param {string} [options.serverName] - TLS SNI / Host override for a forwarded connection
 * @returns {Promise<{ baseUrl: string, wsUrl: string, client: object, token: string }>}
 */
export async function connectToServer({
  url,
  auth = "token",
  token = "",
  password = "",
  user = "",
  allowUnauthorized = false,
  serverName = "",
  stderr,
} = {}) {
  const normalized = normalizeBaseUrl(url);
  // A token in the URL is a convenience: `jupyter server` prints exactly that.
  const effectiveToken = String(token || normalized.token || "");
  const client = createHttpClient({
    allowUnauthorized,
    serverName,
    headers: effectiveToken ? { Authorization: `token ${effectiveToken}` } : {},
  });

  let baseUrl = normalized.baseUrl;
  if (auth === "password") {
    if (!password) throw new Error("Password authentication selected but no password was supplied");
    await loginWithPassword(client, baseUrl, password);
  } else if (auth === "hub") {
    const hubUser = user || (/\/user\/([^/]+)\//.exec(new URL(baseUrl).pathname)?.[1] ?? "");
    if (!hubUser) throw new Error("JupyterHub connection needs a user name");
    // The hub root is the URL with any /user/<name>/ suffix stripped.
    const hubBaseUrl = new URL(new URL(baseUrl).pathname.replace(/user\/[^/]+\/$/, ""), baseUrl).toString();
    if (!effectiveToken && password) await loginWithPassword(client, hubBaseUrl, password);
    baseUrl = await ensureHubServer(client, hubBaseUrl, hubUser, { stderr });
  }

  return { baseUrl, wsUrl: websocketUrlFor(baseUrl), client, token: effectiveToken };
}
