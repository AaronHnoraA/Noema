// The Emacs-hosted host serves this machine's own clients on a loopback
// socket.  Tools send no Origin and its pages send their own, so the one thing
// left to refuse is another web page, and only where a request changes
// something.  Comparing with the socket's own address also refuses a page
// that rebinds a domain to this port.
export function foreignPage(req) {
  const { origin } = req.headers;
  return Boolean(origin) && origin !== `http://127.0.0.1:${req.socket.localPort}`;
}
