const SERVER_READ_CHANNELS = new Set([
  "aaronnote:api:wiki:bootstrap",
  "aaronnote:api:wiki:environment",
  "aaronnote:api:wiki:refresh",
  "aaronnote:api:wiki:search",
  "aaronnote:api:wiki:resolve-link",
  "aaronnote:api:wiki:tags",
  "aaronnote:api:notes:bootstrap",
  "aaronnote:api:notes:open",
  "aaronnote:api:notes:list",
  "aaronnote:api:notes:index",
  "aaronnote:api:notes:graph",
  "aaronnote:api:config:katex-macros",
  "aaronnote:api:config:app",
]);

const SERVER_COMPATIBILITY_CHANNELS = new Map([
  ["aaronnote:api:session:positions", { type: "positions", positions: [] }],
  ["aaronnote:api:session:save-position", { ok: true, stored: false }],
  ["aaronnote:api:session:client-close", { ok: true, closed: false }],
  ["aaronnote:api:emacs:current-file", { ok: true }],
  ["aaronnote:api:emacs:ui-state", { ok: true }],
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
