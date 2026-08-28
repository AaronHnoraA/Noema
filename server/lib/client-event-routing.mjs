/**
 * Normalize the stable renderer client carried by an Emacs xwidget URL.
 * Empty clients are compatibility/broadcast consumers (desktop and older
 * pages); they must never receive a command explicitly addressed to a sibling.
 */
export function normalizeEventClient(value) {
  // Client ids contain canonical note paths and may legitimately exceed a
  // small UI-oriented limit. Truncating only the SSE side would make it differ
  // from the renderer URL identity and silently drop every targeted command.
  return typeof value === "string" ? value.trim() : "";
}

/** Return whether PAYLOAD is a broadcast or belongs to CLIENT. */
export function eventTargetsClient(payload, client) {
  const target = normalizeEventClient(
    payload && typeof payload === "object" ? payload.targetClient : "",
  );
  return !target || (Boolean(client) && target === normalizeEventClient(client));
}

export const MAX_CLIENT_LIFECYCLE_STATES = 256;

/**
 * Retain the last explicit foreground/background fact for a renderer.
 * SSE has no history, so without this state a pause sent while WebKit is
 * reconnecting is lost and a hidden xwidget continues doing foreground work.
 */
export function rememberClientLifecycle(states, payload) {
  if (!(states instanceof Map) || !payload || typeof payload !== "object") return false;
  const client = normalizeEventClient(payload.targetClient);
  const command = String(payload.command || "").trim().toLowerCase();
  if (!client || (command !== "pause" && command !== "resume")) return false;
  // Refresh insertion order so the map doubles as a tiny LRU. A renderer that
  // crashes before `client-close` must not leave immortal path-sized keys in a
  // web host that can otherwise run for weeks.
  states.delete(client);
  states.set(client, command);
  while (states.size > MAX_CLIENT_LIFECYCLE_STATES) {
    const oldest = states.keys().next().value;
    if (typeof oldest !== "string") break;
    states.delete(oldest);
  }
  return true;
}

export function forgetClientLifecycle(states, client) {
  return states instanceof Map && states.delete(normalizeEventClient(client));
}

/** Return a fresh targeted command suitable for replay on SSE attach. */
export function clientLifecycleReplay(states, client) {
  const normalized = normalizeEventClient(client);
  const command = normalized && states instanceof Map ? states.get(normalized) : "";
  return command === "pause" || command === "resume"
    ? { command, targetClient: normalized, client: normalized, replay: true }
    : null;
}
