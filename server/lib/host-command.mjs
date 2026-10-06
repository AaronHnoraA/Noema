// Project one Emacs gateway command onto the renderer's SSE payload.
// The command protocol carries page arguments inside `detail`; top-level
// fields control host routing and must not silently become page arguments.
export function rendererCommandDetail(body = {}) {
  const detail = {
    ...(body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
      ? body.detail : {}),
    command: String(body.command || ""),
  };
  if (body.client) {
    detail.targetClient = String(body.client);
    detail.client = String(body.client);
  }
  return detail;
}
