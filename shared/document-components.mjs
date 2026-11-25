import { splitDocumentWidgetAttrs } from "./document-widget-title.mjs";
import { parseOrgEnvIdentityTitle } from "./block-identity.mjs";
import { stripHiddenInlineTitle } from "./inline-private-title.mjs";

const surfaces = ["none", "paper", "quiet", "raised"];
const accents = ["neutral", "primary", "info", "success", "important", "warning", "danger"];
const alignment = ["left", "center", "right"];
const textAlignment = [...alignment, "start", "end", "justify"];
const boolean = ["true", "false"];
const length = /^\d+(?:\.\d+)?(?:px|ch|em|rem|%|vw|vh)?$/;
const text = /^[^\u0000-\u001f{}]{1,256}$/;
const name = /^[a-z][a-z0-9-]{0,47}$/;
const width = { align: alignment, width: length };
const card = { ...width, description: text, accent: accents, "text-align": textAlignment };
const callout = { collapsible: boolean, open: boolean, background: ["quote", "quiet", "raised", "none"], "border-left-width": length };
const schemas = new Map([
  ["box", { ...width, surface: surfaces, padding: length, "text-align": textAlignment }],
  ["card", { ...card, icon: ["link", "file", "check", "info"] }],
  ["home-box", { ...card, surface: surfaces }],
  ["panel", { ...width, status: text, variant: ["default", "flat"], focus: boolean, accent: accents }],
  ...["note", "tip", "important", "warning", "caution", "info", "danger"].map((kind) => [kind, callout]),
]);

export function parseDocumentComponentHeader(source) {
  const visibleTitle = parseOrgEnvIdentityTitle("component", stripHiddenInlineTitle(source)).title;
  const { title, attrs } = splitDocumentWidgetAttrs(visibleTitle, ["kind", "use"]);
  const { kind, use, ...properties } = attrs;
  if (kind && !use && name.test(title) && schemas.has(kind)) {
    const defaults = validateComponentProperties(kind, properties);
    if (defaults) return { role: "definition", name: title, kind, defaults };
  }
  if (use && !kind && name.test(use)) return { role: "instance", name: use, title, properties };
  return null;
}

function validateComponentProperties(kind, properties) {
  const schema = schemas.get(kind);
  if (!schema) return null;
  const result = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!Object.hasOwn(schema, key)) return null;
    const rule = schema[key];
    const normalized = Array.isArray(rule) ? value.toLowerCase() : value;
    if (Array.isArray(rule) ? !rule.includes(normalized) : !rule.test(normalized)) return null;
    result[key] = normalized;
  }
  return result;
}

export function resolveDocumentComponent(source, definitions) {
  const parsed = parseDocumentComponentHeader(source);
  if (parsed?.role !== "instance") return null;
  const definition = definitions?.get(parsed.name);
  if (!definition) return null;
  const properties = validateComponentProperties(definition.kind, parsed.properties);
  if (!properties) return null;
  return { kind: definition.kind, title: parsed.title, attrs: { ...definition.defaults, ...properties } };
}

const declarationCandidate = /^#\+[ \t]*begin[ \t]+component\b/im;
const opening = /^ {0,3}#\+[ \t]*begin[ \t]+([a-z0-9_-]+)(?:[ \t]+(.*))?$/i;
const closing = /^ {0,3}#\+[ \t]*end[ \t]+([a-z0-9_-]+)[ \t]*$/i;
const fenceOpening = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** An empty top-level declaration supplies defaults to the current source document. */
export function collectDocumentComponents(source) {
  const definitions = new Map();
  if (!declarationCandidate.test(source)) return definitions;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let first = 0;
  if (/^---[ \t]*$/.test(lines[0])) {
    const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line));
    if (end > 0) first = end + 1;
  }
  const opened = [];
  const byKind = new Map();
  let fence = null;
  let comment = false;
  for (let index = first; index < lines.length; index++) {
    const line = lines[index];
    if (fence) {
      const match = fenceOpening.exec(line);
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
      continue;
    }
    if (comment) {
      if (line.includes("-->")) comment = false;
      continue;
    }
    if (/^ {0,3}<!--/.test(line)) {
      comment = !line.includes("-->");
      continue;
    }
    const code = fenceOpening.exec(line);
    if (code && (code[1][0] === "~" || !code[2].includes("`"))) {
      fence = code[1];
      continue;
    }
    const close = closing.exec(line);
    if (close) {
      const match = byKind.get(close[1].toLowerCase())?.pop();
      if (match) match.to = index;
    } else {
      const open = opening.exec(line);
      if (!open) continue;
      const kind = open[1].toLowerCase();
      const block = { kind, from: index, to: -1, title: open[2] ?? "" };
      const peers = byKind.get(kind) ?? [];
      peers.push(block);
      byKind.set(kind, peers);
      opened.push(block);
    }
  }
  // Only balanced outer blocks own their contents. In particular an example
  // opening inside raw HTML cannot keep subsequent declarations in scope.
  let through = -1;
  for (const { kind, from, to, title } of opened) {
    if (from <= through || to < 0) continue;
    through = to;
    if (kind !== "component" || !lines[from].startsWith("#+")) continue;
    const definition = parseDocumentComponentHeader(title);
    if (definition?.role === "definition" && !definitions.has(definition.name)
        && lines.slice(from + 1, to).every((line) => !line.trim())) {
      definitions.set(definition.name, definition);
    }
  }
  return definitions;
}
