export type AttrMap = Record<string, string>;

export type TrailingAttrs = {
  raw: string;
  attrs: AttrMap;
  from: number;
  to: number;
};

export type TrailingAttrsOptions = {
  allowWhitespace?: boolean;
  knownKeys?: readonly string[];
};

function cleanAttrValue(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

export function parseAttrArgs(raw = ""): AttrMap {
  const body = raw.trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  if (!body) return {};
  const out: AttrMap = {};
  for (const chunk of body.split(/[;,]/)) {
    const item = chunk.trim();
    if (!item) continue;
    const attrPattern = /([A-Za-z][\w-]*)(?:\s*[:=]\s*("[^"]*"|'[^']*'|.*?))?(?=\s+[A-Za-z][\w-]*(?:\s*[:=]|\s*$)|$)/g;
    let matched = false;
    for (const match of item.matchAll(attrPattern)) {
      matched = true;
      const key = match[1]!.toLowerCase();
      const value = cleanAttrValue(match[2] ?? key);
      if (key && value) out[key] = value;
    }
    if (matched) continue;
    const match = item.match(/^([A-Za-z][\w-]*)\s*[:=]\s*(.+)$/);
    if (match) {
      const key = match[1]!.toLowerCase();
      const value = cleanAttrValue(match[2]!);
      if (key && value) out[key] = value;
      continue;
    }
    const bare = item.match(/^([A-Za-z][\w-]*)$/);
    if (bare) {
      const key = bare[1]!.toLowerCase();
      out[key] = key;
    }
  }
  return out;
}

export function findSingleLineClose(text: string, open: number, closeChar: "]" | "}"): number {
  let bracketDepth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]!;
    // Skip over a whole inline/display math span so its `]` content does not
    // close the attribute block. Checked before the generic backslash escape.
    if (closeChar === "]" && ch === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) {
      const close = text[i + 1] === "[" ? "\\]" : "\\)";
      const start = i + 2;
      const found = text.indexOf(close, start);
      if (found >= 0 && !/[\n\r]/.test(text.slice(start, found))) {
        i = found + close.length - 1;
        continue;
      }
    }
    if (ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") return -1;
    if (closeChar === "]" && ch === "[") {
      bracketDepth++;
      continue;
    }
    if (ch === closeChar) {
      if (closeChar === "]" && bracketDepth > 0) {
        bracketDepth--;
        continue;
      }
      return i;
    }
  }
  return -1;
}

export function readTrailingAttrs(
  text: string,
  from: number,
  options: TrailingAttrsOptions = {},
): TrailingAttrs | null {
  let openBrace = from;
  if (options.allowWhitespace) {
    while (openBrace < text.length && (text[openBrace] === " " || text[openBrace] === "\t")) openBrace++;
  }
  if (text[openBrace] !== "{") return null;
  const closeBrace = findSingleLineClose(text, openBrace, "}");
  if (closeBrace < 0) return null;

  const raw = text.slice(openBrace, closeBrace + 1);
  const attrs = parseAttrArgs(raw);
  if (options.knownKeys?.length) {
    const allowed = new Set(options.knownKeys.map((key) => key.toLowerCase()));
    if (!Object.keys(attrs).some((key) => allowed.has(key))) return null;
  }

  return {
    raw,
    attrs,
    from: openBrace,
    to: closeBrace + 1,
  };
}
