import {
  BLOCK_ANCHOR_SOURCE,
  UUID_V7_BLOCK_ID_SOURCE,
  orgEnvSupportsBlockIdentity,
  parseBlockProperties,
} from "./block-identity.mjs";

const ANCHOR_TAIL_RE = new RegExp(`${BLOCK_ANCHOR_SOURCE}[ \\t]*$`, "i");
const ORG_BEGIN_RE = /^[ \t]*#\+begin[ \t]+([a-z0-9_-]+)\b/i;
const ORG_END_RE = /^[ \t]*#\+end[ \t]+([a-z0-9_-]+)\b/i;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const UUID_V7_RE = new RegExp(`^${UUID_V7_BLOCK_ID_SOURCE}$`, "i");

/**
 * Scan only Noema's source-portable `{#UUIDv7 key=value}` property surface.
 * CommonMark structure remains owned by Lezer/Lute; this intentionally narrow
 * scanner only supplies the Node/Emacs fallback for the Go block projection.
 */
export function scanBlockPropertyDefinitions(source = "") {
  const text = String(source || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const definitions = [];
  const counts = new Map();
  let offset = 0;
  let fenceChar = "";
  let fenceLength = 0;
  let ignoredOrg = "";
  let mathFence = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    const fence = FENCE_RE.exec(line);
    if (fenceChar) {
      if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLength) {
        fenceChar = "";
        fenceLength = 0;
      }
      offset += line.length + (index < lines.length - 1 ? 1 : 0);
      continue;
    }
    if (fence) {
      fenceChar = fence[1][0];
      fenceLength = fence[1].length;
      offset += line.length + (index < lines.length - 1 ? 1 : 0);
      continue;
    }
    if (trimmed.startsWith("$$")) {
      if ((trimmed.match(/\$\$/g) || []).length === 1) mathFence = !mathFence;
      offset += line.length + (index < lines.length - 1 ? 1 : 0);
      continue;
    }
    if (mathFence || line.startsWith("    ") || line.startsWith("\t")) {
      offset += line.length + (index < lines.length - 1 ? 1 : 0);
      continue;
    }
    if (ignoredOrg) {
      const end = ORG_END_RE.exec(line);
      if (end && end[1].toLowerCase() === ignoredOrg) ignoredOrg = "";
      offset += line.length + (index < lines.length - 1 ? 1 : 0);
      continue;
    }
    const org = ORG_BEGIN_RE.exec(line);
    if (org && !orgEnvSupportsBlockIdentity(org[1])) {
      ignoredOrg = org[1].toLowerCase();
      offset += line.length + (index < lines.length - 1 ? 1 : 0);
      continue;
    }

    const anchor = ANCHOR_TAIL_RE.exec(line);
    if (anchor && UUID_V7_RE.test(String(anchor[1] || ""))) {
      const canonicalId = String(anchor[1] || "").toLowerCase();
      const orgEnv = Boolean(org);
      const kind = orgEnv ? org[1].toLowerCase() : "block";
      const prefix = line.slice(0, anchor.index).trim();
      const title = orgEnv ? line.slice(org[0].length, anchor.index).trim() : prefix;
      definitions.push({
        canonicalId,
        line: index + 1,
        index: offset,
        kind,
        orgEnv,
        text: title,
        properties: parseBlockProperties(anchor[2] || ""),
      });
      counts.set(canonicalId, (counts.get(canonicalId) || 0) + 1);
    }
    offset += line.length + (index < lines.length - 1 ? 1 : 0);
  }

  return {
    definitions,
    duplicateDefinitionIds: [...counts].filter(([, count]) => count > 1).map(([id]) => id).sort(),
  };
}

export function blockPropertyItemsForDocument(source, { file = "", noteTitle = "" } = {}) {
  const projection = scanBlockPropertyDefinitions(source);
  const duplicates = new Set(projection.duplicateDefinitionIds);
  return projection.definitions.filter((definition) => !duplicates.has(definition.canonicalId)).map((definition) => ({
    id: `#${definition.canonicalId}`,
    kind: definition.orgEnv ? "org-env" : "prose",
    status: String(definition.properties.status || ""),
    text: definition.text,
    title: definition.text,
    file: String(file || ""),
    noteTitle: String(noteTitle || ""),
    index: definition.index,
    line: definition.line,
    canon: { ...definition.properties },
    args: definition.orgEnv
      ? { ...definition.properties, env: definition.kind }
      : { ...definition.properties },
  }));
}

function encodePropertyValue(value, quote = "") {
  const text = String(value || "");
  if (!quote && /^[A-Za-z0-9._:/@+%-]+$/.test(text)) return text;
  const selected = quote || '"';
  return selected + text.replace(/\\/g, "\\\\").replace(new RegExp(`\\${selected}`, "g"), `\\${selected}`) + selected;
}

/** Source-only fallback for Emacs/Server; desktop uses the Go CAS mutation. */
export function patchBlockPropertySource(source, { id = "", key = "", value = null } = {}) {
  const text = String(source || "");
  const canonicalId = String(id || "").trim().replace(/^#/, "").toLowerCase();
  const cleanKey = String(key || "").trim().toLowerCase();
  if (!UUID_V7_RE.test(canonicalId)) throw new Error("Block property mutation requires a UUIDv7 identity");
  if (!/^[a-z][a-z0-9_-]*$/i.test(cleanKey) || cleanKey === "id") throw new Error(`Invalid block property key: ${cleanKey}`);
  const projection = scanBlockPropertyDefinitions(text);
  if (projection.duplicateDefinitionIds.includes(canonicalId)) throw new Error(`Block identity ${canonicalId} is ambiguous`);
  const definition = projection.definitions.find((candidate) => candidate.canonicalId === canonicalId);
  if (!definition) throw new Error(`Block identity ${canonicalId} was not found`);

  let lineStart = 0;
  for (let line = 1; line < definition.line; line++) {
    const end = text.indexOf("\n", lineStart);
    if (end < 0) throw new Error(`Block identity ${canonicalId} source line was not found`);
    lineStart = end + 1;
  }
  const newline = text.indexOf("\n", lineStart);
  const lineEnd = newline < 0 ? text.length : newline;
  const rawLine = text.slice(lineStart, lineEnd);
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  const anchor = ANCHOR_TAIL_RE.exec(line);
  if (!anchor || String(anchor[1] || "").toLowerCase() !== canonicalId) throw new Error(`Block identity ${canonicalId} anchor changed during mutation`);
  const anchorToken = anchor[0].trimEnd();
  const close = anchorToken.lastIndexOf("}");
  const propertiesStart = `{#${anchor[1]}`.length;
  if (close < propertiesStart) throw new Error(`Block identity ${canonicalId} anchor is invalid`);
  const rawProperties = anchorToken.slice(propertiesStart, close);
  const tokenPattern = /(?:^|\s)([A-Za-z][A-Za-z0-9_-]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/g;
  const tokens = [];
  let consumed = 0;
  for (const match of rawProperties.matchAll(tokenPattern)) {
    if (rawProperties.slice(consumed, match.index).trim()) throw new Error(`Block identity ${canonicalId} has malformed properties`);
    const tokenText = match[0];
    const rawValue = match[2];
    const valueOffset = tokenText.lastIndexOf(rawValue);
    tokens.push({
      start: match.index,
      end: match.index + tokenText.length,
      key: match[1].toLowerCase(),
      valueStart: match.index + valueOffset,
      valueEnd: match.index + valueOffset + rawValue.length,
      quote: rawValue.startsWith('"') || rawValue.startsWith("'") ? rawValue[0] : "",
    });
    consumed = match.index + tokenText.length;
  }
  if (rawProperties.slice(consumed).trim()) throw new Error(`Block identity ${canonicalId} has malformed properties`);

  const targets = tokens.filter((token) => token.key === cleanKey);
  if (targets.length > 1) throw new Error(`Block identity ${canonicalId} has duplicate property ${cleanKey}`);
  const target = targets[0];
  let nextProperties = rawProperties;
  const deleting = value === null || value === undefined || String(value) === "";
  if (target && deleting) nextProperties = rawProperties.slice(0, target.start) + rawProperties.slice(target.end);
  else if (target) nextProperties = rawProperties.slice(0, target.valueStart) + encodePropertyValue(value, target.quote) + rawProperties.slice(target.valueEnd);
  else if (!deleting) nextProperties = rawProperties.trimEnd() + ` ${cleanKey}=${encodePropertyValue(value)}`;

  const oldAnchor = anchorToken.slice(0, close + 1);
  const nextAnchor = anchorToken.slice(0, propertiesStart) + nextProperties + "}";
  const from = lineStart + anchor.index;
  const nextMarkdown = text.slice(0, from) + nextAnchor + text.slice(from + oldAnchor.length);
  const nextDefinition = scanBlockPropertyDefinitions(nextMarkdown).definitions.find((candidate) => candidate.canonicalId === canonicalId);
  if (!nextDefinition) throw new Error(`Block identity ${canonicalId} disappeared after mutation`);
  return { from, to: from + oldAnchor.length, source: oldAnchor, nextSource: nextAnchor, markdown: nextMarkdown, definition: nextDefinition };
}
