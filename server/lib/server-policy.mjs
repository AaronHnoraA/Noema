const SERVER_READ_CHANNELS = new Set([
  "noema:api:wiki:bootstrap",
  "noema:api:wiki:environment",
  "noema:api:wiki:refresh",
  "noema:api:wiki:search",
  "noema:api:knowledge:search",
  "noema:api:wiki:resolve-link",
  "noema:api:wiki:tags",
  "noema:api:notes:bootstrap",
  "noema:api:notes:open",
  "noema:api:notes:list",
  "noema:api:notes:index",
  "noema:api:notes:graph",
  "noema:api:config:katex-macros",
  "noema:api:config:note-katex-macros",
  "noema:api:config:app",
  "noema:api:jupyter-cell:read-script-cell",
]);

const SERVER_COMPATIBILITY_CHANNELS = new Map([
  ["noema:api:session:positions", { type: "positions", positions: [] }],
  ["noema:api:session:save-position", { ok: true, stored: false }],
  ["noema:api:session:client-close", { ok: true, closed: false }],
  ["noema:api:emacs:current-file", { ok: true }],
  ["noema:api:emacs:ui-state", { ok: true }],
  ["noema:api:emacs:input-focus", { ok: true }],
]);

export function serverApiChannelAllowed(channel) {
  const name = String(channel || "");
  return SERVER_READ_CHANNELS.has(name) || SERVER_COMPATIBILITY_CHANNELS.has(name);
}

export function serverApiCompatibilityResult(channel) {
  const value = SERVER_COMPATIBILITY_CHANNELS.get(String(channel || ""));
  return value ? structuredClone(value) : undefined;
}

export function assertServerApiChannel(channel) {
  if (serverApiChannelAllowed(channel)) return;
  throw Object.assign(new Error("This operation is unavailable in Server reader mode"), {
    code: "ERR_NOEMA_SERVER_READ_ONLY",
    statusCode: 403,
  });
}
