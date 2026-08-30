import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { scanInlineCommands } from "../../shared/command-syntax.mjs";
import { REVISION_KINDS, revisionKind } from "../../shared/revision-kinds.mjs";

const DEFAULT_TEMPLATE = `\\documentclass[11pt]{article}
\\usepackage[a4paper,margin=1in]{geometry}
\\usepackage{amsmath,amssymb,amsthm,mathtools}
\\usepackage{CJKutf8}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\AtBeginDocument{\\begin{CJK*}{UTF8}{gbsn}}
\\AtEndDocument{\\end{CJK*}}

\\newtheorem{theorem}{Theorem}
\\newtheorem{lemma}{Lemma}
\\newtheorem{proposition}{Proposition}
\\newtheorem{corollary}{Corollary}
\\newtheorem{definition}{Definition}
\\theoremstyle{remark}
\\newtheorem{remark}{Remark}
\\newtheorem{example}{Example}

\\usepackage{aaronnote-macros}

\\title{ {{title}} }
\\date{ {{date}} }

\\begin{document}
\\maketitle

{{body}}

\\end{document}
`;

const ENV_MAP = new Map([
  ["definition", "definition"],
  ["define", "definition"],
  ["theorem", "theorem"],
  ["lemma", "lemma"],
  ["proposition", "proposition"],
  ["corollary", "corollary"],
  ["proof", "proof"],
  ["remark", "remark"],
  ["example", "example"],
]);

const COMMENT_BLOCKS = new Set(["comment", "summary", "note", "important", "warning", "attention"]);
const DISPLAY_MATH_OPEN_RE = /^\s*(?:\\\[|\$\$)\s*$/;
const DISPLAY_MATH_CLOSE_RE = /^\s*(?:\\\]|\$\$)\s*$/;
const CEIL_COMMAND_LINE_RE = /^\s*@@cell(?:[ \t]*\([^)\n]*\))?(?:[ \t]+\[[^\]\n]*\])?[ \t]*$/i;

const LATEX_TEXT_ESCAPES = new Map([
  ["\\", "\\textbackslash{}"],
  ["^", "\\textasciicircum{}"],
  ["~", "\\textasciitilde{}"],
  ["#", "\\#"], ["$", "\\$"], ["%", "\\%"], ["&", "\\&"],
  ["_", "\\_"], ["{", "\\{"], ["}", "\\}"],
]);

export function escapeLatexText(value) {
  // One pass over the source. Chained `replace` calls re-escaped the braces
  // that `\textbackslash{}` itself introduces, so a literal backslash in prose
  // reached the PDF as `\{}`.
  return String(value ?? "").replace(/[\\^~#$%&_{}]/g, (char) => LATEX_TEXT_ESCAPES.get(char));
}

export function escapeLatexUrl(value) {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/([%#{}])/g, "\\$1");
}

function inlineTokenAt(source, pos, options = {}) {
  const rest = source.slice(pos);
  let match = rest.match(/^\\\(([^\n]+?)\\\)/);
  if (match) return { length: match[0].length, latex: `\\(${match[1]}\\)` };

  match = rest.match(/^`([^`\n]+)`/);
  if (match) return { length: match[0].length, latex: `\\texttt{${escapeLatexText(match[1])}}` };

  match = rest.match(/^!\[([^\]\n]*)\]\(([^)\n]+)\)/);
  if (match) {
    const label = convertInline(match[1] || "image", { ...options, exportComments: false });
    return { length: match[0].length, latex: `\\href{${escapeLatexUrl(match[2])}}{${label}}` };
  }

  match = rest.match(/^\[([^\]\n]+)\]\(([^)\n]+)\)/);
  if (match) return {
    length: match[0].length,
    latex: `\\href{${escapeLatexUrl(match[2])}}{${convertInline(match[1], { ...options, exportComments: false })}}`,
  };

  match = rest.match(/^\*\*([^*\n]+)\*\*/);
  if (match) return { length: match[0].length, latex: `\\textbf{${convertInline(match[1], options)}}` };
  match = rest.match(/^__([^_\n]+)__/);
  if (match) return { length: match[0].length, latex: `\\textbf{${convertInline(match[1], options)}}` };
  match = rest.match(/^\*([^*\n]+)\*/);
  if (match) return { length: match[0].length, latex: `\\emph{${convertInline(match[1], options)}}` };
  match = rest.match(/^_([^_\n]+)_/);
  if (match) return { length: match[0].length, latex: `\\emph{${convertInline(match[1], options)}}` };
  return null;
}

function commandKeys(command) {
  const parts = String(command.context || "").split(";").map((key) => key.trim());
  if (parts.some((key) => !key)) return [];
  return [...new Set(parts)];
}

function citationMapValue(map, key) {
  return map instanceof Map ? map.get(key) : map[key];
}

function citationPrefixJoin(prefix, citation) {
  if (!prefix) return citation;
  const gap = /[([{\u00ab\u201c\u2018]$/.test(prefix) ? "" : " ";
  return `${escapeLatexText(prefix)}${gap}${citation}`;
}

function citationSuffixJoin(citation, suffix) {
  if (!suffix) return citation;
  const gap = /^[,.;:!?)}\]\u00bb\u201d\u2019]/.test(suffix) ? "" : " ";
  return `${citation}${gap}${escapeLatexText(suffix)}`;
}

export function citeLatex(command, options = {}) {
  const map = options.citationKeyMap || {};
  const namespace = String(command.switchValue || "").trim();
  const sourceKeys = commandKeys(command);
  if (!namespace || sourceKeys.length === 0) return "";
  const keys = sourceKeys.map((key) => String(citationMapValue(map, `${namespace}\0${key}`) || ""));
  // Citation groups are atomic: emitting only the resolvable subset silently
  // drops source-authored keys. A LaTeX-key collision is equally unsafe.
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) return "";
  const args = command.args && typeof command.args === "object" ? command.args : {};
  const locator = String(args.locator || args.page || args.pages || "").trim();
  const escapedLocator = escapeLatexText(locator);
  const opt = locator ? `[${locator.includes("]") ? `{${escapedLocator}}` : escapedLocator}]` : "";
  const citation = `\\cite${opt}{${keys.join(",")}}`;
  const prefixed = citationPrefixJoin(String(args.prefix || "").trim(), citation);
  return citationSuffixJoin(prefixed, String(args.suffix || "").trim());
}

export function isDisplayCommentCommand(command) {
  return command?.name === "comment"
    && String(command.switchValue || "").trim().toLowerCase() === "true";
}

export function revisionLatex(command, options = {}) {
  const args = command?.args && typeof command.args === "object" ? command.args : {};
  const original = String(command?.context || "").replace(/\\\]/g, "]").replace(/\\\\/g, "\\");
  const advice = String(args.advice || "").replace(/\\\\/g, "\\");
  const reason = String(args.reason || "").replace(/\\\\/g, "\\");
  const kind = revisionKind(command?.switchValue).id;
  const macro = options.marginSafe === false ? "aaronrevisioninline" : "aaronrevision";
  return `\\${macro}[${kind}]{${convertInline(original, options)}}{${convertInline(advice, options)}}{${convertInline(reason, options)}}`;
}

export function convertInline(text, options = {}) {
  const source = String(text ?? "").trim();
  const annotations = scanInlineCommands(source)
    .filter((command) => command.name === "todo" || command.name === "itodo" || command.name === "comment" || command.name === "scomment" || command.name === "revision" || command.name === "cite" || command.name === "latexmk");
  let annotationIndex = 0;
  let latex = "";
  let plain = "";
  const flushPlain = () => {
    latex += escapeLatexText(plain);
    plain = "";
  };
  for (let pos = 0; pos < source.length;) {
    while (annotationIndex < annotations.length && annotations[annotationIndex].fullTo <= pos) annotationIndex++;
    const annotation = annotations[annotationIndex];
    if (annotation?.fullFrom === pos) {
      flushPlain();
      if (annotation.name === "scomment") {
        latex += `\\sidecomment{${convertInline(annotation.context, options)}}`;
      } else if (annotation.name === "revision") {
        latex += revisionLatex(annotation, options);
      } else if (annotation.name === "comment" && options.exportComments !== false) {
        // Keep inline review context in exported LaTeX instead of silently
        // dropping it. `comment(true)` still controls the editor's prominent
        // presentation, while both forms use the same export macro.
        latex += `\\aaroncomment{${convertInline(annotation.context, options)}}`;
      } else if (annotation.name === "todo" || annotation.name === "itodo") {
        // Review annotations reach the export. `convertInline` is also used for
        // moving arguments, where the margin form cannot be typeset.
        const title = convertInline(annotation.context, options);
        if (title) latex += options.marginSafe === false ? `\\aarontodoinline{${title}}` : `\\aarontodo{${title}}`;
      } else if (annotation.name === "cite") {
        latex += citeLatex(annotation, options);
      } else if (annotation.name === "latexmk" && annotation.switchValue.toLowerCase() === "newline") {
        // Explicit soft paragraph line break. Markdown source newlines remain
        // spaces inside a paragraph; blank lines remain paragraph boundaries.
        latex = `${latex.trimEnd()}\\\\\n`;
      }
      pos = annotation.fullTo;
      if (annotation.name === "latexmk" && annotation.switchValue.toLowerCase() === "newline") {
        while (source[pos] === " " || source[pos] === "\t") pos += 1;
      }
      annotationIndex++;
      continue;
    }
    const token = inlineTokenAt(source, pos, options);
    if (!token) {
      plain += source[pos];
      pos += 1;
      continue;
    }
    flushPlain();
    latex += token.latex;
    pos += token.length;
  }
  flushPlain();
  return latex;
}

function isPrivateAnnotationLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return false;
  if (CEIL_COMMAND_LINE_RE.test(trimmed)) return true;
  const command = scanInlineCommands(trimmed)[0];
  return Boolean(command
    && command.name === "comment"
    && !isDisplayCommentCommand(command)
    && command.fullFrom === 0
    && command.fullTo === trimmed.length);
}

function orgBlockOpen(line) {
  const match = String(line || "").match(/^#\+\s*begin\s+([A-Za-z0-9_-]+)\s*(.*)$/i);
  return match ? { kind: match[1].toLowerCase(), title: match[2].trim() } : null;
}

function orgBlockCloseKind(line) {
  const match = String(line || "").match(/^#\+\s*end\s+([A-Za-z0-9_-]+)\s*$/i);
  return match ? match[1].toLowerCase() : "";
}

// Titles, headings, and environment labels are LaTeX moving arguments, but
// inline math is still valid there. Escape prose while preserving Noema's
// canonical \(...\) math spans instead of turning their backslashes into text.
export function escapeLatexTitle(value, options = {}) {
  // Titles, headings, and environment labels are moving arguments, where a
  // margin note from todonotes cannot be typeset.
  return convertInline(value, { ...options, marginSafe: false }).replace(/\s+/g, " ").trim();
}

function parseMeta(lines) {
  const meta = {};
  let inMeta = false;
  for (const line of lines) {
    if (/^#\+begin\s+meta\s*$/i.test(line)) {
      inMeta = true;
      continue;
    }
    if (inMeta && /^#\+end\s+meta\s*$/i.test(line)) break;
    if (!inMeta) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) meta[match[1].toLowerCase()] = match[2].trim();
  }
  return meta;
}

function stripMeta(lines) {
  const out = [];
  let inMeta = false;
  for (const line of lines) {
    if (/^#\+begin\s+meta\s*$/i.test(line)) {
      inMeta = true;
      continue;
    }
    if (inMeta && /^#\+end\s+meta\s*$/i.test(line)) {
      inMeta = false;
      continue;
    }
    if (!inMeta) out.push(line);
  }
  return out;
}

function sectionCommand(level) {
  if (level <= 1) return "section";
  if (level === 2) return "subsection";
  if (level === 3) return "subsubsection";
  return "paragraph";
}

function beginEnv(kind, title, envMap = ENV_MAP, commentBlocks = COMMENT_BLOCKS) {
  const env = envMap.get(kind);
  if (env) {
    let label = title ? escapeLatexTitle(title) : "";
    if (kind === "proof" && label && !/^proof\b/i.test(title.trim())) {
      const direction = title.trim() === "=>"
        ? "\\(\\Rightarrow\\)"
        : title.trim() === "<="
          ? "\\(\\Leftarrow\\)"
          : label;
      label = `Proof (${direction})`;
    }
    label = label ? `[${label}]` : "";
    return `\\begin{${env}}${label}`;
  }
  if (commentBlocks.has(kind)) {
    const heading = title || kind;
    return `\\begin{remark}[${escapeLatexTitle(heading)}]`;
  }
  return `\\paragraph{${escapeLatexTitle(kind)}}${title ? ` ${convertInline(title)}` : ""}`;
}

function endEnv(kind, envMap = ENV_MAP, commentBlocks = COMMENT_BLOCKS) {
  const env = envMap.get(kind) || (commentBlocks.has(kind) ? "remark" : "");
  return env ? `\\end{${env}}` : "";
}

// Merge agent-maintained conversion rules over the built-in mapping. The base
// module stays pure; runtime.mjs reads the rules file and passes the parsed
// object in as `options.rules`. Shape: `{ envMap: {kind: env}, commentBlocks: [] }`.
function effectiveEnvMap(rules) {
  const extra = rules && typeof rules.envMap === "object" && rules.envMap ? rules.envMap : null;
  if (!extra) return ENV_MAP;
  const merged = new Map(ENV_MAP);
  for (const [rawKind, rawEnv] of Object.entries(extra)) {
    const kind = String(rawKind || "").trim().toLowerCase();
    const env = String(rawEnv || "").trim();
    if (kind && env) merged.set(kind, env);
  }
  return merged;
}

function effectiveCommentBlocks(rules) {
  const extra = rules && Array.isArray(rules.commentBlocks) ? rules.commentBlocks : null;
  if (!extra || extra.length === 0) return COMMENT_BLOCKS;
  const merged = new Set(COMMENT_BLOCKS);
  for (const raw of extra) {
    const kind = String(raw || "").trim().toLowerCase();
    if (kind) merged.add(kind);
  }
  return merged;
}

function flushParagraph(out, paragraph, options = {}) {
  if (paragraph.length === 0) return;
  let latex = "";
  for (let index = 0; index < paragraph.length; index += 1) {
    const entry = paragraph[index];
    const rendered = convertInline(entry.text, options);
    if (index > 0) {
      const previous = paragraph[index - 1];
      if (previous.hardBreak) {
        latex = `${latex.trimEnd()}\\\\\n`;
      } else {
        const previousTail = previous.text.trimEnd().at(-1) || "";
        const currentHead = entry.text.trimStart().at(0) || "";
        const cjkBoundary = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(previousTail)
          && /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[，。！？；：、）】》」』]/u.test(currentHead);
        if (!latex.endsWith("\n") && !cjkBoundary) latex += " ";
      }
    }
    latex += rendered;
  }
  out.push(latex);
  out.push("");
  paragraph.length = 0;
}

export function aaronnoteMarkdownToLatex(markdown, options = {}) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const meta = parseMeta(lines);
  const bodyLines = stripMeta(lines);
  const envMap = effectiveEnvMap(options.rules);
  const commentBlocks = effectiveCommentBlocks(options.rules);
  const out = [];
  const paragraph = [];
  const envStack = [];
  let inFence = false;
  let fenceLine = 0;
  let inDisplayMath = false;
  let displayMathLine = 0;
  let ignoredOrgBlock = "";
  let ignoredOrgDepth = 0;
  const listStack = [];

  function closeList() {
    while (listStack.length) out.push(`\\end{${listStack.pop().kind}}`, "");
  }

  function openList(kind, indent) {
    while (listStack.length && listStack.at(-1).indent > indent) {
      out.push(`\\end{${listStack.pop().kind}}`);
    }
    const current = listStack.at(-1);
    if (current?.indent === indent && current.kind === kind) return;
    if (current?.indent === indent) out.push(`\\end{${listStack.pop().kind}}`);
    listStack.push({ kind, indent });
    out.push(`\\begin{${kind}}`);
  }

  for (let lineIndex = 0; lineIndex < bodyLines.length; lineIndex += 1) {
    const rawLine = bodyLines[lineIndex];
    const lineNumber = lineIndex + 1;
    const trailingSpaces = rawLine.match(/ +$/)?.[0].length || 0;
    const line = rawLine.replace(/[ \t]+$/g, "");

    if (ignoredOrgBlock) {
      const nested = orgBlockOpen(line);
      if (nested?.kind === ignoredOrgBlock) ignoredOrgDepth += 1;
      if (orgBlockCloseKind(line) === ignoredOrgBlock) {
        ignoredOrgDepth -= 1;
        if (ignoredOrgDepth <= 0) ignoredOrgBlock = "";
      }
      continue;
    }

    if (/^```/.test(line)) {
      flushParagraph(out, paragraph, options);
      closeList();
      out.push(inFence ? "\\end{verbatim}" : "\\begin{verbatim}");
      inFence = !inFence;
      fenceLine = inFence ? lineNumber : 0;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    if (!inDisplayMath && DISPLAY_MATH_OPEN_RE.test(line)) {
      flushParagraph(out, paragraph, options);
      closeList();
      out.push("\\[");
      inDisplayMath = true;
      displayMathLine = lineNumber;
      continue;
    }
    if (inDisplayMath && DISPLAY_MATH_CLOSE_RE.test(line)) {
      out.push("\\]");
      inDisplayMath = false;
      displayMathLine = 0;
      continue;
    }
    if (inDisplayMath) {
      out.push(line);
      continue;
    }

    const begin = orgBlockOpen(line);
    if (begin) {
      flushParagraph(out, paragraph, options);
      closeList();
      const kind = begin.kind;
      if (kind === "lean4" || kind === "src" || kind === "source") {
        ignoredOrgBlock = kind;
        ignoredOrgDepth = 1;
        continue;
      }
      envStack.push(kind);
      out.push(beginEnv(kind, begin.title, envMap, commentBlocks), "");
      continue;
    }
    const end = orgBlockCloseKind(line);
    if (end) {
      flushParagraph(out, paragraph, options);
      closeList();
      const requestedKind = end;
      const kind = envStack.pop();
      if (!kind) {
        throw new Error(`Unexpected #+end ${requestedKind} on line ${lineNumber}`);
      }
      if (kind !== requestedKind) {
        throw new Error(`Mismatched Noema block on line ${lineNumber}: expected #+end ${kind}, found #+end ${requestedKind}`);
      }
      const close = endEnv(kind, envMap, commentBlocks);
      if (close) out.push(close, "");
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph(out, paragraph, options);
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(out, paragraph, options);
      closeList();
      const command = sectionCommand(heading[1].length);
      out.push(`\\${command}{${escapeLatexTitle(heading[2], options)}}`, "");
      continue;
    }

    const unordered = line.match(/^([ \t]*)[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph(out, paragraph, options);
      const indent = [...unordered[1]].reduce((sum, char) => sum + (char === "\t" ? 4 : 1), 0);
      openList("itemize", indent);
      out.push(`\\item ${convertInline(unordered[2], options)}`);
      continue;
    }

    const ordered = line.match(/^([ \t]*)\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph(out, paragraph, options);
      const indent = [...ordered[1]].reduce((sum, char) => sum + (char === "\t" ? 4 : 1), 0);
      openList("enumerate", indent);
      out.push(`\\item ${convertInline(ordered[2], options)}`);
      continue;
    }

    const quote = line.match(/^>\s*(.*)$/);
    if (quote) {
      flushParagraph(out, paragraph, options);
      closeList();
      out.push("\\begin{quote}", convertInline(quote[1], options), "\\end{quote}", "");
      continue;
    }

    if (isPrivateAnnotationLine(line)) {
      flushParagraph(out, paragraph, options);
      closeList();
      continue;
    }

    const slashBreak = /\\$/.test(line);
    paragraph.push({
      text: slashBreak ? line.slice(0, -1).trimEnd() : line,
      hardBreak: trailingSpaces >= 2 || slashBreak,
    });
  }

  flushParagraph(out, paragraph, options);
  closeList();
  if (inFence) throw new Error(`Unclosed Markdown code fence opened on line ${fenceLine}`);
  if (inDisplayMath) throw new Error(`Unclosed display math opened on line ${displayMathLine}`);
  if (envStack.length) throw new Error(`Unclosed Noema block: #+begin ${envStack.at(-1)}`);

  const body = out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  return {
    meta,
    body,
    features: {
      usesSideComment: body.includes("\\sidecomment{"),
    },
  };
}

// Canonical name for the deterministic base conversion. `aaronnoteMarkdownToLatex`
// is kept as an alias for callers and tests that predate the mechanical/codex split.
export const mechanicalConvert = aaronnoteMarkdownToLatex;

export function bibliographyReferencesToLatex(references = [], citationKeyById = {}) {
  const refs = Array.isArray(references) ? references : [];
  if (refs.length === 0) return "";
  const lines = ["", "\\begin{thebibliography}{99}"];
  for (const ref of refs) {
    const id = String(ref?.id || "");
    const key = citationKeyById[id] || id.replace(/[^A-Za-z0-9:_-]/g, "_");
    const text = String(ref?.text || "").replace(/^\[\d+\]\s*/, "");
    lines.push(`\\bibitem{${key}} ${escapeLatexText(text)}`);
  }
  lines.push("\\end{thebibliography}", "");
  return lines.join("\n");
}

export function applyLatexTemplate(template, vars) {
  const source = String(template || DEFAULT_TEMPLATE);
  return source.replace(/\{\{\s*([A-Za-z][\w-]*)\s*\}\}/g, (_m, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) throw new Error(`Unknown LaTeX template placeholder: {{${key}}}`);
    return String(vars[key] ?? "");
  });
}

export function latexMacrosPreamble(macros) {
  const lines = ["% Noema global math macros"];
  for (const [rawName, rawBody] of Object.entries(macros || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^\\[A-Za-z@]+$/.test(rawName)) continue;
    const body = String(rawBody ?? "");
    let argc = 0;
    for (const match of body.matchAll(/#([1-9])/g)) argc = Math.max(argc, Number(match[1]));
    const args = argc ? `[${argc}]` : "";
    // `provide` then `renew` works for both new names and LaTeX built-ins such
    // as \C and \vec, while preserving the KaTeX macro set as authoritative.
    lines.push(`\\providecommand{${rawName}}${args}{}`);
    lines.push(`\\renewcommand{${rawName}}${args}{${body}}`);
  }
  return lines.length > 1 ? `${lines.join("\n")}\n` : "";
}

export function latexSideCommentPreamble(enabled) {
  if (!enabled) return "";
  return String.raw`% Noema side comments
\makeatletter
\@ifpackageloaded{todonotes}{}{\usepackage[textsize=footnotesize]{todonotes}}
\makeatother
\providecolor{AaronSideCommentBackground}{HTML}{A94700}
\providecommand{\sidecomment}[1]{%
  \todo[fancyline,color=AaronSideCommentBackground,textcolor=white,linecolor=AaronSideCommentBackground,bordercolor=white]{#1}%
}

`;
}

// Annotation macros. `\todo` comes from todonotes, which
// `latexSideCommentPreamble` loads later in the same preamble; `\providecommand`
// does not expand its body, so definition order here does not matter.
export function latexAnnotationPreamble() {
  const lines = [
    "% Noema annotations",
    "\\providecolor{AaronDisplayComment}{HTML}{EC008C}",
    "\\providecommand{\\aaroncomment}[1]{%",
    "  \\textcolor{AaronDisplayComment}{\\textbf{COMMENT:}\\nobreakspace #1}%",
    "}",
    "\\providecolor{AaronTodo}{HTML}{E8730A}",
    "\\providecommand{\\aarontodo}[1]{%",
    "  \\todo[fancyline,color=AaronTodo,textcolor=white,linecolor=AaronTodo,bordercolor=white]{%",
    "    \\textbf{TODO:} #1}%",
    "}",
    // `\\todo` cannot appear in a moving argument or a tabular cell. The
    // preprocessor routes those contexts here so an annotated heading or table
    // still compiles instead of failing the whole export.
    "\\providecommand{\\aarontodoinline}[1]{%",
    "  \\textcolor{AaronTodo}{\\textbf{TODO:}\\nobreakspace #1}%",
    "}",
    "\\providecommand{\\sidecommentinline}[1]{%",
    "  \\textcolor{AaronSideCommentBackground}{\\textbf{NOTE:}\\nobreakspace #1}%",
    "}",
  ];
  for (const kind of REVISION_KINDS) {
    lines.push(`\\providecolor{AaronRev${kind.id}}{HTML}{${kind.latexColor}}`);
    lines.push(`\\providecommand{\\AaronRevLabel${kind.id}}{${kind.latexLabel}}`);
  }
  // Kept so a .tex exported before revision kinds existed still compiles
  // against a regenerated package.
  lines.push("\\providecolor{AaronRevision}{HTML}{6558D3}");
  // The suggestion and its reason move to the margin, next to todos and side
  // comments, so a reviewed document reads as one annotation column. The
  // underline stays inline because only a revision marks a span of text.
  lines.push(
    "\\providecommand{\\aaronrevision}[4][suggest]{%",
    "  \\textcolor{AaronRev#1}{\\uline{#2}}%",
    "  \\todo[fancyline,color=AaronRev#1,textcolor=white,linecolor=AaronRev#1,bordercolor=white]{%",
    "    \\textbf{\\csname AaronRevLabel#1\\endcsname:} #3\\ifstrempty{#4}{}{\\par\\textit{#4}}}%",
    "}",
    "\\providecommand{\\aaronrevisioninline}[4][suggest]{%",
    "  \\textcolor{AaronRev#1}{\\uline{#2}}%",
    "  \\textcolor{AaronRev#1}{\\nobreakspace\\textbf{\\csname AaronRevLabel#1\\endcsname:}\\nobreakspace #3%",
    "    \\ifstrempty{#4}{}{\\space\\textit{#4}}}%",
    "}",
  );
  return lines.join("\n");
}

export function latexMacrosPackage(macros, features = {}) {
  return [
    "\\NeedsTeXFormat{LaTeX2e}",
    "\\ProvidesPackage{aaronnote-macros}[2026/07/12 Noema shared macros]",
    "\\RequirePackage{graphicx}",
    "\\RequirePackage{booktabs,longtable,array,calc,etoolbox}",
    "\\RequirePackage{footnote}",
    "\\RequirePackage{needspace}",
    "\\RequirePackage[normalem]{ulem}",
    "\\RequirePackage{xcolor}",
    features.usesTikz ? "\\RequirePackage{tikz}" : "",
    String.raw`% Pandoc body compatibility
\makeatletter
\@ifundefined{c@none}{\newcounter{none}}{}
\patchcmd\longtable{\par}{\if@noskipsec\mbox{}\fi\par}{}{}
\makeatother
\makesavenoteenv{longtable}
\providecommand{\tightlist}{%
  \setlength{\itemsep}{0.2em}\setlength{\parskip}{0pt}}
\providecommand{\st}[1]{\sout{#1}}
\newsavebox{\AaronPandocBox}
\providecommand{\pandocbounded}[1]{%
  \sbox{\AaronPandocBox}{#1}%
  \ifdim\wd\AaronPandocBox>\linewidth
    \resizebox{\linewidth}{!}{\usebox{\AaronPandocBox}}%
  \else\usebox{\AaronPandocBox}\fi}

% Restrained academic page-flow defaults
\widowpenalty=10000
\clubpenalty=10000
\displaywidowpenalty=10000
\interfootnotelinepenalty=10000
\setlength{\emergencystretch}{2em}`,
    latexAnnotationPreamble(),
    latexMacrosPreamble(macros).trim(),
    // Keep this capability stable across every document in the same directory:
    // exporting a note without side comments must not make an older note fail.
    latexSideCommentPreamble(true).trim(),
    "\\endinput",
    "",
  ].filter(Boolean).join("\n\n");
}

// Shared LaTeX log lint. Undefined references/citations and missing characters
// are fatal: the PDF would be published with `??` markers or dropped glyphs.
// Overfull boxes and float pressure are layout warnings worth reporting.
export function latexLogDiagnostics(log) {
  const lines = String(log || "").split(/\r?\n/);
  const fatal = lines.filter((line) =>
    /LaTeX Warning: (?:Citation|Reference).+undefined|There were undefined references|There were undefined citations|Missing character: There is no/i.test(line),
  );
  const layout = lines.filter((line) =>
    /Overfull \\[hv]box|Float too large|Too many unprocessed floats/i.test(line),
  );
  return {
    fatal: [...new Set(fatal)].slice(-20),
    layout: [...new Set(layout)].slice(-20),
  };
}

// A single LaTeX pass leaves cross-references, the table of contents, and
// citation labels unresolved. Only rerun when the compiler says so.
export function latexNeedsAnotherPass(log) {
  return /Rerun to get (?:cross-references|the bibliography|outlines) right|Rerun LaTeX|Label\(s\) may have changed|No file .*\.toc/i.test(String(log || ""));
}

export async function readLatexTemplate(templatesRoot, templatePath = "") {
  const candidates = [];
  if (templatePath) candidates.push(resolve(templatePath));
  if (templatesRoot) {
    candidates.push(join(resolve(templatesRoot), "latex", "noema-article.tex"));
    candidates.push(join(resolve(templatesRoot), "tex", "noema-article.tex"));
    // Compatibility with exports configured before the Noema rename.
    candidates.push(join(resolve(templatesRoot), "latex", "aaronnote-article.tex"));
    candidates.push(join(resolve(templatesRoot), "tex", "aaronnote-article.tex"));
  }
  for (const candidate of candidates) {
    try {
      return { file: candidate, text: await readFile(candidate, "utf8") };
    } catch {}
  }
  return { file: "", text: DEFAULT_TEMPLATE };
}

export function defaultLatexOutputPath(sourceFile, title = "") {
  const file = resolve(String(sourceFile || "aaronnote-export.md"));
  const ext = extname(file);
  if (ext) return file.slice(0, -ext.length) + ".tex";
  const clean = String(title || "aaronnote-export").trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "aaronnote-export";
  return resolve(dirname(file), `${clean}.tex`);
}

export async function writeLatexExport(outputPath, latex) {
  const rawPath = String(outputPath || "").trim();
  if (!rawPath) throw new Error("Missing output path");
  const requested = resolve(rawPath);
  const file = requested.toLowerCase().endsWith(".tex") ? requested : `${requested}.tex`;
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, latex, "utf8");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return file;
}
