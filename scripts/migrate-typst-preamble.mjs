#!/usr/bin/env node
// migrate-typst-preamble.mjs
// Rewrites the old title/meta #align(center) preamble to #roam-meta().
// Usage:  node migrate-typst-preamble.mjs [notesRoot]
//         default notesRoot = /Users/hc/Documents/Noema

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, join } from "node:path";
import { execSync } from "node:child_process";

const notesRoot = resolve(process.argv[2] || "/Users/hc/Documents/Noema");

function typstString(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function typstArrayLiteral(items) {
  if (items.length === 0) return "()";
  const inner = items.map((t) => `"${typstString(t)}"`).join(", ");
  return `(${inner}${items.length === 1 ? "," : ""})`;
}

// Matches the complete old preamble at the top of a .typ file.
//
// Groups:
//   1 — title (from #set document)
//   2 — meta string, e.g. "Date: ... | Tags: ... | Source: ..."
//        (absent when there was no meta align block)
const OLD_PREAMBLE_RE =
  /^#import "[^"]+": \*\n\n#set document\(title: "([^"]*)"\)\n#show: note-theme\n\n#align\(center\)\[\n[ \t]+#text[^[]+\["[^"]*"\]\n\](?:\n#align\(center\)\[\n[ \t]+#text[^[]+\["([^"]*)"\]\n\])?\n?/;

function parseMetaString(s) {
  if (!s) return { date: null, tags: [], source: null };
  const date     = s.match(/Date:\s+(\S+)/)?.[1]  ?? null;
  const tagsRaw  = s.match(/Tags:\s+([^|]+)/)?.[1]?.trim() ?? null;
  const sourceRaw = s.match(/Source:\s+(.+)/)?.[1]?.trim() ?? null;
  const tags = tagsRaw ? tagsRaw.split("·").map((t) => t.trim()).filter(Boolean) : [];
  const source = sourceRaw ?? null;
  return { date, tags, source };
}

function roamTypPath(filePath) {
  const fileDir = dirname(resolve(filePath));
  const roamTyp = join(notesRoot, "_typst", "roam.typ");
  let p = relative(fileDir, roamTyp).replace(/\\/g, "/");
  if (!p.startsWith(".")) p = "./" + p;
  return p;
}

function migrate(filePath) {
  const src = readFileSync(filePath, "utf8");

  // Already migrated or no old preamble
  if (src.includes("#roam-meta(")) return "skip:already";
  if (!src.includes("#set document(")) return "skip:no-preamble";

  const m = src.match(OLD_PREAMBLE_RE);
  if (!m) return "skip:no-match";

  const [fullMatch, title, metaStr] = m;
  const { date, tags, source } = parseMetaString(metaStr);

  const roamPath = roamTypPath(filePath);

  const args = [
    `  title: "${typstString(title)}"`,
    date   ? `  date: "${typstString(date)}"` : null,
    tags.length ? `  tags: ${typstArrayLiteral(tags)}` : null,
    source ? `  source: "${typstString(source)}"` : null,
  ].filter(Boolean);

  const newPreamble = [
    `#import "${roamPath}": *`,
    "#show: note-theme",
    "",
    "#roam-meta(",
    ...args.map((a) => a + ","),
    ")",
    "",
  ].join("\n");

  writeFileSync(filePath, newPreamble + src.slice(fullMatch.length), "utf8");
  return "migrated";
}

const files = execSync(
  `find "${notesRoot}" -name "*.typ" ! -path "*/_typst/*"`,
  { encoding: "utf8" }
)
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

let migrated = 0, skipped = 0;
for (const f of files) {
  const result = migrate(f);
  const rel = relative(notesRoot, f);
  if (result === "migrated") {
    console.log(`✓  ${rel}`);
    migrated++;
  } else {
    console.log(`—  ${rel}  (${result})`);
    skipped++;
  }
}
console.log(`\n${migrated} migrated, ${skipped} skipped`);
