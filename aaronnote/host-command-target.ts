/**
 * Whether a host command belongs to this renderer page.
 *
 * Emacs keeps one renderer per xwidget buffer and addresses pause/resume, key
 * injection and per-pane actions to the `client` from that page's URL. The web
 * host fans control events out over one shared SSE stream, so every renderer
 * must reject commands addressed to a sibling pane.
 *
 * Routing and subject are deliberately different fields. `targetClient` says
 * who must run the command; a plain `client` on a server-originated broadcast
 * (`client-closed`, index notifications) names who the event is *about* and
 * must never be read as an address, or the broadcast reaches nobody.
 * Untargeted commands stay broadcasts for desktop, server and in-page callers.
 */
export function hostCommandTargetsClient(
  detail: unknown,
  rendererClient: string,
): boolean {
  if (!detail || typeof detail !== "object") return true;
  const target = String((detail as { targetClient?: unknown }).targetClient ?? "").trim();
  if (!target) return true;
  return target === rendererClient.trim();
}
