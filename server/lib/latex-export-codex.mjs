// Codex-assisted LaTeX export polish.
//
// Pipeline: the Noema preprocessor + Pandoc produces a draft body;
// this module lets codex adjust that draft (formatting only, never prose), the
// server compiles the assembled document, and on failure feeds the log back to
// codex for a bounded number of retries. The assisted runtime requires a gated
// agent result; direct legacy callers can still inspect the verified draft.
//
// This module owns no runtime state: paths, the template-assembly closure, and
// resolved executable paths are all passed in, so it stays pure enough to test.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { LATEX_MARKS } from "../../shared/latex-marks.mjs";
import { latexLogDiagnostics, latexNeedsAnotherPass } from "./latex-export.mjs";
import { resolveProjectCapabilities, resolvedSkillsForRun } from "./noema-capabilities.mjs";

const execFileAsync = promisify(execFile);

export function codexAvailable(codexBin) {
  const bin = String(codexBin || "").trim();
  if (!bin) return false;
  // `executablePath` (runtime) resolves to an absolute path when found, else the
  // bare command name. Treat an existing file as available; a bare name is only
  // trusted when it contains no path separator (assumed to be on PATH).
  if (existsSync(bin)) return true;
  return !bin.includes("/");
}

// Backend-neutral alias (codex/claude/opencode all resolve to a bin path).
export const agentAvailable = codexAvailable;

// ---- Agent-maintained conversion rules -------------------------------------

export async function loadAgentRules(agentDir) {
  const dir = String(agentDir || "").trim();
  if (!dir) return null;
  try {
    const raw = await readFile(join(dir, "mechanical", "rules.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const envMap = parsed.envMap && typeof parsed.envMap === "object" ? parsed.envMap : {};
    const commentBlocks = Array.isArray(parsed.commentBlocks) ? parsed.commentBlocks : [];
    const hiddenBlocks = Array.isArray(parsed.hiddenBlocks) ? parsed.hiddenBlocks : [];
    const pandocExtensions = Array.isArray(parsed.pandocExtensions) ? parsed.pandocExtensions : [];
    if (Object.keys(envMap).length === 0 && commentBlocks.length === 0 && hiddenBlocks.length === 0 && pandocExtensions.length === 0) return null;
    return { envMap, commentBlocks, hiddenBlocks, pandocExtensions };
  } catch {
    return null;
  }
}

export async function recordPendingImprovement(pendingLogFile, entry) {
  const file = String(pendingLogFile || "").trim();
  if (!file) return;
  try {
    await mkdir(join(file, ".."), { recursive: true });
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {}
}

// ---- Prose fidelity check (heuristic, non-blocking) ------------------------

function proseWords(text) {
  let s = String(text ?? "");
  // Drop math, code, comments, and Noema todos before comparing words.
  s = s.replace(/\\\(.*?\\\)/gs, " ").replace(/\\\[.*?\\\]/gs, " ").replace(/\$\$.*?\$\$/gs, " ");
  s = s.replace(/```[\s\S]*?```/g, " ").replace(/\\begin\{verbatim\}[\s\S]*?\\end\{verbatim\}/g, " ");
  // Noema/Org control syntax is structure, not visible prose.  Keeping it
  // in the word bag made a faithful proof block look as though it had dropped
  // words such as "begin", "proof", "latexmk", and "newline".
  s = s.replace(/^\s*#\+(?:begin|end)\s+[^\n]*$/gim, " ");
  s = s.replace(/@@[A-Za-z][\w-]*(?:\([^\n)]*\))?(?:[ \t]+[^\s{\[]+)?(?:[ \t]*\[[^\]]*\])?(?:[ \t]*\{[^\n]*\})?/g, " ");
  s = s.replace(/%[^\n]*/g, " "); // LaTeX comments
  s = s.replace(/\\(?:begin|end)\{[^}]+\}/g, " "); // environment names are structure
  s = s.replace(/\\[A-Za-z@]+\s*(\[[^\]]*\])?/g, " "); // LaTeX command names + optional args
  s = s.replace(/[#+*_>`~^{}\\$&/=.,;:!?()\[\]|"'—–-]/g, " "); // markup + punctuation
  const words = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const counts = new Map();
  for (const w of words) {
    if (w.length < 2) continue; // ignore single chars / stray letters from commands
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return counts;
}

export function proseFidelityWarnings(sourceMarkdown, latexBody, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.08;
  const src = proseWords(sourceMarkdown);
  const out = proseWords(latexBody);
  let total = 0;
  let missing = 0;
  for (const [w, n] of src) {
    total += n;
    const have = out.get(w) || 0;
    if (have < n) missing += n - have;
  }
  let extra = 0;
  for (const [w, n] of out) {
    const had = src.get(w) || 0;
    if (n > had) extra += n - had;
  }
  const warnings = [];
  if (total > 0 && missing / total > threshold) {
    warnings.push(`fidelity: ~${missing}/${total} source words are missing from the LaTeX body (possible dropped/reworded text)`);
  }
  if (total > 0 && extra / total > threshold) {
    warnings.push(`fidelity: ~${extra} words in the LaTeX body are not in the source (possible added text)`);
  }
  return warnings;
}

function protectedPayloads(text) {
  const source = String(text || "");
  return {
    math: [...source.matchAll(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g)].map((match) => (match[1] ?? match[2] ?? "").replace(/\s+/g, "")),
    code: [...source.matchAll(/\\begin\{(verbatim\*?|Verbatim|BVerbatim|LVerbatim|SaveVerbatim|lstlisting|minted|Highlighting)\}([\s\S]*?)\\end\{\1\}|\\texttt\{((?:\\.|[^{}])*)\}|\\verb\*?(.)(.*?)\4/g)]
      .map((match) => (match[2] ?? match[3] ?? match[5] ?? "").replace(/^\n|\n$/g, "")),
    citations: [...source.matchAll(/\\cite(?:\[[^\]]*\])?\{([^}]+)\}/g)].map((match) => match[0]),
    resources: [...source.matchAll(/\\href\{((?:\\.|[^{}])*)\}|\\includegraphics(?:\[([^\]]*)\])?\{([^}]*)\}/g)]
      .map((match) => match[1] ?? `${match[3] || ""}\0${String(match[2] || "").match(/\balt\s*=\s*\{([^}]*)\}/)?.[1] || ""}`),
    anchors: [...source.matchAll(/\\(?:label|hypertarget)\{([^}]*)\}/g)].map((match) => match[1]),
    tikz: [...source.matchAll(/\\begin\{tikzpicture\}(?:\[[^\]]*\])?[\s\S]*?\\end\{tikzpicture\}/g)].map((match) => match[0]),
  };
}

function romanNumeral(value) {
  const table = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let number = Math.max(1, Number(value) || 1);
  let output = "";
  for (const [amount, symbol] of table) while (number >= amount) { output += symbol; number -= amount; }
  return output;
}

function listLabel(style, index) {
  const kind = /Alph/.test(style) ? "Alph" : /alph/.test(style) ? "alph" : /Roman/.test(style) ? "Roman" : /roman/.test(style) ? "roman" : "arabic";
  let value = kind === "alph" || kind === "Alph"
    ? String.fromCharCode((kind === "Alph" ? 65 : 97) + ((index - 1) % 26))
    : kind === "roman" || kind === "Roman"
      ? (kind === "Roman" ? romanNumeral(index).toUpperCase() : romanNumeral(index))
      : String(index);
  if (/\([^)]*(?:alph|roman|arabic)/i.test(style)) value = `(${value})`;
  else if (/(?:alph|roman|arabic)[^}]*\)/i.test(style)) value = `${value})`;
  else value = `${value}.`;
  return value;
}

function renderListLabels(text) {
  const stack = [];
  const output = [];
  for (const line of String(text || "").split("\n")) {
    const begin = line.match(/\\begin\{(enumerate|itemize|description)\}(?:\[([^\]]*)\])?/);
    if (begin) stack.push({ kind: begin[1], style: begin[2] || "arabic", count: 0 });
    const definition = line.match(/^\s*\\def\\labelenum\w+\{(.+)\}\s*$/);
    if (definition && stack.at(-1)?.kind === "enumerate") {
      stack.at(-1).style = definition[1];
      continue;
    }
    const item = line.match(/\\item(?:\[([^\]]*)\])?/);
    if (item && stack.length) {
      const current = stack.at(-1);
      current.count += 1;
      const label = item[1] || (current.kind === "enumerate" ? listLabel(current.style, current.count) : current.kind === "itemize" ? "•" : "");
      output.push(line.slice(0, item.index) + (label ? `${label} ` : "") + line.slice(item.index + item[0].length));
    } else output.push(line);
    const end = line.match(/\\end\{(enumerate|itemize|description)\}/);
    if (end && stack.at(-1)?.kind === end[1]) stack.pop();
  }
  return output.join("\n");
}

function structuralSignature(text) {
  const tokens = [];
  const pattern = /\\(begin|end)\{([^}]+)\}|\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*)?|\\item(?:\[([^\]]*)\])?|\\def\\labelenum\w+\{([^\n]+)\}|\\(footnote|caption)(\*)?/g;
  const structuralEnvironments = new Set(["enumerate", "itemize", "description", "theorem", "lemma", "proposition", "corollary", "definition", "remark", "example", "proof", "quote"]);
  for (const match of String(text || "").matchAll(pattern)) {
    if (match[1] && structuralEnvironments.has(match[2])) tokens.push(`${match[1]}:${match[2]}`);
    else if (match[3]) tokens.push(`heading:${match[3]}${match[4] || ""}`);
    else if (match[0].startsWith("\\item")) tokens.push(`item:${match[5] || ""}`);
    else if (match[6] != null) tokens.push(`enum-label:${match[6].replace(/\s+/g, "")}`);
    else if (match[7]) tokens.push(`${match[7]}${match[8] || ""}`);
  }
  let tableDepth = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/\\begin\{(?:longtable\*?|tabular\*?|tabularx|array)\}/.test(line)) tableDepth += 1;
    if (tableDepth > 0) {
      const separators = [...line.matchAll(/(?<!\\)&/g)].length;
      const rowEnd = /(?<!\\)\\\\(?:\[[^\]]*\])?\s*$/.test(line);
      if (separators > 0 || rowEnd) tokens.push(`table-row:${separators + 1}`);
    }
    if (/\\end\{(?:longtable\*?|tabular\*?|tabularx|array)\}/.test(line)) tableDepth = Math.max(0, tableDepth - 1);
  }
  return tokens;
}

function visibleContentSignature(text) {
  let source = renderListLabels(text);
  let resourceIndex = 0;
  let anchorIndex = 0;
  let codeIndex = 0;
  let mathIndex = 0;
  let citeIndex = 0;
  source = source.replace(/\\href\{(?:\\.|[^{}])*\}\{|\\includegraphics(?:\[[^\]]*\])?\{[^}]*\}/g,
    (match) => ` NOEMARESOURCE${resourceIndex++} ${match.startsWith("\\href") ? "{" : ""}`);
  source = source.replace(/\\label\{[^}]*\}|\\hypertarget\{[^}]*\}\{/g,
    (match) => ` NOEMAANCHOR${anchorIndex++} ${match.startsWith("\\hypertarget") ? "{" : ""}`);
  source = source.replace(/\\begin\{(verbatim\*?|Verbatim|BVerbatim|LVerbatim|SaveVerbatim|lstlisting|minted|Highlighting)\}[\s\S]*?\\end\{\1\}|\\texttt\{(?:\\.|[^{}])*\}|\\verb\*?(.).*?\2/g,
    () => ` NOEMACODE${codeIndex++} `);
  source = source.replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g,
    () => ` NOEMAMATH${mathIndex++} `);
  source = source.replace(/\\cite(?:\[[^\]]*\])?\{[^}]+\}/g,
    () => ` NOEMACITE${citeIndex++} `);
  source = source
    .replace(/(?<!\\)%[^\n]*/g, " ")
    .replace(/^\s*\\def\\LTcaptype\{none\}\s*$/gm, " ")
    .replace(/\\begin\{(?:longtable\*?|tabular\*?|tabularx|array)\}(?:\[[^\]]*\])?\{(?:[^{}]|\{[^{}]*\})*\}/g, " ")
    .replace(/\\begin\{(?:enumerate|itemize|description)\}(?:\[[^\]]*\])?/g, " ")
    .replace(/\\(?:begin|end)\{[^{}]+\}/g, " ")
    .replace(/\\multicolumn\{[^{}]*\}\{[^{}]*\}\{/g, "{")
    .replace(/\\(?:noalign|Needspace|vspace\*?|hspace\*?|addvspace|setlength|addtolength|enlargethispage)(?:\[[^\]]*\])?(?:\{(?:[^{}]|\{[^{}]*\})*\})*/g, "")
    .replace(/\\textbackslash\{\}/g, "\uE000")
    .replace(/\\textasciicircum\{\}/g, "\uE001")
    .replace(/\\textasciitilde\{\}/g, "\uE002")
    .replace(/\\([#$%&_{}])/g, (_match, value) => ({ "#": "\uE003", "$": "\uE004", "%": "\uE005", "&": "\uE006", "_": "\uE007", "{": "\uE008", "}": "\uE009" })[value])
    .replace(/\\\\|\\[ \t]/g, " ")
    .replace(/\\([A-Za-z@]+)\*?/g, (_match, name) => new Set([
      "textbf", "emph", "textit", "textnormal", "textrm", "textsf", "textsl", "textsc", "underline", "uline", "sout", "st",
      "textsuperscript", "textsubscript", "section", "subsection", "subsubsection", "paragraph", "subparagraph", "part", "chapter",
      "item", "tightlist", "toprule", "midrule", "bottomrule", "endhead", "endlastfoot", "tabularnewline", "noalign",
      "footnote", "caption", "noindent", "newpage", "clearpage", "pagebreak", "nopagebreak", "allowbreak", "linebreak", "newline",
      "Needspace", "raggedright", "centering", "small", "footnotesize", "scriptsize", "sloppy", "fussy", "qedhere", "hfill", "vfill",
      "smallskip", "medskip", "bigskip", "quad", "qquad", "par", "pandocbounded",
    ]).has(name) ? "" : ` NOEMACOMMAND:${name} `)
    .replace(/[{}]/g, "")
    .replace(/&/g, " ")
    .replace(/~/g, " ")
    .replace(/\uE000/g, "\\")
    .replace(/\uE001/g, "^")
    .replace(/\uE002/g, "~")
    .replace(/\uE003/g, "#")
    .replace(/\uE004/g, "$")
    .replace(/\uE005/g, "%")
    .replace(/\uE006/g, "&")
    .replace(/\uE007/g, "_")
    .replace(/\uE008/g, "{")
    .replace(/\uE009/g, "}")
    .replace(/\s+/g, " ")
    .trim();
  return source;
}

function maskedFidelitySource(text) {
  return String(text || "")
    .replace(/\\begin\{(verbatim\*?|Verbatim|BVerbatim|LVerbatim|SaveVerbatim|lstlisting|minted|Highlighting)\}[\s\S]*?\\end\{\1\}/g, " NOEMACODEBLOCK ")
    .replace(/\\texttt\{(?:\\.|[^{}])*\}|\\verb\*?(.).*?\1/g, " NOEMAINLINECODE ")
    .replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, " NOEMAMATH ")
    .replace(/\\href\{(?:\\.|[^{}])*\}/g, "\\href{}")
    .replace(/\\includegraphics(?:\[[^\]]*\])?\{[^}]*\}/g, " NOEMARESOURCE ")
    .replace(/(?<!\\)%[^\n]*/g, " ");
}

function layoutIntentSignature(text) {
  const source = maskedFidelitySource(text);
  const marks = Object.entries(LATEX_MARKS).map(([name, spec]) => ({ name, latex: String(spec.latex || "") })).filter((mark) => mark.latex);
  const tokens = [];
  let cursor = 0;
  while (cursor < source.length) {
    let next = null;
    for (const mark of marks) {
      const index = source.indexOf(mark.latex, cursor);
      if (index < 0) continue;
      if (!next || index < next.index || (index === next.index && mark.latex.length > next.mark.latex.length)) next = { index, mark };
    }
    if (!next) break;
    tokens.push(next.mark.name);
    cursor = next.index + next.mark.latex.length;
  }
  return tokens;
}

function paragraphSignature(text) {
  const source = maskedFidelitySource(text)
    // Heading arguments are structural labels, not prose paragraphs. Removing
    // them lets an agent adjust harmless blank space around a heading while
    // still making a merge of two actual prose paragraphs observable.
    .replace(/\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{(?:\\.|[^{}]|\{[^{}]*\})*\}/g, " ")
    .replace(/\\(?:label|hypertarget)\{[^}]*\}(?:\{)?/g, " ");
  return source.split(/\n[ \t]*\n+/)
    .map((block) => visibleContentSignature(block))
    .filter(Boolean);
}

export function strictFidelityIssues(draftBody, polishedBody) {
  const issues = [];
  const draftVisible = visibleContentSignature(draftBody);
  const polishedVisible = visibleContentSignature(polishedBody);
  if (draftVisible !== polishedVisible) issues.push("visible prose tokens changed or were reordered");
  const draftStructure = structuralSignature(draftBody);
  const polishedStructure = structuralSignature(polishedBody);
  if (JSON.stringify(draftStructure) !== JSON.stringify(polishedStructure)) issues.push("document structure changed or was reordered");
  if (JSON.stringify(paragraphSignature(draftBody)) !== JSON.stringify(paragraphSignature(polishedBody))) {
    issues.push("paragraph boundaries changed or were reordered");
  }
  if (JSON.stringify(layoutIntentSignature(draftBody)) !== JSON.stringify(layoutIntentSignature(polishedBody))) {
    issues.push("explicit layout intents changed or were reordered");
  }
  const draftProtected = protectedPayloads(draftBody);
  const polishedProtected = protectedPayloads(polishedBody);
  for (const key of ["math", "code", "citations", "resources", "anchors", "tikz"]) {
    if (JSON.stringify(draftProtected[key]) !== JSON.stringify(polishedProtected[key])) issues.push(`${key} payloads changed or were reordered`);
  }
  return issues;
}

// Preserve visible prose as well as opaque payloads while allowing markup-only
// structural and mathematical-layout work (lists, paragraphs, aligned/split
// wrappers, breaks).
function criticalFidelityIssues(draftBody, polishedBody) {
  const issues = [];
  if (visibleContentSignature(draftBody) !== visibleContentSignature(polishedBody)) {
    issues.push("visible prose tokens changed or were reordered");
  }
  const draftProtected = protectedPayloads(draftBody);
  const polishedProtected = protectedPayloads(polishedBody);
  for (const key of ["code", "citations", "resources", "anchors", "tikz"]) {
    if (JSON.stringify(draftProtected[key]) !== JSON.stringify(polishedProtected[key])) {
      issues.push(`${key} payloads changed or were reordered`);
    }
  }
  return issues;
}

export function buildPolishCandidates(sourceMarkdown, draftBody) {
  const candidates = [
    { id: "whole-document-structure", kind: "structure", detail: "Audit heading, paragraph, list, theorem/proof, citation, math, and code structure end-to-end." },
    { id: "academic-layout", kind: "typesetting", detail: "Audit restrained academic spacing, page flow, tables, figures, long material, and template fit." },
  ];
  const source = String(sourceMarkdown || "");
  if (/(?:^|\n)\s*\([a-z]\)\s+.+\n\s*\([a-z]\)\s+/i.test(source)) {
    candidates.push({ id: "alpha-enumeration", kind: "list", detail: "Verify that consecutive (a)/(b) material is a true list and that Pandoc preserved the intended labels." });
  }
  if (/^(?:problem|solution|answer|proof)\b/im.test(source)) {
    candidates.push({ id: "role-environments", kind: "environment", detail: "Review explicit Problem/Solution/Answer/Proof roles against environments actually defined by the template." });
  }
  if (/^\s*#\+begin\s+(?:definition|theorem|lemma|proposition|corollary|proof|remark|example|convention)\b/im.test(source)) {
    candidates.push({ id: "semantic-environments", kind: "environment", detail: "Audit every source-declared academic block for the best template-supported environment, label, nesting, and surrounding rhythm." });
  }
  const displayMath = [...String(draftBody || "").matchAll(/\\\[([\s\S]*?)\\\]/g)].map((match) => match[1] || "");
  if (displayMath.some((math) => math.replace(/\s+/g, " ").trim().length > 95
      || (math.match(/\\otimes|\\oplus|\\sum|\\prod|\\longrightarrow/g) || []).length >= 4)) {
    candidates.push({ id: "display-math-layout", kind: "math-layout", detail: "Inspect long display math for semantic aligned/split/multline structure and break points without changing mathematical content." });
  }
  if (/\\cite(?:\[[^\]]*\])?\{[^}]+\}/.test(String(draftBody || ""))) {
    candidates.push({ id: "citation-presentation", kind: "citation", detail: "Verify citation placement, affixes, locators, punctuation, and bibliography-page flow while preserving every citation payload." });
  }
  if (String(draftBody || "").split(/\r?\n/).length > 260) {
    candidates.push({ id: "long-document-flow", kind: "page-flow", detail: "Audit long-document page flow, orphan headings, theorem/proof breaks, floats, and reference-section transition." });
  }
  if (String(draftBody || "").split(/\r?\n/).some((line) => line.length > 140 && !/^\\(?:begin|end)\b/.test(line))) {
    candidates.push({ id: "long-material", kind: "line-break", detail: "Review long URLs, inline math, code-like text, or table cells for semantic break opportunities without rewriting content." });
  }
  return candidates;
}

function reviewGateIssue(review, candidates) {
  if (!review || !Array.isArray(review.decisions)) return "review.json missing or invalid";
  const expected = new Set(candidates.map((candidate) => candidate.id));
  if (review.decisions.length !== expected.size) return "review.json must contain the exact candidate set";
  const decisions = new Map();
  for (const decision of review.decisions) {
    const id = String(decision?.id || "");
    if (!expected.has(id)) return `review.json contains unknown candidate ${id || "(empty)"}`;
    if (decisions.has(id)) return `review.json contains duplicate candidate ${id}`;
    decisions.set(id, decision);
  }
  for (const candidate of candidates) {
    const decision = decisions.get(candidate.id);
    if (!decision) return `review.json omitted candidate ${candidate.id}`;
    if (!["applied", "kept"].includes(String(decision.action || ""))) return `review.json has invalid action for ${candidate.id}`;
    if (!String(decision.reason || "").trim()) return `review.json has no reason for ${candidate.id}`;
  }
  const untouched = review.decisions.filter((decision) => String(decision.reason || "").startsWith("Host baseline:"));
  if (untouched.length) return `agent left ${untouched.length} host baseline decision(s) unreviewed`;
  return "";
}

// ---- Compile a candidate assembled document --------------------------------

// We only need to know whether the document compiles, never the PDF itself, so
// verify in draft mode: pdflatex/lualatex skip PDF output with `-draftmode`,
// xelatex with `-no-pdf`. This skips font embedding / PDF writing — the biggest
// per-attempt cost.
function draftModeFlag(engine) {
  return engine === "xelatex" ? "-no-pdf" : "-draftmode";
}

async function compileLatex({ tex, dir, latexBin, engine = "xelatex", sourceDir, timeoutMs, signal }) {
  const texFile = join(dir, "out.tex");
  await writeFile(texFile, tex, "utf8");
  // Each candidate needs fresh cross-reference state. Otherwise a previous
  // draft's .aux can make a changed citation look resolved on its first pass.
  await Promise.all(["aux", "toc", "out"].map((ext) => rm(join(dir, `out.${ext}`), { force: true })));
  // Compile inside the staging dir (so filecontents-based classes stay there),
  // but let \includegraphics / \input resolve assets next to the source note.
  const env = { ...process.env };
  if (sourceDir) env.TEXINPUTS = `${sourceDir}//:${env.TEXINPUTS || ""}`;
  try {
    const args = [
      "-interaction=nonstopmode",
      "-halt-on-error",
      draftModeFlag(engine),
      `-output-directory=${dir}`,
      texFile,
    ];
    let log = "";
    for (let pass = 0; pass < 3; pass += 1) {
      await execFileAsync(latexBin, args, { cwd: dir, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, signal });
      log = await readFile(join(dir, "out.log"), "utf8").catch(() => "");
      if (!latexNeedsAnotherPass(log)) break;
    }
    // The final export compile rejects undefined references/citations and
    // missing glyphs. Applying the same test here stops a document that can
    // never be published from first paying for a full agent session.
    const diagnostics = latexLogDiagnostics(log);
    return { ok: true, fatal: diagnostics.fatal, log: diagnostics.layout.join("\n") };
  } catch (err) {
    const logFile = join(dir, "out.log");
    let log = "";
    try { log = await readFile(logFile, "utf8"); } catch {}
    const tail = (log || `${err?.stdout || ""}\n${err?.stderr || ""}` || String(err?.message || ""))
      .split(/\r?\n/).filter((l) => /^!|error|undefined|runaway|missing|\.tex:\d+/i.test(l))
      .slice(-30).join("\n");
    return { ok: false, fatal: [], log: tail || String(err?.message || "LaTeX compile failed").slice(0, 2000) };
  }
}

// ---- Agent invocation (codex / claude / opencode) --------------------------

function buildPrompt({ contextItems = [], retryLog, needsTitle = true, sourceTitle = "", documentRole = "", inlineContext = false }) {
  const skills = contextItems.map((item) => item.ref).filter(Boolean);
  const base = [
    "Polish this LaTeX export using the frozen Noema Skill context supplied with this request.",
    ...(skills.length ? [`Apply ${skills.join(" and ")}.`] : []),
    "All inputs are in this working directory. Do not search outside it or read",
    "parent directories, absolute host paths, user configuration, or repositories.",
    "Read style.md, source.md, draft.tex, template.tex, polish-candidates.json,",
    "and the pre-seeded review.json once. Read support .cls/.sty files only when a",
    "specific template macro is ambiguous. body.tex starts as a copy of draft.tex.",
    "",
    "Batch independent reads when possible. Never reread unchanged files. Do not",
    "run LaTeX, tests, git, web searches, or exploratory shell commands; the host",
    "compiles and validates. If the draft is already optimal, leave it unchanged,",
    "complete the concrete `kept` reviews, and finish promptly.",
    ...(sourceTitle ? [`The original source-name title is: ${JSON.stringify(sourceTitle)}.`] : []),
    ...(documentRole ? [`The selected template's document role is: ${JSON.stringify(documentRole)}.`] : []),
    "",
    "You are a format converter and validator, not a copy editor. Preserve every",
    "visible word, number, punctuation mark, citation, math/code token, explicit",
    "line break, TikZ figure, and their order. Improve only LaTeX markup justified",
    "by source structure and supported by template.tex and style.md. Do not invent",
    "content, decoration, packages, or macros. If uncertain, keep the draft.",
    "",
    "Audit source.md against the final body end to end. Fill every review.json",
    "candidate exactly once with `applied` or `kept` and a reason tied to actual",
    "source and markup. Replace every Host baseline reason with concrete evidence.",
    "Claim `applied` only for a matching body.tex change.",
    "Emit body content only, with no preamble or documentclass.",
    "",
    needsTitle
      ? [
          "This template uses a document title. After reading the full source.md and",
          "final body.tex, write a concise document title to title.txt (one plain-text",
          "line, no markup, no quotes). A title is a short application-facing label,",
          "never a summary sentence. Synthesize exactly three signals: the semantic",
          "intent of the original source name, the document role implied by the template",
          "(Assignment, Report, Notes, etc.), and ONE dominant subject from the content.",
          "Do not blindly copy an internal slug or abbreviation such as assg/hw/q1;",
          "expand its intent using the role and subject. Conversely, preserve a source",
          "name that is already clear and suitable. Do not enumerate topics. Use at most",
          "42 characters and normally at most 6 words. Example: source 'assg' + an",
          "Assignment template + linear-algebra content -> 'Linear Algebra Assignment'.",
          "Ensure the result fits template.tex's title area comfortably.",
        ].join("\n")
      : [
          "The host title is authoritative or this template does not accept a generated",
          "title. Do not invent title markup or force a title into body.tex; focus only",
          "on adapting the exported body to this template.",
        ].join("\n"),
    "",
    needsTitle
      ? "Use file-editing tools to write body.tex, title.txt, and the required review.json. Modify no other files. Then return a concise but concrete audit report: what you inspected, exact markup changes applied, important items deliberately kept, and why the result is ready for host validation. Never answer only with tool names, `use tool`, `done`, or a generic success sentence."
      : "Use file-editing tools to write body.tex and the required review.json. Modify no other files. Then return a concise but concrete audit report: what you inspected, exact markup changes applied, important items deliberately kept, and why the result is ready for host validation. Never answer only with tool names, `use tool`, `done`, or a generic success sentence.",
  ];
  if (retryLog) {
    base.push(
      "",
      "Host compile status and diagnostics:",
      "----",
      retryLog,
      "----",
      "Address the diagnostic only where a safe markup change helps; never change prose.",
    );
  }
  if (inlineContext) {
    for (const item of contextItems) {
      base.push("", `[Noema context: ${item.ref}]`, Buffer.from(item.contentBase64, "base64").toString("utf8"));
    }
  }
  return base.join("\n");
}

// Backend-specific argv. All run non-interactively with permission prompts
// disabled and read/write files within the working directory.
function agentArgs(backend, { workdir, model, prompt }) {
  switch (backend) {
    case "claude":
      return [
        "-p", prompt,
        "--safe-mode",
        "--permission-mode", "acceptEdits",
        "--tools", "Read,Edit,Write,Glob,Grep",
        "--disallowedTools", "Bash,Task,Skill,WebFetch,WebSearch",
        "--settings", JSON.stringify({
          permissions: {
            deny: ["Bash", "Task", "Read(../**)", "Read(~/**)", "Edit(../**)", "Edit(~/**)"],
          },
        }),
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--effort", "medium",
        "--no-session-persistence",
        "--no-chrome",
        "--strict-mcp-config",
        "--prompt-suggestions", "false",
        ...(model ? ["--model", model] : []),
      ];
    case "opencode":
      return [
        "run",
        "--dir", workdir,
        "--pure",
        "--format", "json",
        "--thinking",
        ...(model ? ["-m", model] : []),
        prompt,
      ];
    case "codex":
    default:
      return [
        "exec",
        "-C", workdir,
        "--sandbox", "workspace-write",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--json",
        "-c", "approval_policy=\"never\"",
        "-c", "allow_login_shell=false",
        "-c", "model_reasoning_effort=\"medium\"",
        "-c", "sandbox_workspace_write.network_access=true",
        "-c", "sandbox_workspace_write.writable_roots=[]",
        "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
        ...(model ? ["-m", model] : []),
        prompt,
      ];
  }
}

// Extract a short human-readable progress label and final audit report from
// each backend's JSONL/JSON event stream.
function progressEvent(backend, line) {
  const raw = String(line || "").trim();
  if (!raw) return { label: "", report: "" };
  try {
    const ev = JSON.parse(raw);
    const type = ev.type || ev.event || "";
    if (backend === "codex") {
      const item = ev.item || {};
      if (item.type === "agent_message" && item.text) {
        const text = String(item.text).trim();
        return { label: `codex: ${text.slice(0, 150)}`, report: text };
      }
      if (item.type === "command_execution") {
        return { label: `codex: ${String(item.command || "command").slice(0, 140)}`, report: "" };
      }
      if (item.type === "file_change") return { label: "codex: updating export files", report: "" };
      if (type === "turn.started") return { label: "codex: auditing LaTeX draft", report: "" };
      if (type === "turn.completed") return { label: "codex: audit complete", report: "" };
      if (type) return { label: `codex: ${String(type).slice(0, 130)}`, report: "" };
    }
    if (backend === "claude") {
      if (type === "assistant" && ev.message?.content) {
        const t = ev.message.content.find?.((c) => c.type === "tool_use") || ev.message.content.find?.((c) => c.type === "text");
        if (t?.type === "tool_use") return { label: `claude: ${t.name || "tool"}`, report: "" };
        if (t?.type === "text" && t.text) {
          const text = String(t.text).trim();
          return { label: `claude: ${text.slice(0, 140)}`, report: text };
        }
      }
      if (type === "result" && ev.result) {
        const text = String(ev.result).trim();
        return { label: "claude: audit complete", report: text };
      }
      if (type) return { label: `claude: ${type}`, report: "" };
    } else if (backend === "opencode") {
      const text = String(ev.part?.text || ev.message?.text || ev.text || ev.result || "").trim();
      if (text) return { label: `opencode: ${text.slice(0, 140)}`, report: text };
      const label = ev.tool || ev.name || type;
      if (label) return { label: `opencode: ${String(label).slice(0, 130)}`, report: "" };
    }
  } catch {
    return { label: `${backend}: ${raw.slice(0, 150)}`, report: raw };
  }
  return { label: "", report: "" };
}

function runAgent({ backend, bin, workdir, model, contextItems, retryLog, needsTitle, sourceTitle, documentRole, idleTimeoutMs, hardTimeoutMs, signal, onProgress }) {
  return new Promise((resolve) => {
    const args = agentArgs(backend, { workdir, model, prompt: buildPrompt({ contextItems, retryLog, needsTitle, sourceTitle, documentRole, inlineContext: true }) });
    let child;
    try {
      child = spawn(bin, args, {
        cwd: workdir,
        stdio: ["ignore", "pipe", "pipe"],
        // Put the CLI and every subprocess it creates in one process group so
        // an opencode timeout cannot leave model/tool children running.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolve({ ok: false, message: String(err?.message || err) });
      return;
    }
    let stderr = "";
    let stdoutBuf = "";
    let settled = false;
    let idleTimer = null;
    let hardTimer = null;
    let forcedKillTimer = null;
    let stopMessage = "";
    let finalReport = "";
    const terminateGroup = (signalName) => {
      if (!child?.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch {
        try { child.kill(signalName); } catch {}
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (forcedKillTimer) clearTimeout(forcedKillTimer);
      if (signal) signal.removeEventListener?.("abort", onAbort);
      resolve({ ...result, summary: finalReport.slice(0, 4000) });
    };
    const stop = (message, graceMs = 10_000) => {
      if (stopMessage) return;
      stopMessage = message;
      terminateGroup("SIGTERM");
      forcedKillTimer = setTimeout(() => {
        terminateGroup("SIGKILL");
        finish({ ok: false, message });
      }, graceMs);
    };
    const processAlive = () => {
      if (!child?.pid) return false;
      try { process.kill(child.pid, 0); return true; } catch { return false; }
    };
    const armIdleCheck = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled) return;
        if (processAlive()) {
          try { onProgress?.(`${backend} is still alive; waiting for its final polish…`); } catch {}
          armIdleCheck();
        } else {
          stop(`${backend} stopped responding`, 2_000);
        }
      }, idleTimeoutMs);
    };
    const touch = () => armIdleCheck();
    const onAbort = () => stop("aborted", 5_000);
    hardTimer = setTimeout(() => {
      stop(`${backend} reached the ${Math.round(hardTimeoutMs / 60_000)} minute hard limit`);
    }, hardTimeoutMs);
    armIdleCheck();
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener?.("abort", onAbort, { once: true });
    }
    const consumeStdoutLine = (line) => {
      const event = progressEvent(backend, line);
      if (event.report) finalReport = event.report;
      if (event.label && onProgress) { try { onProgress(event.label); } catch {} }
    };
    child.stdout?.on("data", (chunk) => {
      touch();
      stdoutBuf += String(chunk);
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        consumeStdoutLine(line);
      }
      if (stdoutBuf.length > 65536) stdoutBuf = stdoutBuf.slice(-65536);
    });
    child.stderr?.on("data", (chunk) => {
      touch();
      stderr += String(chunk);
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on("error", (err) => finish({ ok: false, message: stopMessage || String(err?.message || err) }));
    child.on("close", (code) => {
      if (stdoutBuf.trim()) consumeStdoutLine(stdoutBuf);
      finish(stopMessage
        ? { ok: false, message: stopMessage }
        : code === 0
          ? { ok: true }
          : { ok: false, message: stderr.trim() || `${backend} exited ${code}` });
    });
  });
}

async function stageOptionalFile(source, destination, fallback = "") {
  let content = fallback;
  if (String(source || "").trim()) {
    try { content = await readFile(source, "utf8"); } catch {}
  }
  if (content) await writeFile(destination, content, "utf8");
}

const EXPORT_SKILLS = ["noema-latex-polish", "academic-typesetting"];

async function stageAgentContext({ workdir, styleDoc, syntaxDoc, skillsDir, backend }) {
  const writes = [
    stageOptionalFile(styleDoc, join(workdir, "style.md"), "# LaTeX export style\nPreserve source text and improve only LaTeX markup.\n"),
    stageOptionalFile(syntaxDoc, join(workdir, "syntax.md")),
  ];
  let contextItems = [];
  if (String(skillsDir || "").trim()) {
    const resolution = await resolveProjectCapabilities({
      scope: "global", builtinSkillDirectory: skillsDir,
      globalConfigPath: join(skillsDir, ".noema-export-global-config.json"),
      globalSkillDirectory: join(skillsDir, ".noema-export-global-skills"),
      requestedSkills: EXPORT_SKILLS,
      includeContent: true,
    });
    const missing = EXPORT_SKILLS
      .filter((id) => !resolution.skills.some((skill) => skill.id === id && skill.enabled && skill.validation?.valid));
    if (missing.length) throw new Error(`Noema export Skill unavailable: ${missing.join(", ")}`);
    // The resolver sorts by id; the agent reads the export Skills in the order asked for.
    const rank = (item) => EXPORT_SKILLS.indexOf(String(item.ref || "").replace(/^skill:/, ""));
    contextItems = resolvedSkillsForRun(resolution).items.sort((a, b) => rank(a) - rank(b));
  }
  if (backend === "opencode") {
    writes.push(writeFile(join(workdir, "opencode.json"), `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      permission: {
        read: "allow", edit: "allow", glob: "allow", grep: "allow", list: "allow",
        webfetch: "deny", websearch: "deny",
        bash: "deny", task: "deny", skill: "deny", lsp: "deny",
        question: "deny", doom_loop: "deny", external_directory: "deny",
      },
    }, null, 2)}\n`, "utf8"));
  }
  await Promise.all(writes);
  return contextItems;
}

// ---- Orchestrator ----------------------------------------------------------

export function normalizeAgentTitle(value, maxLength = 42) {
  const line = String(value || "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
  const clean = line
    .replace(/^\s*(?:title\s*:\s*)/i, "")
    .replace(/^['\"“”‘’]+|['\"“”‘’]+$/g, "")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if ([...clean].length <= maxLength) return clean;
  const clipped = [...clean].slice(0, maxLength + 1).join("");
  const boundary = clipped.slice(0, maxLength).replace(/[\s,:;\-–—]+\S*$/u, "").trim();
  return (boundary || [...clean].slice(0, maxLength).join("")).replace(/[\s,:;\-–—]+$/u, "").trim();
}

async function readAgentTitle(workdir) {
  try {
    const raw = await readFile(join(workdir, "title.txt"), "utf8");
    return normalizeAgentTitle(raw);
  } catch {
    return "";
  }
}

async function readAgentReview(workdir) {
  try {
    const parsed = JSON.parse(await readFile(join(workdir, "review.json"), "utf8"));
    if (!parsed || !Array.isArray(parsed.decisions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Polish the Pandoc draft with the configured agent, gated on fidelity + compilation.
 * @returns {Promise<{body:string, aiTitle:string, usedAgent:boolean, backend:string, compiled:boolean, attempts:number, warnings:string[]}>}
 */
export async function polishBodyWithAgent(opts) {
  const {
    sourceMarkdown = "",
    draftBody = "",
    templateText = "",
    styleDoc = "",
    syntaxDoc = "",
    agentsDoc = "",
    assemble,
    engine = "xelatex",
    latexBin = "",
    backend = "codex",
    agentBin = "",
    agentRunner,
    model = "",
    sourceDir = "",
    makeWorkdir,
    maxAttempts = 3,
    polishVerifiedDraft = false,
    needsTitle = true,
    sourceTitle = "",
    documentRole = "",
    supportFiles = [],
    skillsDir = "",
    agentTimeoutMs = 180_000,
    agentHardTimeoutMs = 900_000,
    compileTimeoutMs = 120_000,
    signal,
    onProgress,
  } = opts || {};

  const emit = (text) => { if (onProgress && text) { try { onProgress(text); } catch {} } };
  const warnings = [];
  const base = { body: draftBody, aiTitle: "", backend, attempts: 0, agentElapsedMs: 0, review: null };
  const compileEnabled = typeof assemble === "function" && !!latexBin && existsSync(latexBin);
  if (!compileEnabled) {
    return { ...base, usedAgent: false, compiled: false, warnings: ["compile not verified; skipped agent polish"] };
  }
  if (typeof agentRunner !== "function" && !agentAvailable(agentBin)) {
    return { ...base, usedAgent: false, compiled: false, warnings: [`${backend} unavailable; used Pandoc draft`] };
  }

  const workdir = await makeWorkdir();
  try {
    const polishCandidates = buildPolishCandidates(sourceMarkdown, draftBody);
    const reviewTemplate = {
      decisions: polishCandidates.map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        action: "kept",
        reason: "Host baseline: verified Pandoc draft retained; replace with a concrete source and markup check.",
      })),
    };
    const prepare = [
      writeFile(join(workdir, "source.md"), sourceMarkdown, "utf8"),
      writeFile(join(workdir, "draft.tex"), draftBody, "utf8"),
      writeFile(join(workdir, "body.tex"), draftBody, "utf8"),
      writeFile(join(workdir, "template.tex"), templateText, "utf8"),
      writeFile(join(workdir, "polish-candidates.json"), `${JSON.stringify({ candidates: polishCandidates }, null, 2)}\n`, "utf8"),
    ];
    for (const file of supportFiles) {
      if (file?.name && file?.content) prepare.push(writeFile(join(workdir, basename(file.name)), file.content));
    }
    await Promise.all(prepare);
    const contextItems = await stageAgentContext({ workdir, styleDoc, syntaxDoc, skillsDir, backend });

    emit("Validating Pandoc draft…");
    const draftVerification = await compileLatex({
      tex: assemble(draftBody),
      dir: workdir,
      latexBin,
      engine,
      sourceDir,
      timeoutMs: compileTimeoutMs,
      signal,
    });
    if (draftVerification.fatal?.length) {
      // Undefined references and missing glyphs are content defects, not
      // typesetting ones. Report them now instead of spending an agent session
      // and two full compiler passes to arrive at the same failure.
      return {
        ...base,
        usedAgent: false,
        compiled: false,
        warnings: [...warnings, `LaTeX verification failed:\n${draftVerification.fatal.join("\n")}`],
      };
    }
    if (draftVerification.ok && !polishVerifiedDraft) {
      return { ...base, usedAgent: false, compiled: true, warnings };
    }

    let body = draftBody;
    let retryLog = draftVerification.ok
      ? draftVerification.log
        ? `VERIFIED MECHANICAL DRAFT WITH NON-FATAL LAYOUT WARNINGS:\n${draftVerification.log}`
        : "VERIFIED MECHANICAL DRAFT: review once and apply only safe markup-level polish."
      : `LATEX COMPILE FAILURE:\n${draftVerification.log}`;
    let attempts = 0;
    let agentElapsedMs = 0;
    let agentSummary = "";
    // A compiling draft gets exactly one optional polish attempt. Repeated
    // free-form retries after a timeout or gate rejection caused the observed
    // opencode retry loop and add no reliability. Multiple attempts are kept
    // only for a concrete mechanical compile failure with compiler feedback.
    const attemptLimit = draftVerification.ok ? 1 : Math.max(1, maxAttempts);
    for (let i = 0; i < attemptLimit; i += 1) {
      attempts = i + 1;
      emit(i === 0 ? `Polishing with ${backend}…` : `Polishing with ${backend} (retry ${attempts})…`);
      // Required outputs are attempt-scoped. Without clearing them, an agent
      // that exits successfully without reviewing can accidentally reuse a
      // review/title written by an earlier rejected attempt.
      await Promise.all([
        rm(join(workdir, "title.txt"), { force: true }),
        writeFile(join(workdir, "review.json"), `${JSON.stringify(reviewTemplate, null, 2)}\n`, "utf8"),
      ]);
      const agentStartedAt = Date.now();
      const runOptions = {
        backend,
        bin: agentBin,
        workdir,
        model,
        contextItems,
        retryLog,
        needsTitle,
        sourceTitle,
        documentRole,
        idleTimeoutMs: Math.max(10, agentTimeoutMs),
        hardTimeoutMs: Math.max(agentTimeoutMs, agentHardTimeoutMs),
        signal,
        onProgress,
      };
      const run = typeof agentRunner === "function"
        ? await agentRunner({ ...runOptions, prompt: buildPrompt(runOptions) })
        : await runAgent(runOptions);
      agentElapsedMs += Date.now() - agentStartedAt;
      agentSummary = String(run.summary || "").trim();
      if (!run.ok) {
        warnings.push(`${backend} adjust failed (${run.message || "unknown"})`);
        break;
      }
      const candidateAiTitle = needsTitle ? await readAgentTitle(workdir) : "";
      try {
        body = await readFile(join(workdir, "body.tex"), "utf8");
      } catch {
        warnings.push(`${backend} did not produce body.tex; used Pandoc draft`);
        return { ...base, usedAgent: false, compiled: false, attempts, warnings };
      }
      const review = await readAgentReview(workdir);
      const fidelityIssues = criticalFidelityIssues(draftBody, body);
      const reviewIssue = reviewGateIssue(review, polishCandidates);
      if (fidelityIssues.length > 0) {
        const gate = [reviewIssue, ...fidelityIssues].filter(Boolean).join("; ");
        warnings.push(`${backend} polish gate rejected attempt ${attempts}: ${gate}`);
        // Re-running a free-form agent after it changed protected content is
        // not a repair strategy. Fall back immediately to the known draft.
        break;
      }
      if (reviewIssue) {
        // A compiled body is not an audited body. Keep the verified Pandoc
        // draft when the agent did not account for every candidate.
        warnings.push(`${backend} review incomplete on attempt ${attempts}: ${reviewIssue}`);
        break;
      }
      const applied = review.decisions.filter((decision) => decision?.action === "applied").length;
      if (body === draftBody && applied > 0) {
        warnings.push(`${backend} review says ${applied} change(s) were applied, but body.tex is unchanged`);
        break;
      }
      if (body !== draftBody && applied === 0) {
        warnings.push(`${backend} changed body.tex but review.json records no applied decision`);
        break;
      }
      emit(`Compiling (attempt ${attempts})…`);
      const res = await compileLatex({ tex: assemble(body, candidateAiTitle), dir: workdir, latexBin, engine, sourceDir, timeoutMs: compileTimeoutMs, signal });
      if (res.fatal?.length) {
        warnings.push(`${backend} output has fatal LaTeX diagnostics: ${res.fatal.join("; ")}`);
        break;
      }
      if (res.ok) {
        if (res.log) {
          warnings.push(`${backend} output has non-fatal LaTeX layout warnings: ${res.log}`);
        }
        // The hard gate compares the mechanical draft with the agent body.
        // This separate heuristic compares the original Markdown source and
        // can flag conversion loss that predates the agent pass.
        warnings.push(...proseFidelityWarnings(sourceMarkdown, body).map((warning) => `${backend} ${warning}`));
        return { body, aiTitle: candidateAiTitle, backend, usedAgent: true, compiled: true, attempts, warnings, agentElapsedMs, review, agentSummary };
      }
      emit(`Compile failed; feeding log back to ${backend}…`);
      retryLog = res.log;
    }

    // Do not spend another compiler pass re-checking the byte-identical draft:
    // its result is already known from draftVerification. The assisted runtime
    // treats usedAgent=false as a failed export, while legacy/direct callers
    // still receive the verified draft explicitly in the result.
    if (draftVerification.ok) {
      warnings.push(`${backend} polish did not pass after ${attempts} attempt(s); kept verified Pandoc draft`);
      return { ...base, usedAgent: false, compiled: true, attempts, warnings, agentElapsedMs, agentSummary };
    }
    warnings.push(`${backend} did not repair the mechanical LaTeX compile failure`);
    return { ...base, usedAgent: false, compiled: false, attempts, warnings, agentElapsedMs, agentSummary };
  } finally {
    // The workdir contains source and draft copies; Skill context stays in
    // the in-memory ACP request and is never installed into this directory.
    // A cleanup failure must surface instead of silently retaining them.
    await rm(workdir, { recursive: true, force: true });
  }
}

// Back-compat alias: earlier callers used the codex-only name/shape.
export async function polishBodyWithCodex(opts = {}) {
  const result = await polishBodyWithAgent({
    ...opts,
    backend: "codex",
    agentBin: opts.agentBin || opts.codexBin || "",
    agentTimeoutMs: opts.agentTimeoutMs || opts.codexTimeoutMs,
  });
  return { ...result, usedCodex: result.usedAgent };
}
