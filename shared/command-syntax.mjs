function cleanAttrValue(value) {
  const clean = String(value || "").trim();
  if (clean.length >= 2 && (clean[0] === '"' || clean[0] === "'") && clean.at(-1) === clean[0]) {
    const quote = clean[0];
    return clean.slice(1, -1).replace(new RegExp(`\\\\${quote}`, "g"), quote);
  }
  return clean;
}

function splitArgChunks(body) {
  const chunks = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let nesting = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "{") nesting += 1;
    else if (ch === "}" && nesting > 0) nesting -= 1;
    if (ch === ";" && nesting === 0) {
      chunks.push(current);
      current = "";
      continue;
    }
    if (ch === "," && nesting === 0) {
      // Commas are often data in citation affixes/locators (`pp. 2, 4`).
      // Treat one as an argument separator only before another named field,
      // or in the historical bare-flag form (`done, pinned`).
      const currentHasAssignment = /[A-Za-z][\w-]*\s*[:=]/.test(current);
      const nextStartsAssignment = /^\s*[A-Za-z][\w-]*\s*[:=]/.test(body.slice(i + 1));
      if (!currentHasAssignment || nextStartsAssignment) {
        chunks.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  chunks.push(current);
  return chunks;
}

export function parseCommandArgs(raw = "") {
  const body = String(raw || "").trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  if (!body) return {};
  const out = {};
  for (const chunk of splitArgChunks(body)) {
    const item = chunk.trim();
    if (!item) continue;
    const bare = item.match(/^([A-Za-z][\w-]*)$/);
    if (bare) {
      out[bare[1].toLowerCase()] = bare[1].toLowerCase();
      continue;
    }
    const attrPattern = /([A-Za-z][\w-]*)\s*[:=]\s*("[^"]*"|'[^']*'|.*?)(?=\s+[A-Za-z][\w-]*\s*[:=]|$)/g;
    let matched = false;
    for (const match of item.matchAll(attrPattern)) {
      matched = true;
      const key = match[1].toLowerCase();
      const value = cleanAttrValue(match[2] ?? key);
      if (key && value) out[key] = value;
    }
    if (matched) continue;
    const pair = item.match(/^([A-Za-z][\w-]*)\s*[:=]\s*(.+)$/);
    if (pair) {
      const key = pair[1].toLowerCase();
      const value = cleanAttrValue(pair[2]);
      if (key && value) out[key] = value;
      continue;
    }
  }
  return out;
}

export function findInlineCommandClose(text, open, closeChar) {
  const openChar = text[open];
  let nestedDepth = 0;
  let quote = "";
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && i + 1 < text.length) i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    // Quotes delimit attribute values inside `{...}`. Apostrophes inside the
    // bracket command body remain ordinary citation/key text.
    if (closeChar === "}" && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }
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
    if (ch === openChar) {
      nestedDepth++;
      continue;
    }
    if (ch === closeChar) {
      if (nestedDepth > 0) {
        nestedDepth--;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function isEscapedCommandStart(text, from) {
  let slashes = 0;
  for (let index = from - 1; index >= 0 && text[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function metaRange(text, closeBracket) {
  let openBrace = closeBracket + 1;
  while (openBrace < text.length && (text[openBrace] === " " || text[openBrace] === "\t")) openBrace++;
  if (text[openBrace] !== "{") return { raw: "", fullTo: closeBracket + 1, error: "" };
  const closeBrace = findInlineCommandClose(text, openBrace, "}");
  return closeBrace < 0
    ? { raw: "", fullTo: closeBracket + 1, error: "unclosed command arguments" }
    : { raw: text.slice(openBrace, closeBrace + 1), fullTo: closeBrace + 1, error: "" };
}

function trailingMetaBeforeLineEnd(text, bodyFrom, lineEnd) {
  const line = text.slice(bodyFrom, lineEnd);
  const match = line.match(/[ \t]+(\{[^{}\n]*\})[ \t]*$/);
  if (!match || match.index === undefined) return { raw: "", bodyTo: lineEnd, fullTo: lineEnd };
  return {
    raw: match[1] || "",
    bodyTo: bodyFrom + match.index,
    fullTo: bodyFrom + match.index + match[0].length,
  };
}

export function scanInlineCommands(input, name = "") {
  const text = String(input || "");
  const commands = [];
  const wanted = String(name || "").toLowerCase();
  const push = (commandName, switchValue, contextFrom, contextTo, fullFrom, fullTo, argsRaw = "", argsError = "") => {
    if (wanted && commandName !== wanted) return;
    commands.push({
      name: commandName,
      switchValue,
      context: text.slice(contextFrom, contextTo),
      argsRaw,
      args: parseCommandArgs(argsRaw),
      argsError,
      fullFrom,
      fullTo,
      contextFrom,
      contextTo,
    });
  };

  // Marker-only commands still go through the shared command scanner.  Keep
  // this list deliberately small: unlike the bracket commands below, their
  // end is determined by the command name itself.
  const markerRe = /@@latexmk\(([^)\n]+)\)/gi;
  let markerMatch;
  while ((markerMatch = markerRe.exec(text))) {
    push("latexmk", markerMatch[1].trim(), markerMatch.index + markerMatch[0].length,
      markerMatch.index + markerMatch[0].length, markerMatch.index, markerRe.lastIndex);
  }

  const tagRe = /@@tag\[/gi;
  let tagMatch;
  while ((tagMatch = tagRe.exec(text))) {
    const open = tagRe.lastIndex - 1;
    const close = findInlineCommandClose(text, open, "]");
    if (close < 0) continue;
    push("tag", "", open + 1, close, tagMatch.index, close + 1);
    tagRe.lastIndex = close + 1;
  }

  // Cite completion accepts both `@@cite(ns) [key]` and the compact
  // `@@cite(ns)[key]`.  Keep the historical whitespace requirement for the
  // other bracket commands, whose no-space forms may be ordinary prose.
  const re = /@@([A-Za-z][\w-]*)(?:\(([^)\n]*)\))?([ \t]*)\[/g;
  let match;
  while ((match = re.exec(text))) {
    const commandName = match[1].toLowerCase();
    if (!match[3] && commandName !== "cite") continue;
    // A single (or otherwise odd) escaping backslash makes @@cite literal.
    // Even backslashes leave the command active, matching normal escaping
    // parity rather than rejecting every command preceded by a backslash.
    if (commandName === "cite" && isEscapedCommandStart(text, match.index)) continue;
    if (commandName === "latexmk") continue;
    const open = re.lastIndex - 1;
    const close = findInlineCommandClose(text, open, "]");
    if (close < 0) continue;
    const meta = metaRange(text, close);
    push(commandName, match[2]?.trim() ?? "", open + 1, close, match.index, meta.fullTo, meta.raw, meta.error);
    re.lastIndex = meta.fullTo;
  }

  const bareTodoRe = /@@(todo|itodo)(?:\(([^)\n]*)\))?[ \t]+(?!\[)([^\n]+)/gi;
  let bare;
  while ((bare = bareTodoRe.exec(text))) {
    const bodyFrom = bare.index + bare[0].length - bare[3].length;
    const lineEnd = bare.index + bare[0].length;
    const meta = trailingMetaBeforeLineEnd(text, bodyFrom, lineEnd);
    if (text.slice(bodyFrom, meta.bodyTo).trim()) {
      push(bare[1].toLowerCase(), bare[2]?.trim() ?? "", bodyFrom, meta.bodyTo, bare.index, meta.fullTo, meta.raw);
    }
    bareTodoRe.lastIndex = lineEnd;
  }

  return commands.sort((a, b) => a.fullFrom - b.fullFrom || a.fullTo - b.fullTo);
}

export function parseBlockCommandOpenLine(line) {
  const match = String(line || "").match(/^\s*#\+begin(?:_|\s+)([A-Za-z][\w-]*)(?:\s+([^\n]+?))?\s*$/i);
  return match ? { name: match[1].toLowerCase(), title: match[2]?.trim() ?? "" } : null;
}

export function isBlockCommandCloseLine(line, name) {
  const escaped = String(line || "").replace(/^(\s*)\\(?=#\+end)/i, "$1");
  return new RegExp(`^\\s*#\\+end(?:_|\\s+)${name}\\s*$`, "i").test(escaped);
}

export function parseBlockCommandText(text) {
  const source = String(text || "");
  const open = source.match(/^\s*#\+begin(?:_|\s+)([A-Za-z][\w-]*)(?:\s+([^\n]+?))?\s*\n/i);
  if (!open) return null;
  const name = open[1].toLowerCase();
  const lines = source.slice(open[0].length).replace(/\n$/, "").split(/\n/);
  if (!isBlockCommandCloseLine(lines.at(-1) ?? "", name)) return null;
  return {
    name,
    title: open[2]?.trim() ?? "",
    content: lines.slice(0, -1).join("\n").replace(/\n$/, ""),
  };
}
