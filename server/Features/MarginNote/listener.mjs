import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createMarginNoteHttpHandler } from "./api.mjs";

/** A stable loopback rendezvous, owned by the existing host process. */
export async function startMarginNoteListener({ bridge, token, port = 3212 }) {
  const handle = createMarginNoteHttpHandler({ bridge, token });
  const server = createServer(async (req, res) => {
    if (!await handle(req, res)) { res.writeHead(404); res.end(); }
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", failed); resolve(); };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(port, "127.0.0.1");
      });
      break;
    } catch (error) {
      // During a supervised restart the previous host may still be closing.
      if (error.code !== "EADDRINUSE" || attempt >= 20) { server.close(); throw error; }
      await delay(250);
    }
  }
  return { url: `http://127.0.0.1:${server.address().port}/v1/marginnote`,
    close() { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); } };
}
