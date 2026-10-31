// The Emacs-hosted Noema host serves this machine's own clients.  A request
// is one of them unless a browser says it comes from another page, or it
// reached the socket under a name that is not this machine (DNS rebinding).
// A route that checks a bearer token takes browser extensions as well.
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

export function localClientRequest(headers, { bearerRoute = false } = {}) {
  const host = String(headers.host || "");
  if (!LOOPBACK_HOST.test(host)) return false;
  const { origin } = headers;
  return !origin || bearerRoute || origin === `http://${host}`;
}
