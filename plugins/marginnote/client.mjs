import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function connection() {
  const candidates = process.env.NOEMA_HOST_DESCRIPTOR ? [process.env.NOEMA_HOST_DESCRIPTOR] : [
    process.env.NOEMA_STATE_DIR && join(process.env.NOEMA_STATE_DIR, "host.json"),
    fileURLToPath(new URL("../../../../var/noema/host.json", import.meta.url)),
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "noema/host.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const host = JSON.parse(await readFile(file, "utf8"));
      process.kill(host.pid, 0);
      if (host.marginnote?.url && host.marginnote?.token) return host.marginnote;
    } catch {}
  }
  throw new Error("Live Noema host has no MarginNote bridge. Start/restart Noema in Emacs.");
}

export async function call(path, body) {
  const config = await connection();
  if (path === "/execute") body = { ...body, requestId: body.requestId || randomUUID() };
  let response;
  try { response = await fetch(config.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout((body?.timeoutMs || 30_000) + 5000),
  }); } catch (error) {
    throw new Error(body?.requestId ? `Request ${body.requestId}: transport interrupted; execution outcome unknown. Query result before retrying. ${error.message}` : error.message);
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "HTTP " + response.status);
  return result;
}

export async function apiReference(query = "", offset = 0, limit = 20) {
  const catalog = JSON.parse(await readFile(new URL("api-catalog.json", import.meta.url), "utf8"));
  const needle = query.toLowerCase();
  const matches = catalog.interfaces.filter((item) => (item.name + " " + item.globals.join(" ") + " " + item.declarations).toLowerCase().includes(needle));
  return { source: catalog.source, revision: catalog.revision, total: matches.length,
    interfaces: matches.slice(offset, offset + limit), nextOffset: offset + limit < matches.length ? offset + limit : null };
}
