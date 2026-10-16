// The user's own global math macros.
//
// `resources/katex-macros/` is the shared, versioned macro set and is edited
// as files. The user's additions are a separate layer, managed from the
// formula palette and kept in Noema's user configuration directory as one
// ordinary `.tex` file, so the Emacs preview and LaTeX export read the same
// definitions. User macros override shared ones of the same name.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseLatexMacros } from "../../shared/katex-macros.mjs";
import {
  balancedMacroBody,
  filterClassMacros,
  serializeMacroDefinitions,
  validMacroName,
} from "../../shared/note-macros.mjs";
import { noemaAppConfigDir } from "./app-config.mjs";

export const USER_KATEX_MACROS_FILE_NAME = "katex-macros.tex";
export const USER_KATEX_MACROS_LIMIT = 500;
export const USER_KATEX_MACRO_BODY_LIMIT = 2000;
export const MACRO_SOURCE_BYTES_LIMIT = 1024 * 1024;

const HEADER = [
  "% Noema user math macros.",
  "% Managed from the formula palette's macro tab; editing by hand is fine.",
  "% Shared macros live in resources/katex-macros/; these override them.",
].join("\n");

export function userKatexMacrosFile(options = {}) {
  return join(noemaAppConfigDir(options), USER_KATEX_MACROS_FILE_NAME);
}

export async function loadUserKatexMacros(options = {}) {
  const file = userKatexMacrosFile(options);
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { file, macros: {}, errors: [{ file, message: String(error?.message || error) }] };
    }
  }
  const parsed = parseLatexMacros([{ name: USER_KATEX_MACROS_FILE_NAME, text }]);
  return { file, macros: parsed.macros, errors: parsed.errors };
}

/** Validate a `{ "\\name": "body" }` map from the page. Throws a 400 on bad input. */
export function normalizeUserKatexMacros(input) {
  const entries = input && typeof input === "object" && !Array.isArray(input) ? Object.entries(input) : null;
  const fail = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  };
  if (!entries) fail("Macros must be an object of name → body");
  if (entries.length > USER_KATEX_MACROS_LIMIT) fail(`At most ${USER_KATEX_MACROS_LIMIT} macros`);
  const macros = {};
  for (const [rawName, rawBody] of entries) {
    const name = String(rawName || "").trim();
    const body = String(rawBody ?? "");
    if (!validMacroName(name)) fail(`Invalid macro name: ${name || "(empty)"}`);
    if (body.length > USER_KATEX_MACRO_BODY_LIMIT) fail(`Macro ${name} is too long`);
    if (/[\r\n]/.test(body)) fail(`Macro ${name} must be on one line`);
    if (!balancedMacroBody(body)) fail(`Unbalanced braces in ${name}`);
    macros[name] = body;
  }
  return macros;
}

export async function saveUserKatexMacros(input, options = {}) {
  const macros = normalizeUserKatexMacros(input);
  const file = userKatexMacrosFile(options);
  await mkdir(dirname(file), { recursive: true });
  const body = serializeMacroDefinitions(macros);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${HEADER}\n${body ? `${body}\n` : ""}`, "utf8");
  await rename(temp, file);
  return loadUserKatexMacros(options);
}

// ---------------------------------------------------------------------------
// Project macro files named by a note's `macros-from`
// ---------------------------------------------------------------------------

const sourceCache = new Map();
const SOURCE_CACHE_LIMIT = 64;

/** Read a local macro source, cached by mtime and size. */
export async function readLocalMacroSource(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Not a file");
  if (info.size > MACRO_SOURCE_BYTES_LIMIT) throw new Error("File is larger than 1 MB");
  const key = `${info.mtimeMs}:${info.size}`;
  const hit = sourceCache.get(path);
  if (hit?.key === key) return hit.text;
  const text = await readFile(path, "utf8");
  sourceCache.delete(path);
  sourceCache.set(path, { key, text });
  while (sourceCache.size > SOURCE_CACHE_LIMIT) sourceCache.delete(sourceCache.keys().next().value);
  return text;
}

/**
 * Parse the files a note names in `macros-from`. READ resolves and reads one
 * name (relative to the note, through whichever file backend owns the note).
 */
export async function loadMacroSourceFiles(names, read) {
  const files = [];
  const errors = [];
  for (const raw of Array.isArray(names) ? names.slice(0, 8) : []) {
    const name = String(raw || "").trim();
    if (!name) continue;
    if (!/\.(?:cls|sty|tex)$/i.test(name)) {
      errors.push({ file: name, message: "macros-from accepts .cls, .sty and .tex files" });
      continue;
    }
    try {
      files.push({ name, text: await read(name) });
    } catch (error) {
      errors.push({ file: name, message: String(error?.message || error) });
    }
  }
  const parsed = parseLatexMacros(files);
  return { macros: filterClassMacros(parsed.macros), errors: [...errors, ...parsed.errors], files: files.map((file) => file.name) };
}
