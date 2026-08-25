export const BLOCK_ID_SOURCE = "[A-Za-z0-9][A-Za-z0-9._:-]{2,127}";
export const UUID_V7_BLOCK_ID_SOURCE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
export const LEGACY_SIYUAN_BLOCK_ID_SOURCE = "[0-9]{14}-[0-9a-z]{7}";
export const BLOCK_REFERENCE_ID_SOURCE = `(?:${UUID_V7_BLOCK_ID_SOURCE}|${LEGACY_SIYUAN_BLOCK_ID_SOURCE})`;
export const BLOCK_ANCHOR_SOURCE = `\\{#(${BLOCK_ID_SOURCE})(?:[ \\t]+([^{}\\r\\n]*))?\\}`;

const BLOCK_REFERENCE_ID_RE = new RegExp(`^(?:${BLOCK_REFERENCE_ID_SOURCE})$`);

const TRAILING_BLOCK_ID_RE = new RegExp(`^(?:(.*?)[ \\t]+)?${BLOCK_ANCHOR_SOURCE}[ \\t]*$`);

const NON_SEMANTIC_ORG_ENVS = new Set([
  "comment",
  "fold",
  "html",
  "lean4",
  "meta",
  "org",
  "tikz",
]);

export function orgEnvSupportsBlockIdentity(kind) {
  return !NON_SEMANTIC_ORG_ENVS.has(String(kind || "").trim().toLowerCase());
}

function unquotePropertyValue(value) {
  const text = String(value || "");
  if (text.length >= 2 && ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'"))) {
    return text.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return text;
}

/** Parse the optional key=value fields carried by a portable block anchor. */
export function parseBlockProperties(raw = "") {
  const source = String(raw || "").trim();
  const attrs = {};
  const token = /(?:^|\s)([A-Za-z][A-Za-z0-9_-]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/g;
  for (const match of source.matchAll(token)) {
    const key = String(match[1] || "").toLowerCase();
    if (key && key !== "id") attrs[key] = unquotePropertyValue(match[2]);
  }
  return attrs;
}

/** Parse one complete `{#id key=value ...}` portable anchor token. */
export function parseBlockAnchor(value = "") {
  const match = new RegExp(`^${BLOCK_ANCHOR_SOURCE}$`, "i").exec(String(value || "").trim());
  if (!match) return { blockId: "", attrs: {} };
  return { blockId: String(match[1] || ""), attrs: parseBlockProperties(match[2] || "") };
}

/** Split a generated trailing `{#id}` from an org-environment display title. */
export function parseOrgEnvIdentityTitle(kind, value) {
  const rawTitle = String(value || "").trim();
  if (!orgEnvSupportsBlockIdentity(kind)) return { title: rawTitle, blockId: "", attrs: {} };
  const match = TRAILING_BLOCK_ID_RE.exec(rawTitle);
  if (!match) return { title: rawTitle, blockId: "", attrs: {} };
  return {
    title: String(match[1] || "").trim(),
    blockId: String(match[2] || ""),
    attrs: parseBlockProperties(match[3] || ""),
  };
}

/**
 * Return whether VALUE is accepted by Noema's `((id))` block-reference wire
 * syntax. New identities are UUIDv7; the timestamp-shaped SiYuan form remains
 * readable so documents produced during the kernel spike do not break.
 */
export function isBlockReferenceId(value) {
  return BLOCK_REFERENCE_ID_RE.test(String(value || ""));
}

export function shortBlockId(value, length = 6) {
  const id = String(value || "");
  const size = Math.max(1, Number(length) || 6);
  return id.length > size ? `…${id.slice(-size)}` : id;
}
