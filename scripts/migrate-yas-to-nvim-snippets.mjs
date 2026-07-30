#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const defaultSources = [
  { label: "Noema", root: join(repoRoot, "snippets") },
  { label: "Emacs", root: join(homedir(), ".config", "emacs", "snippets") },
];
const defaultOutputDir = join(homedir(), ".config", "nvim", "snippets");

const modeMap = new Map([
  ["markdown-mode", "markdown"],
  ["org-mode", "markdown"],
  ["fundamental-mode", "markdown"],
  ["tex-mode", "tex"],
  ["lean4-mode", "lean"],
  ["typst-ts-mode", "typst"],
  ["python-mode", "python"],
  ["python-ts-mode", "python"],
  ["json-mode", "json"],
  ["sh-mode", "sh"],
  ["rust-mode", "rust"],
  ["java-mode", "java"],
  ["sql-mode", "sql"],
  ["nxml-mode", "html"],
  ["html-mode", "html"],
  ["yaml-mode", "yaml"],
  ["vue-mode", "vue"],
  ["vue-html-mode", "vue"],
  ["restclient-mode", "http"],
  ["go-mode", "go"],
  ["lua-mode", "lua"],
  ["gitconfig-mode", "gitconfig"],
  ["c-mode", "c"],
  ["c++-mode", "cpp"],
]);

function usage() {
  return [
    "Usage: node scripts/migrate-yas-to-nvim-snippets.mjs [--write] [--dry-run] [--output-dir DIR] [--source LABEL=DIR]",
    "",
    "Reads Noema/Emacs YAS-style snippets and merges them into VS Code JSON",
    "snippet files for blink.cmp under ~/.config/nvim/snippets by default.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { write: false, dryRun: false, outputDir: defaultOutputDir, sources: [...defaultSources] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") args.write = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--output-dir") {
      args.outputDir = resolve(String(argv[++i] || ""));
    } else if (arg.startsWith("--output-dir=")) {
      args.outputDir = resolve(arg.slice("--output-dir=".length));
    } else if (arg === "--source") {
      args.sources.push(parseSource(argv[++i]));
    } else if (arg.startsWith("--source=")) {
      args.sources.push(parseSource(arg.slice("--source=".length)));
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (args.dryRun) args.write = false;
  return args;
}

function parseSource(raw) {
  const text = String(raw || "");
  const eq = text.indexOf("=");
  if (eq <= 0) throw new Error(`--source must be LABEL=DIR, got: ${text}`);
  return { label: text.slice(0, eq), root: resolve(text.slice(eq + 1)) };
}

async function walk(dir, out = []) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) await walk(file, out);
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function shouldSkipFile(file) {
  const name = basename(file);
  return name.startsWith(".")
    || name.endsWith(".el")
    || name === ".yas-parents"
    || name === ".yas-compiled-snippets.el";
}

function parseSnippet(content) {
  const lines = content.split(/\r?\n/);
  const headers = new Map();
  let bodyStart = -1;
  let headerEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^# --\s*$/.test(line)) {
      bodyStart = i + 1;
      break;
    }
    const header = line.match(/^#\s*([^:\n]+):\s*(.*)$/);
    if (header) {
      headers.set(header[1].trim().toLowerCase(), header[2].trim());
      headerEnd = i + 1;
    } else if (/^#/.test(line) || /^\s*$/.test(line)) {
      headerEnd = i + 1;
    } else {
      break;
    }
  }
  const start = bodyStart >= 0 ? bodyStart : headerEnd;
  return {
    headers,
    body: lines.slice(start).join("\n").replace(/\s+$/, ""),
  };
}

function filetypeForMode(mode) {
  if (modeMap.has(mode)) return modeMap.get(mode);
  if (!mode || mode.startsWith(".")) return "";
  return mode
    .replace(/-ts-mode$/, "")
    .replace(/-mode$/, "")
    .replace(/[^A-Za-z0-9_+.-]+/g, "-");
}

function maxSnippetIndex(text) {
  let max = 0;
  for (const match of text.matchAll(/\$(?:\{(\d+)(?=[:}|}])|(\d+))/g)) {
    max = Math.max(max, Number(match[1] || match[2] || 0));
  }
  return max;
}

function replaceBackquoteForms(body, report) {
  let nextIndex = maxSnippetIndex(body) + 1;
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "`") {
      out += body[i];
      continue;
    }
    if (i > 0 && body[i - 1] === "\\") {
      out += body[i];
      continue;
    }
    const run = body.slice(i).match(/^`+/)?.[0] ?? "`";
    if (run.length >= 3) {
      out += run;
      i += run.length - 1;
      continue;
    }
    let end = -1;
    for (let j = i + 1; j < body.length; j++) {
      if (body[j] !== "`") continue;
      if (j > 0 && body[j - 1] === "\\") continue;
      const closeRun = body.slice(j).match(/^`+/)?.[0] ?? "`";
      if (closeRun.length >= 3) continue;
      end = j;
      break;
    }
    if (end < 0) {
      out += body[i];
      continue;
    }
    const expr = body.slice(i + 1, end);
    const clean = expr.trim();
    if (clean === "yas-selected-text") {
      out += "$TM_SELECTED_TEXT";
      i = end;
      continue;
    }
    if (!clean) {
      out += body.slice(i, end + 1);
      i = end;
      continue;
    }
    if (!clean.startsWith("(")) {
      out += body.slice(i, end + 1);
      i = end;
      continue;
    }
    report.dynamicForms.push(clean);
    out += `\${${nextIndex++}:TODO}`;
    i = end;
  }
  return out;
}

function escapeUnsupportedDollars(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "$") {
      out += ch;
      continue;
    }
    const rest = body.slice(i);
    if (/^\$\d+/.test(rest) || /^\$\{\d+(?=[:}|}])/.test(rest)) {
      out += "$";
      continue;
    }
    if (/^\$TM_SELECTED_TEXT\b/.test(rest)) {
      out += "$";
      continue;
    }
    out += "\\$";
  }
  return out;
}

function splitBodyLines(body) {
  return body.split("\n");
}

function sourceTag(source) {
  return `[imported:${source.label}:${source.rel}]`;
}

function snippetKey(source, name, prefix) {
  const cleanName = String(name || prefix || basename(source.rel)).trim() || "Snippet";
  return `${source.label}: ${cleanName}`;
}

function ensureUniqueKey(target, preferred, fallback) {
  if (!Object.prototype.hasOwnProperty.call(target, preferred)) return preferred;
  if (!Object.prototype.hasOwnProperty.call(target, fallback)) return fallback;
  for (let i = 2; ; i++) {
    const key = `${fallback} #${i}`;
    if (!Object.prototype.hasOwnProperty.call(target, key)) return key;
  }
}

function removePreviouslyImported(existing, labels) {
  const next = {};
  let removed = 0;
  for (const [key, value] of Object.entries(existing || {})) {
    const desc = typeof value?.description === "string" ? value.description : "";
    const imported = labels.some((label) => desc.includes(`[imported:${label}:`));
    if (imported) removed++;
    else next[key] = value;
  }
  return { next, removed };
}

async function loadExistingJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (!existsSync(file)) return {};
    throw new Error(`Failed to parse existing snippet JSON ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function collectSnippets(sources) {
  const byFiletype = new Map();
  const stats = {
    scannedFiles: 0,
    imported: 0,
    skipped: 0,
    dynamicFiles: 0,
    dynamicForms: 0,
    byFiletype: new Map(),
    warnings: [],
  };

  for (const sourceRoot of sources) {
    const root = resolve(sourceRoot.root);
    const files = await walk(root);
    for (const file of files) {
      if (shouldSkipFile(file)) continue;
      stats.scannedFiles++;
      const rel = relative(root, file).split(sep).join("/");
      const mode = rel.split("/")[0] || "";
      const filetype = filetypeForMode(mode);
      if (!filetype) {
        stats.skipped++;
        stats.warnings.push(`skip unknown mode: ${sourceRoot.label}:${rel}`);
        continue;
      }
      const parsed = parseSnippet(await readFile(file, "utf8"));
      if (!parsed.body.trim()) {
        stats.skipped++;
        continue;
      }
      const prefix = parsed.headers.get("key") || basename(file);
      const name = parsed.headers.get("name") || prefix;
      const group = parsed.headers.get("group") || "";
      const condition = parsed.headers.get("condition") || "";
      const report = { dynamicForms: [] };
      const replaced = replaceBackquoteForms(parsed.body, report);
      const body = escapeUnsupportedDollars(replaced);
      const source = { label: sourceRoot.label, rel };
      const descriptionParts = [
        name,
        group ? `group: ${group}` : "",
        condition ? `condition discarded: ${condition}` : "",
        sourceTag(source),
      ].filter(Boolean);
      const entry = {
        name,
        prefix,
        body: splitBodyLines(body),
        description: descriptionParts.join(" | "),
      };
      if (!byFiletype.has(filetype)) byFiletype.set(filetype, []);
      byFiletype.get(filetype).push({
        key: snippetKey(source, name, prefix),
        fallbackKey: `${sourceRoot.label}: ${rel}`,
        entry,
        source,
        dynamicForms: report.dynamicForms,
      });
      stats.imported++;
      stats.byFiletype.set(filetype, (stats.byFiletype.get(filetype) || 0) + 1);
      if (report.dynamicForms.length) {
        stats.dynamicFiles++;
        stats.dynamicForms += report.dynamicForms.length;
        stats.warnings.push(`dynamic downgraded: ${sourceRoot.label}:${rel} -> ${report.dynamicForms.join("; ")}`);
      }
    }
  }

  return { byFiletype, stats };
}

async function mergeAndWrite({ byFiletype, stats }, options) {
  const labels = options.sources.map((source) => source.label);
  const written = [];
  const removed = [];
  for (const [filetype, snippets] of [...byFiletype.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const file = join(options.outputDir, `${filetype}.json`);
    const existing = await loadExistingJson(file);
    const cleaned = removePreviouslyImported(existing, labels);
    removed.push([filetype, cleaned.removed]);
    const next = { ...cleaned.next };
    for (const snippet of snippets.sort((a, b) => a.key.localeCompare(b.key))) {
      const key = ensureUniqueKey(next, snippet.key, snippet.fallbackKey);
      next[key] = snippet.entry;
    }
    if (options.write) {
      await mkdir(options.outputDir, { recursive: true });
      await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    }
    written.push([filetype, snippets.length, file]);
  }
  return { written, removed, stats };
}

function printReport(result, options) {
  const mode = options.write ? "write" : "dry-run";
  console.log(`snippet migration ${mode}`);
  console.log(`scanned files: ${result.stats.scannedFiles}`);
  console.log(`imported snippets: ${result.stats.imported}`);
  console.log(`skipped files: ${result.stats.skipped}`);
  console.log(`dynamic files: ${result.stats.dynamicFiles}`);
  console.log(`dynamic forms: ${result.stats.dynamicForms}`);
  for (const [filetype, count, file] of result.written) {
    const removed = result.removed.find(([ft]) => ft === filetype)?.[1] ?? 0;
    console.log(`${filetype}: +${count}, replaced previous imports ${removed}, target ${file}`);
  }
  if (result.stats.warnings.length) {
    console.log("\nwarnings:");
    for (const warning of result.stats.warnings.slice(0, 80)) console.log(`- ${warning}`);
    if (result.stats.warnings.length > 80) console.log(`- ... ${result.stats.warnings.length - 80} more`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const collected = await collectSnippets(options.sources.filter((source) => existsSync(source.root)));
  const result = await mergeAndWrite(collected, options);
  printReport(result, options);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
