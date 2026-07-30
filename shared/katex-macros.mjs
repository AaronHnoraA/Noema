// Pure LaTeX-preamble → KaTeX macros parser.
//
// Shared by the Node server (web-host endpoint, scripts/render-html.mjs) and the
// browser bundle (re-exported from src/katex-macros.ts). MUST stay free of any
// node:* imports so it can be bundled for the editor.
//
// Supported definition forms (a practical subset that maps onto KaTeX's `macros`
// option, where a macro value is a string and arity is inferred from #1..#9):
//
//   \newcommand{\name}[argc][opt]{body}     (also \renewcommand, \providecommand,
//   \newcommand\name{body}                    and their starred variants)
//   \DeclareMathOperator{\name}{op}          → \operatorname{op}   (starred → *)
//   \def\name{body}  /  \def\name#1#2{body}
//
// KaTeX itself does not support \DeclareMathOperator or LaTeX optional-argument
// defaults; those are normalized/dropped here. Anything we cannot parse is
// recorded in `errors` instead of throwing.

const DEF_RE = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def)(\*?)/g;

// Strip TeX line comments (unescaped `%` to end of line) before scanning.
function stripComments(text) {
  const lines = String(text || "").split("\n");
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    let cut = -1;
    for (let k = 0; k < line.length; k++) {
      if (line[k] === "%" && line[k - 1] !== "\\") { cut = k; break; }
    }
    if (cut >= 0) lines[l] = line.slice(0, cut);
  }
  return lines.join("\n");
}

// Read a brace group. `text[i]` must be "{". Returns inner content (braces
// stripped, one level) and the index just past the closing "}", or null when
// unbalanced. Escaped braces (\{ \}) do not affect nesting.
function readGroup(text, i) {
  if (text[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") { j++; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { value: text.slice(i + 1, j), end: j + 1 };
    }
  }
  return null;
}

function skipSpace(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

// Read a macro name: either `{\name}` or a bare `\name`. Returns the name with
// its leading backslash (KaTeX macro keys keep the backslash) and the end index.
function readName(text, i) {
  i = skipSpace(text, i);
  if (text[i] === "{") {
    const g = readGroup(text, i);
    if (!g) return null;
    const name = g.value.trim();
    if (!/^\\[A-Za-z]+$|^\\.$/.test(name)) return null;
    return { name, end: g.end };
  }
  if (text[i] === "\\") {
    let j = i + 1;
    while (j < text.length && /[A-Za-z]/.test(text[j])) j++;
    if (j === i + 1) j = i + 2; // single non-letter control symbol, e.g. \,
    return { name: text.slice(i, j), end: j };
  }
  return null;
}

// Skip consecutive optional `[...]` groups (argc / default value).
function skipOptionals(text, i) {
  for (;;) {
    i = skipSpace(text, i);
    if (text[i] !== "[") break;
    const close = text.indexOf("]", i + 1);
    if (close < 0) break;
    i = close + 1;
  }
  return i;
}

/**
 * Parse LaTeX macro definitions from a list of `{ name, text }` files into a
 * KaTeX macros map.
 *
 * @param {{name: string, text: string}[]} files
 * @returns {{ macros: Record<string,string>, errors: {file:string, message:string}[] }}
 */
export function parseLatexMacros(files) {
  const macros = {};
  const errors = [];
  for (const file of Array.isArray(files) ? files : []) {
    const fileName = String(file?.name || "?");
    const text = stripComments(file?.text || "");
    DEF_RE.lastIndex = 0;
    let m;
    while ((m = DEF_RE.exec(text))) {
      const kind = m[1];
      const starred = m[2] === "*";
      let pos = DEF_RE.lastIndex;

      const named = readName(text, pos);
      if (!named) { errors.push({ file: fileName, message: `Missing macro name after \\${kind}` }); continue; }
      pos = named.end;

      let body;
      if (kind === "DeclareMathOperator") {
        const g = readGroup(text, skipSpace(text, pos));
        if (!g) { errors.push({ file: fileName, message: `Malformed \\DeclareMathOperator for ${named.name}` }); continue; }
        body = `\\operatorname${starred ? "*" : ""}{${g.value}}`;
        pos = g.end;
      } else if (kind === "def") {
        // Skip param text (e.g. #1#2) up to the body brace.
        let p = pos;
        while (p < text.length && text[p] !== "{") p++;
        const g = readGroup(text, p);
        if (!g) { errors.push({ file: fileName, message: `Malformed \\def for ${named.name}` }); continue; }
        body = g.value;
        pos = g.end;
      } else {
        pos = skipOptionals(text, pos);
        const g = readGroup(text, skipSpace(text, pos));
        if (!g) { errors.push({ file: fileName, message: `Malformed \\${kind} for ${named.name}` }); continue; }
        body = g.value;
        pos = g.end;
      }

      macros[named.name] = body;
      DEF_RE.lastIndex = pos;
    }
  }
  return { macros, errors };
}
