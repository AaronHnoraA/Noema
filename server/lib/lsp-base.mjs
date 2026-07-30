/**
 * Shared LSP stdio client base — JSON-RPC 2.0 over Content-Length framed stdio.
 *
 * Subclass and implement `handleNotification(method, params)` and
 * `handleServerRequest(id, method, params)` for custom notification handling.
 */
import { spawn } from "node:child_process";

export class LspClient {
  constructor() {
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Spawn the server process. Subclass calls this after setting up cwd/env. */
  spawnProcess(command, args, { cwd, env } = {}) {
    const proc = spawn(command, args, {
      cwd: cwd ?? process.cwd(),
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout.on("data", (chunk) => this.receive(chunk));
    proc.stderr.on("data", (chunk) => {
      const msg = String(chunk || "").trim();
      if (msg) this.onStderr(msg);
    });
    proc.once("error", (err) => {
      if (this.proc !== proc) return;
      this.onError(err);
      this.failPending(err);
      this.proc = null;
    });
    proc.once("exit", (code, signal) => {
      if (this.proc !== proc) return;
      const err = new Error(`LSP server exited (${signal ?? (code ?? "unknown")})`);
      this.onExit(code, signal);
      this.failPending(err);
      this.proc = null;
    });
    return proc;
  }

  stop() {
    if (!this.proc) return;
    try { this.proc.kill(); } catch {}
    this.proc = null;
  }

  get running() {
    return Boolean(this.proc);
  }

  // ---------------------------------------------------------------------------
  // Overridable hooks
  // ---------------------------------------------------------------------------

  onStderr(msg) { console.warn(`[LSP stderr] ${msg}`); }
  onError(_err) {}
  onExit(_code, _signal) {}

  /** Handle an incoming notification from the server. Override in subclass. */
  handleNotification(_method, _params) {}

  /** Handle an incoming server→client request. Override in subclass. */
  handleServerRequest(id, _method, _params) {
    this.respond(id, null);
  }

  // ---------------------------------------------------------------------------
  // Send / receive
  // ---------------------------------------------------------------------------

  send(value) {
    if (!this.proc?.stdin?.writable) throw new Error("LSP server is not running");
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          reject(new Error(`LSP request timed out: ${method}`));
        }, timeoutMs);
      }
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respond(id, result, error = null) {
    if (error) this.send({ jsonrpc: "2.0", id, error });
    else this.send({ jsonrpc: "2.0", id, result });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) { this.buffer = this.buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const raw = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try { this.dispatch(JSON.parse(raw)); } catch (err) {
        console.warn("[LSP] parse error", err);
      }
    }
  }

  dispatch(message) {
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    // Response to our request
    if (hasId && (hasResult || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "LSP error"));
      else pending.resolve(message.result);
      return;
    }
    // Server→client request
    if (hasId && message.method) {
      this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    // Notification
    if (message.method) {
      this.handleNotification(message.method, message.params);
    }
  }

  failPending(err) {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }
}
