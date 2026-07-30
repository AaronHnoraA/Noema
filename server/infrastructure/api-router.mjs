/**
 * Transport-neutral API composition root.
 *
 * Feature modules return channel -> handler records. The router owns duplicate
 * detection and unknown-channel errors so HTTP is not mixed with feature
 * registration.
 */
export class ApiRouter {
  #handlers = new Map();

  register(handlers, owner = "feature") {
    for (const [channel, handler] of Object.entries(handlers || {})) {
      if (typeof handler !== "function") {
        throw new TypeError(`${owner}: ${channel} is not an API handler`);
      }
      if (this.#handlers.has(channel)) {
        throw new Error(`Duplicate API channel: ${channel}`);
      }
      this.#handlers.set(channel, handler);
    }
    return this;
  }

  has(channel) {
    return this.#handlers.has(String(channel || ""));
  }

  channels() {
    return [...this.#handlers.keys()];
  }

  async call(channel, args = []) {
    const name = String(channel || "");
    const handler = this.#handlers.get(name);
    if (!handler) {
      throw Object.assign(new Error(`Unknown API channel: ${name}`), { statusCode: 404 });
    }
    return await handler(...(Array.isArray(args) ? args : []));
  }
}
