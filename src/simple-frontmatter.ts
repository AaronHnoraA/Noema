/**
 * Deliberately small Markdown-frontmatter compatibility layer.
 *
 * Noema's writable metadata model is `#+begin meta`. YAML is accepted at
 * byte zero for common Markdown fields, but nested maps, anchors, multiline
 * scalars and typed objects remain source-only. The parser is bounded and does
 * not pretend to be a general YAML implementation.
 */

export type SimpleFrontmatterValue = string | string[];

export type SimpleFrontmatter = {
  from: number;
  to: number;
  body: string;
  fields: Map<string, SimpleFrontmatterValue>;
  unsupported: boolean;
};

export const SIMPLE_FRONTMATTER_MAX_BYTES = 256 * 1024;
export const SIMPLE_FRONTMATTER_MAX_LINES = 1024;

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function flowList(value: string): string[] | null {
  const text = value.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  const body = text.slice(1, -1);
  const items: string[] = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quote) {
      current += char;
      if (char === "\\" && index + 1 < body.length) current += body[++index]!;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === ",") { if (current.trim()) items.push(unquote(current)); current = ""; continue; }
    current += char;
  }
  if (current.trim()) items.push(unquote(current));
  return items;
}

export function parseSimpleFrontmatter(source: string): SimpleFrontmatter | null {
  const text = String(source || "");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
  const firstBreak = text.indexOf("\n");
  let cursor = firstBreak + 1;
  let lineCount = 1;
  let closeFrom = -1;
  let closeTo = -1;
  while (cursor <= text.length && cursor <= SIMPLE_FRONTMATTER_MAX_BYTES && lineCount <= SIMPLE_FRONTMATTER_MAX_LINES) {
    const end = text.indexOf("\n", cursor);
    const lineTo = end < 0 ? text.length : end;
    const line = text.slice(cursor, lineTo).replace(/\r$/, "");
    lineCount += 1;
    if (line.trim() === "---") {
      closeFrom = cursor;
      closeTo = end < 0 ? lineTo : end + 1;
      break;
    }
    if (end < 0) break;
    cursor = end + 1;
  }
  if (closeFrom < 0) return null;

  const body = text.slice(firstBreak + 1, closeFrom);
  const fields = new Map<string, SimpleFrontmatterValue>();
  let unsupported = false;
  let listKey = "";
  for (const rawLine of body.split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    const listItem = /^\s{1,}-\s+(.+?)\s*$/.exec(rawLine);
    if (listItem && listKey) {
      const current = fields.get(listKey);
      const values = Array.isArray(current) ? current : [];
      values.push(unquote(listItem[1] ?? ""));
      fields.set(listKey, values);
      continue;
    }
    if (/^\s/.test(rawLine)) { unsupported = true; listKey = ""; continue; }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(rawLine);
    if (!pair) { unsupported = true; listKey = ""; continue; }
    const key = (pair[1] ?? "").toLowerCase();
    const rawValue = pair[2] ?? "";
    if (!rawValue) {
      fields.set(key, []);
      listKey = key;
      continue;
    }
    listKey = "";
    if (/^[>|&*!]/.test(rawValue) || /:\s/.test(rawValue)) {
      unsupported = true;
      continue;
    }
    const list = flowList(rawValue);
    fields.set(key, list ?? unquote(rawValue));
  }
  return { from: 0, to: closeTo, body, fields, unsupported };
}

export function simpleFrontmatterStrings(
  frontmatter: SimpleFrontmatter | null,
  key: string,
): string[] {
  const value = frontmatter?.fields.get(key.toLowerCase());
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (value == null) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}
