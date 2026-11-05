import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

const addon = "/addons/noema.extension.agent";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function validateOfficialConnection({ url, token }, device) {
  if (!["mac", "ipad"].includes(device)) throw new Error("Select device mac or ipad");
  const parsed = new URL(url);
  const privateIPv4 = isIP(parsed.hostname) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname);
  if (parsed.protocol !== "http:" || !parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== "/bridge/v1" || (device === "mac" ? parsed.hostname !== "127.0.0.1" : !privateIPv4) ||
      typeof token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(token)) {
    throw new Error("Official Bridge credentials do not match the named device and local Bridge URL");
  }
  return { url: parsed.href, token, device };
}

export async function officialConnection(device = "mac") {
  if (!["mac", "ipad"].includes(device)) throw new Error("Select device mac or ipad");
  const folder = join(process.env.NOEMA_MN_CONFIG_ROOT || join(homedir(), ".config/mn-bridge"), device);
  const [url, token] = await Promise.all([readFile(join(folder, "base"), "utf8"), readFile(join(folder, "token"), "utf8")]);
  return validateOfficialConnection({ url: url.trim(), token: token.trim() }, device);
}

async function boundedJson(response) {
  const chunks = []; let size = 0;
  if (Number(response.headers.get("content-length")) > 2 * 1024 * 1024) { await response.body.cancel(); throw new Error("Official response exceeds 2 MiB"); }
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 2 * 1024 * 1024) throw new Error("Official response exceeds 2 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createOfficialClient(config, { fetchImpl = fetch, pause = sleep } = {}) {
  config = validateOfficialConnection(config, config.device);
  async function post(path, body, timeout = 10000) {
    const response = await fetchImpl(config.url + path, { method: "POST", redirect: "error",
      headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, timeout)) });
    const data = await boundedJson(response);
    if (!response.ok) {
      const detail = data.error;
      throw Object.assign(new Error(typeof detail === "string" ? detail : detail?.message || data.message || "Official HTTP " + response.status),
        { code: detail?.code || data.code, status: response.status });
    }
    return data;
  }
  async function evaluate(js, timeout) { return (await post(addon + "/panel/eval", { js }, timeout)).value; }
  async function rpc(action, payload, deadline = Date.now() + 10000) {
    const id = randomUUID();
    const js = "return noema.request(" + JSON.stringify(id) + "," + JSON.stringify(action) + "," + JSON.stringify(payload) + ");";
    const started = await evaluate(js, Math.min(10000, deadline - Date.now()));
    if (started?.state !== "pending" && started?.state !== "completed") throw new Error("Noema panel protocol mismatch; install the current Noema package");
    let delay = 20;
    while (Date.now() < deadline) {
      const result = await evaluate("return noema.result(" + JSON.stringify(id) + ");", Math.min(10000, deadline - Date.now()));
      if (result?.state === "completed") return result.value;
      if (result?.state !== "pending") throw new Error(result?.error || "Panel response lost; execution outcome unknown");
      await pause(delay); delay = Math.min(delay * 2, 200);
    }
    throw new Error("Panel response deadline exceeded; execution outcome unknown");
  }
  async function status() { return { ...await rpc("status", {}), device: config.device, transport: "official" }; }
  async function open() {
    const pressed = await post(addon + "/capsule", {});
    if (!pressed.pressed) throw new Error("MarginNote did not open the Noema panel");
    // The native command can return before WKWebView has loaded the document.
    let last;
    for (let i = 0; i < 12; i++) {
      await pause(250);
      try { return await status(); } catch (error) { last = error; if (error.status === 401 || error.status === 403) throw error; }
    }
    throw last;
  }
  async function call(path, body = {}) {
    if (path === "/open") return open();
    if (path === "/sessions") return status();
    if (path !== "/execute" && !path.startsWith("/requests/")) throw new Error("Unknown Noema operation");
    const requestId = path === "/execute" ? body.requestId || randomUUID() : decodeURIComponent(path.slice("/requests/".length));
    let submitted = false;
    try {
      if (path === "/execute" && (typeof body.code !== "string" || !body.code.trim() || Buffer.byteLength(body.code) > 256 * 1024 ||
          Buffer.byteLength(JSON.stringify(body.args ?? {})) > 256 * 1024)) throw new Error("Code and args each have a 256 KiB UTF-8 limit");
      // The native callback checks a caller's pinned session on every action,
      // avoiding two extra HTTP trips when status was already read.
      let sessionId = body.sessionId;
      if (!sessionId) {
        const context = await status();
        if (context.protocol !== 1 || context.sessions?.length !== 1) throw new Error("Select one active Noema panel");
        sessionId = context.sessions[0].id;
      }
      if (path !== "/execute") return await rpc("result", { sessionId, requestId });
      const timeoutMs = body.timeoutMs ?? 30000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error("Invalid timeoutMs");
      const deadline = Date.now() + timeoutMs;
      submitted = true;
      let result = await rpc("submit", { ...body, timeoutMs, requestId, sessionId }, deadline + 3000);
      let delay = 20;
      while (result.state === "running" && Date.now() < deadline) {
        result = await rpc("result", { sessionId, requestId }, deadline + 3000);
        if (result.state === "running") { await pause(delay); delay = Math.min(delay * 2, 250); }
      }
      if (result.state === "running") return { ok: false, requestId, sessionId, state: "timed_out", execution: "unknown" };
      return result;
    } catch (error) {
      throw new Error(`Request ${requestId}: ${submitted ? "execution outcome unknown; query result before retrying" : "not submitted"}. ${error.message}`);
    }
  }
  return { call, status, open };
}

export async function callOfficial(path, body, { device = "mac" } = {}) {
  return createOfficialClient(await officialConnection(device)).call(path, body);
}
