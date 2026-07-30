#!/usr/bin/env node
// One-time codemod: convert legacy dollar math to LaTeX bracket math.
//
//   inline   $...$    -> \(...\)
//   display  $$ lines -> \[ ... \]   (each $$-only line becomes \[ / \])
//
// This is intentionally SELF-CONTAINED: it snapshots the OLD dollar detection
// (regex + prose heuristic) so it does not depend on the now-rewritten
// src/inline-math.ts and so it can be re-run independently of source state.
//
// Safety:
//   - fenced code blocks (``` / ~~~) and inline `code` spans are skipped
//   - escaped \$ (literal dollars) are never converted
//   - dry-run by default; pass --write to modify files
//
// Usage:
//   node scripts/migrate-dollar-to-bracket-math.mjs [--write] [root]
//   AARONNOTE_ROOT=/path node scripts/migrate-dollar-to-bracket-math.mjs --write

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// --- frozen OLD detection (mirrors the pre-migration src/inline-math.ts) ----

const INLINE_MATH_RE = /(?<![A-Za-z0-9_$])\$(?![\s$])([^$\n]{0,119}\S) {0,5}\$(?![A-Za-z0-9_$])/g;
const BLOCK_FENCE_RE = /^[ \t]*\$\$[ \t]*$/;
const CODE_FENCE_RE = /^\s*(```+|~~~+)/;

const INLINE_TEXT_WORD_RE = /(?:^|[^\\A-Za-z])([A-Za-z]+)(?=$|[^A-Za-z])/g;
const INLINE_CJK_RE = /[㐀-鿿]/;
const INLINE_MATH_SIGNAL_RE = /[\\^_=+\-*/<>|()[\]{}0-9]/;
const INLINE_COMMON_PROSE_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "for", "from", "graph",
  "has", "have", "i", "in", "is", "it", "like", "math", "not", "of", "on",
  "or", "plain", "prose", "some", "text", "the", "this", "to", "words",
]);

function isLikelyInlineMath(tex) {
  const trimmed = tex.trim();
  if (!trimmed || trimmed.length !== tex.length || trimmed.length > 120) return false;
  // The original heuristic also rejected `#` (to dodge $-ambiguity with headers/
  // hashtags). For this deliberate migration of hand-written math we keep `\#`
  // cardinality notation, so only the (now impossible) bare `$` is rejected.
  if (/\$/.test(trimmed)) return false;
  if (INLINE_CJK_RE.test(trimmed) && !trimmed.includes("\\")) return false;
  if (INLINE_MATH_SIGNAL_RE.test(trimmed)) return true;
  let words = 0;
  let commonProseWords = 0;
  INLINE_TEXT_WORD_RE.lastIndex = 0;
  let match;
  while ((match = INLINE_TEXT_WORD_RE.exec(trimmed)) !== null) {
    const word = match[1];
    const wordStart = match.index + match[0].length - word.length;
    if (wordStart > 0 && trimmed[wordStart - 1] === "\\") continue;
    words++;
    if (INLINE_COMMON_PROSE_WORDS.has(word.toLowerCase())) commonProseWords++;
  }
  if (words >= 3 && commonProseWords >= 3) return false;
  return true;
}

// --- helpers ---------------------------------------------------------------

function isEscaped(line, pos) {
  let count = 0;
  for (let i = pos - 1; i >= 0 && line[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

// Inline `code` span ranges on a single line (CommonMark backtick runs).
function inlineCodeRanges(line) {
  const ranges = [];
  const re = /(`+)(?:[^`]|(?!\1)`)*?\1/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function overlapsCode(from, to, codeRanges) {
  return codeRanges.some(([cf, ct]) => from < ct && to > cf);
}

function convertInlineLine(line) {
  const codeRanges = inlineCodeRanges(line);
  const edits = [];
  INLINE_MATH_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_MATH_RE.exec(line)) !== null) {
    const from = m.index;
    const to = m.index + m[0].length;
    const closePos = to - 1;
    if (overlapsCode(from, to, codeRanges)) continue;
    if (isEscaped(line, from) || isEscaped(line, closePos)) continue;
    if (!isLikelyInlineMath(m[1])) continue;
    edits.push({ from, to, replacement: `\\(${m[1]}\\)` });
  }
  if (edits.length === 0) return { line, count: 0 };
  let out = line;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    out = out.slice(0, e.from) + e.replacement + out.slice(e.to);
  }
  return { line: out, count: edits.length };
}

function convertContent(content) {
  const lines = content.split("\n");
  let inCodeFence = false;
  let inDisplayMath = false;
  let inlineCount = 0;
  let blockCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (CODE_FENCE_RE.test(line) && !inDisplayMath) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    if (BLOCK_FENCE_RE.test(line)) {
      const replacement = inDisplayMath ? "\\]" : "\\[";
      lines[i] = line.replace("$$", replacement);
      inDisplayMath = !inDisplayMath;
      blockCount++;
      continue;
    }
    if (inDisplayMath) continue; // body of a display block: leave as-is

    const { line: converted, count } = convertInlineLine(line);
    lines[i] = converted;
    inlineCount += count;
  }

  return { content: lines.join("\n"), inlineCount, blockCount };
}

// --- file walk -------------------------------------------------------------

function* walkMarkdown(dir) {
  for (const entry of readdirSync(dir)) {
    // Skip VCS, deps, and vendored toolchain caches (e.g. Lean's .lake packages).
    if (entry === ".git" || entry === "node_modules" || entry === ".lake") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkMarkdown(full);
    else if (st.isFile() && /\.md$/i.test(entry)) yield full;
  }
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const positional = args.find((a) => !a.startsWith("--"));
  const root = resolve(
    positional || process.env.AARONNOTE_ROOT || join(__dirname, "..", "..", "..", "..", ".roam"),
  );

  let files = 0;
  let changedFiles = 0;
  let totalInline = 0;
  let totalBlock = 0;

  for (const file of walkMarkdown(root)) {
    files++;
    const original = readFileSync(file, "utf8");
    const { content, inlineCount, blockCount } = convertContent(original);
    if (content === original) continue;
    changedFiles++;
    totalInline += inlineCount;
    totalBlock += blockCount;
    console.log(
      `${write ? "write" : "would"}: ${relative(root, file)}  (inline ${inlineCount}, block-lines ${blockCount})`,
    );
    if (write) writeFileSync(file, content, "utf8");
  }

  console.log(
    `\n${write ? "Converted" : "Dry run"}: ${changedFiles}/${files} files, ` +
      `${totalInline} inline spans, ${totalBlock} block fence lines (root: ${root})`,
  );
  if (!write) console.log("Re-run with --write to apply.");
}

main();
