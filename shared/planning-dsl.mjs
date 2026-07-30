import {
  findInlineCommandClose,
  parseCommandArgs,
  scanInlineCommands,
} from "./command-syntax.mjs";
import {
  TODO_CANON_KEYS,
  parseDateValue,
  parseDepRefs,
  parseDuration,
  parseRepeater,
} from "./planning-values.mjs";

export const PLANNING_KINDS = new Set(["todo", "itodo", "project", "milestone", "clock"]);

const TODO_PLANNING_KINDS = new Set(["todo", "itodo"]);
const TITLE_PLANNING_KINDS = new Set(["project", "milestone", "clock"]);

// Keys whose value grammar is checked at parse time. Anything not listed
// here (or in TODO_CANON_KEYS) is an unrecognized-key lint, not a hard
// error — a typo in an attr must never make a planning node disappear.
const DATE_VALUE_KEYS = new Set(["ddl", "due", "deadline", "sche", "scheduled", "start", "end", "finish", "date", "when", "done", "from", "to"]);
const DEP_REF_KEYS = new Set(["after", "dep", "blocks", "task"]);
const DURATION_KEYS = new Set(["effort"]);
const KNOWN_ATTR_KEYS = new Set([...TODO_CANON_KEYS, "from", "to", "note", "task"]);

function diagnosePlanningAttrs(attrs) {
  const diagnostics = [];
  for (const [key, rawValue] of Object.entries(attrs || {})) {
    const value = String(rawValue ?? "").trim();
    if (!value) continue;
    if (DATE_VALUE_KEYS.has(key)) {
      if (!parseDateValue(value)) diagnostics.push({ kind: "invalid-date", key, message: `Unparseable date in "${key}": ${value}` });
    } else if (key === "repeat" || key === "rep" || key === "every") {
      if (!parseRepeater(value)) diagnostics.push({ kind: "invalid-repeater", key, message: `Unparseable repeater in "${key}": ${value}` });
    } else if (key === "warn" || key === "lead") {
      if (!/^\d+\s*(d|day|days|w|week|weeks|m|month|months)?$/i.test(value)) {
        diagnostics.push({ kind: "invalid-lead-time", key, message: `Unparseable lead time in "${key}": ${value}` });
      }
    } else if (DURATION_KEYS.has(key)) {
      if (parseDuration(value) === null) diagnostics.push({ kind: "invalid-duration", key, message: `Unparseable duration in "${key}": ${value}` });
    } else if (DEP_REF_KEYS.has(key)) {
      if (parseDepRefs(value).length === 0) diagnostics.push({ kind: "invalid-dep-ref", key, message: `Empty dependency reference in "${key}"` });
    } else if (!KNOWN_ATTR_KEYS.has(key)) {
      diagnostics.push({ kind: "unknown-key", key, message: `Unrecognized planning key "${key}"` });
    }
  }
  return diagnostics;
}

function lineStartsFor(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineForIndex(lineStarts, index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (lineStarts[mid] <= index) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(0, hi) + 1;
}

function parseBlockAttrs(body) {
  const out = {};
  const lines = String(body || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const pair = trimmed.match(/^([A-Za-z][\w-]*)\s*[:=]\s*(.*?)\s*,?\s*$/);
    if (!pair) continue;
    out[pair[1].toLowerCase()] = pair[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function attrsFromRaw(raw) {
  if (!raw) return {};
  return raw.includes("\n") ? parseBlockAttrs(raw.replace(/^\s*\{|\}\s*$/g, "")) : parseCommandArgs(raw);
}

function nodeFromInline(command, text, lineStarts) {
  const line = lineForIndex(lineStarts, command.fullFrom);
  const lineStart = lineStarts[line - 1] || 0;
  const attrs = { ...(command.args || {}) };
  return {
    kind: command.name,
    status: command.switchValue || "",
    title: String(command.context || "").replace(/\\([\]\\])/g, "$1").trim(),
    attrs,
    attrsRaw: command.argsRaw || "",
    shape: "inline",
    span: {
      from: command.fullFrom,
      to: command.fullTo,
      line,
      column: command.fullFrom - lineStart + 1,
    },
    raw: text.slice(command.fullFrom, command.fullTo),
    diagnostics: diagnosePlanningAttrs(attrs),
  };
}

function kindMatchesWanted(kind, wanted) {
  if (!wanted) return true;
  if (wanted === "todo") return TODO_PLANNING_KINDS.has(kind);
  return kind === wanted;
}

function scanBlockPlanningCommands(text, lineStarts) {
  const nodes = [];
  const re = /@@([A-Za-z][\w-]*)(?:\(([^)\n]*)\))?[ \t]+\[/g;
  let match;
  while ((match = re.exec(text))) {
    const kind = match[1].toLowerCase();
    if (!PLANNING_KINDS.has(kind)) continue;
    const openBracket = re.lastIndex - 1;
    const closeBracket = findInlineCommandClose(text, openBracket, "]");
    if (closeBracket < 0) continue;
    let pos = closeBracket + 1;
    while (text[pos] === " " || text[pos] === "\t") pos++;
    if (text[pos] !== "{") continue;
    const openBrace = pos;
    const beforeBrace = text.slice(match.index, openBrace);
    if (!/\n/.test(text.slice(match.index, openBrace))) {
      const sameLineClose = findInlineCommandClose(text, openBrace, "}");
      if (sameLineClose >= 0) {
        re.lastIndex = sameLineClose + 1;
        continue;
      }
    }
    const tail = text.slice(openBrace + 1);
    const closeMatch = tail.match(/\n[ \t]*}/);
    if (!closeMatch || closeMatch.index === undefined) continue;
    const closeBrace = openBrace + 1 + closeMatch.index + closeMatch[0].lastIndexOf("}");
    const fullTo = closeBrace + 1;
    const attrsRaw = text.slice(openBrace, fullTo);
    const line = lineForIndex(lineStarts, match.index);
    const lineStart = lineStarts[line - 1] || 0;
    const attrs = attrsFromRaw(attrsRaw);
    const diagnostics = beforeBrace.trim()
      ? diagnosePlanningAttrs(attrs)
      : [{ kind: "malformed", message: "Missing planning command title" }];
    nodes.push({
      kind,
      status: match[2]?.trim() || "",
      title: text.slice(openBracket + 1, closeBracket).replace(/\\([\]\\])/g, "$1").trim(),
      attrs,
      attrsRaw,
      shape: "block",
      span: {
        from: match.index,
        to: fullTo,
        line,
        column: match.index - lineStart + 1,
      },
      raw: text.slice(match.index, fullTo),
      diagnostics,
    });
    re.lastIndex = fullTo;
  }
  return nodes;
}

function scanTitlePlanningCommands(text, lineStarts) {
  const nodes = [];
  const re = /@@(project|milestone|clock)(?:\(([^)\n]*)\))?[ \t]+/gi;
  let match;
  while ((match = re.exec(text))) {
    const kind = match[1].toLowerCase();
    if (!TITLE_PLANNING_KINDS.has(kind)) continue;
    const titleFrom = re.lastIndex;
    if (text[titleFrom] === "[") continue;
    const lineEnd = text.indexOf("\n", titleFrom);
    const headerEnd = lineEnd < 0 ? text.length : lineEnd;
    const openBrace = text.indexOf("{", titleFrom);
    if (openBrace < 0 || openBrace > headerEnd) continue;
    const title = text.slice(titleFrom, openBrace).trim();
    if (!title) continue;

    let fullTo = -1;
    let shape = "inline";
    const sameLineClose = findInlineCommandClose(text.slice(0, headerEnd), openBrace, "}");
    if (sameLineClose >= 0) {
      fullTo = sameLineClose + 1;
    } else {
      const tail = text.slice(openBrace + 1);
      const closeMatch = tail.match(/\n[ \t]*}/);
      if (!closeMatch || closeMatch.index === undefined) continue;
      const closeBrace = openBrace + 1 + closeMatch.index + closeMatch[0].lastIndexOf("}");
      fullTo = closeBrace + 1;
      shape = "block";
    }

    const attrsRaw = text.slice(openBrace, fullTo);
    const line = lineForIndex(lineStarts, match.index);
    const lineStart = lineStarts[line - 1] || 0;
    const attrs = attrsFromRaw(attrsRaw);
    nodes.push({
      kind,
      status: match[2]?.trim() || "",
      title,
      attrs,
      attrsRaw,
      shape,
      span: {
        from: match.index,
        to: fullTo,
        line,
        column: match.index - lineStart + 1,
      },
      raw: text.slice(match.index, fullTo),
      diagnostics: diagnosePlanningAttrs(attrs),
    });
    re.lastIndex = fullTo;
  }
  return nodes;
}

export function scanPlanningNodes(input, options = {}) {
  const text = String(input || "");
  const wanted = options.kind ? String(options.kind).toLowerCase() : "";
  const lineStarts = lineStartsFor(text);
  const blockLikeSpans = [];
  const inline = scanInlineCommands(text)
    .filter((cmd) => PLANNING_KINDS.has(cmd.name))
    .filter((cmd) => {
      let pos = cmd.fullTo;
      while (text[pos] === " " || text[pos] === "\t") pos++;
      const lineEnd = text.indexOf("\n", pos + 1);
      const sameLineEnd = lineEnd < 0 ? text.length : lineEnd;
      const sameLineClose = text[pos] === "{" ? findInlineCommandClose(text.slice(0, sameLineEnd), pos, "}") : -1;
      const blockLike = text[pos] === "{" && sameLineClose < 0;
      if (blockLike) blockLikeSpans.push({ from: cmd.fullFrom, to: pos + 1 });
      return !blockLike;
    })
    .map((cmd) => nodeFromInline(cmd, text, lineStarts));
  const blocks = [
    ...scanBlockPlanningCommands(text, lineStarts),
    ...scanTitlePlanningCommands(text, lineStarts),
  ];
  const blockSpans = [...blocks.map((node) => node.span), ...blockLikeSpans];
  const nodes = [
    ...inline.filter((node) => !blockSpans.some((span) => node.span.from >= span.from && node.span.to <= span.to)),
    ...blocks,
  ]
    .filter((node) => kindMatchesWanted(node.kind, wanted))
    .sort((a, b) => a.span.from - b.span.from || a.span.to - b.span.to);
  return nodes;
}

export function serializePlanningValue(value) {
  const text = String(value ?? "");
  if (!text) return "";
  return /[\s,;{}[\]"']/.test(text) ? JSON.stringify(text) : text;
}

export function serializeInlineAttrs(attrs) {
  const entries = Object.entries(attrs || {})
    .filter(([, value]) => String(value ?? "").trim());
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}=${serializePlanningValue(value)}`).join(", ")}}`;
}

export function serializeBlockAttrs(attrs) {
  const entries = Object.entries(attrs || {})
    .filter(([, value]) => String(value ?? "").trim());
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([key, value]) => `  ${key}: ${value}`).join("\n")}\n}`;
}

function replaceAttrsInRaw(raw, nextAttrsRaw) {
  const text = String(raw || "");
  const attrs = String(nextAttrsRaw || "");
  const bracket = text.indexOf("[");
  let pos = -1;
  if (bracket >= 0) {
    const close = findInlineCommandClose(text, bracket, "]");
    if (close < 0) return text;
    pos = close + 1;
    while (text[pos] === " " || text[pos] === "\t") pos++;
  } else {
    const titleFrom = text.match(/^@@[A-Za-z][\w-]*(?:\([^)\n]*\))?[ \t]+/)?.[0]?.length ?? -1;
    if (titleFrom < 0) return text;
    const lineEnd = text.indexOf("\n", titleFrom);
    const headerEnd = lineEnd < 0 ? text.length : lineEnd;
    pos = text.indexOf("{", titleFrom);
    if (pos < 0 || pos > headerEnd) return attrs ? `${text.trimEnd()} ${attrs}` : text;
  }
  if (text[pos] === "{") {
    if (text.includes("\n", pos)) return `${text.slice(0, pos).trimEnd()} ${attrs}`;
    const end = findInlineCommandClose(text, pos, "}");
    if (end >= 0) return `${text.slice(0, pos).trimEnd()}${attrs ? " " + attrs : ""}${text.slice(end + 1)}`;
  }
  return attrs ? `${text.trimEnd()} ${attrs}` : text;
}

export function patchPlanningNodeRaw(node, patch = {}) {
  const attrs = { ...(node?.attrs || {}) };
  for (const [key, value] of Object.entries(patch.attrs || {})) {
    if (value === null || value === undefined || value === false || String(value).trim() === "") delete attrs[key];
    else attrs[key] = value;
  }
  let raw = String(node?.raw || "");
  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    const status = String(patch.status || "").trim();
    const prefix = status ? `@@${node.kind}(${status}) ` : `@@${node.kind} `;
    raw = raw.replace(/^@@[A-Za-z][\w-]*(?:\([^)\n]*\))?[ \t]+/i, prefix);
  }
  const emptyAttrsRaw = TITLE_PLANNING_KINDS.has(String(node?.kind || "").toLowerCase()) ? "{}" : "";
  const nextAttrsRaw = node?.shape === "block" ? serializeBlockAttrs(attrs) : (serializeInlineAttrs(attrs) || emptyAttrsRaw);
  return replaceAttrsInRaw(raw, nextAttrsRaw);
}
