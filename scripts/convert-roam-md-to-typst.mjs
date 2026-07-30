#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const roamRoot = resolve(process.argv[2] || `${repoRoot}/../roam`);

const orgBlockFuncs = new Map([
  ["summary", "summary"],
  ["define", "definition"],
  ["definition", "definition"],
  ["theorem", "theorem"],
  ["lemma", "lemma"],
  ["proposition", "proposition"],
  ["corollary", "corollary"],
  ["proof", "proof"],
  ["note", "note-block"],
  ["important", "important"],
  ["warning", "warning"],
  ["attention", "attention"],
  ["example", "example"],
  ["remark", "remark"],
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    ...options,
  });
  if (result.status !== 0) {
    const message = result.stderr || result.stdout || `${command} failed`;
    throw new Error(message.trim());
  }
  return result.stdout;
}

function typstString(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function parseMeta(lines) {
  const meta = {};
  let inMeta = false;
  for (const line of lines) {
    if (/^#\+begin\s+meta\s*$/i.test(line)) {
      inMeta = true;
      continue;
    }
    if (/^#\+end\s+meta\s*$/i.test(line)) break;
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

function normalizeOrgBlocks(lines) {
  const out = [];
  for (const line of lines) {
    const begin = line.match(/^#\+begin\s+([A-Za-z0-9_-]+)\s*(.*)$/i);
    if (begin) {
      const kind = begin[1].toLowerCase();
      const title = begin[2].trim();
      const func = orgBlockFuncs.get(kind);
      if (func) {
        // Emit a pandoc raw-typst fence so the block call passes through
        // verbatim while the body is still processed as markdown.
        const call = title ? `#${func}(title: "${typstString(title)}")[` : `#${func}[`;
        out.push("", "~~~{=typst}", call, "~~~", "");
      } else {
        // Unknown block type: fall back to a level-4 heading.
        const label = kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, " ");
        out.push("", `#### ${label}${title ? `: ${title}` : ""}`, "");
      }
      continue;
    }

    if (/^#\+end\s+[A-Za-z0-9_-]+\s*$/i.test(line)) {
      out.push("", "~~~{=typst}", "]", "~~~", "");
      continue;
    }

    out.push(line);
  }
  return out;
}

function findMarkdownNotes() {
  const out = run("find", [
    "-L",
    roamRoot,
    "-path",
    `${roamRoot}/.lake`,
    "-prune",
    "-o",
    "-type",
    "f",
    "-name",
    "*.md",
    "-print",
  ]);
  return out
    .split(/\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasRoamMeta(file) {
  return /^#\+begin\s+meta\s*$/im.test(readFileSync(file, "utf8"));
}

function relativeImport(fromFile, imported) {
  let path = relative(dirname(fromFile), imported).replace(/\\/g, "/");
  if (!path.startsWith(".")) path = `./${path}`;
  return path;
}

function typstArrayLiteral(items) {
  if (items.length === 0) return "()";
  const inner = items.map((t) => `"${typstString(t)}"`).join(", ");
  return `(${inner}${items.length === 1 ? "," : ""})`;
}

function preamble(file, meta) {
  const title = meta.title || meta.id || relative(roamRoot, file).replace(/\.md$/i, "");
  const date = meta.date || "";
  const tags = (meta.tags || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const source = meta.source || relative(roamRoot, file).replace(/\\/g, "/");
  const roamImport = relativeImport(file.replace(/\.md$/i, ".typ"), resolve(roamRoot, "_typst/roam.typ"));

  const args = [
    `  title: "${typstString(title)}"`,
    date   ? `  date: "${typstString(date)}"` : null,
    tags.length ? `  tags: ${typstArrayLiteral(tags)}` : null,
    source ? `  source: "${typstString(source)}"` : null,
  ].filter(Boolean);

  return [
    `#import "${roamImport}": *`,
    "#show: note-theme",
    "",
    "#roam-meta(",
    ...args.map((a) => a + ","),
    ")",
    "",
  ].join("\n");
}

function convertFile(file) {
  const input = readFileSync(file, "utf8");
  const lines = input.split(/\r?\n/);
  const meta = parseMeta(lines);
  const markdown = normalizeOrgBlocks(stripMeta(lines)).join("\n").trim();

  const pandoc = spawnSync("pandoc", ["--from=markdown+tex_math_single_backslash-citations+raw_attribute", "--to=typst"], {
    input: markdown,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  if (pandoc.status !== 0) {
    throw new Error((pandoc.stderr || pandoc.stdout || "pandoc failed").trim());
  }

  const outFile = file.replace(/\.md$/i, ".typ");
  const body = pandoc.stdout
    .replace(/^#horizontalrule$/gm, "#line(length: 100%)");
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${preamble(file, meta)}${body.trim()}\n`, "utf8");
  return outFile;
}

const notes = findMarkdownNotes().filter(hasRoamMeta);
const written = notes.map(convertFile);
console.log(JSON.stringify({ roamRoot, count: written.length, written }, null, 2));
