#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectTexSnippetBody, normalizeTexSnippetBody } from "./tex-snippet-format.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const snippetRoot = join(repoRoot, "resources", "snippets", "tex-mode");
const manifestFile = join(snippetRoot, "generated", ".manifest.json");
const write = process.argv.includes("--write");

async function snippetFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name.endsWith(".el") || entry.name.endsWith(".json")) continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await snippetFiles(file));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort();
}

function splitSnippet(content) {
  const marker = /^# --\s*$/m.exec(content);
  if (!marker) return { prefix: "", body: content.replace(/\n$/, ""), suffix: content.endsWith("\n") ? "\n" : "" };
  const lineEnd = content.indexOf("\n", marker.index + marker[0].length);
  const bodyStart = lineEnd < 0 ? content.length : lineEnd + 1;
  const body = content.slice(bodyStart).replace(/\n$/, "");
  return {
    prefix: content.slice(0, bodyStart),
    body,
    suffix: content.endsWith("\n") ? "\n" : "",
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const files = await snippetFiles(snippetRoot);
const changed = [];
let groups = 0;
let mirrors = 0;
for (const file of files) {
  const content = await readFile(file, "utf8");
  // A migration artifact left two consecutive YAS separators in many files.
  // YAS treats the second one as snippet output, so collapse it at the source.
  const canonicalHeaders = content.replace(/(^# --\s*\n)(?:# --\s*\n)+/m, "$1");
  const { prefix, body, suffix } = splitSnippet(canonicalHeaders);
  const normalized = normalizeTexSnippetBody(body);
  const nextContent = `${prefix}${normalized}${suffix}`;
  if (nextContent !== content) {
    changed.push(relative(snippetRoot, file));
    if (write) await writeFile(file, nextContent, "utf8");
  }
  const inspected = inspectTexSnippetBody(write ? normalized : body);
  groups += inspected.groups;
  mirrors += inspected.mirrors;
  if (inspected.diagnostics.length > 0 && (!write || nextContent === content)) {
    for (const diagnostic of inspected.diagnostics) {
      console.error(`${relative(snippetRoot, file)}: ${diagnostic}`);
    }
  }
}

if (write) {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  for (const name of Object.keys(manifest.files ?? {})) {
    manifest.files[name] = sha256(await readFile(join(snippetRoot, "generated", name), "utf8"));
  }
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

if (!write && changed.length > 0) {
  console.error(`${changed.length} TeX snippets are not canonical; run npm run snippets:audit -- --write`);
  process.exitCode = 1;
} else {
  console.log(`TeX snippet audit: ${files.length} files, ${groups} tabstop groups, ${mirrors} mirrors, ${changed.length} normalized`);
}
