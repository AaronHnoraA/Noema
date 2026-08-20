// A small fetch-compatible HTTP client for talking to a Jupyter server.
//
// Node's global fetch cannot do two things this needs: keep cookies across
// requests (the notebook password login is a cookie flow, and `_xsrf` must be
// echoed back on every mutating call), and relax TLS verification for a
// self-signed lab certificate without setting NODE_TLS_REJECT_UNAUTHORIZED=0
// process-wide. Rather than take on a dispatcher dependency, this wraps
// node:http/node:https directly and returns real `Response` objects, so it can
// be handed to `ServerConnection.makeSettings({ fetch })` unchanged.
//
// Scope is deliberately narrow: one client per configured server, no caching,
// no streaming bodies. Jupyter's REST payloads are small JSON documents.

import http from "node:http";
import https from "node:https";

const MAX_REDIRECTS = 5;

// Set-Cookie is carried on the response object directly rather than read back
// out of `Headers`. `Headers.getSetCookie()` is not implemented by every
// environment this module is loaded in (test DOM shims, in particular), and a
// silently-dropped cookie turns into an authentication failure that only shows
// up against a real server.
const RAW_SET_COOKIE = Symbol("set-cookie");

/** Parse one Set-Cookie header into `{ name, value }`, ignoring attributes. */
function parseSetCookie(line) {
  const [pair] = String(line || "").split(";");
  const index = pair.indexOf("=");
  if (index <= 0) return null;
  return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.allowUnauthorized] - accept a self-signed/mismatched TLS certificate
 * @param {Record<string,string>} [options.headers] - sent with every request (e.g. Authorization)
 * @param {string} [options.serverName] - TLS SNI / Host override, for a forwarded connection
 *   whose URL is 127.0.0.1 but whose certificate names the real host
 */
export function createHttpClient({ allowUnauthorized = false, headers = {}, serverName = "" } = {}) {
  /** name -> value. One client serves exactly one Jupyter server, so a flat jar is enough. */
  const cookies = new Map();
  const baseHeaders = { ...headers };

  function cookieHeader() {
    if (cookies.size === 0) return "";
    return Array.from(cookies.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
  }

  function rememberCookies(response) {
    for (const line of response[RAW_SET_COOKIE] || []) {
      const cookie = parseSetCookie(line);
      if (cookie) cookies.set(cookie.name, cookie.value);
    }
  }

  function once(url, init) {
    return new Promise((resolve, reject) => {
      const target = new URL(String(url));
      const secure = target.protocol === "https:";
      const request = (secure ? https : http).request(
        target,
        {
          method: init?.method || "GET",
          headers: init?.headers || {},
          ...(secure
            ? {
                rejectUnauthorized: !allowUnauthorized,
                ...(serverName ? { servername: serverName } : {}),
              }
            : {}),
        },
        (message) => {
          const chunks = [];
          message.on("data", (chunk) => chunks.push(chunk));
          message.on("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(message.headers)) {
              if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
              else if (value !== undefined) responseHeaders.append(name, String(value));
            }
            const status = message.statusCode || 0;
            const response = new Response(
              // 204/304 must not carry a body, and Response rejects one.
              status === 204 || status === 304 ? null : Buffer.concat(chunks),
              { status, statusText: message.statusMessage || "", headers: responseHeaders },
            );
            const setCookie = message.headers["set-cookie"];
            Object.defineProperty(response, RAW_SET_COOKIE, {
              value: Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []),
            });
            resolve(response);
          });
        },
      );
      request.on("error", reject);
      if (init?.body !== undefined && init.body !== null) request.write(init.body);
      request.end();
    });
  }

  /** Headers may arrive as a Headers, an array of pairs, or a plain object. */
  function headerEntries(value) {
    if (!value) return {};
    if (typeof value.entries === "function") return Object.fromEntries(value.entries());
    if (Array.isArray(value)) return Object.fromEntries(value);
    return { ...value };
  }

  /**
   * fetch-compatible. Applies the configured headers, the cookie jar, and
   * Jupyter's `X-XSRFToken` echo; follows redirects unless `redirect:
   * "manual"` was asked for, carrying cookies across the hops (which is what
   * makes a hub login land on the user server).
   *
   * Both call shapes must work. @jupyterlab/services builds a `Request` and
   * calls `fetch(request)` with no second argument — reading the method off
   * `init` alone would silently turn every POST into a GET, which a Jupyter
   * server answers with a perfectly valid 200 for the wrong resource.
   */
  async function clientFetch(input, init = {}) {
    const isRequest = Boolean(input)
      && typeof input === "object"
      && typeof input.url === "string"
      && typeof input.method === "string";

    let url = isRequest ? input.url : String(input);
    let method = String(init.method || (isRequest ? input.method : "GET")).toUpperCase();
    let body = init.body;
    if (body === undefined && isRequest && method !== "GET" && method !== "HEAD") {
      const text = await input.text().catch(() => "");
      if (text) body = text;
    }
    const inherited = {
      ...(isRequest ? headerEntries(input.headers) : {}),
      ...headerEntries(init.headers),
    };
    const redirect = init.redirect || (isRequest ? input.redirect : undefined);

    for (let hop = 0; ; hop++) {
      const requestHeaders = { ...baseHeaders, ...inherited };

      const jarHeader = cookieHeader();
      if (jarHeader) requestHeaders.Cookie = jarHeader;
      // Jupyter rejects unsafe methods unless the _xsrf cookie is echoed in a
      // header. Harmless when the server does not use XSRF at all.
      const xsrf = cookies.get("_xsrf");
      if (xsrf && method !== "GET" && method !== "HEAD") requestHeaders["X-XSRFToken"] = xsrf;
      if (serverName) requestHeaders.Host = serverName;
      if (body !== undefined && body !== null && requestHeaders["Content-Length"] === undefined) {
        requestHeaders["Content-Length"] = String(Buffer.byteLength(String(body)));
      }

      const response = await once(url, { method, headers: requestHeaders, body });
      rememberCookies(response);

      const location = response.headers.get("location");
      const redirectable = response.status >= 300 && response.status < 400 && location;
      if (!redirectable || redirect === "manual") return response;
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects from ${url}`);
      url = new URL(location, url).toString();
      // Mirror browser semantics: 303, and 301/302 on POST, continue as GET.
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
    }
  }

  return {
    fetch: clientFetch,
    cookieHeader,
    /** Current `_xsrf` cookie, if the server issued one. */
    xsrf: () => cookies.get("_xsrf") || "",
    /** Headers a WebSocket handshake needs to look like the same client. */
    websocketHeaders() {
      const result = { ...baseHeaders };
      const jarHeader = cookieHeader();
      if (jarHeader) result.Cookie = jarHeader;
      if (serverName) result.Host = serverName;
      return result;
    },
    setHeader(name, value) {
      if (value === undefined) delete baseHeaders[name];
      else baseHeaders[name] = value;
    },
    allowUnauthorized,
    serverName,
  };
}
