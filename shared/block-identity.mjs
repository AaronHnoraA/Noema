export const BLOCK_ID_SOURCE = "[A-Za-z0-9][A-Za-z0-9._:-]{2,127}";

const TRAILING_BLOCK_ID_RE = new RegExp(`^(?:(.*?)[ \\t]+)?\\{#(${BLOCK_ID_SOURCE})\\}[ \\t]*$`);

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

/** Split a generated trailing `{#id}` from an org-environment display title. */
export function parseOrgEnvIdentityTitle(kind, value) {
  const rawTitle = String(value || "").trim();
  if (!orgEnvSupportsBlockIdentity(kind)) return { title: rawTitle, blockId: "" };
  const match = TRAILING_BLOCK_ID_RE.exec(rawTitle);
  if (!match) return { title: rawTitle, blockId: "" };
  return {
    title: String(match[1] || "").trim(),
    blockId: String(match[2] || ""),
  };
}

export function shortBlockId(value, length = 6) {
  const id = String(value || "");
  const size = Math.max(1, Number(length) || 6);
  return id.length > size ? `…${id.slice(-size)}` : id;
}
