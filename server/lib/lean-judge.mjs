// Lean as the judge of a proof: whether a candidate proves a frozen statement
// is decided by Lean, never by what a model says about it.
// Contract: docs/noema/design/math-exploration.md (L1-L8).
//
// The textual rules and the strict verify protocol are translated from Open
// Math Harness (Apache-2.0; interfaces/lean/src/rules.rs and
// program-files/lean/src/verify.rs).  They are pure functions of the frozen
// file and the candidate; only `runLean` touches a process.
//
// A frozen file is the person's statement: imports, the definitions the
// statement uses, and one `theorem NAME … := sorry`.  A candidate must keep
// that preamble line for line and the statement byte for byte.  `verify`
// elaborates the frozen preamble itself, a separator, then the candidate's
// text after its copy, and reads only the report that follows a per-run marker:
// `#print axioms` (nothing beyond propext, Classical.choice, Quot.sound, no
// sorryAx) and the `pp.all` type, which must equal the pristine statement's.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const TRUSTED_AXIOMS = ["propext", "Classical.choice", "Quot.sound"];
export const MAX_FROZEN_BYTES = 64 * 1024;
export const MAX_CANDIDATE_BYTES = 512 * 1024;
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
export const MAX_LISTED = 32;
/** Whether Lean's OUTPUT reports an error, with or without a tag. */
export const reportsError = (output) => /(^|[\s:])error(\([^)]*\))?:/m.test(output);
export const SEPARATOR = "#print \"noema: the frozen preamble ends here\"";

const AMBIGUOUS = "string or character literal the checker cannot read unambiguously";
const OPEN_COMMENT = "comment opened with /- and never closed with -/";
const OPEN_NAME = "name opened with « and never closed with »";

// Words that make Lean run code, change the syntax, or reach the meta and IO
// libraries while it elaborates.  A proof needs none of them; elaborated code
// could print into the output the verdict is read from.
const EXEC_WORDS = new Set([
  "#exit", "#guard", "#html", "#widget", "#sample", "#test",
  "run_cmd", "run_elab", "run_meta", "run_tac", "by_elab",
  "syntax", "macro", "macro_rules", "elab", "elab_rules", "declare_syntax_cat",
  "notation", "notation3", "infix", "infixl", "infixr", "prefix", "postfix", "binder_predicate",
  "initialize", "builtin_initialize", "simproc", "dsimproc", "simproc_decl", "dsimproc_decl",
  "command_elab", "term_elab", "tactic", "delab", "app_unexpander", "implemented_by", "extern",
  "unsafe", "Lean", "Mathlib", "Aesop", "Batteries", "Qq", "IO", "EIO", "BaseIO",
  "println!", "eprintln!", "asTask",
]);
const IMPORTABLE = new Set(["Lean", "Mathlib", "Aesop", "Batteries", "Qq"]);
const BANNED_OPTION_ROOTS = new Set(["pp", "debug"]);
// Keywords that start a command and never continue a term.
const COMMAND_WORDS = new Set([
  "theorem", "lemma", "def", "abbrev", "instance", "example", "opaque", "structure", "class", "inductive",
  "namespace", "section", "end", "variable", "universe", "noncomputable", "private", "protected", "partial",
  "open", "set_option", "attribute", "local", "scoped", "mutual", "export", "import", "omit", "include",
  "irreducible_def",
]);

const judgeError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/** Lean's `isIdRest`: the characters that continue an identifier. */
export function isIdRest(char) {
  if (char === undefined) return false;
  const v = char.codePointAt(0);
  const letterLike = (v >= 0x3b1 && v <= 0x3c9 && v !== 0x3bb) || (v >= 0x391 && v <= 0x3a9 && v !== 0x3a0 && v !== 0x3a3)
    || (v >= 0x3ca && v <= 0x3fb) || (v >= 0x1f00 && v <= 0x1ffe) || (v >= 0x2100 && v <= 0x214f)
    || (v >= 0x1d49c && v <= 0x1d59f);
  const subscript = (v >= 0x2080 && v <= 0x2089) || (v >= 0x2090 && v <= 0x209c) || (v >= 0x1d62 && v <= 0x1d6a) || v === 0x2c7c;
  return /[A-Za-z0-9_'!?]/.test(char) || letterLike || subscript;
}

/**
 * SOURCE with comments and (when STRINGS) string literals blanked to spaces,
 * every character in place, plus the spans of the string literals.  Throws
 * `{lexical}` where this lexer could read the text differently from Lean:
 * raw/interpolated/escaped strings, character literals before a comment or a
 * name, and text ending inside a comment or a `«` name.  `«…»` stays visible.
 */
export function blanked(source, strings = true) {
  const chars = Array.from(source);
  const out = chars.slice();
  const spans = [];
  // UTF-16 offset of every character, so spans index the original string.
  const offsets = [];
  let position = 0;
  for (const char of chars) { offsets.push(position); position += char.length; }
  offsets.push(position);
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ".repeat(out[k].length); };
  const refuse = (why) => { throw Object.assign(new Error(why), { lexical: true }); };
  let k = 0;
  while (k < chars.length) {
    const c = chars[k];
    const prev = chars[k - 1];
    const opensComment = (c === "-" && chars[k + 1] === "-") || (c === "/" && chars[k + 1] === "-");
    if ((opensComment || c === "«" || c === "\"") && (prev === "'" || prev === "\\")) refuse(AMBIGUOUS);
    if (c === "-" && chars[k + 1] === "-") {
      const start = k;
      while (k < chars.length && chars[k] !== "\n") k += 1;
      blank(start, k);
    } else if (c === "/" && chars[k + 1] === "-") {
      const start = k;
      let depth = 1;
      // `/--` and `/-!` are one token, so `/--/` opens a doc comment.
      k += chars[k + 2] === "-" || chars[k + 2] === "!" ? 3 : 2;
      while (k < chars.length && depth > 0) {
        if (chars[k] === "-" && chars[k + 1] === "/") { depth -= 1; k += 2; }
        else if (chars[k] === "/" && chars[k + 1] === "-") { depth += 1; k += 2; }
        else k += 1;
      }
      if (depth > 0) refuse(OPEN_COMMENT);
      blank(start, k);
    } else if (c === "\"") {
      if (prev !== undefined && (isIdRest(prev) || prev === "#")) refuse(AMBIGUOUS);
      const start = k;
      k += 1;
      for (;;) {
        const here = chars[k];
        if (here === undefined || here === "\\" || here === "{") refuse(AMBIGUOUS);
        if (here === "\"") break;
        k += 1;
      }
      k += 1;
      spans.push([offsets[start], offsets[k]]);
      if (strings) blank(start, k);
    } else if (c === "«") {
      while (k < chars.length && chars[k] !== "»") k += 1;
      if (k === chars.length) refuse(OPEN_NAME);
    } else k += 1;
  }
  return { code: out.join(""), spans };
}

/** SOURCE as code: comments and strings blanked, or throws `{lexical}`. */
export const leanCode = (source) => blanked(source, true).code;

/** Words of CODE: maximal runs of identifier characters, a leading `#` kept. */
function words(code) {
  const out = [];
  const chars = Array.from(code);
  let offset = 0;
  let start = null;
  let startOffset = 0;
  for (let k = 0; k <= chars.length; k += 1) {
    const c = k < chars.length ? chars[k] : " ";
    if (start !== null && !isIdRest(c)) {
      const word = chars.slice(start, k).join("");
      if (word !== "#") out.push({ word, start: startOffset, end: offset });
      start = c === "#" ? k : null;
      startOffset = offset;
    } else if (start === null && (isIdRest(c) || c === "#")) { start = k; startOffset = offset; }
    offset += c.length;
  }
  return out;
}

/** The first word of CODE that runs code or alters what the judge reads. */
function execWord(code) {
  const list = words(code);
  let inImport = false;
  for (let n = 0; n < list.length; n += 1) {
    const { word, start } = list[n];
    const before = list[n - 1];
    const gap = before ? code.slice(before.end, start) : "";
    inImport = Boolean(before) && ((before.word === "import" && gap.length > 0 && /^[ \t]+$/.test(gap)) || (inImport && gap === "."));
    if (inImport && IMPORTABLE.has(word)) continue;
    if (word.startsWith("#eval")) return "#eval";
    if (word === "eval" && code[list[n].end] === "%") return "eval%";
    if (EXEC_WORDS.has(word)) return word;
  }
  return null;
}

const lexicalReason = (fn) => { try { return fn(); } catch (error) { if (error.lexical) return { lexical: error.message }; throw error; } };

/** The first token forbidden even in a partial proof (`sorry` is allowed). */
export function checkForbiddenToken(candidate) {
  const code = lexicalReason(() => leanCode(candidate));
  if (code?.lexical) return code.lexical;
  if (code.includes("native_decide")) return "native_decide";
  const list = words(code);
  if (list.some(({ word }) => word === "axiom")) return "axiom";
  for (let n = 0; n + 1 < list.length; n += 1)
    if (list[n].word === "set_option" && BANNED_OPTION_ROOTS.has(list[n + 1].word))
      return list[n + 1].word === "pp" ? "set_option pp" : "set_option debug";
  return execWord(code);
}

/** The first token forbidden under the strict protocol: `sorry` too. */
export function forbiddenToken(candidate) {
  const code = lexicalReason(() => leanCode(candidate));
  if (!code?.lexical && code.includes("sorry")) return "sorry";
  return checkForbiddenToken(candidate);
}

/** Span of the frozen statement: the first code line starting `theorem` to the last `:=`. */
function statementSpan(frozen) {
  const code = lexicalReason(() => leanCode(frozen));
  if (code?.lexical) return null;
  let start = -1;
  for (let at = code.indexOf("theorem"); at >= 0; at = code.indexOf("theorem", at + 1))
    if (at === 0 || code[at - 1] === "\n") { start = at; break; }
  const end = code.lastIndexOf(":=");
  return start >= 0 && end >= start ? [start, end + 2] : null;
}

/** The frozen `theorem … :=` statement a candidate must contain verbatim, or null. */
export function extractStatement(frozen) {
  const span = statementSpan(frozen);
  return span ? frozen.slice(span[0], span[1]) : null;
}

/** The theorem's name in FROZEN, or null. */
export function theoremName(frozen) {
  const statement = extractStatement(frozen);
  const match = statement && /^theorem\s+([^\s:({[]+)/u.exec(statement);
  return match ? match[1] : null;
}

const startsCommand = (text) => {
  const word = Array.from(text).findIndex((c) => !isIdRest(c));
  const head = word < 0 ? text : Array.from(text).slice(0, word).join("");
  return text.startsWith("@[") || COMMAND_WORDS.has(head);
};

function provedBySorryAlone(proof) {
  let rest = proof.trimStart();
  if (rest.startsWith("by") && /^\s/.test(rest.slice(2))) rest = rest.slice(2);
  rest = rest.trimStart();
  if (!rest.startsWith("sorry") || isIdRest(rest[5])) return false;
  const after = rest.slice(5);
  const next = after.trimStart();
  return next === "" || (after.slice(0, after.length - next.length).includes("\n") && startsCommand(next));
}

/** Lines of code: comments blanked, trailing space trimmed, blank lines dropped;
 * a line break inside a string literal does not end a line. */
function codeLines(text) {
  const { code, spans } = blanked(text, false);
  const lines = [];
  let start = 0;
  let next = 0;
  const breaks = [];
  for (let at = code.indexOf("\n"); at >= 0; at = code.indexOf("\n", at + 1)) breaks.push(at);
  breaks.push(code.length);
  for (const at of breaks) {
    while (next < spans.length && spans[next][1] <= at) next += 1;
    if (next < spans.length && spans[next][0] < at) continue;
    const line = code.slice(start, at).trimEnd();
    if (line) lines.push({ text: line, end: start + line.length });
    start = at + 1;
  }
  return lines;
}

/** Where CANDIDATE's copy of FROZEN's preamble ends, or null for an empty
 * preamble; throws `{objection}` when the candidate does not keep it. */
export function preambleCopy(frozen, candidate) {
  const object = (message) => { throw Object.assign(new Error(message), { objection: true }); };
  const span = statementSpan(frozen);
  if (!span) object("the frozen file has no `theorem … :=` statement at the start of a line");
  let preamble;
  let lines;
  try { preamble = codeLines(frozen.slice(0, span[0])); lines = codeLines(candidate); }
  catch (error) { if (error.lexical) object(error.message); throw error; }
  const differs = preamble.findIndex((want, k) => lines[k]?.text !== want.text);
  if (differs >= 0)
    object(`the candidate must begin with the frozen file's preamble (its lines before the theorem, blank lines and comments aside), unchanged; the first line that differs is, byte for byte:\n${preamble[differs].text}`);
  if (!preamble.length) return null;
  const copy = { frozenEnd: preamble.at(-1).end, candidateEnd: lines[preamble.length - 1].end };
  const following = lines[preamble.length]?.text.trimStart();
  if (following === undefined || startsCommand(following)) return copy;
  return object(`the line after the frozen preamble must start a new command (\`lemma\`, \`theorem\`, \`def\`, \`open\`, \`@[\`, …) so that it adds nothing to the preamble's last declaration; it starts: ${following.slice(0, 200)}`);
}

/** Why FROZEN cannot judge proofs, or null.  Its theorem is proved by `sorry`
 * alone, nothing before it holds `sorry`, and nothing in it runs code. */
export function frozenObjection(frozen) {
  if (Buffer.byteLength(frozen) > MAX_FROZEN_BYTES) return `the frozen file is larger than ${MAX_FROZEN_BYTES} bytes`;
  const code = lexicalReason(() => leanCode(frozen));
  if (code?.lexical) return `the frozen file has a ${code.lexical}; close every comment and « name and write string literals plainly`;
  const token = checkForbiddenToken(frozen);
  if (token) return `the frozen file has the forbidden token \`${token}\``;
  const span = statementSpan(frozen);
  if (!span) return "the frozen file has no `theorem … :=` statement at the start of a line";
  if (!theoremName(frozen)) return "the frozen theorem has no name";
  const commented = blanked(frozen, false).code;
  if (!provedBySorryAlone(commented.slice(span[1])))
    return "the frozen theorem must be proved by `sorry` alone (`:= sorry` or `:= by sorry`); put no proof steps in the frozen file";
  if (code.slice(0, span[1]).includes("sorry"))
    return "the definitions and statement before the proof contain `sorry`; every candidate must copy them, so no proof could ever be accepted";
  const head = codeLines(frozen.slice(0, span[0]));
  const last = head.at(-1)?.text;
  if (last && /(^|[^\p{L}\p{N}_'!?])in$/u.test(last))
    return "the frozen file's last line before the theorem ends in `in`, which scopes it to the next command; drop the `in`";
  try { preambleCopy(frozen, frozen); } catch (error) { if (error.objection) return error.message; throw error; }
  return null;
}

/** Why CANDIDATE cannot be graded as a partial proof of STATEMENT, or null. */
export function protocolObjection(statement, candidate) {
  const token = checkForbiddenToken(candidate);
  if (token) return `forbidden token \`${token}\``;
  if (!candidate.includes(statement)) return `the frozen theorem statement must appear verbatim; it is, byte for byte:\n${statement}`;
  return null;
}

/** The file Lean elaborates for CANDIDATE: FROZEN's preamble, the separator on
 * its last line, then the candidate after its copy, padded so that Lean's line
 * numbers are the candidate's own when its copy is not shorter. */
export function checkedSource(frozen, candidate) {
  const copy = preambleCopy(frozen, candidate);
  if (!copy) return { source: candidate, rest: candidate };
  const preamble = frozen.slice(0, copy.frozenEnd);
  const rest = candidate.slice(copy.candidateEnd);
  const lines = (text) => text.split("\n").length - 1;
  const padding = Math.max(0, lines(candidate.slice(0, copy.candidateEnd)) - lines(preamble));
  return { source: `${preamble} ${SEPARATOR}${"\n".repeat(padding)}${rest}`, rest };
}

const checkLine = (thm) => `set_option pp.all true in #check @${thm}\n`;
const reportCommands = (marker, thm) => `\n#print "${marker}"\n#print axioms ${thm}\n${checkLine(thm)}`;
const freshMarker = () => `noema-report-${randomBytes(16).toString("hex")}`;

function startsWithTypeHead(text, thm) {
  let rest = text.startsWith("@") ? text.slice(1) : text;
  if (!rest.startsWith(thm)) return false;
  rest = rest.slice(thm.length);
  if (rest.startsWith(".{")) {
    const close = rest.indexOf("}");
    if (close < 0 || !/^[\p{L}\p{N}_,\s]*$/u.test(rest.slice(2, close))) return false;
    rest = rest.slice(close + 1);
  }
  return rest.startsWith(" : ");
}

/** What the judge's own commands printed after the line that is exactly
 * MARKER: one axioms line for THM then the type block, or null. */
export function harnessReport(output, marker, thm) {
  const line = `${marker}\n`;
  const start = output.startsWith(line) ? 0 : output.indexOf(`\n${line}`) + 1;
  if (start === 0 && !output.startsWith(line)) return null;
  if (output.split(marker).length !== 2) return null;
  const report = output.slice(start + line.length);
  const newline = report.indexOf("\n");
  if (newline < 0) return null;
  const axiomLine = report.slice(0, newline);
  const rest = report.slice(newline + 1);
  const quoted = `'${thm}' `;
  const tail = axiomLine.startsWith(quoted) ? axiomLine.slice(quoted.length) : null;
  const wellFormed = tail === "does not depend on any axioms"
    || (tail?.startsWith("depends on axioms: [") && tail.endsWith("]") && !tail.slice(20).includes("["));
  if (!wellFormed || !startsWithTypeHead(rest, thm)) return null;
  return { axiomLine, type: rest.trim() };
}

/** Parse an axioms line: whether it uses sorryAx, and the axioms. */
export function parseAxioms(line) {
  const at = line.indexOf("depends on axioms: [");
  const inner = at < 0 ? "" : line.slice(at + 20, line.indexOf("]", at));
  return { sorry: line.includes("sorryAx"), axioms: inner.split(",").map((part) => part.trim()).filter(Boolean) };
}

/** Diagnostics of a Lean run on FILE: errors with positions and sorry warnings. */
export function diagnostics(output, file) {
  const errors = [];
  let sorries = 0;
  // Lean 4 prints `FILE:LINE:COL: error(lean.tag): …`; the tag is optional.
  const pattern = /^(.*?):(\d+):(\d+): (error|warning)(?:\([^)]*\))?: ([\s\S]*?)(?=^\S.*?:\d+:\d+: (?:error|warning|info)(?:\([^)]*\))?:|(?![\s\S]))/gm;
  for (const match of output.matchAll(pattern)) {
    if (file && basename(match[1]) !== basename(file)) continue;
    const message = match[5].trim();
    if (match[4] === "error") errors.push({ line: Number(match[2]), col: Number(match[3]), message: message.slice(0, 2000) });
    else if (/declaration uses 'sorry'/.test(message)) sorries += 1;
  }
  return { errors, sorries };
}

// ---------------------------------------------------------------------------
// Running Lean
// ---------------------------------------------------------------------------

/** The nearest directory at or above START holding a Lake project. */
export function lakeRootOf(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (["lakefile.toml", "lakefile.lean"].some((name) => existsSync(join(dir, name)))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

const LEAN_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "ELAN_HOME", "LEAN_PATH"];

/** Run `lake env lean` on SOURCE in LAKE within TIMEOUT.  Resolves
 * `{output}` after a clean exit, `{refused}` when Lean exited non-zero, and
 * `{noVerdict}` when Lean gave no verdict (could not start, timed out, signal). */
export function runLean(source, { lake, timeoutMs = DEFAULT_TIMEOUT_MS, command = "lake" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "noema-lean-"));
  const file = join(dir, "Candidate.lean");
  writeFileSync(file, source);
  const env = Object.fromEntries(LEAN_ENV.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  return new Promise((done) => {
    let output = "";
    let settled = false;
    const finish = (answer) => { if (settled) return; settled = true; clearTimeout(limit); rmSync(dir, { recursive: true, force: true }); done({ ...answer, file }); };
    const child = spawn(command, command === "lake" ? ["env", "lean", file] : [file], { cwd: lake, env, stdio: ["ignore", "pipe", "pipe"] });
    const take = (chunk) => { if (output.length < 4_000_000) output += chunk; };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const limit = setTimeout(() => { child.kill("SIGKILL"); finish({ noVerdict: `Lean did not finish within ${timeoutMs} ms` }); }, timeoutMs);
    child.on("error", (error) => finish({ noVerdict: `Lean could not start: ${error.message}` }));
    child.on("close", (code, signal) => {
      if (code === 0) finish({ output });
      else if (code !== null) finish({ refused: output, output });
      else finish({ noVerdict: `Lean was ended by ${signal}`, output });
    });
  });
}

const excerpt = (text) => String(text ?? "").slice(0, 2000);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const pristineCache = new Map();

/** The pristine `pp.all` type of FROZEN's theorem, one Lean run per frozen
 * text.  CACHE is a directory that keeps it across processes. */
export async function pristineType(frozen, thm, { run, cache, lake = "" } = {}) {
  // The same text can elaborate differently in another Lake project.
  const key = sha(`${lake}\0${frozen}`);
  if (pristineCache.has(key)) return { type: pristineCache.get(key) };
  const cached = cache && join(cache, `${key}.type`);
  if (cached && existsSync(cached)) { const type = readFileSync(cached, "utf8"); pristineCache.set(key, type); return { type }; }
  const { source } = checkedSource(frozen, frozen);
  const marker = freshMarker();
  const result = await run(`${source}${reportCommands(marker, thm)}`);
  if (result.noVerdict) return { noVerdict: result.noVerdict };
  const output = result.output ?? "";
  if (result.refused !== undefined || reportsError(output)) return { refused: excerpt(output) };
  const report = harnessReport(output, marker, thm);
  if (!report) return { refused: `Lean printed no \`#print axioms ${thm}\` and \`#check @${thm}\` report after the file` };
  pristineCache.set(key, report.type);
  if (cached) { mkdirSync(cache, { recursive: true }); writeFileSync(cached, report.type); }
  return { type: report.type };
}

/**
 * Judge CANDIDATE against FROZEN.  OP `check` grades a partial proof
 * (`invalid`, `errors`, `sorries`, `complete`); `verify` decides a solve
 * (`accepted` or a `rejection`).  RUN runs Lean on a source.
 */
export async function judge({ op, frozen, candidate, run, cache, lake }) {
  const statement = extractStatement(frozen);
  const thm = theoremName(frozen);
  const objection = frozenObjection(frozen);
  if (objection) return { op, status: "invalid_statement", reason: objection };
  if (Buffer.byteLength(candidate) > MAX_CANDIDATE_BYTES) return { op, status: "invalid", reason: `the candidate is larger than ${MAX_CANDIDATE_BYTES} bytes` };
  if (op === "check") {
    const textual = protocolObjection(statement, candidate);
    if (textual) return { op, status: "invalid", reason: textual };
    let built;
    try { built = checkedSource(frozen, candidate); } catch (error) { if (error.objection) return { op, status: "invalid", reason: error.message }; throw error; }
    const result = await run(built.source);
    if (result.noVerdict) return { op, status: "no_verdict", reason: result.noVerdict };
    const { errors, sorries } = diagnostics(result.output ?? "", result.file);
    const status = errors.length || result.refused !== undefined ? "errors" : sorries ? "sorries" : "complete";
    return { op, status, theorem: thm, errorsTotal: errors.length, errors: errors.slice(0, MAX_LISTED), sorries,
      ...(status === "complete" ? { next: "complete is a candidate solve; verify decides" } : {}) };
  }
  if (op !== "verify") throw judgeError(`Unknown operation: ${op}`);
  const reject = (rejection, detail) => ({ op, accepted: false, theorem: thm, rejection, ...(detail ? { detail } : {}) });
  const token = forbiddenToken(candidate);
  if (token) return reject("forbidden", token);
  if (!candidate.includes(statement)) return reject("statement_mismatch", `the frozen statement, byte for byte:\n${statement}`);
  let built;
  try { built = checkedSource(frozen, candidate); } catch (error) { if (error.objection) return reject("preamble_mismatch", error.message); throw error; }
  if (!built.rest.includes(statement)) return reject("statement_mismatch", `the frozen statement, byte for byte:\n${statement}`);
  const builtToken = forbiddenToken(built.source);
  if (builtToken) return reject("forbidden", builtToken);
  const pristine = await pristineType(frozen, thm, { run, cache, lake });
  if (pristine.noVerdict) return { op, accepted: null, status: "no_verdict", reason: pristine.noVerdict };
  if (pristine.refused) return { op, status: "invalid_statement", reason: `Lean refused the frozen file itself:\n${pristine.refused}` };
  const marker = freshMarker();
  const result = await run(`${built.source}${reportCommands(marker, thm)}`);
  if (result.noVerdict) return { op, accepted: null, status: "no_verdict", reason: result.noVerdict };
  const output = result.output ?? "";
  if (result.refused !== undefined || reportsError(output)) return reject("elaboration", excerpt(output));
  const report = harnessReport(output, marker, thm);
  if (!report) return reject("no_type");
  const { sorry, axioms } = parseAxioms(report.axiomLine);
  if (sorry) return reject("sorry_ax");
  const extra = axioms.filter((name) => !TRUSTED_AXIOMS.includes(name));
  if (extra.length) return reject("non_standard_axioms", extra.join(", "));
  if (report.type !== pristine.type.trim()) return reject("type_mismatch");
  return { op, accepted: true, theorem: thm, axioms };
}

const readText = (path, name) => {
  if (typeof path !== "string" || !isAbsolute(path)) throw judgeError(`${name} must be an absolute path`);
  try { return readFileSync(path, "utf8"); } catch { throw judgeError(`Cannot read ${name}: ${path}`, 404); }
};

/** The API and CLI entry: files in, verdict out.  STATEMENT is the person's
 * frozen file, CANDIDATE the proof file; LAKE defaults to the nearest Lake
 * project above the statement. */
export async function leanJudge(body = {}, { run, cache } = {}) {
  const op = String(body.op || "verify");
  const frozen = readText(body.statement, "statement");
  if (op === "statement") {
    const reason = frozenObjection(frozen);
    return reason ? { op, ok: false, reason } : { op, ok: true, theorem: theoremName(frozen), statement: extractStatement(frozen) };
  }
  const candidate = readText(body.candidate, "candidate");
  const lake = body.lake ? resolve(String(body.lake)) : lakeRootOf(dirname(body.statement));
  if (!lake) throw judgeError("No Lake project at or above the statement; pass lake", 422);
  const timeoutMs = body.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(body.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw judgeError(`timeoutMs is 1000..${MAX_TIMEOUT_MS}`);
  const runner = run ?? ((source) => runLean(source, { lake, timeoutMs }));
  return { ...(await judge({ op, frozen, candidate, run: runner, cache, lake })), statementFile: body.statement, candidateFile: body.candidate, lake };
}
