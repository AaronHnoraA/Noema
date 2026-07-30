import { scanInlineCommands } from "./command-syntax.mjs";

const TECHNICAL_ORG_ENV_KINDS = new Set([
  "src",
  "source",
  "example",
  "export",
  "html",
  "meta",
  "lean",
  "tex",
  "latex",
  "math",
  "tikz",
  "mermaid",
  "plantuml",
  "diagram",
]);

const PROSE_INLINE_COMMANDS = new Set([
  "todo",
  "itodo",
  "comment",
  "scomment",
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
]);

export const AARONNOTE_ACCEPTED_WORDS = [
  "noema",
  "aaronnote",
  "aaronnotes",
  "codemirror",
  "katex",
  "latex",
  "lean",
  "leanprover",
  "markdown",
  "roam",
  "typora",
  "tikz",
  "tex",
  "todo",
  "todos",
  "idlink",
  "infoview",
  "mathlib",
  "qubit",
  "qubits",
  "qudit",
  "qudits",
  "hilbert",
  "hamiltonian",
  "lindblad",
  "lindbladian",
  "povm",
  "cptp",
  "qaoa",
  "nisq",
  "qubo",
];

const ACCEPTED_WORDS = new Set(AARONNOTE_ACCEPTED_WORDS.map((word) => word.toLowerCase()));

function maskRange(chars, from, to) {
  const start = Math.max(0, from);
  const end = Math.min(chars.length, to);
  for (let i = start; i < end; i++) {
    if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
  }
}

function unmaskRange(chars, source, from, to) {
  const start = Math.max(0, from);
  const end = Math.min(chars.length, to);
  for (let i = start; i < end; i++) chars[i] = source[i];
}

function lineRanges(text) {
  const ranges = [];
  let from = 0;
  while (from <= text.length) {
    const newline = text.indexOf("\n", from);
    const to = newline < 0 ? text.length : newline;
    ranges.push({ from, to, lineEnd: newline < 0 ? to : newline + 1, text: text.slice(from, to) });
    if (newline < 0) break;
    from = newline + 1;
  }
  return ranges;
}

function maskFencedCodeBlocks(text, chars) {
  const fenceRe = /^([ \t]*)(`{3,}|~{3,})/;
  let openFence = null;
  let openFrom = 0;
  for (const line of lineRanges(text)) {
    const match = line.text.match(fenceRe);
    if (!openFence && match) {
      openFence = match[2][0];
      openFrom = line.from;
      continue;
    }
    if (openFence && match && match[2][0] === openFence) {
      maskRange(chars, openFrom, line.lineEnd);
      openFence = null;
    }
  }
  if (openFence) maskRange(chars, openFrom, text.length);
}

function maskBlockMath(text, chars) {
  maskDelimited(text, chars, "$$", "$$");
}

function maskDelimited(text, chars, open, close) {
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf(open, from);
    if (start < 0) break;
    const end = text.indexOf(close, start + open.length);
    const to = end < 0 ? text.length : end + close.length;
    maskRange(chars, start, to);
    from = to;
  }
}

function maskFrontMatter(text, chars) {
  const lines = lineRanges(text);
  if (!lines.length || !/^\ufeff?---[ \t]*$/.test(lines[0].text)) return;
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i].text)) {
      maskRange(chars, 0, lines[i].lineEnd);
      return;
    }
  }
}

function maskLatexEnvironments(text, chars) {
  const tokenRe = /\\(begin|end)\{([A-Za-z*]+)\}/g;
  const stack = [];
  let match;
  while ((match = tokenRe.exec(text)) !== null) {
    if (match[1] === "begin") {
      stack.push({ name: match[2], from: match.index });
      continue;
    }
    const open = stack.at(-1);
    if (open?.name === match[2]) {
      stack.pop();
      if (!stack.length) maskRange(chars, open.from, tokenRe.lastIndex);
    }
  }
  if (stack.length) maskRange(chars, stack[0].from, text.length);
}

function maskMarkdownLinks(text, chars) {
  const linkRe = /(!?)\[([^\]\n]*)\]\(([^)\n]*)\)/g;
  let match;
  while ((match = linkRe.exec(text)) !== null) {
    if (match[1]) {
      maskRange(chars, match.index, linkRe.lastIndex);
      continue;
    }
    const labelFrom = match.index + 1;
    const labelTo = labelFrom + match[2].length;
    maskRange(chars, match.index, labelFrom);
    maskRange(chars, labelTo, linkRe.lastIndex);
  }
}

function maskDocumentSyntax(text, chars) {
  maskRegex(text, chars, /<!--[\s\S]*?-->/g);
  maskRegex(text, chars, /^[ \t]*#\+(?!begin(?:_|\s)|end(?:_|\s)).*$/gim);
  maskRegex(text, chars, /^[ \t]*:[A-Za-z][\w-]*:[ \t]+.*$/gm);
  maskRegex(text, chars, /^[ \t]*\[[^\]\n]+\]:[ \t]+\S+.*$/gm);
}

function maskOrgEnvBlocks(text, chars) {
  const lines = lineRanges(text);
  let active = null;
  for (const line of lines) {
    if (!active) {
      const open = line.text.match(/^[ \t]*#\+[ \t]*begin(?:_|\s+)([A-Za-z][\w-]*)\b/i);
      if (!open) continue;
      const kind = open[1].toLowerCase();
      active = { kind, from: line.from, bodyFrom: line.lineEnd, prose: !TECHNICAL_ORG_ENV_KINDS.has(kind) };
      maskRange(chars, line.from, line.lineEnd);
      continue;
    }

    const closeRe = new RegExp(`^[ \\t]*#\\+[ \\t]*end(?:_|\\s+)${active.kind}\\s*$`, "i");
    if (!closeRe.test(line.text)) continue;
    if (!active.prose) maskRange(chars, active.from, line.lineEnd);
    else maskRange(chars, line.from, line.lineEnd);
    active = null;
  }
  if (active && !active.prose) maskRange(chars, active.from, text.length);
}

function maskRegex(text, chars, re) {
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    maskRange(chars, match.index, match.index + match[0].length);
    if (match[0].length === 0) re.lastIndex++;
  }
}

function maskInlineCommands(text, chars) {
  for (const command of scanInlineCommands(text)) {
    if (command.name === "revision") {
      maskRange(chars, command.fullFrom, command.fullTo);
      unmaskRange(chars, text, command.contextFrom, command.contextTo);
      const commandSource = text.slice(command.fullFrom, command.fullTo);
      for (const match of commandSource.matchAll(/\b(?:advice|reason)\s*:\s*"((?:[^"\\]|\\.)*)"/gi)) {
        if (match.index === undefined) continue;
        const value = match[1] || "";
        const valueOffset = match[0].indexOf(value);
        const from = command.fullFrom + match.index + valueOffset;
        unmaskRange(chars, text, from, from + value.length);
      }
    } else if (PROSE_INLINE_COMMANDS.has(command.name)) {
      maskRange(chars, command.fullFrom, command.contextFrom);
      maskRange(chars, command.contextTo, command.fullTo);
    } else {
      maskRange(chars, command.fullFrom, command.fullTo);
    }
  }
}

export function maskAaronnoteProse(text) {
  const source = String(text || "");
  const chars = source.split("");

  maskFrontMatter(source, chars);
  maskFencedCodeBlocks(source, chars);
  maskBlockMath(source, chars);
  maskDelimited(source, chars, "\\(", "\\)");
  maskDelimited(source, chars, "\\[", "\\]");
  maskLatexEnvironments(source, chars);
  maskOrgEnvBlocks(source, chars);
  maskInlineCommands(source, chars);
  maskDocumentSyntax(source, chars);

  maskRegex(source, chars, /`[^`\n]+`/g);
  maskRegex(source, chars, /(?<![A-Za-z0-9_$])\$(?![\s$])([^$\n]*?\S)\$(?![A-Za-z0-9_$])/g);
  maskMarkdownLinks(source, chars);
  maskRegex(source, chars, /\b(?:https?|file|mailto):[^\s<>)]+/gi);
  maskRegex(source, chars, /\\[A-Za-z]+(?:\*?\s*(?:\[[^\]\n]*\]|\{[^}\n]*\}))*/g);
  maskRegex(source, chars, /<\/?[A-Za-z][^>\n]*>/g);
  maskRegex(source, chars, /&[A-Za-z][A-Za-z0-9]+;/g);

  return chars.join("");
}

export function lineStartOffsets(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

export function offsetFromLineColumn(text, line, column) {
  const starts = lineStartOffsets(text);
  const lineIndex = Math.max(0, Math.min(starts.length - 1, Number(line) - 1));
  const start = starts[lineIndex] ?? 0;
  const nextStart = starts[lineIndex + 1] ?? text.length + 1;
  const lineEnd = Math.max(start, nextStart - 1);
  return Math.max(start, Math.min(lineEnd, start + Math.max(0, Number(column) - 1)));
}

export function rangeHasCheckedText(masked, from, to) {
  return /\S/.test(masked.slice(Math.max(0, from), Math.min(masked.length, to)));
}

export function collectBrowserSpellWords(masked, limit = 2500) {
  const words = new Map();
  const re = /[A-Za-z][A-Za-z'’-]{2,}/g;
  let match;
  while ((match = re.exec(masked)) !== null) {
    const raw = match[0].replace(/^[’'-]+|[’'-]+$/g, "");
    if (!raw || raw.length < 3) continue;
    if (raw.length > 64) continue;
    if (/^[A-Z]{2,}$/.test(raw)) continue;
    if (ACCEPTED_WORDS.has(raw.toLowerCase())) continue;
    const entry = words.get(raw) ?? { word: raw, ranges: [] };
    entry.ranges.push({ from: match.index, to: match.index + match[0].length });
    words.set(raw, entry);
    if (words.size >= limit) break;
  }
  return [...words.values()];
}
