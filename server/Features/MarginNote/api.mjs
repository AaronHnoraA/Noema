import { captureRequestAuthorized } from "../../lib/capture-token.mjs";

export const MARGINNOTE_ROUTE = "/v1/marginnote";

export function createMarginNoteHttpHandler({ bridge, token }) {
  return async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(MARGINNOTE_ROUTE + "/")) return false;
    const send = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    if (!local || req.headers.origin || !captureRequestAuthorized(req.headers.authorization, token)) {
      send(401, { ok: false, error: "MarginNote bearer token required; browser origins are not accepted" });
      return true;
    }
    try {
      if (req.method === "GET" && url.pathname === MARGINNOTE_ROUTE + "/sessions") send(200, bridge.list());
      else if (req.method === "GET" && url.pathname.startsWith(MARGINNOTE_ROUTE + "/requests/")) {
        send(200, bridge.request(url.pathname.slice((MARGINNOTE_ROUTE + "/requests/").length)));
      } else if (req.method === "POST" && ["poll", "execute", "disconnect", "heartbeat"].some((name) => url.pathname === MARGINNOTE_ROUTE + "/" + name)) {
        let text = "";
        for await (const chunk of req) {
          text += chunk;
          if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Object.assign(new Error("Request exceeds 2 MiB; return files by path or base64 chunks"), { statusCode: 413 });
        }
        const body = JSON.parse(text || "{}");
        if (url.pathname.endsWith("/execute")) send(200, await bridge.submit(body));
        else if (url.pathname.endsWith("/heartbeat")) send(200, bridge.heartbeat(body));
        else if (url.pathname.endsWith("/disconnect")) { bridge.disconnect(body.sessionId); send(200, { ok: true }); }
        else {
          const controller = new AbortController();
          const abort = () => controller.abort();
          res.on("close", abort);
          try { send(200, await bridge.poll(body, controller.signal)); }
          finally { res.off("close", abort); }
        }
      } else send(404, { ok: false, error: "Unknown MarginNote route or method" });
    } catch (error) {
      send(error.statusCode || 400, { ok: false, error: String(error.message || error) });
    }
    return true;
  };
}
