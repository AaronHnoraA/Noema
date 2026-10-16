// Math macro layers that belong to one note.
//
// The global macro set (resources/katex-macros, then the user's own file) is
// shared by every note. A note can add two layers of its own, both declared
// in its `#+begin meta` block:
//
//   #+begin meta
//   title: ...
//   macros-from: ../assignment.cls, notation.sty
//   #+begin macros
//   \newcommand{\Mon}{\operatorname{Mon}}
//   #+end macros
//   #+end meta
//
// `macros-from` names project files (.cls/.sty/.tex, relative to the note)
// whose definitions are imported, like a document class would; the `macros`
// block holds the note's own definitions, which win over everything else.
//
// Browser-safe and pure: the page, the Node host and LaTeX export share it.
// The scan reads only the meta block at the head of the note.

import { parseLatexMacros } from "./katex-macros.mjs";
import { ORG_META_PREAMBLE_LINE_LIMIT } from "./meta-summary.mjs";

export const NOTE_MACROS_FROM_KEY = "macros-from";
export const NOTE_MACRO_SOURCE_EXTENSIONS = /\.(?:cls|sty|tex)$/i;
export const NOTE_MACROS_FROM_LIMIT = 8;

const META_SCAN_LINE_LIMIT = 800;
const META_OPEN_RE = /^[ \t]*#\+\s*begin\s+meta(?:[ \t]+[^\r\n]*)?[ \t]*$/i;
const META_CLOSE_RE = /^[ \t]*#\+\s*end\s+meta[ \t]*$/i;
const MACROS_OPEN_RE = /^[ \t]*#\+\s*begin\s+macros[ \t]*$/i;
const MACROS_CLOSE_RE = /^[ \t]*#\+\s*end\s+macros[ \t]*$/i;
const NESTED_OPEN_RE = /^[ \t]*#\+\s*begin\s+(\S+)/i;
const NESTED_CLOSE_RE = /^[ \t]*#\+\s*end\s+(\S+)/i;
const MACROS_FROM_RE = /^[ \t]*macros-from[ \t]*:[ \t]*(.*?)[ \t]*$/i;

function unquote(value) {
  const text = String(value || "").trim();
  if (text.length >= 2 && ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'"))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Locate a note's macro declarations. Offsets are into `markdown`.
 *
 * @param {string} markdown
 */
export function noteMacroSpec(markdown) {
  const source = String(markdown || "");
  let cursor = 0;
  let lineNumber = 0;
  let metaFrom = -1;
  let metaCloseFrom = -1;
  let metaTo = -1;
  /** @type {{from:number,to:number,bodyFrom:number,bodyTo:number}|null} */
  let block = null;
  let blockOpen = null;
  let nested = "";
  /** @type {string[]} */
  let from = [];
  let fromLine = null;
  while (cursor <= source.length) {
    const newline = source.indexOf("\n", cursor);
    const lineEnd = newline < 0 ? source.length : newline;
    const next = newline < 0 ? source.length + 1 : newline + 1;
    const text = source.slice(cursor, lineEnd).replace(/\r$/, "");
    lineNumber++;
    if (metaFrom < 0) {
      if (META_OPEN_RE.test(text)) metaFrom = cursor;
      else if (lineNumber >= ORG_META_PREAMBLE_LINE_LIMIT) return null;
    } else if (blockOpen) {
      if (MACROS_CLOSE_RE.test(text)) {
        block = { from: blockOpen.from, to: Math.min(next, source.length), bodyFrom: blockOpen.bodyFrom, bodyTo: cursor };
        blockOpen = null;
      }
    } else if (nested) {
      const close = NESTED_CLOSE_RE.exec(text);
      if (close && close[1].toLowerCase() === nested) nested = "";
    } else if (META_CLOSE_RE.test(text)) {
      metaCloseFrom = cursor;
      metaTo = Math.min(next, source.length);
      break;
    } else if (MACROS_OPEN_RE.test(text)) {
      if (!block) blockOpen = { from: cursor, bodyFrom: Math.min(next, source.length) };
    } else {
      const open = NESTED_OPEN_RE.exec(text);
      if (open) nested = open[1].toLowerCase();
      else {
        const match = MACROS_FROM_RE.exec(text);
        if (match && !fromLine) {
          fromLine = { from: cursor, to: lineEnd };
          from = match[1].split(",").map(unquote).filter(Boolean).slice(0, NOTE_MACROS_FROM_LIMIT);
        }
      }
    }
    if (metaFrom >= 0 && lineNumber >= META_SCAN_LINE_LIMIT) break;
    if (newline < 0) break;
    cursor = next;
  }
  if (metaFrom < 0 || metaTo < 0) return null;
  return {
    metaFrom,
    metaTo,
    metaCloseFrom,
    from,
    fromLine,
    block,
    text: block ? source.slice(block.bodyFrom, block.bodyTo) : "",
  };
}

/** The note's own `#+begin macros` definitions. */
export function parseNoteLocalMacros(markdown) {
  const spec = noteMacroSpec(markdown);
  if (!spec?.text.trim()) return { macros: {}, errors: [] };
  return parseLatexMacros([{ name: "#+begin macros", text: spec.text }]);
}

/**
 * A document class defines internals (`\@title`, `\if@...`) next to the math
 * notation it offers. Only plain-named definitions without `@` are notation.
 */
export function filterClassMacros(macros) {
  const kept = {};
  for (const [name, body] of Object.entries(macros || {})) {
    if (!/^\\[A-Za-z]+$/.test(name) || String(body).includes("@")) continue;
    kept[name] = body;
  }
  return kept;
}

/** Highest `#n` parameter a macro body uses. */
export function macroArity(body) {
  let arity = 0;
  for (const match of String(body || "").matchAll(/#([1-9])/g)) arity = Math.max(arity, Number(match[1]));
  return arity;
}

export function validMacroName(name) {
  return /^\\[A-Za-z]+$/.test(String(name || ""));
}

/** True when every `{` in BODY is closed, ignoring escaped braces. */
export function balancedMacroBody(body) {
  let depth = 0;
  const text = String(body || "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

export function serializeMacroDefinition(name, body) {
  const arity = macroArity(body);
  return `\\newcommand{${name}}${arity ? `[${arity}]` : ""}{${body}}`;
}

/** One `\newcommand` line per entry, in the given order. */
export function serializeMacroDefinitions(macros) {
  return Object.entries(macros || {}).map(([name, body]) => serializeMacroDefinition(name, body)).join("\n");
}

/**
 * The edit that makes MARKDOWN's local macro block hold MACROS: replace the
 * block body, add a block before `#+end meta`, or open a meta block at the
 * top. An empty set removes the block. Returns null when nothing changes.
 */
export function noteMacroBlockEdit(markdown, macros) {
  const source = String(markdown || "");
  const spec = noteMacroSpec(source);
  const body = serializeMacroDefinitions(macros);
  const empty = !body;
  if (spec?.block) {
    if (empty) return { from: spec.block.from, to: spec.block.to, insert: "" };
    const insert = `${body}\n`;
    if (source.slice(spec.block.bodyFrom, spec.block.bodyTo) === insert) return null;
    return { from: spec.block.bodyFrom, to: spec.block.bodyTo, insert };
  }
  if (empty) return null;
  const block = `#+begin macros\n${body}\n#+end macros\n`;
  if (spec) return { from: spec.metaCloseFrom, to: spec.metaCloseFrom, insert: block };
  return { from: 0, to: 0, insert: `#+begin meta\n${block}#+end meta\n\n` };
}
