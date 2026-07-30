export const DEFAULT_LEAN_SELECTOR = "";

export function parseLeanPlaceholderLine(line) {
  const text = String(line ?? "");
  const match = /^([ \t]*)@@lean4(?:\(([^\n]*)\))?(?:[ \t]+(?:\[([^\]\n]+)\]|([A-Za-z0-9_.:-]+)))?[ \t]*$/.exec(text);
  if (!match) return null;
  const selector = normalizeLeanSelector(match[2] ?? "");
  const tag = String(match[3] ?? match[4] ?? "").trim();
  if (!tag) return null;
  const leading = match[1] ?? "";
  const commandFrom = leading.length;
  return {
    commandFrom,
    commandTo: text.trimEnd().length,
    selector,
    tag,
    bracketed: match[3] != null,
    bareTag: match[4] != null,
  };
}

export function formatLeanPlaceholder(selector, tag, leading = "") {
  const cleanSelector = normalizeLeanSelector(selector);
  const cleanTag = String(tag ?? "").trim();
  const prefix = cleanSelector ? `@@lean4(${cleanSelector})` : "@@lean4";
  return `${String(leading ?? "")}${prefix} [${cleanTag}]`;
}

export function normalizeLeanPlaceholderLine(line) {
  const parsed = parseLeanPlaceholderLine(line);
  if (!parsed) return null;
  const leading = String(line ?? "").slice(0, parsed.commandFrom);
  const normalized = formatLeanPlaceholder(parsed.selector, parsed.tag, leading);
  return normalized === String(line ?? "").trimEnd() ? null : normalized;
}

export function normalizeLeanSelector(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

export function isLeanNewfileSelector(selector) {
  const clean = normalizeLeanSelector(selector).toLowerCase();
  return clean === "newfile" || /^newfile:\d+$/.test(clean);
}

export function leanNewfileId(selector) {
  const clean = normalizeLeanSelector(selector).toLowerCase();
  if (clean === "newfile") return null;
  const match = /^newfile:(\d+)$/.exec(clean);
  if (!match) return null;
  return Number(match[1]);
}

export function canonicalLeanSelector(selector) {
  const clean = normalizeLeanSelector(selector);
  const id = leanNewfileId(clean);
  if (id === 0) return DEFAULT_LEAN_SELECTOR;
  if (id != null) return `newfile:${id}`;
  return clean;
}

export function scanMarkdownLeanPlaceholders(markdown) {
  const text = String(markdown ?? "");
  const out = [];
  let offset = 0;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const parsed = parseLeanPlaceholderLine(line);
    const lineFrom = offset;
    const lineTo = offset + line.length;
    if (parsed) {
      out.push({
        tag: parsed.tag,
        selector: canonicalLeanSelector(parsed.selector),
        rawSelector: parsed.selector,
        from: lineFrom + parsed.commandFrom,
        to: lineFrom + parsed.commandTo,
        lineFrom,
        lineTo,
        lineNo: index + 1,
      });
    }
    offset = lineTo + 1;
  }
  return out;
}
