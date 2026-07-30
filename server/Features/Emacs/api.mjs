export function createEmacsApiHandlers({
  apiOpenInEmacs,
  apiCurrentFile,
  apiEmacsUiState,
  apiEmacsKey,
  apiSystemOpen,
  apiEmacsZotero,
}) {
  return {
    "aaronnote:api:emacs:open": (body) => apiOpenInEmacs(body?.file ?? body, body?.line, body?.col, body?.tag),
    "aaronnote:api:emacs:current-file": (file) => apiCurrentFile(file),
    "aaronnote:api:emacs:ui-state": (body) => apiEmacsUiState(body),
    "aaronnote:api:emacs:key": (key) => apiEmacsKey(key),
    "aaronnote:api:emacs:system-open": (target) => apiSystemOpen(target),
    "aaronnote:api:emacs:zotero": (body) => apiEmacsZotero(body),
    "aaronnote:api:emacs:zotero-import": (body) => apiEmacsZotero(body, "zotero-import"),
  };
}
