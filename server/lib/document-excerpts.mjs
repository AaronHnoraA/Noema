import MarkdownIt from "markdown-it";
import { parser as javascript } from "@lezer/javascript";

export const DOCUMENT_EXCERPT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 200;
const markdown = new MarkdownIt("commonmark");
const scriptParsers = new Map([
  ["javascript", javascript], ["js", javascript],
  ["typescript", javascript.configure({ dialect: "ts" })],
  ["jsx", javascript.configure({ dialect: "jsx" })],
  ["tsx", javascript.configure({ dialect: "jsx ts" })],
]);
scriptParsers.set("ts", scriptParsers.get("typescript"));
const scriptDeclarations = new Set(["FunctionDeclaration", "ClassDeclaration", "VariableDeclaration", "TypeAliasDeclaration",
  "InterfaceDeclaration", "EnumDeclaration", "MethodDeclaration", "NamespaceDeclaration"]);

export function documentAssetError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function splitLines(source) {
  let from = 0;
  const lines = [];
  for (const ending of source.matchAll(/\r\n|[\r\n]/g)) {
    lines.push({ from, to: ending.index });
    from = ending.index + ending[0].length;
  }
  if (from < source.length || !lines.length) lines.push({ from, to: source.length });
  return lines;
}

function lineSelection(spec, count) {
  if (!spec) return [0, count];
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(spec);
  const start = Number(match?.[1]);
  const end = Number(match?.[2] ?? match?.[1]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw documentAssetError("Use a line number or an ascending line range", 400);
  }
  if (start > count) throw documentAssetError("The requested lines are outside the file", 404);
  return [start - 1, Math.min(count, end)];
}

function regionSelection(lines, name) {
  const openRegion = /^\s*(?:(?:\/\/|;{1,}|--|<!--|\/\*)\s*)?#region\s+(.+?)(?:\s*(?:-->|\*\/))?\s*$/u;
  const closeRegion = /^\s*(?:(?:\/\/|;{1,}|--|<!--|\/\*)\s*)?#endregion\b/u;
  const noteMarker = /^\s*(?:--|#|\/\/|;+)[ \t]*@(?:noema|note-code|aaronnote)[ \t]+([^\s]+)\s*$/u;
  let start = -1;
  let depth = 0;
  for (const [index, line] of lines.entries()) {
    const region = openRegion.exec(line)?.[1];
    const marker = noteMarker.exec(line)?.[1];
    if (start < 0) {
      if (region !== name && marker !== name) continue;
      start = index + 1;
      depth = region === name ? 1 : 0;
    } else if (!depth && marker) return [start, index];
    else if (depth && region) depth++;
    else if (depth && closeRegion.test(line) && --depth === 0) return [start, index];
  }
  if (start < 0) throw documentAssetError(`Region not found: ${name}`, 404);
  return [start, lines.length];
}

function sectionSelection(source, lines, name) {
  const tokens = markdown.parse(source, {});
  let start = -1;
  let level = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "heading_open" || token.level !== 0 || !token.map) continue;
    const rank = Number(token.tag[1]);
    if (start >= 0 && rank <= level) return [start, token.map[0]];
    if (start >= 0) continue;
    const inline = tokens[index + 1];
    const title = inline.children?.map((child) => child.content).join("").trim();
    if (title === name || inline.content.trim() === name) {
      start = token.map[0];
      level = rank;
    }
  }
  if (start < 0) throw documentAssetError(`Heading not found: ${name}`, 404);
  return [start, lines.length];
}

function balancedLine(lines, first, offset, opener, closer, lisp) {
  let depth = 0;
  let quote = "";
  let blockComment = false;
  const limit = Math.min(lines.length, first + 100);
  for (let row = first; row < limit; row++) {
    const line = lines[row];
    for (let column = row === first ? offset : 0; column < line.length; column++) {
      const character = line[column];
      const pair = line.slice(column, column + 2);
      if (blockComment) {
        if (pair === "*/") { blockComment = false; column++; }
      } else if (quote) {
        if (character === "\\") column++;
        else if (character === quote) quote = "";
      } else if (lisp ? character === ";" : pair === "//") break;
      else if (!lisp && pair === "/*") { blockComment = true; column++; }
      else if (character === '"' || !lisp && (character === "'" || character === "`")) quote = character;
      else if (lisp && character === "\\") column++;
      else if (character === opener) depth++;
      else if (character === closer && --depth === 0) return row;
    }
  }
  return -1;
}

function scriptDefinitionRange(source, parser, name, offsets) {
  let definition = null;
  let priority = 0;
  parser.parse(source).iterate({ enter(ref) {
    if (!scriptDeclarations.has(ref.name)) return;
    const node = ref.node;
    const members = [...node.getChildren("VariableDefinition"), ...node.getChildren("TypeDefinition"), ...node.getChildren("PropertyDefinition")];
    if (!members.some((member) => source.slice(member.from, member.to) === name)) return;
    const score = ref.name === "FunctionDeclaration" && !node.getChild("Block") ? 1 : 2;
    if (score <= priority) return;
    priority = score;
    definition = node;
  } });
  if (!definition) return null;
  const lineAt = (position) => {
    let low = 0;
    let high = offsets.length;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (offsets[middle].from <= position) low = middle;
      else high = middle;
    }
    return low;
  };
  return [lineAt(definition.from), lineAt(Math.max(definition.from, definition.to - 1))];
}

function definitionSelection(source, lines, offsets, name, language, context) {
  const script = scriptParsers.get(language);
  if (script) {
    const span = scriptDefinitionRange(source, script, name, offsets);
    if (!span) throw documentAssetError(`Definition not found: ${name}`, 404);
    return [Math.max(0, span[0] - context), Math.min(lines.length, span[1] + context + 1)];
  }
  const quote = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`^\\s*\\(?(?:(?:export|default|async|pub(?:\\(crate\\))?|public|private|static|final)\\s+)*(?:defun|defmacro|defsubst|defvar|defcustom|defconst|cl-defun|cl-defmacro|cl-defstruct|defn|function|def|fn|func|class|struct|interface|type|const|let|var|enum|theorem|lemma|defalias)\\s+${quote}(?=$|[^\\p{L}\\p{N}_$!?-])`, "u");
  const index = lines.findIndex((line) => declaration.test(line));
  if (index < 0) throw documentAssetError(`Definition not found: ${name}`, 404);
  const lisp = /^(?:elisp|emacs-lisp|lisp|clojure|scheme)$/.test(language);
  const indentation = (line) => line.match(/^\s*/)[0].length;
  const base = indentation(lines[index]);
  let last = index;
  let startBrace = -1;
  let braceLine = index;
  if (!lisp && language !== "python") {
    for (let row = index; row < Math.min(index + 3, lines.length); row++) {
      if (row > index && declaration.test(lines[row])) break;
      startBrace = lines[row].indexOf("{");
      if (startBrace >= 0) { braceLine = row; break; }
      if (row > index && lines[row].trim() && indentation(lines[row]) <= base) break;
    }
  }
  const balanced = lisp ? balancedLine(lines, index, base, "(", ")", true)
    : startBrace >= 0 ? balancedLine(lines, braceLine, startBrace, "{", "}", false) : -1;
  if (balanced >= index) last = balanced;
  else {
    for (let row = index + 1; row < Math.min(index + 100, lines.length); row++) {
      if (!lines[row].trim()) continue;
      if (indentation(lines[row]) <= base) break;
      last = row;
    }
  }
  return [Math.max(0, index - context), Math.min(lines.length, last + context + 1)];
}

export function selectDocumentExcerpt(source, request, language) {
  const incoming = Object.fromEntries(["lines", "region", "section", "symbol"].map((key) => [key, String(request[key] ?? "").trim()]));
  const selectors = Object.keys(incoming).filter((key) => incoming[key]);
  if (selectors.length > 1) throw documentAssetError("Choose one of lines, region, section, or symbol", 400);
  const offsets = splitLines(source);
  const lines = offsets.map(({ from, to }) => source.slice(from, to));
  const context = Number(request.context ?? 0);
  if (!Number.isSafeInteger(context) || context < 0 || context > 40) throw documentAssetError("Context must be between 0 and 40 lines", 400);
  let range;
  if (incoming.region) range = regionSelection(lines, incoming.region);
  else if (incoming.section) range = sectionSelection(source, lines, incoming.section);
  else if (incoming.symbol) range = definitionSelection(source, lines, offsets, incoming.symbol, language, context);
  else range = lineSelection(incoming.lines, lines.length);
  const [from, requestedEnd] = range;
  const to = Math.min(requestedEnd, from + MAX_LINES);
  const body = from < to ? source.slice(offsets[from].from, offsets[to - 1].to) : "";
  return { body, startLine: from + 1, endLine: Math.max(from + 1, to), totalLines: lines.length, truncated: to < requestedEnd, language };
}
