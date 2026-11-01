import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve each request afresh: Emacs may restart the host on another port. */
export async function agentApiConnection() {
  const candidates = process.env.NOEMA_HOST_DESCRIPTOR ? [process.env.NOEMA_HOST_DESCRIPTOR] : [
    process.env.NOEMA_STATE_DIR && join(process.env.NOEMA_STATE_DIR, "host.json"),
    fileURLToPath(new URL("../../../../var/noema/host.json", import.meta.url)),
    join(homedir(), "Library/Application Support/Noema/state/runtime/host.json"),
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "noema/host.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const host = JSON.parse(await readFile(file, "utf8"));
      if (!Number.isSafeInteger(host.pid) || host.pid < 1) continue;
      process.kill(host.pid, 0);
      const url = new URL(host.url);
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) continue;
      return url.origin;
    } catch {}
  }
  throw new Error("No live local Noema host. Start/restart Noema in Emacs; do not edit the document as an API fallback.");
}

/** Skills and prompts say `emacs:agent`; both spellings name one channel. */
export const fullChannel = (channel) => (typeof channel === "string" && !channel.startsWith("noema:api:") ? `noema:api:${channel}` : channel);

export async function callAgentApi(given, args = [], { connection = agentApiConnection, fetcher = fetch } = {}) {
  const channel = fullChannel(given);
  if (typeof channel !== "string" || !Array.isArray(args))
    throw new Error("A channel and a JSON args array are required");
  let response;
  try {
    response = await fetcher(`${await connection()}/api`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "noema:api:agent:call", args: [{ channel, args }] }), signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new Error(`API transport interrupted; outcome may be unknown. Read current state before retrying a mutation. ${error.message}`);
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || `HTTP ${response.status}`);
  return result;
}
