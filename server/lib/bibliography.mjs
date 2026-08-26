import { readdir, readFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { scanInlineCommands } from "../../shared/command-syntax.mjs";
import { protectedCitationRanges } from "../../shared/bibliography-syntax.mjs";

const BIB_CACHE_LIMIT = 32;
const BIB_CACHE_BYTES = 16 * 1024 * 1024;
const SAFE_EXT = new Set([".md", ".markdown"]);
const INHERIT_FIELDS = new Set(["bib", "tags", "kind", "project", "source", "summary", "private", "css"]);
const META_BLOCK_RE = /^\s*#\+begin\s+meta\s*\r?\n([\s\S]*?)\r?\n\s*#\+end\s+meta\s*$/im;

let rootDir = "";
let version = 0;
let bibliographyProvider = null;
const bibCache = new Map();
let bibCacheBytes = 0;

function canonicalPath(value) {
  const absolute = resolve(String(value || ""));
  try {
    return realpathSync.native(absolute);
  } catch {
    // The target (for example an unsaved standalone note) may not exist yet,
    // while one of its parents is reached through a platform symlink such as
    // macOS `/var` -> `/private/var`. Canonicalize the nearest existing parent
    // so containment checks use one path identity for existing and live files.
    const tail = [];
    let parent = absolute;
    while (true) {
      const next = dirname(parent);
      if (next === parent) return absolute;
      tail.unshift(basename(parent));
      parent = next;
      try {
        return join(realpathSync.native(parent), ...tail);
      } catch {}
    }
  }
}

export function configureBibliography(options = {}) {
  rootDir = canonicalPath(options.root);
  clearBibliographyCache();
}

export function configureBibliographyProvider(provider = null) {
  bibliographyProvider = provider && typeof provider === "object" ? provider : null;
  clearBibliographyCache();
}

export function clearBibliographyCache() {
  bibCache.clear();
  bibCacheBytes = 0;
  version += 1;
}

export function bibliographyVersion() {
  return version;
}

function inside(file, root) {
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function rootRelative(file, base = rootDir) {
  return relative(base, file).replace(/\\/g, "/");
}

// Metadata is intentionally flat: Noema/YAML values used here are paths
// and scalar inheritance fields. Complex YAML remains Pandoc's responsibility.
function parseMeta(content) {
  const source = String(content || "").replace(/^\uFEFF/, "");
  const out = {};
  const addLines = (body) => {
    for (const line of String(body || "").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      out[key] = key !== "bib" && value.length >= 2
        && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]
        ? value.slice(1, -1)
        : value;
    }
  };
  const yaml = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (yaml) addLines(yaml[1]);
  const match = source.match(META_BLOCK_RE);
  if (match) addLines(match[1]);
  return out;
}

function splitList(value) {
  const items = [];
  let current = "";
  let quote = "";
  const source = String(value || "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      if (next === "," || next === "\\" || next === '"' || next === "'") {
        current += next;
        index += 1;
      } else current += char;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ",") {
      if (current.trim()) items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

async function effectiveMeta(file, content, seen = new Set(), allowedRoot = rootDir) {
  const current = parseMeta(content);
  const key = canonicalPath(file || rootDir);
  if (seen.has(key)) return { meta: current, bibSources: [], diagnostics: [`extend cycle at ${rootRelative(key, allowedRoot)}`] };
  seen.add(key);
  const diagnostics = [];
  const extend = String(current.extend || "").trim();
  let parentResult = { meta: {}, bibSources: [], diagnostics: [] };
  if (extend && file) {
    const parentFile = canonicalPath(resolve(dirname(key), extend));
    if (!inside(parentFile, allowedRoot)) {
      diagnostics.push(`extend is outside the allowed note root: ${extend}`);
    } else if (!SAFE_EXT.has(extname(parentFile).toLowerCase())) {
      diagnostics.push(`extend source is not a Markdown file: ${extend}`);
    } else {
      try {
        parentResult = await effectiveMeta(parentFile, await readFile(parentFile, "utf8"), seen, allowedRoot);
      } catch {
        diagnostics.push(`extend source not found: ${extend}`);
      }
    }
  }
  diagnostics.push(...parentResult.diagnostics);
  const parent = parentResult.meta;
  const merged = {};
  for (const [k, v] of Object.entries(parent)) if (INHERIT_FIELDS.has(k)) merged[k] = v;
  for (const [k, v] of Object.entries(current)) {
    if (k === "bib" && merged.bib) merged.bib = `${v}, ${merged.bib}`;
    else merged[k] = v;
  }
  // Keep each bibliography declaration tied to the file that declared it.
  // Resolving inherited raw paths relative to the child note silently points at
  // the wrong directory whenever an `extend` crosses a folder boundary.
  const ownBibSources = splitList(current.bib).map((raw) => ({
    raw,
    base: dirname(key),
    origin: key,
  }));
  return { meta: merged, bibSources: [...ownBibSources, ...parentResult.bibSources], diagnostics };
}

async function visibleBibFiles(file, content, metadataContent = content, requestedRoot = "", libraryRoot = rootDir) {
  const noteFile = canonicalPath(file || join(libraryRoot, "scratch.md"));
  // Noema explicitly supports opening a standalone Markdown file outside
  // the library. Its local `bib: ./...` declarations must work too, while
  // remaining confined to that note's directory unless the trusted caller
  // supplies a narrower project root.
  const allowedRoot = inside(noteFile, libraryRoot)
    ? libraryRoot
    : canonicalPath(requestedRoot || dirname(noteFile));
  if (!inside(noteFile, allowedRoot)) {
    return { files: [], diagnostics: ["standalone note is outside the allowed bibliography root"] };
  }
  const { bibSources, diagnostics } = await effectiveMeta(noteFile, metadataContent, new Set(), allowedRoot);
  // Every note gets a conventional local bibliography directory for free.
  // Explicit/inherited `bib:` declarations add sources; they are not required
  // for the common `<note directory>/bib/*.bib` layout.  A missing default is
  // normal and stays silent, while a missing explicitly declared path remains
  // diagnostic-worthy.
  const sources = [
    { raw: "./bib", base: dirname(noteFile), origin: noteFile, optional: true },
    ...bibSources.map((source) => ({ ...source, optional: false })),
  ];
  const files = [];
  const seenFiles = new Set();
  const addFile = (filePath) => {
    const canonical = canonicalPath(filePath);
    if (seenFiles.has(canonical)) return;
    seenFiles.add(canonical);
    const full = rootRelative(canonical, allowedRoot).replace(/\.bib$/i, "");
    const shortNamespace = basename(canonical).replace(/\.bib$/i, "");
    files.push({ file: canonical, namespace: full, shortNamespace, pathRoot: allowedRoot });
  };
  for (const declaration of sources) {
    const raw = declaration.raw;
    const source = canonicalPath(resolve(declaration.base, raw));
    if (!inside(source, allowedRoot)) {
      diagnostics.push(`bib source is outside the allowed note root: ${raw}`);
      continue;
    }
    try {
      const sourceStat = await stat(source);
      if (sourceStat.isFile()) {
        if (extname(source).toLowerCase() !== ".bib") {
          diagnostics.push(`bib source is not a .bib file: ${raw}`);
          continue;
        }
        addFile(source);
        continue;
      }
      if (!sourceStat.isDirectory()) {
        diagnostics.push(`bib source is neither a directory nor .bib file: ${raw}`);
        continue;
      }
      const entries = (await readdir(source, { withFileTypes: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".bib") continue;
        addFile(join(source, entry.name));
      }
    } catch {
      if (!declaration.optional) diagnostics.push(`bib source not found: ${raw}`);
    }
  }
  return { files, diagnostics };
}

function skipSpaces(source, pos) {
  while (pos < source.length && /\s/.test(source[pos])) pos += 1;
  return pos;
}

function readBalanced(source, pos, open, close) {
  if (source[pos] !== open) return null;
  let depth = 0;
  let braceDepth = 0;
  let quote = "";
  for (let i = pos; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\" && i + 1 < source.length) i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    // TeX accents such as {\"o} are ubiquitous in BibTeX.  Their escaped
    // quote is data, not the beginning of a quoted BibTeX value.
    if (ch === "\\" && i + 1 < source.length) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      quote = ch;
      continue;
    }
    // With parenthesized entries, parentheses inside a braced field value are
    // protected and must not alter the outer entry depth.
    if (open === "(") {
      if (ch === "{") { braceDepth += 1; continue; }
      if (ch === "}" && braceDepth > 0) { braceDepth -= 1; continue; }
      if (braceDepth > 0) continue;
    }
    if (ch === open) depth += 1;
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return { text: source.slice(pos + 1, i), end: i + 1 };
    }
  }
  return null;
}

function readQuoted(source, pos) {
  const quote = source[pos];
  if (quote !== '"' && quote !== "'") return null;
  let out = "";
  for (let i = pos + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\" && i + 1 < source.length) {
      out += ch + source[i + 1];
      i += 1;
      continue;
    }
    if (ch === quote) return { text: out, end: i + 1 };
    out += ch;
  }
  return null;
}

const BIB_ACCENT_MARKS = {
  "\"": "\u0308",
  "'": "\u0301",
  "`": "\u0300",
  "^": "\u0302",
  "~": "\u0303",
  "=": "\u0304",
  ".": "\u0307",
  u: "\u0306",
  v: "\u030C",
  H: "\u030B",
  c: "\u0327",
  k: "\u0328",
  r: "\u030A",
};

function decodeBibTeXText(value) {
  return String(value || "")
    .replace(/\{?\\(["'`^~=\.uvHckr])\s*\{?([A-Za-z])\}?\}?/g,
      (_match, accent, letter) => `${letter}${BIB_ACCENT_MARKS[accent] || ""}`.normalize("NFC"))
    .replace(/\\(ae|AE|oe|OE|aa|AA|o|O|l|L|ss)\b(?:\{\})?/g, (_match, name) => ({
      ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", aa: "å", AA: "Å",
      o: "ø", O: "Ø", l: "ł", L: "Ł", ss: "ß",
    })[name] || name);
}

function cleanBibValue(value) {
  return decodeBibTeXText(value)
    .trim()
    .replace(/^["{]+|["}]+$/g, "")
    .replace(/[{}]/g, "")
    .replace(/\\&/g, "&")
    .replace(/\\_/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function bibValuePart(value) {
  return decodeBibTeXText(value)
    .replace(/[{}]/g, "")
    .replace(/\\&/g, "&")
    .replace(/\\_/g, "_");
}

function readBibValueAtom(source, start) {
  const pos = skipSpaces(source, start);
  if (pos >= source.length) return null;
  if (source[pos] === "{") {
    const parsed = readBalanced(source, pos, "{", "}");
    return parsed ? { part: { kind: "literal", text: parsed.text }, end: parsed.end } : null;
  }
  if (source[pos] === '"') {
    const parsed = readQuoted(source, pos);
    return parsed ? { part: { kind: "literal", text: parsed.text }, end: parsed.end } : null;
  }
  let end = pos;
  while (end < source.length && source[end] !== "#" && source[end] !== ",") end += 1;
  const text = source.slice(pos, end).trim();
  return text ? { part: { kind: "bare", text }, end } : null;
}

function parseBibValueExpression(source, start) {
  const parts = [];
  let pos = start;
  while (pos < source.length) {
    const atom = readBibValueAtom(source, pos);
    if (!atom) return null;
    parts.push(atom.part);
    pos = skipSpaces(source, atom.end);
    if (source[pos] !== "#") break;
    pos = skipSpaces(source, pos + 1);
  }
  return { parts, end: pos };
}

function parseFields(body) {
  const comma = body.indexOf(",");
  if (comma < 0) return null;
  const key = body.slice(0, comma).trim();
  const fields = {};
  const diagnostics = [];
  let pos = comma + 1;
  while (pos < body.length) {
    pos = skipSpaces(body, pos);
    if (body[pos] === ",") { pos += 1; continue; }
    if (!body.slice(pos).trim()) break;
    const m = body.slice(pos).match(/^([A-Za-z][\w-]*)\s*=/);
    if (!m) {
      diagnostics.push(`invalid field syntax near ${JSON.stringify(body.slice(pos, pos + 40).trim())}`);
      break;
    }
    const name = m[1].toLowerCase();
    pos += m[0].length;
    const expression = parseBibValueExpression(body, pos);
    if (!expression) {
      diagnostics.push(`invalid value for field ${name}`);
      break;
    }
    fields[name] = expression.parts;
    pos = skipSpaces(body, expression.end);
    if (pos < body.length && body[pos] !== ",") {
      diagnostics.push(`expected comma after field ${name}`);
      break;
    }
  }
  return key ? { key, fields, diagnostics } : null;
}

function parseStringBody(body) {
  const source = String(body || "");
  const m = source.match(/^\s*([A-Za-z][\w-]*)\s*=\s*/);
  if (!m) return null;
  const expression = parseBibValueExpression(source, m[0].length);
  if (!expression || source.slice(expression.end).trim()) return null;
  return { key: m[1].toLowerCase(), parts: expression.parts };
}

const BIB_MONTHS = new Map(Object.entries({
  jan: "January", feb: "February", mar: "March", apr: "April",
  may: "May", jun: "June", jul: "July", aug: "August",
  sep: "September", oct: "October", nov: "November", dec: "December",
}));

function bibLocation(source, offset) {
  const before = source.slice(0, Math.max(0, offset));
  const lines = before.split("\n");
  return `offset ${offset} (line ${lines.length}, column ${(lines.at(-1)?.length || 0) + 1})`;
}

function scanBibRecords(source, diagnostics) {
  const records = [];
  for (let pos = 0; pos < source.length;) {
    if (source[pos] === "%") {
      const newline = source.indexOf("\n", pos + 1);
      pos = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source[pos] !== "@") { pos += 1; continue; }
    const match = source.slice(pos).match(/^@([A-Za-z]+)\s*([{(])/);
    if (!match) { pos += 1; continue; }
    const open = pos + match[0].length - 1;
    const parsed = readBalanced(source, open, match[2], match[2] === "{" ? "}" : ")");
    if (!parsed) {
      diagnostics.push(`Unclosed BibTeX entry near ${bibLocation(source, pos)}`);
      break;
    }
    records.push({ type: match[1].toLowerCase(), text: parsed.text, offset: pos, end: parsed.end });
    pos = parsed.end;
  }
  return records;
}

export function parseBibTeX(source) {
  const input = String(source || "");
  const entries = [];
  const diagnostics = [];
  const records = scanBibRecords(input, diagnostics);
  const stringDefinitions = new Map();
  for (const record of records) {
    if (record.type !== "string") continue;
    const string = parseStringBody(record.text);
    if (!string) {
      diagnostics.push(`Invalid BibTeX @string near ${bibLocation(input, record.offset)}`);
      continue;
    }
    if (stringDefinitions.has(string.key)) diagnostics.push(`Duplicate BibTeX string macro: ${string.key}`);
    stringDefinitions.set(string.key, { ...string, offset: record.offset });
  }
  const macroCache = new Map(BIB_MONTHS);
  const diagnosticSet = new Set(diagnostics);
  const addDiagnostic = (message) => {
    if (!diagnosticSet.has(message)) {
      diagnosticSet.add(message);
      diagnostics.push(message);
    }
  };
  const resolveParts = (parts, stack = []) => cleanBibValue(parts.map((part) => {
    if (part.kind === "literal") return bibValuePart(part.text);
    const raw = String(part.text || "").trim();
    const name = raw.toLowerCase();
    if (!/^[A-Za-z][\w-]*$/.test(raw)) return bibValuePart(raw);
    if (macroCache.has(name)) return macroCache.get(name);
    const definition = stringDefinitions.get(name);
    if (!definition) {
      addDiagnostic(`Unknown BibTeX string macro: ${raw}`);
      return raw;
    }
    if (stack.includes(name)) {
      addDiagnostic(`Cyclic BibTeX string macro: ${[...stack, name].join(" -> ")}`);
      return raw;
    }
    const value = resolveParts(definition.parts, [...stack, name]);
    macroCache.set(name, value);
    return value;
  }).join(""));

  // Resolve every definition up front so cycles and invalid forward references
  // are reported even when a particular macro is not used by the cited entry.
  for (const name of stringDefinitions.keys()) {
    if (!macroCache.has(name)) resolveParts([{ kind: "bare", text: name }]);
  }

  for (const record of records) {
    const type = record.type;
    if (type === "comment" || type === "preamble" || type === "string") continue;
    const fields = parseFields(record.text);
    if (!fields) {
      diagnostics.push(`Invalid BibTeX entry near ${bibLocation(input, record.offset)}`);
      continue;
    }
    for (const diagnostic of fields.diagnostics) {
      diagnostics.push(`${fields.key}: ${diagnostic}`);
    }
    const resolvedFields = Object.fromEntries(Object.entries(fields.fields)
      .map(([name, parts]) => [name, resolveParts(parts)]));
    entries.push({ type, key: fields.key, fields: resolvedFields, raw: input.slice(record.offset, record.end) });
  }
  return { entries, diagnostics };
}

async function readBibFile(file, namespace, shortNamespace, pathRoot = rootDir) {
  const st = await stat(file);
  const cached = bibCache.get(file);
  let parsed;
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    cached.usedAt = Date.now();
    parsed = cached.value;
  } else {
    const source = await readFile(file, "utf8");
    parsed = parseBibTeX(source);
    const old = bibCache.get(file);
    if (old) bibCacheBytes -= old.size;
    bibCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, usedAt: Date.now(), value: parsed });
    bibCacheBytes += st.size;
    while (bibCache.size > BIB_CACHE_LIMIT || bibCacheBytes > BIB_CACHE_BYTES) {
      const victim = [...bibCache.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      if (!victim) break;
      bibCache.delete(victim[0]);
      bibCacheBytes -= victim[1].size;
    }
  }
  // Cache only file parsing.  Namespace is declaration-specific and the same
  // canonical file may legitimately be reached through different metadata
  // contexts during the lifetime of the process.
  const entries = parsed.entries.map((entry) => ({
    ...entry,
    namespace,
    shortNamespace,
    file,
    path: rootRelative(file, pathRoot),
    id: `bib-${createHash("sha1").update(file).update("\0").update(entry.key).digest("hex")}`,
  }));
  return { file, path: rootRelative(file, pathRoot), namespace, shortNamespace, entries, diagnostics: parsed.diagnostics };
}

function authors(value) {
  return cleanBibValue(value)
    .split(/\s+and\s+/i)
    .map((name) => name.includes(",")
      ? name.split(",").map((x) => x.trim()).filter(Boolean).reverse().join(" ")
      : name.trim())
    .filter(Boolean);
}

export function formatBibEntry(entry, index = 0) {
  const f = entry?.fields || {};
  const a = authors(f.author || f.editor || "");
  const names = a.length > 2 ? `${a[0]} et al.` : a.join(" and ");
  const title = f.title || entry.key || "";
  const venue = f.journaltitle || f.journal || f.booktitle || f.publisher || "";
  const year = f.year || f.date || "";
  const pages = f.pages ? `, pp. ${f.pages}` : "";
  const doi = f.doi ? ` DOI: ${f.doi}.` : "";
  const url = f.url ? ` ${f.url}` : "";
  const head = index > 0 ? `[${index}] ` : "";
  return `${head}${names ? `${names}. ` : ""}${title ? `"${title}." ` : ""}${venue ? `${venue}. ` : ""}${year}${pages}.${doi}${url}`.replace(/\s+/g, " ").trim();
}

function namespaceMatches(files, namespace) {
  return files.filter((file) => file.namespace === namespace || file.shortNamespace === namespace);
}

function escapedAt(source, from) {
  let slashes = 0;
  for (let index = from - 1; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function citationScan(markdown) {
  const source = String(markdown || "");
  const ranges = protectedCitationRanges(markdown);
  const commands = scanInlineCommands(markdown, "cite").filter((command) =>
    !ranges.some((range) => command.fullFrom >= range.from && command.fullFrom < range.to));
  const starts = new Set(commands.map((command) => command.fullFrom));
  const diagnostics = [];
  for (const match of source.matchAll(/@@cite\b/gi)) {
    const from = match.index;
    if (escapedAt(source, from) || ranges.some((range) => from >= range.from && from < range.to) || starts.has(from)) continue;
    const lineEnd = source.indexOf("\n", from);
    const fragment = source.slice(from, lineEnd < 0 ? source.length : lineEnd);
    const open = fragment.match(/^@@cite(?:\([^)]*\))?[ \t]*\[/i);
    diagnostics.push(open
      ? `unclosed citation key list near ${bibLocation(source, from)}`
      : `malformed citation command near ${bibLocation(source, from)}`);
  }
  return { commands, diagnostics };
}

async function loadVisibleBibliographies(file, content, metadataContent, allowedRoot = "", libraryRoot = rootDir) {
  if (typeof bibliographyProvider?.load === "function" && bibliographyProvider.owns?.(file)) {
    try {
      const loaded = await bibliographyProvider.load({ file, metadataContent });
      const parsed = loaded.files;
      const shortCounts = new Map();
      for (const bib of parsed) shortCounts.set(bib.shortNamespace, (shortCounts.get(bib.shortNamespace) || 0) + 1);
      return {
        parsed,
        diagnostics: loaded.diagnostics,
        shortCounts,
        source: String(loaded.source || "kernel-bibliography"),
      };
    } catch {
      // Standalone/Server and a transient local kernel outage retain the Node
      // parser so citation rendering and export preflight remain available.
    }
  }
  const { files, diagnostics } = await visibleBibFiles(file, content, metadataContent, allowedRoot, libraryRoot);
  const results = await Promise.all(files.map(async (bib) => {
    try {
      return { value: await readBibFile(bib.file, bib.namespace, bib.shortNamespace, bib.pathRoot) };
    } catch (error) {
      return { error: `failed to read bibliography ${rootRelative(bib.file, bib.pathRoot)}: ${String(error?.message || error)}` };
    }
  }));
  const parsed = [];
  for (const result of results) {
    if (result.error) {
      diagnostics.push(result.error);
      continue;
    }
    const bib = result.value;
    parsed.push(bib);
    for (const diagnostic of bib.diagnostics || []) diagnostics.push(`${bib.path}: ${diagnostic}`);
    const keyCounts = new Map();
    for (const entry of bib.entries) keyCounts.set(entry.key, (keyCounts.get(entry.key) || 0) + 1);
    for (const [key, count] of keyCounts) {
      if (count > 1) diagnostics.push(`${bib.path}: duplicate BibTeX key: ${key}`);
    }
  }

  // A short namespace is export-safe only when it identifies exactly one
  // visible file.  Keep full namespaces intact while withholding ambiguous
  // aliases from the entry objects consumed by the LaTeX map builder.
  const shortCounts = new Map();
  for (const bib of parsed) shortCounts.set(bib.shortNamespace, (shortCounts.get(bib.shortNamespace) || 0) + 1);
  for (const bib of parsed) {
    if (shortCounts.get(bib.shortNamespace) > 1) {
      bib.entries = bib.entries.map((entry) => ({ ...entry, shortNamespace: "" }));
    }
  }
  return { parsed, diagnostics, shortCounts, source: "node-bibliography" };
}

export async function bibliographyForDocument(options = {}) {
  const file = String(options.file || "");
  const content = String(options.content || "");
  const metadataContent = typeof options.metadataContent === "string" ? options.metadataContent : content;
  const libraryRoot = rootDir;
  if (!libraryRoot) return { ok: false, message: "Bibliography root is not configured", entries: [], references: [], citations: [] };
  const scanned = citationScan(content);
  const commands = scanned.commands;
  if (commands.length === 0) {
    return { ok: true, version, entries: [], references: [], citations: [], namespaces: [], diagnostics: scanned.diagnostics };
  }
  const { parsed, diagnostics, source } = await loadVisibleBibliographies(file, content, metadataContent, options.allowedRoot, libraryRoot);
  diagnostics.push(...scanned.diagnostics);
  const namespaceList = parsed.map((bib) => ({
    namespace: bib.namespace,
    shortNamespace: bib.shortNamespace,
    file: bib.path,
    entries: bib.entries.length,
  }));
  const numbered = new Map();
  const citations = [];
  for (const command of commands) {
    const ns = command.switchValue.trim();
    const matches = namespaceMatches(parsed, ns);
    const sourceKeys = String(command.context || "").split(";").map((key) => key.trim());
    const cite = {
      from: command.fullFrom,
      to: command.fullTo,
      namespace: ns,
      keys: [],
      args: { ...(command.args || {}) },
      items: [],
      itemIds: [],
      numbers: [],
      diagnostics: [],
    };
    if (command.argsError) cite.diagnostics.push(command.argsError);
    let namespaceDiagnostic = "";
    if (!ns) namespaceDiagnostic = "citation namespace is required";
    else if (matches.length === 0) namespaceDiagnostic = `unknown bibliography namespace: ${ns}`;
    else if (matches.length > 1) namespaceDiagnostic = `ambiguous bibliography namespace: ${ns}`;
    if (namespaceDiagnostic) cite.diagnostics.push(namespaceDiagnostic);

    const seenKeys = new Map();
    for (const key of sourceKeys) {
      if (!key) {
        const item = { key: "", diagnostics: ["citation key is required"] };
        cite.items.push(item);
        cite.diagnostics.push(...item.diagnostics);
        continue;
      }
      if (seenKeys.has(key)) {
        const original = seenKeys.get(key);
        cite.items.push({ ...original, diagnostics: [...original.diagnostics], duplicate: true });
        continue;
      }
      cite.keys.push(key);
      const item = { key, diagnostics: [] };
      if (namespaceDiagnostic) {
        item.diagnostics.push(namespaceDiagnostic);
      } else {
        const found = matches[0].entries.filter((entry) => entry.key === key);
        if (found.length !== 1) {
          item.diagnostics.push(found.length > 1 ? `duplicate BibTeX key: ${key}` : `unknown BibTeX key: ${key}`);
        } else {
          const entry = found[0];
          if (!numbered.has(entry.id)) numbered.set(entry.id, numbered.size + 1);
          item.id = entry.id;
          item.entry = entry;
          item.number = numbered.get(entry.id);
          cite.itemIds.push(entry.id);
          cite.numbers.push(item.number);
        }
      }
      seenKeys.set(key, item);
      cite.items.push(item);
      cite.diagnostics.push(...item.diagnostics);
    }
    cite.diagnostics = [...new Set(cite.diagnostics)];
    citations.push(cite);
  }
  const byId = new Map(parsed.flatMap((bib) => bib.entries).map((entry) => [entry.id, entry]));
  const references = [...numbered.entries()].map(([id, number]) => {
    const entry = byId.get(id);
    return { id, number, entry, text: formatBibEntry(entry, number), links: bibLinks(entry) };
  });
  const entries = references.map((reference) => reference.entry).filter(Boolean);
  const hash = createHash("sha1").update(content).update("\0").update(metadataContent).digest("hex").slice(0, 12);
  return { ok: true, version, hash, namespaces: namespaceList, entries, references, citations, diagnostics: [...new Set(diagnostics)], source };
}

export async function bibliographyCompletions(options = {}) {
  const file = String(options.file || "");
  const content = String(options.content || "");
  const metadataContent = typeof options.metadataContent === "string" ? options.metadataContent : content;
  const namespace = String(options.namespace || "").trim();
  const prefix = String(options.prefix || "");
  const kind = String(options.kind || "keys");
  const libraryRoot = rootDir;
  const { parsed, diagnostics, shortCounts, source } = await loadVisibleBibliographies(file, content, metadataContent, options.allowedRoot, libraryRoot);
  const needle = String(prefix || "").toLowerCase();
  if (kind === "namespaces") {
    const seen = new Map();
    for (const bib of parsed) {
      if (shortCounts.get(bib.shortNamespace) === 1) {
        seen.set(bib.shortNamespace, { key: bib.shortNamespace, name: bib.shortNamespace, body: bib.shortNamespace, detail: bib.path });
      }
      seen.set(bib.namespace, { key: bib.namespace, name: bib.namespace, body: bib.namespace, detail: bib.path });
    }
    const items = [...seen.values()]
      .filter((item) => !needle || item.key.toLowerCase().includes(needle))
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, 24);
    return { ok: true, items, diagnostics: [...new Set(diagnostics)], source };
  }
  const matches = namespaceMatches(parsed, namespace);
  if (matches.length !== 1) {
    const reason = matches.length === 0
      ? `unknown bibliography namespace: ${namespace}`
      : `ambiguous bibliography namespace: ${namespace}`;
    return { ok: true, items: [], diagnostics: [...new Set([...diagnostics, reason])], source };
  }
  const keyCounts = new Map();
  for (const entry of matches[0].entries) keyCounts.set(entry.key, (keyCounts.get(entry.key) || 0) + 1);
  const items = matches[0].entries.filter((entry) => keyCounts.get(entry.key) === 1).map((entry) => {
    const f = entry.fields || {};
    const detail = [authors(f.author || "").join(", "), f.year || f.date, f.title].filter(Boolean).join(" · ");
    return { key: entry.key, name: entry.key, body: entry.key, detail, source: entry.path };
  });
  return {
    ok: true,
    items: items
      .filter((item) => !needle || `${item.key} ${item.detail}`.toLowerCase().includes(needle))
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, 24),
    diagnostics: [...new Set(diagnostics)],
    source,
  };
}

function bibLinks(entry) {
  const f = entry?.fields || {};
  const links = [];
  if (f.doi) links.push({ label: "DOI", href: /^https?:\/\//i.test(f.doi) ? f.doi : `https://doi.org/${f.doi}` });
  if (f.url) links.push({ label: "URL", href: f.url });
  for (const key of ["zotero", "zoteroselect", "zotero_select", "zotero-link", "zotero_link"]) {
    if (f[key]) links.push({ label: "Zotero", href: f[key] });
  }
  if (f.file) links.push({ label: "file", href: f.file });
  return links;
}

export function bibliographyPathWatchRelevant(file) {
  return extname(String(file || "")).toLowerCase() === ".bib";
}
