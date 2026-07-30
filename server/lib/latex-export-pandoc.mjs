import { spawn } from "node:child_process";
import { scanInlineCommands } from "../../shared/command-syntax.mjs";
import { LATEX_MARKS, latexMark } from "../../shared/latex-marks.mjs";
import { citeLatex, convertInline, escapeLatexTitle, isDisplayCommentCommand, revisionLatex } from "./latex-export.mjs";

const ENV_MAP = new Map([
  ["definition", "definition"], ["define", "definition"],
  ["theorem", "theorem"], ["lemma", "lemma"],
  ["proposition", "proposition"], ["corollary", "corollary"],
  ["proof", "proof"], ["remark", "remark"], ["example", "example"],
]);
const REMARK_BLOCKS = new Set(["comment", "summary", "note", "important", "warning", "attention", "fold"]);
const HIDDEN_BLOCKS = new Set(["lean4", "src", "source", "meta"]);
const PRIVATE_INLINE = new Set(["todo", "itodo", "project", "milestone", "clock", "comment", "cell", "lean4", "note-code"]);
const PRIVATE_COMMAND_LINE_RE = /^\s*@@(?:todo|itodo|project|milestone|clock|comment|cell|lean4|note-code)\b/i;

export { LATEX_MARKS };

function rawLatexInline(latex) {
  const longest = Math.max(0, ...[...String(latex || "").matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${latex}${ticks}{=latex}`;
}

function rawLatexBlock(latex) {
  return `\n\n\`\`\`{=latex}\n${latex}\n\`\`\`\n\n`;
}

function yamlScalar(value) {
  const raw = String(value || "").trim();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch {}
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw.replace(/\s+#.*$/, "").trim();
}

function parseYamlFrontMatter(lines) {
  if (!/^\ufeff?---\s*$/.test(lines[0] || "")) return { meta: {}, end: -1 };
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[index])) { end = index; break; }
  }
  if (end < 0 || !lines.slice(1, end).some((line) => /^[A-Za-z0-9_-]+\s*:/.test(line))) return { meta: {}, end: -1 };
  const meta = {};
  for (let index = 1; index < end; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key !== "title" && key !== "date") continue;
    if (match[2] === ">" || match[2] === "|") {
      const parts = [];
      while (index + 1 < end && /^(?:\s+|$)/.test(lines[index + 1])) parts.push(lines[++index].trim());
      meta[key] = match[2] === ">" ? parts.join(" ").trim() : parts.join("\n").trim();
    } else meta[key] = yamlScalar(match[2]);
  }
  return { meta, end };
}

function parseMeta(lines, initial = {}) {
  const meta = { ...initial };
  let active = false;
  for (const line of lines) {
    if (/^#\+begin\s+meta\s*$/i.test(line)) { active = true; continue; }
    if (active && /^#\+end\s+meta\s*$/i.test(line)) break;
    if (!active) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) meta[match[1].toLowerCase()] = match[2].trim();
  }
  return meta;
}

function orgOpen(line) {
  const match = String(line || "").match(/^#\+\s*begin\s+([A-Za-z0-9_-]+)\s*(.*)$/i);
  return match ? { kind: match[1].toLowerCase(), title: match[2].trim() } : null;
}

function orgClose(line) {
  return String(line || "").match(/^#\+\s*end\s+([A-Za-z0-9_-]+)\s*$/i)?.[1]?.toLowerCase() || "";
}

function environmentFor(kind, rules) {
  const extra = rules?.envMap && typeof rules.envMap === "object" ? rules.envMap[kind] : "";
  return String(extra || ENV_MAP.get(kind) || "").trim();
}

function environmentOpen(kind, title, options) {
  let env = environmentFor(kind, options.rules);
  let heading = title;
  const extraRemarks = new Set(Array.isArray(options.rules?.commentBlocks) ? options.rules.commentBlocks.map((value) => String(value).toLowerCase()) : []);
  if (!env && (REMARK_BLOCKS.has(kind) || extraRemarks.has(kind))) {
    env = "remark";
    if (kind !== "fold") heading ||= kind;
  }
  if (!env) return { latex: `\\begin{quote}\n\\textbf{${escapeLatexTitle(title ? `${kind}: ${title}` : kind)}}\\par`, env: "quote" };
  let label = heading ? escapeLatexTitle(heading, options) : "";
  if (kind === "proof" && label && !/^proof\b/i.test(heading)) {
    const direction = heading === "=>" ? "\\(\\Rightarrow\\)" : heading === "<=" ? "\\(\\Leftarrow\\)" : label;
    label = `Proof (${direction})`;
  }
  return { latex: `\\begin{${env}}${label ? `[${label}]` : ""}`, env };
}

function validateLatexMark(command, lineText, context = {}) {
  const key = command.switchValue.trim().toLowerCase();
  const spec = latexMark(key);
  if (!spec) throw new Error(`Unknown @@latexmk mark: ${key || "(empty)"}`);
  const trimmed = lineText.trim();
  const onlyMarker = trimmed === lineText.slice(command.fullFrom, command.fullTo);
  if ((spec.placement === "block" || spec.placement === "block-once") && !onlyMarker) throw new Error(`@@latexmk(${key}) must be alone on its line`);
  if (spec.placement === "prefix" && (lineText.slice(0, command.fullFrom).trim() || context.atParagraphStart === false)) {
    throw new Error(`@@latexmk(${key}) must appear at the start of a paragraph`);
  }
  const adjacentMark = visibleLatexMarkCommands(lineText).some((other) => other.fullFrom !== command.fullFrom
    && ((other.fullTo <= command.fullFrom && !lineText.slice(other.fullTo, command.fullFrom).trim())
      || (other.fullFrom >= command.fullTo && !lineText.slice(command.fullTo, other.fullFrom).trim())));
  if (spec.placement === "between" && adjacentMark) throw new Error(`@@latexmk(${key}) must sit between visible inline content`);
  const visibleBefore = withoutVisibleLatexMarks(lineText.slice(0, command.fullFrom)).trim();
  const visibleAfter = withoutVisibleLatexMarks(lineText.slice(command.fullTo)).trim();
  if (spec.placement === "between" && (!visibleBefore || (!visibleAfter && context.nextLineVisible !== true))) {
    throw new Error(`@@latexmk(${key}) must sit between visible inline content`);
  }
  return { key, spec };
}

function transformInlineCommands(line, options, context = {}) {
  line = stripPrivateCommandsFromLinkLabels(line);
  const protectedRanges = protectedInlineRanges(line);
  const commands = scanInlineCommands(line)
    .filter((command) => !protectedRanges.some((range) => command.fullFrom >= range.from && command.fullFrom < range.to))
    .filter((command) => PRIVATE_INLINE.has(command.name) || command.name === "scomment" || command.name === "revision" || command.name === "cite" || command.name === "tag" || command.name === "latexmk");
  if (commands.length === 0) return line;
  let out = "";
  let cursor = 0;
  for (const command of commands) {
    if (command.fullFrom < cursor) continue;
    out += line.slice(cursor, command.fullFrom);
    if (command.name === "scomment") out += rawLatexInline(`\\sidecomment{${convertInline(command.context, options)}}`);
    else if (command.name === "revision") out += rawLatexInline(revisionLatex(command, options));
    else if (command.name === "comment") out += rawLatexInline(`\\aaroncomment{${convertInline(command.context, options)}}`);
    else if (command.name === "cite") {
      const citation = citeLatex(command, options);
      if (!citation) {
        const namespace = String(command.switchValue || "").trim();
        const key = String(command.context || "").trim() || "?";
        const visible = namespace ? `${namespace}:${key}` : key;
        if (Array.isArray(options.unresolvedCitations)) options.unresolvedCitations.push(visible);
        out += rawLatexInline(`\\textnormal{[${escapeLatexTitle(visible)}]}`);
      } else out += rawLatexInline(citation);
    } else if (command.name === "tag") {
      const anchor = command.context.trim().replace(/[^A-Za-z0-9:_.-]+/g, "-");
      if (anchor) out += rawLatexInline(`\\hypertarget{${anchor}}{}`);
    }
    else if (command.name === "latexmk") {
      const { spec } = validateLatexMark(command, line, context);
      out += rawLatexInline(spec.latex);
    }
    cursor = command.fullTo;
  }
  return out + line.slice(cursor);
}

function stripPrivateCommandsFromLinkLabels(line) {
  return String(line || "").replace(/(!?\[)([^\n]*)\]\(/g, (whole, open, label) => {
    const commands = scanInlineCommands(label)
      .filter((command) => PRIVATE_INLINE.has(command.name) && !isDisplayCommentCommand(command));
    let result = String(label);
    for (let index = commands.length - 1; index >= 0; index -= 1) {
      const command = commands[index];
      result = result.slice(0, command.fullFrom) + result.slice(command.fullTo);
    }
    return `${open}${result} ](`.replace(" ](", "](");
  });
}

function protectedInlineRanges(line) {
  const ranges = [];
  if (/^ {0,3}\[[^\]\n]+\]:/.test(line)) ranges.push({ from: 0, to: line.length });
  for (const match of line.matchAll(/(`+)[\s\S]*?\1/g)) ranges.push({ from: match.index, to: match.index + match[0].length });
  for (const match of line.matchAll(/\\\([^\n]*?\\\)|(?<!\\)\$[^$\n]+?(?<!\\)\$/g)) ranges.push({ from: match.index, to: match.index + match[0].length });
  ranges.push(...markdownLinkRanges(line));
  for (const match of line.matchAll(/<[^>\n]+>/g)) ranges.push({ from: match.index, to: match.index + match[0].length });
  return ranges;
}

function markdownLinkRanges(line) {
  const source = String(line || "");
  const ranges = [];
  for (let start = 0; start < source.length; start += 1) {
    const image = source[start] === "!" && source[start + 1] === "[";
    if (!image && source[start] !== "[") continue;
    const bracketStart = start + (image ? 1 : 0);
    let bracketDepth = 1;
    let cursor = bracketStart + 1;
    let escaped = false;
    for (; cursor < source.length && bracketDepth > 0; cursor += 1) {
      const char = source[cursor];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === "[") bracketDepth += 1;
      else if (char === "]") bracketDepth -= 1;
    }
    if (bracketDepth !== 0 || source[cursor] !== "(") continue;
    const destinationFrom = cursor;
    let parenDepth = 1;
    cursor += 1;
    escaped = false;
    for (; cursor < source.length && parenDepth > 0; cursor += 1) {
      const char = source[cursor];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === "(") parenDepth += 1;
      else if (char === ")") parenDepth -= 1;
    }
    if (parenDepth === 0) {
      ranges.push({ from: destinationFrom, to: cursor });
      start = cursor - 1;
    }
  }
  return ranges;
}

function markdownContainerLine(line) {
  const source = String(line || "");
  let content = source;
  let quoteDepth = 0;
  while (true) {
    const match = content.match(/^ {0,3}>[ \t]?/);
    if (!match) break;
    content = content.slice(match[0].length);
    quoteDepth += 1;
  }
  return { content, quoteDepth, prefix: source.slice(0, source.length - content.length) };
}

function semanticCommandOnLine(line) {
  const content = String(line || "");
  const command = scanInlineCommands(content).find((candidate) => candidate.name === "section" || candidate.name === "part");
  if (!command || content.slice(0, command.fullFrom).trim() || content.slice(command.fullTo).trim()) return null;
  return semanticMarkdownLevel(command) ? command : null;
}

function scanPrivateBraces(text, initial = { depth: 0, quote: "" }) {
  let depth = Math.max(0, Number(initial.depth) || 0);
  let quote = String(initial.quote || "");
  let escaped = false;
  const source = String(text || "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "{") depth += 1;
    else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) return { state: { depth, quote: "" }, closeAt: index };
    }
  }
  return { state: { depth, quote }, closeAt: -1 };
}

function multilinePrivateStart(line) {
  for (const command of visiblePrivateCommands(line)) {
    const remainder = String(line || "").slice(command.fullTo);
    if (!/^\s*\{/.test(remainder)) continue;
    const scanned = scanPrivateBraces(remainder);
    if (scanned.state.depth > 0) return { command, state: scanned.state };
  }
  return null;
}

function continuePrivatePlanning(line, state) {
  const container = markdownContainerLine(line);
  const scanned = scanPrivateBraces(container.content, state);
  if (scanned.closeAt < 0) return { closed: false, state: scanned.state, line: "" };
  // Quote prefixes and indentation before the closing brace are Markdown
  // structure, not private payload. Keep them when public prose follows `}`.
  const indent = container.content.slice(0, scanned.closeAt).match(/^[ \t]*/)?.[0] || "";
  return {
    closed: true,
    state: null,
    line: `${container.prefix}${indent}${container.content.slice(scanned.closeAt + 1)}`,
  };
}

function containsSemanticOutline(lines, frontMatterEnd, hiddenKinds) {
  let fence = null;
  let displayMath = null;
  let hidden = null;
  let hiddenDepth = 0;
  let privatePlanning = null;
  for (let index = frontMatterEnd + 1; index < lines.length; index += 1) {
    let line = lines[index];
    let container = markdownContainerLine(line);
    if (privatePlanning) {
      const continued = continuePrivatePlanning(line, privatePlanning);
      privatePlanning = continued.state;
      if (!continued.closed) continue;
      line = continued.line;
      container = markdownContainerLine(line);
      if (!container.content.trim()) continue;
    }
    if (hidden) {
      if (orgOpen(line)?.kind === hidden) hiddenDepth += 1;
      if (orgClose(line) === hidden && --hiddenDepth === 0) hidden = null;
      continue;
    }
    if (fence && container.quoteDepth !== fence.quoteDepth) fence = null;
    if (fence) {
      const close = container.content.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && container.quoteDepth === fence.quoteDepth && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = container.content.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) { fence = { char: open[1][0], length: open[1].length, quoteDepth: container.quoteDepth }; continue; }
    if (displayMath && container.quoteDepth !== displayMath.quoteDepth) displayMath = null;
    if (displayMath) {
      if (container.quoteDepth === displayMath.quoteDepth && /^\s*(?:\\\]|\$\$)\s*$/.test(container.content)) displayMath = null;
      continue;
    }
    if (/^\s*(?:\\\[|\$\$)\s*$/.test(container.content)) { displayMath = { quoteDepth: container.quoteDepth }; continue; }
    if (/^(?: {4}|\t)/.test(container.content)) continue;
    const begin = orgOpen(line);
    if (begin && hiddenKinds.has(begin.kind)) { hidden = begin.kind; hiddenDepth = 1; continue; }
    const multilinePrivate = multilinePrivateStart(line);
    if (multilinePrivate) { privatePlanning = multilinePrivate.state; continue; }
    if (privateCommandLine(line)) continue;
    if (semanticCommandOnLine(line)) return true;
  }
  return false;
}

function visibleLatexMarkCommands(line) {
  const protectedRanges = protectedInlineRanges(line);
  return scanInlineCommands(line, "latexmk")
    .filter((command) => !protectedRanges.some((range) => command.fullFrom >= range.from && command.fullFrom < range.to));
}

function withoutVisibleLatexMarks(line) {
  const commands = visibleLatexMarkCommands(line);
  let output = String(line || "");
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    output = output.slice(0, command.fullFrom) + output.slice(command.fullTo);
  }
  return output;
}

function visiblePrivateCommands(line) {
  const protectedRanges = protectedInlineRanges(line);
  return scanInlineCommands(line)
    .filter((command) => PRIVATE_INLINE.has(command.name))
    .filter((command) => !isDisplayCommentCommand(command))
    .filter((command) => !protectedRanges.some((range) => command.fullFrom >= range.from && command.fullFrom < range.to));
}

function privateCommandLine(line) {
  if (!PRIVATE_COMMAND_LINE_RE.test(line)) return false;
  const command = scanInlineCommands(String(line || "").trim())[0];
  return !isDisplayCommentCommand(command);
}

function semanticMarkdownLevel(command) {
  if (command.name === "part") return 1;
  const levels = { "": 2, sec: 2, section: 2, sub: 3, subsub: 4, subsubsub: 5 };
  const key = String(command.switchValue || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(levels, key) ? levels[key] : 0;
}

function subparagraphLatex(rawTitle, options) {
  let title = String(rawTitle || "").replace(/[ \t]+#+[ \t]*$/, "").trim();
  const attr = title.match(/[ \t]+\{#([^}]+)\}[ \t]*$/);
  if (attr) title = title.slice(0, attr.index).trim();
  const id = String(attr?.[1] || "").replace(/[^A-Za-z0-9:_.-]+/g, "-");
  return `\\subparagraph{${convertInline(title, options)}}${id ? `\\label{${id}}` : ""}`;
}

function canonicalMathForPandoc(line) {
  let out = "";
  let cursor = 0;
  while (cursor < line.length) {
    if (line[cursor] === "`") {
      const ticks = line.slice(cursor).match(/^`+/)?.[0] || "`";
      const close = line.indexOf(ticks, cursor + ticks.length);
      const end = close < 0 ? line.length : close + ticks.length;
      out += line.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (line.startsWith("\\(", cursor)) {
      const close = line.indexOf("\\)", cursor + 2);
      if (close >= 0) {
        out += rawLatexInline(line.slice(cursor, close + 2));
        cursor = close + 2;
        continue;
      }
    }
    out += line[cursor];
    cursor += 1;
  }
  return out;
}

export function extractAaronnoteMetadata(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const frontMatter = parseYamlFrontMatter(lines);
  return parseMeta(lines, frontMatter.meta);
}

export function preprocessAaronnoteForPandoc(markdown, options = {}) {
  const source = String(markdown || "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const frontMatter = parseYamlFrontMatter(lines);
  const meta = extractAaronnoteMetadata(source);
  const hiddenKinds = new Set([...HIDDEN_BLOCKS, ...(Array.isArray(options.rules?.hiddenBlocks) ? options.rules.hiddenBlocks.map((value) => String(value).toLowerCase()) : [])]);
  const hasSemanticOutline = containsSemanticOutline(lines, frontMatter.end, hiddenKinds);
  const output = [];
  const stack = [];
  let hidden = null;
  let hiddenDepth = 0;
  let fence = null;
  let displayMath = null;
  let rawTikz = false;
  let privatePlanning = null;
  let htmlComment = false;
  const singletonMarks = new Set();
  const unresolvedCitations = [];
  const conversionOptions = { ...options, unresolvedCitations };

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    const lineNumber = index + 1;
    const atParagraphStart = index === 0 || !lines[index - 1].trim();
    const markContext = { atParagraphStart, nextLineVisible: Boolean(lines[index + 1]?.trim()) };
    let container = markdownContainerLine(line);
    if (index <= frontMatter.end) continue;
    if (privatePlanning) {
      const continued = continuePrivatePlanning(line, privatePlanning);
      privatePlanning = continued.state;
      if (!continued.closed) continue;
      line = continued.line;
      container = markdownContainerLine(line);
      if (!container.content.trim()) continue;
    }
    if (hidden) {
      if (orgOpen(line)?.kind === hidden) hiddenDepth += 1;
      if (orgClose(line) === hidden && --hiddenDepth === 0) hidden = null;
      continue;
    }
    if (rawTikz) {
      if (orgClose(line) === "tikz") {
        output.push("\\end{tikzpicture}", "\\end{center}", "```", "");
        rawTikz = false;
      } else output.push(line);
      continue;
    }
    if (fence && container.quoteDepth !== fence.quoteDepth) {
      output.push(`${fence.prefix}${fence.char.repeat(fence.length)}`);
      fence = null;
    }
    if (fence) {
      const close = container.content.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && container.quoteDepth === fence.quoteDepth && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      output.push(line);
      continue;
    }
    const fenceMatch = container.content.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length, quoteDepth: container.quoteDepth, prefix: container.prefix };
      output.push(line);
      continue;
    }
    if (displayMath && container.quoteDepth !== displayMath.quoteDepth) {
      output.push(`${displayMath.prefix}$$`);
      displayMath = null;
    }
    if (!displayMath && /^\s*(?:\\\[|\$\$)\s*$/.test(container.content)) {
      displayMath = { quoteDepth: container.quoteDepth, prefix: container.prefix };
      output.push(`${container.prefix}$$`);
      continue;
    }
    if (displayMath && container.quoteDepth === displayMath.quoteDepth && /^\s*(?:\\\]|\$\$)\s*$/.test(container.content)) {
      displayMath = null;
      output.push(`${container.prefix}$$`);
      continue;
    }
    if (displayMath) { output.push(line); continue; }

    // Pandoc owns indented code/list continuation parsing. Never execute an
    // Noema command merely because its literal text occurs after 4 spaces.
    if (/^(?: {4}|\t)/.test(container.content)) { output.push(line); continue; }

    if (htmlComment) {
      const closeComment = line.indexOf("-->");
      if (closeComment < 0) {
        output.push(line);
      } else {
        htmlComment = false;
        const comment = line.slice(0, closeComment + 3);
        const suffix = line.slice(closeComment + 3);
        const transformedSuffix = transformInlineCommands(suffix, conversionOptions, markContext);
        output.push(`${comment}${canonicalMathForPandoc(transformedSuffix)}`);
      }
      continue;
    }
    const openComment = line.indexOf("<!--");
    if (openComment >= 0 && line.indexOf("-->", openComment + 4) < 0) {
      const prefix = transformInlineCommands(line.slice(0, openComment), conversionOptions, markContext);
      output.push(`${canonicalMathForPandoc(prefix)}${line.slice(openComment)}`);
      htmlComment = true;
      continue;
    }

    if (/^\s*\[(?:toc|TOC)\]\s*$/.test(line)) continue;

    const multilinePrivate = multilinePrivateStart(line);
    if (multilinePrivate) {
      privatePlanning = multilinePrivate.state;
      const visiblePrefix = transformInlineCommands(line.slice(0, multilinePrivate.command.fullTo), conversionOptions, { atParagraphStart });
      if (markdownContainerLine(visiblePrefix).content.trim()) output.push(canonicalMathForPandoc(visiblePrefix));
      continue;
    }

    if (privateCommandLine(line)) {
      continue;
    }
    const semantic = semanticCommandOnLine(line);
    if (semantic) {
      const level = semanticMarkdownLevel(semantic);
      const id = String(semantic.args?.id || "").trim().replace(/[^A-Za-z0-9:_.-]+/g, "-");
      output.push(`${"#".repeat(level)} ${semantic.context.trim()}${id ? ` {#${id}}` : ""}`);
      continue;
    }
    if (hasSemanticOutline) {
      const atx = line.match(/^( {0,3})(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/);
      if (atx) {
        output.push(rawLatexBlock(subparagraphLatex(atx[3] || "", conversionOptions)));
        continue;
      }
      if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line) && index > 0 && lines[index - 1].trim()
          && !/^\s*(?:#{1,6}(?:\s|$)|>|[-+*]\s|\d+[.)]\s|@@|#\+)/.test(lines[index - 1]) && output.length > 0) {
        output.pop();
        output.push(rawLatexBlock(subparagraphLatex(lines[index - 1], conversionOptions)));
        continue;
      }
    }

    const begin = orgOpen(line);
    if (begin) {
      if (hiddenKinds.has(begin.kind)) { hidden = begin.kind; hiddenDepth = 1; continue; }
      if (begin.kind === "tikz") {
        output.push("", "```{=latex}", "\\begin{center}", "\\begin{tikzpicture}");
        rawTikz = true;
        continue;
      }
      const opened = environmentOpen(begin.kind, begin.title, conversionOptions);
      stack.push({ kind: begin.kind, env: opened.env, line: lineNumber });
      output.push(rawLatexBlock(opened.latex));
      continue;
    }
    const close = orgClose(line);
    if (close) {
      const opened = stack.pop();
      if (!opened || opened.kind !== close) throw new Error(`Mismatched Noema block on line ${lineNumber}`);
      output.push(rawLatexBlock(`\\end{${opened.env}}`));
      continue;
    }
    for (const command of visibleLatexMarkCommands(line)) {
      const { key, spec } = validateLatexMark(command, line, markContext);
      if (spec.placement === "block-once" && singletonMarks.has(key)) throw new Error(`@@latexmk(${key}) may appear only once`);
      if (spec.placement === "block-once") singletonMarks.add(key);
    }
    const callout = line.match(/^(\s*>\s*)\[!([A-Za-z]+)\](?:\s+(.+))?\s*$/);
    if (callout) {
      const label = String(callout[3] || callout[2]).trim();
      output.push(`${callout[1]}**${label}**`);
      continue;
    }
    const transformed = transformInlineCommands(line, conversionOptions, markContext);
    output.push(canonicalMathForPandoc(transformed));
  }
  if (fence) output.push(`${fence.prefix}${fence.char.repeat(fence.length)}`);
  if (displayMath) throw new Error("Unclosed display math");
  if (hidden) throw new Error(`Unclosed hidden Noema block: ${hidden}`);
  if (privatePlanning) throw new Error("Unclosed Noema planning block");
  if (htmlComment) throw new Error("Unclosed HTML comment");
  if (rawTikz) throw new Error("Unclosed Noema block: tikz");
  if (stack.length) throw new Error(`Unclosed Noema block: ${stack.at(-1).kind}`);
  return {
    meta,
    markdown: output.join("\n"),
    warnings: [...new Set(unresolvedCitations)].map((key) => `Unresolved Noema citation kept visibly: ${key}`),
    features: {
      usesSideComment: output.some((line) => line.includes("\\sidecomment{")),
      usesTikz: output.some((line) => line.includes("tikzpicture")),
    },
  };
}

export function academicLatexPostprocess(latex) {
  const codeBlocks = [];
  const protectedSource = String(latex || "").replace(
    /\\begin\{(verbatim\*?|Verbatim|BVerbatim|LVerbatim|SaveVerbatim|lstlisting|minted|Highlighting)\}[\s\S]*?\\end\{\1\}/g,
    (block) => {
      const token = `\uE100AARONNOTECODEBLOCK${codeBlocks.length}\uE101`;
      codeBlocks.push(block);
      return token;
    },
  );
  const normalized = protectedSource
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim() + "\n";
  return normalized.replace(/\uE100AARONNOTECODEBLOCK(\d+)\uE101/g,
    (_match, index) => codeBlocks[Number(index)] || "");
}

function runPandoc(bin, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd || process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const limit = 32 * 1024 * 1024;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      const error = new Error("LaTeX export canceled");
      error.name = "AbortError";
      finish(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Pandoc timed out"));
    }, options.timeoutMs || 120_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > limit) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > limit) stderr = stderr.slice(-limit);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (options.signal?.aborted) return onAbort();
      if (code === 0 && stdout.length <= limit) finish(null, stdout);
      else finish(new Error(stderr.trim() || `pandoc exited ${code}`));
    });
    if (options.signal) {
      if (options.signal.aborted) { onAbort(); return; }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdin.end(input, "utf8");
  });
}

export async function aaronnoteMarkdownToLatexPandoc(markdown, options = {}) {
  const prepared = preprocessAaronnoteForPandoc(markdown, options);
  const pandocBin = String(options.pandocBin || "pandoc").trim();
  const maintainedExtensions = Array.isArray(options.rules?.pandocExtensions)
    ? options.rules.pandocExtensions.map((value) => String(value).trim()).filter((value) => /^[A-Za-z0-9_]+$/.test(value))
    : [];
  const extensions = [
    "markdown", "fancy_lists", "task_lists", "definition_lists", "footnotes",
    "strikeout", "pipe_tables", "table_captions", "raw_attribute", "raw_tex",
    "tex_math_dollars", "autolink_bare_uris", "bracketed_spans", "superscript", "subscript", "east_asian_line_breaks", ...maintainedExtensions,
  ].join("+");
  const from = `${extensions}-implicit_figures-smart-citations`;
  let stdout;
  try {
    stdout = await runPandoc(pandocBin, [
      `--from=${from}`, "--to=latex", "--wrap=none", "--syntax-highlighting=none",
      "--top-level-division=section",
    ], prepared.markdown, { cwd: options.sourceDir || process.cwd(), timeoutMs: options.timeoutMs, signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted || error?.name === "AbortError") throw error;
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`Pandoc Markdown→LaTeX conversion failed: ${detail}`);
  }
  return { meta: prepared.meta, body: academicLatexPostprocess(stdout), features: prepared.features, warnings: prepared.warnings, preprocessedMarkdown: prepared.markdown };
}
